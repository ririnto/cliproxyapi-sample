import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { withUsageCache } from "./usage-cache.mjs";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

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
      if (!isRecord(payload) || payload.error || payload.success === false) {
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

const readJson = async (filePath) => {
  try {
    const value = JSON.parse(await readFile(filePath, "utf-8"));
    return isRecord(value) ? value : undefined;
  } catch (error) {
    if (process.env.STATUSLINE_DEBUG) {
      console.error(`[codex-usage] unreadable ${filePath}`, error);
    }
  }
};

const secondsToMs = (value) =>
  isFiniteNumber(value) && value > 0
    ? Math.max(0, Math.trunc(value * 1000))
    : 0;

const percentageMetric = (label, percentage, resetsInMs) =>
  isFiniteNumber(percentage) && percentage >= 0 && percentage <= 100
    ? {
        label,
        percentage,
        resetsInMs: Math.max(0, resetsInMs || 0),
        type: "percentage"
      }
    : undefined;

const readChatgptAuth = (data) => {
  const tokens = data?.tokens;
  return isRecord(tokens) &&
    typeof tokens.access_token === "string" &&
    tokens.access_token
    ? {
        accountId:
          typeof tokens.account_id === "string" ? tokens.account_id : "",
        token: tokens.access_token
      }
    : undefined;
};

const readOpenCodeOpenAiAuth = (data) => {
  const tokens = data?.openai;
  return isRecord(tokens) && typeof tokens.access === "string" && tokens.access
    ? {
        accountId: typeof tokens.accountId === "string" ? tokens.accountId : "",
        token: tokens.access
      }
    : undefined;
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

const windowLabel = (seconds, fallback) => {
  if (
    typeof seconds !== "number" ||
    !Number.isFinite(seconds) ||
    seconds <= 0
  ) {
    return fallback;
  }
  if (seconds % 86_400 === 0) {
    return `${seconds / 86_400}d`;
  }
  return seconds % 3600 === 0 ? `${seconds / 3600}h` : fallback;
};

const chatgptWindow = (window, fallback) =>
  isRecord(window)
    ? percentageMetric(
        windowLabel(window.limit_window_seconds, fallback),
        window.used_percent,
        secondsToMs(window.reset_after_seconds)
      )
    : undefined;

const compactMetrics = (metrics, index = 0) => {
  if (index >= metrics.length) {
    return [];
  }
  const rest = compactMetrics(metrics, index + 1);
  return metrics[index] ? [metrics[index], ...rest] : rest;
};

const chatgptGroup = (rateLimit, label, credit) => {
  const metrics = compactMetrics(
    isRecord(rateLimit)
      ? [
          chatgptWindow(rateLimit.secondary_window, "5h"),
          chatgptWindow(rateLimit.primary_window, "7d"),
          credit
        ]
      : [credit]
  );
  return metrics.length ? { metrics, ...(label ? { label } : {}) } : undefined;
};

const chatgptCredit = (credits) => {
  if (!isRecord(credits) || credits.has_credits !== true) {
    return;
  }
  const { balance: creditBalance } = credits;
  let balance = Number.NaN;
  if (typeof creditBalance === "number") {
    balance = creditBalance;
  } else if (typeof creditBalance === "string" && creditBalance.trim()) {
    balance = Number(creditBalance);
  }
  return isFiniteNumber(balance) && balance > 0
    ? { label: "credit", remaining: balance, type: "credit" }
    : undefined;
};

const chatgptPlanLabel = (planType) => {
  const known = ["free", "plus", "pro", "team", "enterprise", "edu"];
  if (typeof planType !== "string" || !known.includes(planType)) {
    return "";
  }
  return planType.charAt(0).toUpperCase() + planType.slice(1);
};

const usageSnapshot = async (selected, options) => {
  const { payload } = await requestJson(
    USAGE_URL,
    {
      Authorization: `Bearer ${selected.token}`,
      "Content-Type": "application/json",
      "User-Agent": "codex",
      ...(selected.accountId
        ? { "ChatGPT-Account-ID": selected.accountId }
        : {})
    },
    fetchFunction(options),
    options.onUsageError
  );
  const plan = chatgptPlanLabel(payload?.plan_type);
  const groups = payload
    ? [
        chatgptGroup(
          payload.rate_limit,
          plan && `ChatGPT (${plan})`,
          chatgptCredit(payload.credits)
        ),
        ...(Array.isArray(payload.additional_rate_limits)
          ? payload.additional_rate_limits.filter(
              (limit) =>
                isRecord(limit) &&
                typeof limit.limit_name === "string" &&
                limit.limit_name
            )
          : []
        ).map((limit) =>
          chatgptGroup(
            limit.rate_limit,
            limit.limit_name === "gpt-5.3-codex-spark"
              ? "Additional"
              : limit.limit_name
          )
        )
      ].filter(Boolean)
    : [];
  return groups.length ? { groups } : undefined;
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
  return selected?.token
    ? withUsageCache(
        "chatgpt",
        { accountId: selected.accountId, token: selected.token },
        options,
        (fetchOptions) => usageSnapshot(selected, fetchOptions)
      )
    : undefined;
};
