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
      if (character !== "\\") {
        escaped = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    if (character === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      result += "\n";
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      index += 2;
      while (
        index < text.length &&
        !(text[index] === "*" && text[index + 1] === "/")
      ) {
        index += 1;
      }
      index += 1;
      continue;
    }
    result += character;
  }
  return result;
};

const readJson = async (filePath, jsonc = false) => {
  try {
    const text = await readFile(filePath, "utf-8");
    const value = JSON.parse(jsonc ? stripJsonc(text) : text);
    return isRecord(value) ? value : undefined;
  } catch {
    // Return undefined when local authentication data is unreadable.
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
  let result = host.trim().replace(/\/$/u, "");
  if (!result.includes("://")) {
    result = `https://${result}`;
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
  const candidates = [];
  if (!oauth) {
    return candidates;
  }
  for (const [authority, entries] of Object.entries(oauth)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    const host = authority.endsWith("/login/oauth")
      ? authority.slice(0, -12)
      : authority;
    for (const entry of entries) {
      if (
        isRecord(entry) &&
        typeof entry.accessToken === "string" &&
        entry.accessToken
      ) {
        candidates.push({
          host: copilotApiHost(host),
          scheme: "token",
          token: entry.accessToken
        });
      }
    }
  }
  return candidates;
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
  candidates.push(
    ...(await intellijCandidates(home)),
    ...(await openCodeCopilotCandidates(home))
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

const normalizeCopilot = (payload, now) => {
  const window = payload.quota_snapshots?.premium_interactions;
  if (!isRecord(window)) {
    return;
  }
  const remaining = isFiniteNumber(window.quota_remaining)
    ? window.quota_remaining
    : window.remaining;
  if (!isFiniteNumber(remaining) || !isFiniteNumber(window.entitlement)) {
    return;
  }
  const total = Math.max(0, window.entitlement);
  const used = Math.round(Math.max(0, total - remaining) * 100) / 100;
  return snapshot([
    usageMetric("Premium", used, total, copilotReset(payload, now))
  ]);
};

/**
 * Fetch and normalize Copilot usage with credential fallback discovery.
 * @param {object} [options] Input value.
 * @returns {Promise<object|undefined>} Result.
 */
const fetchCandidate = async (candidates, options, seen, index = 0) => {
  if (index >= candidates.length) {
    return;
  }
  const candidate = candidates[index];
  const host = copilotApiHost(candidate.host);
  const identity = JSON.stringify([candidate.token, host, candidate.scheme]);
  if (seen.has(identity)) {
    return fetchCandidate(candidates, options, seen, index + 1);
  }
  seen.add(identity);
  const response = await requestJson(
    `${host}/copilot_internal/user`,
    {
      Accept: "application/vnd.github+json",
      Authorization: `${candidate.scheme} ${candidate.token}`,
      "Content-Type": "application/json",
      "User-Agent": "copilot",
      "X-GitHub-Api-Version": "2025-04-01"
    },
    fetchFunction(options)
  );
  if (response.status === 401 || response.status === 403) {
    return fetchCandidate(candidates, options, seen, index + 1);
  }
  if (
    response.status === undefined ||
    response.status < 200 ||
    response.status >= 300 ||
    !response.payload
  ) {
    return;
  }
  return normalizeCopilot(response.payload, nowValue(options.now));
};

/**
 * Fetch and normalize Copilot usage with credential fallback discovery.
 * @param {object} [options] Input value.
 * @returns {Promise<object|undefined>} Result.
 */
export const fetchUsage = async (options = {}) => {
  const { credential } = options;
  const candidates = await copilotCandidates(
    options,
    typeof credential === "string" ? credential : ""
  );
  return fetchCandidate(candidates, options, new Set());
};
