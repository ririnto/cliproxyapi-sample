import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

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

const readJson = async (filePath) => {
  try {
    const value = JSON.parse(await readFile(filePath, "utf-8"));
    return isRecord(value) ? value : undefined;
  } catch {
    // Return undefined when local authentication data is unreadable.
  }
};

const secondsToMs = (value) =>
  isFiniteNumber(value) && value > 0
    ? Math.max(0, Math.trunc(value * 1000))
    : 0;

const percentageMetric = (label, percentage, resetsInMs) => {
  if (!isFiniteNumber(percentage) || percentage < 0 || percentage > 100) {
    return;
  }
  return {
    label,
    percentage,
    resetsInMs: Math.max(0, resetsInMs || 0),
    type: "percentage"
  };
};

const readChatgptAuth = (data) => {
  const tokens = data?.tokens;
  if (
    isRecord(tokens) &&
    typeof tokens.access_token === "string" &&
    tokens.access_token
  ) {
    return {
      accountId: typeof tokens.account_id === "string" ? tokens.account_id : "",
      token: tokens.access_token
    };
  }
};

const readOpenCodeOpenAiAuth = (data) => {
  const tokens = data?.openai;
  if (isRecord(tokens) && typeof tokens.access === "string" && tokens.access) {
    return {
      accountId: typeof tokens.accountId === "string" ? tokens.accountId : "",
      token: tokens.access
    };
  }
};

const chatgptAuth = async (options) => {
  const home = options.home ?? homedir();
  const codex = readChatgptAuth(
    await readJson(path.join(home, ".codex", "auth.json"))
  );
  const openCode = readOpenCodeOpenAiAuth(
    await readJson(path.join(home, ".local", "share", "opencode", "auth.json"))
  );
  return {
    accountId: codex?.accountId || openCode?.accountId || "",
    codex,
    openCode
  };
};

const chatgptWindow = (window, fallback) => {
  if (!isRecord(window)) {
    return;
  }
  const percentage = window.used_percent;
  const reset = secondsToMs(window.reset_after_seconds);
  const seconds = window.limit_window_seconds;
  let label = fallback;
  if (
    typeof seconds === "number" &&
    Number.isFinite(seconds) &&
    seconds > 0 &&
    seconds % 86_400 === 0
  ) {
    label = `${seconds / 86_400}d`;
  } else if (
    typeof seconds === "number" &&
    Number.isFinite(seconds) &&
    seconds > 0 &&
    seconds % 3600 === 0
  ) {
    label = `${seconds / 3600}h`;
  }
  return percentageMetric(label, percentage, reset);
};

const chatgptGroup = (rateLimit, label) => {
  if (!isRecord(rateLimit)) {
    return;
  }
  const metrics = [
    chatgptWindow(rateLimit.secondary_window, "5h"),
    chatgptWindow(rateLimit.primary_window, "7d")
  ];
  const validMetrics = metrics.filter(Boolean);
  if (!validMetrics.length) {
    return;
  }
  const group = { metrics: validMetrics };
  if (label) {
    group.label = label;
  }
  return group;
};

/**
 * Fetch and normalize ChatGPT Codex usage with local auth fallback.
 * @param {object} [options] Input value.
 * @returns {Promise<object|undefined>} Result.
 */
export const fetchUsage = async (options = {}) => {
  const auth = await chatgptAuth(options);
  const explicit =
    typeof options.credential === "string" && options.credential
      ? options.credential
      : "";
  const selected = explicit
    ? { accountId: auth.accountId, token: explicit }
    : (auth.codex ?? auth.openCode);
  if (!selected?.token) {
    return;
  }
  const headers = {
    Authorization: `Bearer ${selected.token}`,
    "Content-Type": "application/json",
    "User-Agent": "codex"
  };
  if (selected.accountId) {
    headers["ChatGPT-Account-ID"] = selected.accountId;
  }
  const response = await requestJson(
    USAGE_URL,
    headers,
    fetchFunction(options)
  );
  const { payload } = response;
  if (!payload) {
    return;
  }
  const groups = [];
  const primary = chatgptGroup(payload.rate_limit);
  if (primary) {
    groups.push(primary);
  }
  if (Array.isArray(payload.additional_rate_limits)) {
    for (const limit of payload.additional_rate_limits) {
      if (
        !isRecord(limit) ||
        typeof limit.limit_name !== "string" ||
        !limit.limit_name
      ) {
        continue;
      }
      const group = chatgptGroup(limit.rate_limit, limit.limit_name);
      if (group) {
        groups.push(group);
      }
    }
  }
  return groups.length ? { groups } : undefined;
};
