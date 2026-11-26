import { setTimeout as delay } from "node:timers/promises";

const BUDGET_URL = "https://api.mistral.ai/v1/billing/budget";

/**
 * @param {unknown} value Value to validate.
 * @returns {value is import("./types.ts").JsonRecord} Whether the value has the required shape.
 */
const isRecord = (value: unknown): value is import("./types.ts").JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * @param {unknown} value Value to validate.
 * @returns {value is number} Whether the value has the required shape.
 */
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * @param {unknown} value Current timestamp or Date.
 */
const nowValue = (value: unknown) => {
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
const requestJson = async (
  url: string,
  headers: Record<string, string>,
  fetchFunction: import("./types.ts").Fetch,
  onUsageError: (() => void) | undefined
): Promise<import("./types.ts").JsonRecord | null> => {
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
          const payload: unknown = await response.json();
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
const budgetMetric = (
  label: string,
  budget: unknown,
  now: number
): import("./types.ts").Metric | undefined => {
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
const fetchUsageUncached = async (
  options: import("./types.ts").UsageOptions = {}
): Promise<import("./types.ts").Snapshot | undefined> => {
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
 * @param {import("./types.ts").UsageOptions} options Lookup options.
 * @param {Pick<import("./types.ts").UsageRuntime, "withUsageCache">} runtime Host-provided usage helpers.
 * @returns {Promise<import("./types.ts").Snapshot | undefined> | undefined} Usage when a credential is available.
 */
export const fetchUsage = (
  options: import("./types.ts").UsageOptions,
  { withUsageCache }: Pick<import("./types.ts").UsageRuntime, "withUsageCache">
): Promise<import("./types.ts").Snapshot | undefined> | undefined => {
  const credential =
    typeof options.credential === "string" ? options.credential : "";
  return credential
    ? withUsageCache("mistral", credential, options, fetchUsageUncached)
    : undefined;
};
