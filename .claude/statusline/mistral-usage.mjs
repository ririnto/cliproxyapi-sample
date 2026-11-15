import { setTimeout as delay } from "node:timers/promises";

import { withUsageCache } from "./usage-cache.mjs";

const BUDGET_URL = "https://api.mistral.ai/v1/billing/budget";

/**
 * @param {unknown} value Value to validate.
 * @returns {value is import("./types.ts").JsonRecord} Whether the value has the required shape.
 */
const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * @param {unknown} value Value to validate.
 * @returns {value is number} Whether the value has the required shape.
 */
const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

/**
 * @param {unknown} value Current timestamp or Date.
 */
const nowValue = (value) => {
  if (value instanceof Date) {
    return value.getTime();
  }
  return isFiniteNumber(value) ? value : Date.now();
};

/**
 * @param {string} url Input value.
 * @param {Record<string, string>} headers Input value.
 * @param {import("./types.ts").Fetch} fetchFunction Input value.
 * @param {(() => void) | undefined} onUsageError Input value.
 * @returns {Promise<import("./types.ts").JsonRecord | null>} Validated record.
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
      typeof response.status === "number" &&
      Number.isFinite(response.status)
    ) {
      if (response.status >= 200 && response.status < 300) {
        try {
          /**
           * @type {unknown}
           */
          const payload = await response.json();
          if (isRecord(payload)) {
            return payload;
          }
          onUsageError?.();
        } catch {
          onUsageError?.();
        }
      } else {
        try {
          await Promise.race([
            response.body?.cancel(),
            delay(3000, undefined, { signal: controller.signal })
          ]);
        } catch {
          controller.abort();
        }
        controller.abort();
      }
    }
  } catch {
    controller.abort();
  } finally {
    clearTimeout(timeout);
  }
  return null;
};

/**
 * @param {string} label Budget label.
 * @param {unknown} budget Untrusted provider budget.
 * @param {number} now Current timestamp.
 * @returns {import("./types.ts").Metric | undefined} Normalized budget.
 */
const budgetMetric = (label, budget, now) => {
  const resetAt = Date.parse(
    isRecord(budget) && typeof budget.reset_at === "string"
      ? budget.reset_at
      : ""
  );
  return isRecord(budget) &&
    isFiniteNumber(budget.usage_percentage) &&
    budget.usage_percentage >= 0
    ? {
        label,
        percentage: budget.usage_percentage,
        resetsInMs: Number.isFinite(resetAt) ? Math.max(0, resetAt - now) : 0,
        type: "percentage"
      }
    : undefined;
};

/**
 * Fetch and normalize the Mistral API and Vibe budgets.
 * @param {import("./types.ts").UsageOptions} [options] Input value.
 * @returns {Promise<import("./types.ts").Snapshot|undefined>} Result.
 */
const fetchUsageUncached = async (options = {}) => {
  const credential =
    typeof options.credential === "string" ? options.credential : "";
  const budget = await requestJson(
    BUDGET_URL,
    { Authorization: `Bearer ${credential}` },
    options.fetch ?? globalThis.fetch,
    options.onUsageError
  );
  if (budget === null) {
    options.onUsageError?.();
  }
  const now = nowValue(options.now);
  const metrics =
    budget === null
      ? []
      : [
          budgetMetric("api", budget.api_budget, now),
          budgetMetric("vibe", budget.vibe_budget, now)
        ].filter((metric) => metric !== undefined);
  return metrics.length > 0
    ? { groups: [{ label: "Mistral", metrics }] }
    : undefined;
};

/**
 * 자격 증명별 영구 캐시를 사용해 Mistral 사용량을 조회합니다.
 * @param {import("./types.ts").UsageOptions} [options] 입력 옵션입니다.
 * @returns {Promise<import("./types.ts").Snapshot|undefined> | undefined} 사용량 스냅샷입니다.
 */
export const fetchUsage = (options = {}) => {
  const credential =
    typeof options.credential === "string" ? options.credential : "";
  return credential
    ? withUsageCache("mistral", credential, options, fetchUsageUncached)
    : undefined;
};
