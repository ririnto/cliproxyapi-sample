import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const GITHUB_COM = "https://github.com";
const COPILOT_API = "https://api.github.com";

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeResponse = async (response) => {
  try {
    const payload = await response.json();
    return {
      payload: isRecord(payload) ? payload : undefined,
      status: response.status
    };
  } catch {
    return { status: response.status };
  }
};

const requestJson = async (url, headers, fetchFunction) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  let response;
  let result;
  try {
    response = await fetchFunction(url, {
      headers,
      method: "GET",
      signal: controller.signal
    });
    if (
      !response ||
      typeof response.status !== "number" ||
      !Number.isFinite(response.status)
    ) {
      result = { status: undefined };
    } else if (response.status < 200 || response.status >= 300) {
      result = { status: response.status };
    } else {
      result = await decodeResponse(response);
    }
  } catch {
    result = { status: undefined };
  } finally {
    controller.abort();
    clearTimeout(timeout);
    if (response?.body && !response.bodyUsed) {
      await response.body.cancel().catch(() => null);
    }
  }
  return result;
};

const fetchFunction = (options) => options.fetch ?? globalThis.fetch;

const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

const nowValue = (value) => {
  let now;
  if (value instanceof Date) {
    now = value.getTime();
  } else if (isFiniteNumber(value)) {
    now = value;
  } else {
    now = Date.now();
  }
  return now;
};

const stripJsonc = (text) => {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      result += character;
      if (character === '"' && !escaped) {
        inString = false;
      }
      escaped = character === "\\" && !escaped;
    } else if (character === '"') {
      inString = true;
      result += character;
    } else if (character === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      result += "\n";
    } else if (character === "/" && text[index + 1] === "*") {
      index += 2;
      while (
        index < text.length &&
        !(text[index] === "*" && text[index + 1] === "/")
      ) {
        index += 1;
      }
      index += 1;
    } else {
      result += character;
    }
  }
  return result;
};

const readJson = async (filePath, jsonc = false) => {
  try {
    const text = await readFile(filePath, "utf-8");
    const value = JSON.parse(jsonc ? stripJsonc(text) : text);
    return isRecord(value) ? value : undefined;
  } catch (error) {
    if (process.env.STATUSLINE_DEBUG) {
      console.error(
        `[copilot-usage] unreadable credentials (${error instanceof SyntaxError ? "invalid JSON" : "file read failed"})`
      );
    }
  }
};

const resetAfter = (timestamp, now) =>
  isFiniteNumber(timestamp) && timestamp > 0
    ? Math.max(0, Math.trunc(timestamp - now))
    : 0;

const snapshot = (metrics, label) => {
  const validMetrics = metrics.filter(Boolean);
  const group = validMetrics.length ? { metrics: validMetrics } : undefined;
  if (group && label) {
    group.label = label;
  }
  return group ? { groups: [group] } : undefined;
};

const usageMetric = (label, used, total, resetsInMs) =>
  isFiniteNumber(used) && isFiniteNumber(total) && used >= 0 && total >= 0
    ? {
        label,
        resetsInMs: Math.max(0, resetsInMs || 0),
        total,
        type: "usage",
        used
      }
    : undefined;

const candidateEnvironmentTokens = (environment) =>
  ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]
    .map((name) => environment?.[name] ?? process.env[name] ?? "")
    .filter((token) => typeof token === "string" && token);

const normalizeHost = (host) => {
  let result = GITHUB_COM;
  if (typeof host === "string" && host) {
    const trimmed = host.trim().replace(/\/$/u, "");
    result = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  }
  return result;
};

const copilotApiHost = (host) => {
  const normalized = normalizeHost(host);
  return normalized === GITHUB_COM ? COPILOT_API : normalized;
};

const intellijCandidates = async (home) => {
  const oauth = await readJson(
    path.join(home, ".config", "github-copilot", "oauth.json")
  );
  return Object.entries(oauth ?? {})
    .filter(([, entries]) => Array.isArray(entries))
    .flatMap(([authority, entries]) => {
      const host = authority.endsWith("/login/oauth")
        ? authority.slice(0, -12)
        : authority;
      return entries
        .filter(
          (entry) =>
            isRecord(entry) &&
            typeof entry.accessToken === "string" &&
            entry.accessToken
        )
        .map((entry) => ({
          host: copilotApiHost(host),
          scheme: "token",
          token: entry.accessToken
        }));
    });
};

const openCodeCopilotCandidates = async (home) => {
  const openCode = await readJson(
    path.join(home, ".local", "share", "opencode", "auth.json")
  );
  const oauth = openCode?.["github-copilot"];
  const candidates = [];
  const host =
    oauth?.type === "oauth"
      ? copilotApiHost(oauth.enterpriseUrl || GITHUB_COM)
      : undefined;
  if (host !== undefined && typeof oauth.access === "string" && oauth.access) {
    candidates.push({ host, scheme: "token", token: oauth.access });
  }
  if (
    host !== undefined &&
    typeof oauth.refresh === "string" &&
    oauth.refresh &&
    oauth.refresh !== oauth.access
  ) {
    candidates.push({ host, scheme: "token", token: oauth.refresh });
  }
  return candidates;
};

const ghCliCandidates = async (home) => {
  const hosts = await readJson(path.join(home, ".config", "gh", "hosts.json"));
  return Object.entries(hosts ?? {})
    .filter(([, entry]) => isRecord(entry))
    .flatMap(([authority, entry]) => {
      const host = copilotApiHost(authority);
      const userTokens = isRecord(entry.users)
        ? Object.values(entry.users)
            .filter(isRecord)
            .map((user) => user.oauth_token)
        : [];
      return [...userTokens, entry.oauth_token]
        .filter((token) => typeof token === "string" && token)
        .map((token) => ({ host, scheme: "token", token }));
    });
};

/**
 * Gather tokens from explicit input, environment, and local client settings.
 * An unreadable macOS Copilot CLI Keychain entry is ignored so remaining local
 * credential sources can still be tried.
 */
const copilotCandidates = async (options, credential) => {
  const candidates = [];
  if (credential) {
    candidates.push({ host: COPILOT_API, scheme: "token", token: credential });
  }
  for (const token of candidateEnvironmentTokens(options.environment)) {
    candidates.push({ host: COPILOT_API, scheme: "token", token });
  }
  const home = options.home ?? homedir();
  const config = await readJson(
    path.join(home, ".copilot", "config.json"),
    true
  );
  const login = config?.lastLoggedInUser?.login;
  const session = login && config.copilotTokens?.[`${GITHUB_COM}:${login}`];
  if (typeof session === "string" && session) {
    candidates.push({ host: COPILOT_API, scheme: "Bearer", token: session });
  }
  if (
    process.platform === "darwin" &&
    (home === homedir() || options.execFile)
  ) {
    try {
      const token = (options.execFile ?? execFileSync)(
        "security",
        ["find-generic-password", "-s", "copilot-cli", "-w"],
        {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 3000
        }
      ).trim();
      if (token) {
        candidates.push({ host: COPILOT_API, scheme: "token", token });
      }
    } catch {
      // No readable Copilot CLI Keychain token; try other credentials.
    }
  }
  candidates.push(
    ...(await intellijCandidates(home)),
    ...(await openCodeCopilotCandidates(home)),
    ...(await ghCliCandidates(home))
  );
  return candidates;
};

const copilotReset = (payload, now) => {
  let reset;
  if (
    typeof payload.quota_reset_date_utc === "string" &&
    payload.quota_reset_date_utc
  ) {
    const timestamp = Date.parse(payload.quota_reset_date_utc);
    reset = Number.isFinite(timestamp)
      ? Math.max(0, timestamp - now)
      : undefined;
  }
  return (
    reset ?? resetAfter(Number(payload.limited_user_reset_date) * 1000, now)
  );
};

const planLabel = (plan) => {
  const known = [
    "free",
    "individual",
    "pro",
    "pro_plus",
    "business",
    "enterprise",
    "team"
  ];
  let label = "";
  if (typeof plan === "string" && known.includes(plan)) {
    const name = plan.replaceAll("_", " ");
    label = name.charAt(0).toUpperCase() + name.slice(1);
  }
  return label;
};

/**
 * Convert Copilot quotas into bounded usage metrics. A remaining value of -1
 * represents exhaustion with overage and is treated as zero remaining quota.
 */
const normalizeCopilot = (payload, now) => {
  const reset = copilotReset(payload, now);
  const metrics = Object.entries({
    Chat: payload.quota_snapshots?.chat,
    Completions: payload.quota_snapshots?.completions,
    Premium: payload.quota_snapshots?.premium_interactions
  }).flatMap(([label, window]) => {
    let result;
    if (isRecord(window) && isFiniteNumber(window.entitlement)) {
      const remaining = isFiniteNumber(window.quota_remaining)
        ? window.quota_remaining
        : window.remaining;
      const total =
        !isFiniteNumber(remaining) || window.entitlement < 0
          ? undefined
          : Math.max(0, window.entitlement);
      result =
        total === undefined
          ? []
          : [
              usageMetric(
                label,
                Math.min(
                  total,
                  Math.round(
                    Math.max(0, total - Math.max(0, remaining)) * 100
                  ) / 100
                ),
                total,
                reset
              )
            ];
    } else {
      result = [];
    }
    return result;
  });
  const plan = planLabel(payload.copilot_plan);
  return snapshot(metrics, plan && `Copilot (${plan})`);
};

const copilotHeaders = (candidate) => ({
  Accept: "application/vnd.github+json",
  Authorization: `${candidate.scheme} ${candidate.token}`,
  "Content-Type": "application/json",
  "User-Agent": "copilot",
  "X-GitHub-Api-Version": "2025-04-01"
});

/**
 * Try candidates in order, advancing only after an HTTP 401 or 403 response.
 * Other request failures stop the search without a snapshot.
 * @param {object[]} candidates Ordered token, host, and auth-scheme records.
 * @param {object} options Fetch and current-time overrides.
 * @param {number} [index] First candidate to attempt.
 * @returns {Promise<object|undefined>} Normalized usage, or undefined when no
 * candidate succeeds or no valid metrics remain.
 */
const fetchCandidate = async (candidates, options, index = 0) => {
  const candidate = candidates[index];
  const response = candidate
    ? await requestJson(
        `${copilotApiHost(candidate.host)}/copilot_internal/user`,
        copilotHeaders(candidate),
        fetchFunction(options)
      )
    : undefined;
  let result;
  if (!response) {
    result = undefined;
  } else if (response.status === 401 || response.status === 403) {
    result = fetchCandidate(candidates, options, index + 1);
  } else {
    const failed =
      response.status === undefined ||
      response.status < 200 ||
      response.status >= 300 ||
      !response.payload;
    result = failed
      ? undefined
      : normalizeCopilot(response.payload, nowValue(options.now));
  }
  return result;
};

/**
 * Discover and deduplicate Copilot credentials, then fetch normalized usage.
 * Reads environment and local client settings and may query macOS Keychain.
 * Candidates are retried only on HTTP 401/403; other request failures and
 * snapshots without valid metrics return no result.
 * @param {object} [options] Credential, environment, home directory, fetch and
 * Keychain-command overrides, and current time as a Date or milliseconds.
 * @returns {Promise<object|undefined>} Usage groups, or undefined when no
 * candidate succeeds or usable metrics are unavailable.
 */
export const fetchUsage = async (options = {}) => {
  const candidates = await copilotCandidates(
    options,
    typeof options.credential === "string" ? options.credential : ""
  );
  const seen = new Set();
  const usable = candidates.filter((candidate) => {
    const identity = JSON.stringify([
      candidate.token,
      copilotApiHost(candidate.host),
      candidate.scheme
    ]);
    return seen.has(identity) ? false : seen.add(identity);
  });
  return fetchCandidate(usable, options);
};
