import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { withUsageCache } from "./usage-cache.mjs";

const GITHUB_COM = "https://github.com";
const COPILOT_API = "https://api.github.com";

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requestJson = async (url, headers, fetchFunction, onUsageError) => {
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
      if (!isRecord(payload)) {
        onUsageError?.();
        return { status: response.status };
      }
      return { payload, status: response.status };
    } catch {
      onUsageError?.();
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
  const group = label
    ? { label, metrics: validMetrics }
    : { metrics: validMetrics };
  return validMetrics.length ? { groups: [group] } : undefined;
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

const ENVIRONMENT_TOKEN_NAMES = [
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN"
];

const candidateEnvironmentTokens = (environment, index = 0) => {
  if (index >= ENVIRONMENT_TOKEN_NAMES.length) {
    return [];
  }
  const token =
    environment?.[ENVIRONMENT_TOKEN_NAMES[index]] ??
    process.env[ENVIRONMENT_TOKEN_NAMES[index]] ??
    "";
  const rest = candidateEnvironmentTokens(environment, index + 1);
  return typeof token === "string" && token ? [token, ...rest] : rest;
};

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
    .flatMap(([authority, entries]) =>
      entries
        .filter(
          (entry) =>
            isRecord(entry) &&
            typeof entry.accessToken === "string" &&
            entry.accessToken
        )
        .map((entry) => ({
          host: copilotApiHost(
            authority.endsWith("/login/oauth")
              ? authority.slice(0, -12)
              : authority
          ),
          scheme: "token",
          token: entry.accessToken
        }))
    );
};

const openCodeCopilotCandidates = async (home) => {
  const openCode = await readJson(
    path.join(home, ".local", "share", "opencode", "auth.json")
  );
  const oauth = openCode?.["github-copilot"];
  if (oauth?.type !== "oauth") {
    return [];
  }
  const host = copilotApiHost(oauth.enterpriseUrl || GITHUB_COM);
  return [
    ...(typeof oauth.access === "string" && oauth.access
      ? [{ host, scheme: "token", token: oauth.access }]
      : []),
    ...(typeof oauth.refresh === "string" &&
    oauth.refresh &&
    oauth.refresh !== oauth.access
      ? [{ host, scheme: "token", token: oauth.refresh }]
      : [])
  ];
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

const keychainToken = (options, home) => {
  if (
    (options.platform ?? process.platform) !== "darwin" ||
    !(home === homedir() || options.execFile)
  ) {
    return "";
  }
  try {
    return (options.execFile ?? execFileSync)(
      "security",
      ["find-generic-password", "-s", "copilot-cli", "-w"],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000
      }
    ).trim();
  } catch {
    return "";
  }
};

const copilotCandidates = async (options, credential) => {
  const home = options.home ?? homedir();
  const config = await readJson(
    path.join(home, ".copilot", "config.json"),
    true
  );
  const login = config?.lastLoggedInUser?.login;
  const session = login && config.copilotTokens?.[`${GITHUB_COM}:${login}`];
  const keychain = keychainToken(options, home);
  return [
    ...(credential
      ? [{ host: COPILOT_API, scheme: "token", token: credential }]
      : []),
    ...candidateEnvironmentTokens(options.environment).map((token) => ({
      host: COPILOT_API,
      scheme: "token",
      token
    })),
    ...(typeof session === "string" && session
      ? [{ host: COPILOT_API, scheme: "Bearer", token: session }]
      : []),
    ...(keychain
      ? [{ host: COPILOT_API, scheme: "token", token: keychain }]
      : []),
    ...(await intellijCandidates(home)),
    ...(await openCodeCopilotCandidates(home)),
    ...(await ghCliCandidates(home))
  ];
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

const COPILOT_PLANS = new Set([
  "free",
  "individual",
  "pro",
  "pro_plus",
  "business",
  "enterprise",
  "team"
]);

const planLabel = (plan) => {
  const name = COPILOT_PLANS.has(plan) ? plan.replaceAll("_", " ") : "";
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : "";
};

const groupLabel = (payload) => {
  if (payload.access_type_sku === "free_limited_copilot") {
    return "Copilot (Free)";
  }
  const plan = planLabel(payload.copilot_plan);
  return plan && `Copilot (${plan})`;
};

const QUOTA_METRICS = [
  ["Chat", "chat"],
  ["Completions", "completions"],
  ["Premium", "premium_interactions"]
];

const quotaMetric = (label, window, reset) => {
  const entitlement =
    isRecord(window) && isFiniteNumber(window.entitlement)
      ? window.entitlement
      : Number.NaN;
  const total = Math.max(0, entitlement);
  const remaining = isFiniteNumber(window?.quota_remaining)
    ? window.quota_remaining
    : window?.remaining;
  return isFiniteNumber(remaining) && entitlement > 0
    ? usageMetric(
        label,
        Math.min(
          total,
          Math.round(Math.max(0, total - Math.max(0, remaining)) * 100) / 100
        ),
        total,
        reset
      )
    : undefined;
};

const quotaMetrics = (payload, reset, index = 0) => {
  if (index >= QUOTA_METRICS.length) {
    return [];
  }
  const [label, key] = QUOTA_METRICS[index];
  const metric = quotaMetric(label, payload.quota_snapshots?.[key], reset);
  const rest = quotaMetrics(payload, reset, index + 1);
  return metric ? [metric, ...rest] : rest;
};

const normalizeCopilot = (payload, now) =>
  snapshot(
    quotaMetrics(payload, copilotReset(payload, now)),
    groupLabel(payload)
  );

const copilotHeaders = (candidate) => ({
  Accept: "application/vnd.github+json",
  Authorization: `${candidate.scheme} ${candidate.token}`,
  "Content-Type": "application/json",
  "User-Agent": "copilot",
  "X-GitHub-Api-Version": "2025-04-01"
});

const fetchCandidate = async (candidates, options, index = 0) => {
  const candidate = candidates[index];
  if (candidate) {
    const { status, payload } = await requestJson(
      `${copilotApiHost(candidate.host)}/copilot_internal/user`,
      copilotHeaders(candidate),
      fetchFunction(options),
      options.onUsageError
    );
    if (status === 401 || status === 403) {
      options.onUsageError?.();
      return fetchCandidate(candidates, options, index + 1);
    }
    if (status === undefined || status < 200 || status >= 300 || !payload) {
      return;
    }
    if (!isRecord(payload.quota_snapshots)) {
      options.onUsageError?.();
      return;
    }
    return normalizeCopilot(payload, nowValue(options.now));
  }
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
  return usable.length
    ? withUsageCache(
        "copilot",
        usable.map((candidate) => [
          candidate.token,
          copilotApiHost(candidate.host),
          candidate.scheme
        ]),
        options,
        (cachedOptions) => fetchCandidate(usable, cachedOptions)
      )
    : undefined;
};
