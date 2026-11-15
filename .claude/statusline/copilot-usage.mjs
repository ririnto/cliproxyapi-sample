import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { withUsageCache } from "./usage-cache.mjs";

const GITHUB_COM = "https://github.com";
const COPILOT_API = "https://api.github.com";

/**
 * @param {unknown} value Value to validate.
 * @returns {value is import("./types.ts").JsonRecord} Record check.
 */
const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * @param {string} url Input value.
 * @param {Record<string, string>} headers Input value.
 * @param {import("./types.ts").Fetch} fetchFunction Input value.
 * @param {(() => void) | undefined} onUsageError Input value.
 */
const requestJson = async (url, headers, fetchFunction, onUsageError) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 3000);
  try {
    const response = await fetchFunction(url, {
      headers,
      method: "GET",
      signal: controller.signal
    });
    if (
      typeof response.status !== "number" ||
      !Number.isFinite(response.status)
    ) {
      return { status: undefined };
    }
    if (response.status < 200 || response.status >= 300) {
      try {
        await Promise.race([
          response.body?.cancel(),
          delay(3000, undefined, { signal: controller.signal })
        ]);
      } catch {
        controller.abort();
        return { status: response.status };
      }
      controller.abort();
      return { status: response.status };
    }
    try {
      /**
       * @type {unknown}
       */
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

/**
 * @param {unknown} value Value to validate.
 * @returns {value is number} Finite check.
 */
const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

/**
 * @param {unknown} value - Timestamp.
 */
const nowValue = (value) => {
  if (value instanceof Date) {
    return value.getTime();
  }
  return isFiniteNumber(value) ? value : Date.now();
};

/**
 * @param {string} text - JSONC document.
 */
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

/**
 * @param {string} filePath - File location.
 * @param {boolean} [jsonc] - Strip comments.
 * @returns {Promise<Record<string,unknown>|undefined|null>} Valid result or absence.
 */
const readJson = async (filePath, jsonc = false) => {
  try {
    const text = await readFile(filePath, "utf-8");
    /**
     * @type {unknown}
     */
    const value = JSON.parse(jsonc ? stripJsonc(text) : text);
    return isRecord(value) ? value : undefined;
  } catch {
    if (
      process.env.STATUSLINE_DEBUG !== undefined &&
      process.env.STATUSLINE_DEBUG !== ""
    ) {
      console.error("[copilot-usage] unreadable credential data");
    }
  }
  return null;
};

/**
 * @param {unknown} timestamp - Reset timestamp.
 * @param {number} now - Current time.
 */
const resetAfter = (timestamp, now) =>
  isFiniteNumber(timestamp) && timestamp > 0
    ? Math.max(0, Math.trunc(timestamp - now))
    : 0;

/**
 * @param {(import("./types.ts").Metric | undefined)[]} metrics - Candidate metrics.
 * @param {string} label - Group label.
 */
const snapshot = (metrics, label) => {
  const validMetrics = metrics.filter((metric) => metric !== undefined);
  return validMetrics.length > 0
    ? {
        groups: [
          label === ""
            ? { metrics: validMetrics }
            : { label, metrics: validMetrics }
        ]
      }
    : undefined;
};

/**
 * @param {string} label - Metric label.
 * @param {unknown} used - Used amount.
 * @param {unknown} total - Quota.
 * @param {number} resetsInMs - Reset delay.
 * @returns {import("./types.ts").Metric | undefined} Valid metric.
 */
const usageMetric = (label, used, total, resetsInMs) =>
  isFiniteNumber(used) && isFiniteNumber(total) && used >= 0 && total >= 0
    ? {
        label,
        resetsInMs: Math.max(0, resetsInMs ?? 0),
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

/**
 * @param {Record<string, string | undefined> | undefined} environment - Environment.
 * @param {number} [index] - Candidate index.
 * @returns {string[]} Ordered tokens.
 */
const candidateEnvironmentTokens = (environment, index = 0) => {
  if (index >= ENVIRONMENT_TOKEN_NAMES.length) {
    return [];
  }
  const token =
    environment?.[ENVIRONMENT_TOKEN_NAMES[index]] ??
    process.env[ENVIRONMENT_TOKEN_NAMES[index]] ??
    "";
  const rest = candidateEnvironmentTokens(environment, index + 1);
  return typeof token === "string" && token !== "" ? [token, ...rest] : rest;
};

/**
 * @param {unknown} host - Host input.
 */
const normalizeHost = (host) => {
  if (typeof host !== "string" || host === "") {
    return GITHUB_COM;
  }
  const trimmed = host.trim().replace(/\/$/u, "");
  return trimmed.includes("://") ? trimmed : `https://${trimmed}`;
};

/**
 * @param {unknown} host - Host input.
 */
const copilotApiHost = (host) => {
  const normalized = normalizeHost(host);
  return normalized === GITHUB_COM ? COPILOT_API : normalized;
};

/**
 * @param {string} home - Home directory.
 */
/**
 * @param {unknown} value - OAuth entry.
 * @returns {value is Record<string, unknown> & {accessToken: string}} Token-bearing record.
 */
const hasAccessToken = (value) =>
  isRecord(value) &&
  typeof value.accessToken === "string" &&
  value.accessToken !== "";
/**
 * @param {string} home - Home directory.
 */
const intellijCandidates = async (home) => {
  const oauth = await readJson(
    path.join(home, ".config", "github-copilot", "oauth.json")
  );
  return Object.entries(oauth ?? {}).flatMap(([authority, entries]) =>
    (Array.isArray(entries) ? entries : [])
      .filter(hasAccessToken)
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

/**
 * @param {string} home - Home directory.
 */
const openCodeCopilotCandidates = async (home) => {
  const auth = await readJson(
    path.join(home, ".local", "share", "opencode", "auth.json")
  );
  const oauth = auth?.["github-copilot"];
  if (!isRecord(oauth) || oauth.type !== "oauth") {
    return [];
  }
  const host = copilotApiHost(oauth.enterpriseUrl ?? GITHUB_COM);
  return [
    ...(typeof oauth.access === "string" && oauth.access !== ""
      ? [{ host, scheme: "token", token: oauth.access }]
      : []),
    ...(typeof oauth.refresh === "string" &&
    oauth.refresh !== "" &&
    oauth.refresh !== oauth.access
      ? [{ host, scheme: "token", token: oauth.refresh }]
      : [])
  ];
};

/**
 * @param {string} home - Home directory.
 */
const ghCliCandidates = async (home) => {
  const hosts = await readJson(path.join(home, ".config", "gh", "hosts.json"));
  return Object.entries(hosts ?? {}).flatMap(([authority, value]) => {
    const entry = isRecord(value) ? value : {};
    const host = copilotApiHost(authority);
    return [
      ...(isRecord(entry.users)
        ? Object.values(entry.users)
            .filter(isRecord)
            .map((user) => user.oauth_token)
        : []),
      entry.oauth_token
    ]
      .filter((token) => typeof token === "string")
      .filter((token) => token !== "")
      .map((token) => ({ host, scheme: "token", token }));
  });
};

/**
 * @param {import("./types.ts").UsageOptions} options - Lookup options.
 * @param {string} home - Home directory.
 */
const keychainToken = (options, home) => {
  if (
    (options.platform ?? process.platform) !== "darwin" ||
    !(home === homedir() || options.execFile !== undefined)
  ) {
    return "";
  }
  try {
    return String(
      (options.execFile ?? execFileSync)(
        "security",
        ["find-generic-password", "-s", "copilot-cli", "-w"],
        {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 3000
        }
      )
    ).trim();
  } catch {
    return "";
  }
};

/**
 * @param {import("./types.ts").UsageOptions} options - Lookup options.
 * @param {string} credential - Explicit token.
 */
const copilotCandidates = async (options, credential) => {
  const home = options.home ?? homedir();
  const config = await readJson(
    path.join(home, ".copilot", "config.json"),
    true
  );
  const user = config?.lastLoggedInUser;
  const login =
    isRecord(user) && typeof user.login === "string" ? user.login : "";
  const tokens = config?.copilotTokens;
  const session =
    login !== "" && isRecord(tokens)
      ? tokens[`${GITHUB_COM}:${login}`]
      : undefined;
  const keychain = keychainToken(options, home);
  return [
    ...(credential === ""
      ? []
      : [{ host: COPILOT_API, scheme: "token", token: credential }]),
    ...candidateEnvironmentTokens(options.environment).map((token) => ({
      host: COPILOT_API,
      scheme: "token",
      token
    })),
    ...(typeof session === "string" && session !== ""
      ? [{ host: COPILOT_API, scheme: "Bearer", token: session }]
      : []),
    ...(keychain === ""
      ? []
      : [{ host: COPILOT_API, scheme: "token", token: keychain }]),
    ...(await intellijCandidates(home)),
    ...(await openCodeCopilotCandidates(home)),
    ...(await ghCliCandidates(home))
  ];
};

/**
 * @param {Record<string, unknown>} payload - Usage payload.
 * @param {number} now - Current time.
 */
const copilotReset = (payload, now) => {
  if (
    typeof payload.quota_reset_date_utc === "string" &&
    payload.quota_reset_date_utc !== ""
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

/**
 * @param {unknown} plan - Plan metadata.
 */
const planLabel = (plan) => {
  const name =
    typeof plan === "string" && COPILOT_PLANS.has(plan)
      ? plan.replaceAll("_", " ")
      : "";
  return name === "" ? "" : name.charAt(0).toUpperCase() + name.slice(1);
};

/**
 * @param {Record<string, unknown>} payload - Usage payload.
 */
const groupLabel = (payload) => {
  if (payload.access_type_sku === "free_limited_copilot") {
    return "Copilot (Free)";
  }
  const plan = planLabel(payload.copilot_plan);
  return plan === "" ? "" : `Copilot (${plan})`;
};

const QUOTA_METRICS = [
  ["Chat", "chat"],
  ["Completions", "completions"],
  ["Premium", "premium_interactions"]
];

/**
 * @param {string} label - Metric label.
 * @param {unknown} window - Quota payload.
 * @param {number} reset - Reset delay.
 */
const quotaMetric = (label, window, reset) => {
  const entitlement =
    isRecord(window) && isFiniteNumber(window.entitlement)
      ? window.entitlement
      : Number.NaN;
  const total = Math.max(0, entitlement);
  const record = isRecord(window) ? window : {};
  const remaining = isFiniteNumber(record.quota_remaining)
    ? record.quota_remaining
    : record.remaining;
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

/**
 * @param {string} label - Metric label.
 * @param {unknown} window - Quota payload.
 * @param {number} reset - Reset delay.
 */
/**
 * @param {Record<string, unknown>} payload - Usage payload.
 * @param {number} reset - Reset delay.
 * @param {number} [index] - Metric index.
 * @returns {import("./types.ts").Metric[]} Valid metrics.
 */
const quotaMetrics = (payload, reset, index = 0) => {
  if (index >= QUOTA_METRICS.length) {
    return [];
  }
  const [label, key] = QUOTA_METRICS[index];
  const metric = quotaMetric(
    label,
    isRecord(payload.quota_snapshots)
      ? payload.quota_snapshots[key]
      : undefined,
    reset
  );
  const rest = quotaMetrics(payload, reset, index + 1);
  return metric ? [metric, ...rest] : rest;
};

/**
 * @param {{host:string,scheme:string,token:string}[]} candidates - Ordered credentials.
 * @param {import("./types.ts").UsageOptions} options - Lookup options.
 * @param {number} [index] - Candidate index.
 * @returns {Promise<import("./types.ts").Snapshot|undefined|null>} Available usage.
 */
const fetchCandidate = async (candidates, options, index = 0) => {
  const candidate = candidates.at(index);
  if (candidate !== undefined) {
    const { status, payload } = await requestJson(
      `${copilotApiHost(candidate.host)}/copilot_internal/user`,
      {
        Accept: "application/vnd.github+json",
        Authorization: `${candidate.scheme} ${candidate.token}`,
        "Content-Type": "application/json",
        "User-Agent": "copilot",
        "X-GitHub-Api-Version": "2025-04-01"
      },
      options.fetch ?? globalThis.fetch,
      options.onUsageError
    );
    if (status === 401 || status === 403) {
      options.onUsageError?.();
      return await fetchCandidate(candidates, options, index + 1);
    }
    const successful =
      status !== undefined &&
      status >= 200 &&
      status < 300 &&
      payload !== undefined;
    if (successful && !isRecord(payload.quota_snapshots)) {
      options.onUsageError?.();
    }
    return successful && isRecord(payload.quota_snapshots)
      ? snapshot(
          quotaMetrics(payload, copilotReset(payload, nowValue(options.now))),
          groupLabel(payload)
        )
      : undefined;
  }
  return null;
};

/**
 * Fetch and normalize Copilot usage with credential fallback discovery.
 * @param {import("./types.ts").UsageOptions} [options] Input value.
 * @returns {Promise<import("./types.ts").Snapshot|undefined>} Result.
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
    if (seen.has(identity)) {
      return false;
    }
    seen.add(identity);
    return true;
  });
  return usable.length > 0
    ? await withUsageCache(
        "copilot",
        usable.map((candidate) => [
          candidate.token,
          copilotApiHost(candidate.host),
          candidate.scheme
        ]),
        options,
        async (cachedOptions) =>
          (await fetchCandidate(usable, cachedOptions)) ?? undefined
      )
    : undefined;
};
