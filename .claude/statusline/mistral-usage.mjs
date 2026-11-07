import { setTimeout as delay } from "node:timers/promises";

import { withUsageCache } from "./usage-cache.mjs";

const BUDGET_URL = "https://api.mistral.ai/v1/billing/budget";

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

const nowValue = (value) => {
  if (value instanceof Date) {
    return value.getTime();
  }
  return isFiniteNumber(value) ? value : Date.now();
};

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
      response &&
      typeof response.status === "number" &&
      Number.isFinite(response.status)
    ) {
      if (response.status >= 200 && response.status < 300) {
        try {
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
};

const budgetMetric = (label, budget, now) => {
  if (
    !isRecord(budget) ||
    !isFiniteNumber(budget.usage_percentage) ||
    budget.usage_percentage < 0
  ) {
    return;
  }
  const resetAt = Date.parse(budget.reset_at);
  return {
    label,
    percentage: budget.usage_percentage,
    resetsInMs: Number.isFinite(resetAt) ? Math.max(0, resetAt - now) : 0,
    type: "percentage"
  };
};

/**
 * Fetch and normalize the Mistral API and Vibe budgets.
 * @param {object} [options] Input value.
 * @returns {Promise<object|undefined>} Result.
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
  if (!budget) {
    options.onUsageError?.();
    return;
  }
  const now = nowValue(options.now);
  const metrics = [
    budgetMetric("api", budget.api_budget, now),
    budgetMetric("vibe", budget.vibe_budget, now)
  ].filter(Boolean);
  return metrics.length
    ? { groups: [{ label: "Mistral", metrics }] }
    : undefined;
};

/**
 * 자격 증명별 영구 캐시를 사용해 Mistral 사용량을 조회합니다.
 * @param {object} [options] 입력 옵션입니다.
 * @returns {Promise<object|undefined>} 사용량 스냅샷입니다.
 */
export const fetchUsage = (options = {}) => {
  const credential =
    typeof options.credential === "string" ? options.credential : "";
  return credential
    ? withUsageCache("mistral", credential, options, (cachedOptions) =>
        fetchUsageUncached(cachedOptions)
      )
    : undefined;
};
