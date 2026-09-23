import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const GITHUB_COM = "https://github.com";
const COPILOT_API = "https://api.github.com";

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requestJson = async (url, headers, fetchFunction) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetchFunction(url, {
      headers,
      method: "GET",
      signal: controller.signal
    });
    if (
      !response ||
      typeof response.status !== "number" ||
      !Number.isFinite(response.status)
    ) {
      return { status: undefined };
    }
    if (response.status < 200 || response.status >= 300) {
      return { status: response.status };
    }
    try {
      const payload = await response.json();
      return {
        payload: isRecord(payload) ? payload : undefined,
        status: response.status
      };
    } catch {
      return { status: response.status };
    }
  } catch {
    return { status: undefined };
  } finally {
    clearTimeout(timeout);
  }
};

const fetchFunction = (options) => options.fetch ?? globalThis.fetch;

const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

const nowValue = (value) => {
  if (value instanceof Date) {
    return value.getTime();
  }
  return isFiniteNumber(value) ? value : Date.now();
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
      console.error(`[copilot-usage] unreadable ${filePath}`, error);
    }
  }
};

const resetAfter = (timestamp, now) =>
  isFiniteNumber(timestamp) && timestamp > 0
    ? Math.max(0, Math.trunc(timestamp - now))
    : 0;

const snapshot = (metrics, label) => {
  const validMetrics = metrics.filter(Boolean);
  if (!validMetrics.length) {
    return;
  }
  const group = { metrics: validMetrics };
  if (label) {
    group.label = label;
  }
  return { groups: [group] };
};

const usageMetric = (label, used, total, resetsInMs) => {
  if (
    !isFiniteNumber(used) ||
    !isFiniteNumber(total) ||
    used < 0 ||
    total < 0
  ) {
    return;
  }
  return {
    label,
    resetsInMs: Math.max(0, resetsInMs || 0),
    total,
    type: "usage",
    used
  };
};

const candidateEnvironmentTokens = (environment) =>
  ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]
    .map((name) => environment?.[name] ?? process.env[name] ?? "")
    .filter((token) => typeof token === "string" && token);

const normalizeHost = (host) => {
  if (typeof host !== "string" || !host) {
    return GITHUB_COM;
  }
  const trimmed = host.trim().replace(/\/$/u, "");
  return trimmed.includes("://") ? trimmed : `https://${trimmed}`;
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
  if (oauth?.type !== "oauth") {
    return candidates;
  }
  const host = copilotApiHost(oauth.enterpriseUrl || GITHUB_COM);
  if (typeof oauth.access === "string" && oauth.access) {
    candidates.push({ host, scheme: "token", token: oauth.access });
  }
  if (
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
  if (
    typeof payload.quota_reset_date_utc === "string" &&
    payload.quota_reset_date_utc
  ) {
    const timestamp = Date.parse(payload.quota_reset_date_utc);
    if (Number.isFinite(timestamp)) {
      return Math.max(0, timestamp - now);
    }
  }
  return resetAfter(Number(payload.limited_user_reset_date) * 1000, now);
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
  if (typeof plan !== "string" || !known.includes(plan)) {
    return "";
  }
  const name = plan.replaceAll("_", " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
};

const normalizeCopilot = (payload, now) => {
  const reset = copilotReset(payload, now);
  const metrics = Object.entries({
    Chat: payload.quota_snapshots?.chat,
    Completions: payload.quota_snapshots?.completions,
    Premium: payload.quota_snapshots?.premium_interactions
  }).flatMap(([label, window]) => {
    if (!isRecord(window) || !isFiniteNumber(window.entitlement)) {
      return [];
    }
    const remaining = isFiniteNumber(window.quota_remaining)
      ? window.quota_remaining
      : window.remaining;
    // ponytail: remaining=-1 means exhausted with overage, not unlimited.
    if (!isFiniteNumber(remaining) || window.entitlement < 0) {
      return [];
    }
    const total = Math.max(0, window.entitlement);
    const used = Math.min(
      total,
      Math.round(Math.max(0, total - Math.max(0, remaining)) * 100) / 100
    );
    return [usageMetric(label, used, total, reset)];
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
 * Fetch and normalize Copilot usage with credential fallback discovery.
 * @param {object} [options] Input value.
 * @returns {Promise<object|undefined>} Result.
 */
const fetchCandidate = async (candidates, options, index = 0) => {
  const candidate = candidates[index];
  if (!candidate) {
    return;
  }
  const { status, payload } = await requestJson(
    `${copilotApiHost(candidate.host)}/copilot_internal/user`,
    copilotHeaders(candidate),
    fetchFunction(options)
  );
  if (status === 401 || status === 403) {
    return fetchCandidate(candidates, options, index + 1);
  }
  const failed =
    status === undefined || status < 200 || status >= 300 || !payload;
  return failed ? undefined : normalizeCopilot(payload, nowValue(options.now));
};

/**
 * Fetch and normalize Copilot usage with credential fallback discovery.
 * @param {object} [options] Input value.
 * @returns {Promise<object|undefined>} Result.
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
