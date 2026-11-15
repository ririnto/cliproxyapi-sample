import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { withUsageCache } from "./usage-cache.mjs";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/**
 * @param {unknown} value Value to validate.
 * @returns {value is import("./types.ts").JsonRecord} Whether the value has the required shape.
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
      if (
        !isRecord(payload) ||
        Boolean(payload.error) ||
        payload.success === false
      ) {
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
 * @returns {value is number} Whether the value has the required shape.
 */
const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

/**
 * @param {string} filePath Auth file.
 */
const readJson = async (filePath) => {
  try {
    /**
     * @type {unknown}
     */
    const value = JSON.parse(await readFile(filePath, "utf-8"));
    return isRecord(value) ? value : null;
  } catch {
    if ((process.env.STATUSLINE_DEBUG ?? "") !== "") {
      console.error("[codex-usage] unreadable credential data");
    }
    return null;
  }
};

/**
 * @param {unknown} value Seconds.
 */
const secondsToMs = (value) =>
  isFiniteNumber(value) && value > 0
    ? Math.max(0, Math.trunc(value * 1000))
    : 0;

/**
 * @param {string} label Window.
 * @param {unknown} percentage Usage.
 * @param {number} resetsInMs Delay.
 * @returns {import("./types.ts").Metric | undefined} Metric.
 */
const percentageMetric = (label, percentage, resetsInMs) =>
  isFiniteNumber(percentage) && percentage >= 0 && percentage <= 100
    ? {
        label,
        percentage,
        resetsInMs: Math.max(0, resetsInMs || 0),
        type: "percentage"
      }
    : undefined;

/**
 * @param {unknown} data Untrusted auth.
 */
const readChatgptAuth = (data) => {
  const tokens = isRecord(data) ? data.tokens : undefined;
  return isRecord(tokens) &&
    typeof tokens.access_token === "string" &&
    tokens.access_token !== ""
    ? {
        accountId:
          typeof tokens.account_id === "string" ? tokens.account_id : "",
        token: tokens.access_token
      }
    : undefined;
};

/**
 * @param {unknown} data Untrusted auth.
 */
const readOpenCodeOpenAiAuth = (data) => {
  const tokens = isRecord(data) ? data.openai : undefined;
  return isRecord(tokens) &&
    typeof tokens.access === "string" &&
    tokens.access !== ""
    ? {
        accountId: typeof tokens.accountId === "string" ? tokens.accountId : "",
        token: tokens.access
      }
    : undefined;
};

/**
 * @param {import("./types.ts").UsageOptions} options Auth options.
 */
const chatgptAuth = async (options) => {
  const home = options.home ?? homedir();
  const codex = readChatgptAuth(
    await readJson(path.join(home, ".codex", "auth.json"))
  );
  const openCode = readOpenCodeOpenAiAuth(
    await readJson(path.join(home, ".local", "share", "opencode", "auth.json"))
  );
  return {
    accountId:
      (codex?.accountId ?? "") === ""
        ? (openCode?.accountId ?? "")
        : (codex?.accountId ?? ""),
    codex,
    openCode
  };
};

/**
 * @param {unknown} seconds Window length.
 * @param {string} fallback Default.
 */
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

/**
 * @param {unknown} window Untrusted window.
 * @param {string} fallback Default label.
 */
const chatgptWindow = (window, fallback) =>
  isRecord(window)
    ? percentageMetric(
        windowLabel(window.limit_window_seconds, fallback),
        window.used_percent,
        secondsToMs(window.reset_after_seconds)
      )
    : undefined;

/**
 * @param {unknown} rateLimit Untrusted limit.
 * @param {string} label Label.
 * @param {import("./types.ts").Metric} [credit] Credit.
 */
const chatgptGroup = (rateLimit, label, credit) => {
  const metrics = (
    isRecord(rateLimit)
      ? [
          chatgptWindow(rateLimit.secondary_window, "5h"),
          chatgptWindow(rateLimit.primary_window, "7d"),
          credit
        ]
      : [credit]
  ).filter((metric) => metric !== undefined);
  return metrics.length
    ? { metrics, ...(label === "" ? {} : { label }) }
    : undefined;
};

/**
 * @param {unknown} credits Untrusted balance.
 * @returns {import("./types.ts").Metric | undefined} Metric.
 */
const chatgptCredit = (credits) => {
  const creditBalance =
    isRecord(credits) && credits.has_credits === true
      ? credits.balance
      : undefined;
  const balance =
    typeof creditBalance === "number" ||
    (typeof creditBalance === "string" && creditBalance.trim() !== "")
      ? Number(creditBalance)
      : Number.NaN;
  return isFiniteNumber(balance) && balance > 0
    ? { label: "credit", remaining: balance, type: "credit" }
    : undefined;
};

/**
 * @param {unknown} planType Untrusted plan.
 */
const chatgptPlanLabel = (planType) => {
  if (
    typeof planType !== "string" ||
    !["free", "plus", "pro", "team", "enterprise", "edu"].includes(planType)
  ) {
    return "";
  }
  return planType.charAt(0).toUpperCase() + planType.slice(1);
};

/**
 * @param {{ token: string, accountId: string }} selected Auth.
 * @param {import("./types.ts").UsageOptions} options Options.
 */
const usageSnapshot = async (selected, options) => {
  const { payload } = await requestJson(
    USAGE_URL,
    {
      Authorization: `Bearer ${selected.token}`,
      "Content-Type": "application/json",
      "User-Agent": "codex",
      ...(selected.accountId === ""
        ? {}
        : { "ChatGPT-Account-ID": selected.accountId })
    },
    options.fetch ?? globalThis.fetch,
    options.onUsageError
  );
  const plan = chatgptPlanLabel(payload?.plan_type);
  const groups = payload
    ? [
        chatgptGroup(
          payload.rate_limit,
          plan === "" ? "" : `ChatGPT (${plan})`,
          chatgptCredit(payload.credits)
        ),
        ...(Array.isArray(payload.additional_rate_limits)
          ? payload.additional_rate_limits
              .filter(isRecord)
              .filter(
                (limit) =>
                  isRecord(limit) &&
                  typeof limit.limit_name === "string" &&
                  limit.limit_name !== ""
              )
          : []
        ).map((limit) => {
          const label =
            typeof limit.limit_name === "string" ? limit.limit_name : "";
          return chatgptGroup(
            limit.rate_limit,
            limit.limit_name === "gpt-5.3-codex-spark" ? "Additional" : label
          );
        })
      ].filter((group) => group !== undefined)
    : [];
  return groups.length ? { groups } : undefined;
};

/**
 * Fetch and normalize ChatGPT Codex usage with local auth fallback.
 * @param {import("./types.ts").UsageOptions} [options] Input value.
 * @returns {Promise<import("./types.ts").Snapshot|undefined>} Result.
 */
export const fetchUsage = async (options = {}) => {
  const auth = await chatgptAuth(options);
  const explicit =
    typeof options.credential === "string" && options.credential !== ""
      ? options.credential
      : "";
  const selected = explicit
    ? { accountId: auth.accountId, token: explicit }
    : (auth.codex ?? auth.openCode);
  return selected !== undefined && selected.token !== ""
    ? await withUsageCache(
        "chatgpt",
        { accountId: selected.accountId, token: selected.token },
        options,
        async (fetchOptions) => await usageSnapshot(selected, fetchOptions)
      )
    : undefined;
};
