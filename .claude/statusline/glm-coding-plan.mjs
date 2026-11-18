import { withUsageCache } from "./usage-cache.mjs";
import { requestJson } from "./usage-http.mjs";

const USAGE_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

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
 * @param {unknown} value Current timestamp.
 */
const nowValue = (value) => {
  if (value instanceof Date) {
    return value.getTime();
  }
  return isFiniteNumber(value) ? value : Date.now();
};

/**
 * @param {unknown} timestamp Reset time.
 * @param {number} now Current time.
 */
const resetAfter = (timestamp, now) =>
  isFiniteNumber(timestamp) && timestamp > 0
    ? Math.max(0, Math.trunc(timestamp - now))
    : 0;

/**
 * @param {string} label Window.
 * @param {unknown} percentage Usage percentage.
 * @param {number} resetsInMs Reset delay.
 * @returns {import("./types.ts").Metric | undefined} Normalized metric.
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
 * @param {(import("./types.ts").Metric | undefined)[]} metrics Values.
 * @param {string | undefined} label Tier label.
 */
const snapshot = (metrics, label) => {
  const validMetrics = metrics.filter((metric) => metric !== undefined);
  return validMetrics.length
    ? {
        groups: [
          label !== undefined && label !== ""
            ? { label, metrics: validMetrics }
            : { metrics: validMetrics }
        ]
      }
    : undefined;
};

/**
 * @type {Record<string, string>}
 */
const TIER_LABELS = {
  lite: "Lite",
  max: "Max",
  pro: "Pro"
};

/**
 * @param {string} credential API token.
 * @param {import("./types.ts").UsageOptions} options Request options.
 */
const fetchUsageData = async (credential, options) => {
  const { payload } = await requestJson(
    USAGE_URL,
    {
      Authorization: `Bearer ${credential}`,
      "Content-Type": "application/json"
    },
    options.fetch ?? globalThis.fetch,
    options.onUsageError
  );
  const data = isRecord(payload?.data) ? payload.data : null;
  const successful = Boolean(payload?.success);
  /**
   * @type {unknown[] | null}
   */
  const limits = successful && Array.isArray(data?.limits) ? data.limits : null;
  if (limits === null) {
    options.onUsageError?.();
  }
  const now = nowValue(options.now);
  const metrics = (limits ?? [])
    .filter(isRecord)
    .filter(
      (limit) =>
        (limit.type === "TOKENS_LIMIT" || limit.type === "CREDIT_LIMIT") &&
        ((limit.unit === 3 && limit.number === 5) ||
          (limit.unit === 6 && limit.number === 1))
    )
    .map((limit) =>
      percentageMetric(
        limit.unit === 3 ? "5h" : "7d",
        limit.percentage,
        resetAfter(limit.nextResetTime, now)
      )
    );
  const level =
    typeof data?.level === "string"
      ? TIER_LABELS[data.level.toLowerCase()]
      : undefined;
  return snapshot(
    metrics,
    level === undefined || level === "" ? undefined : `Z.AI (${level})`
  );
};

/**
 * Fetch and normalize Z.AI coding plan usage.
 * @param {import("./types.ts").UsageOptions} [options] Input value.
 * @returns {Promise<import("./types.ts").Snapshot|undefined>} Result.
 */
export const fetchUsage = async (options = {}) => {
  const credential =
    typeof options.credential === "string" ? options.credential : "";
  return credential
    ? await withUsageCache(
        "zai",
        credential,
        options,
        async (cachedOptions) => await fetchUsageData(credential, cachedOptions)
      )
    : undefined;
};
