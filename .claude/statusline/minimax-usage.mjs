const USAGE_URL =
  "https://api.minimax.io/v1/api/openplatform/coding_plan/remains";

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
 * @param {(import("./types.ts").Metric | undefined)[]} metrics Values.
 * @param {string} [label] Tier label.
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
 * @param {string} label Window.
 * @param {unknown} used Usage.
 * @param {unknown} total Total.
 * @param {number} resetsInMs Reset delay.
 * @returns {import("./types.ts").Metric | undefined} Normalized metric.
 */
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

/**
 * @param {import("./types.ts").JsonRecord} model Valid model record.
 */
const usageSnapshot = (model) => {
  const intervalTotal = isFiniteNumber(model.current_interval_total_count)
    ? Math.max(0, model.current_interval_total_count)
    : 0;
  const weeklyTotal = isFiniteNumber(model.current_weekly_total_count)
    ? Math.max(0, model.current_weekly_total_count)
    : 0;
  return snapshot([
    usageMetric(
      "5h",
      Math.max(
        0,
        intervalTotal -
          (isFiniteNumber(model.current_interval_usage_count)
            ? model.current_interval_usage_count
            : 0)
      ),
      intervalTotal,
      isFiniteNumber(model.remains_time) ? Math.max(0, model.remains_time) : 0
    ),
    usageMetric(
      "7d",
      Math.max(
        0,
        weeklyTotal -
          (isFiniteNumber(model.current_weekly_usage_count)
            ? model.current_weekly_usage_count
            : 0)
      ),
      weeklyTotal,
      isFiniteNumber(model.weekly_remains_time)
        ? Math.max(0, model.weekly_remains_time)
        : 0
    )
  ]);
};

/**
 * Fetch and normalize MiniMax coding plan usage.
 * @param {import("./types.ts").UsageOptions} options Input value.
 * @returns {Promise<import("./types.ts").Snapshot|undefined>} Result.
 * @param {import("./types.ts").UsageRuntime["requestJson"]} requestJson Host HTTP transport.
 */
const fetchUsageUncached = async (options, requestJson) => {
  const credential =
    typeof options.credential === "string" ? options.credential : "";
  const { payload } = credential
    ? await requestJson(
        USAGE_URL,
        {
          Authorization: `Bearer ${credential}`,
          "Content-Type": "application/json"
        },
        options.fetch ?? globalThis.fetch,
        options.onUsageError
      )
    : {};
  /**
   * @type {unknown[] | null}
   */
  const entries =
    payload !== undefined &&
    isRecord(payload.base_resp) &&
    payload.base_resp.status_code === 0 &&
    Array.isArray(payload.model_remains)
      ? payload.model_remains
      : null;
  if (entries === null) {
    options.onUsageError?.();
  }
  const model = entries
    ?.filter(isRecord)
    .find((entry) => entry.model_name === "MiniMax-M*");
  return model === undefined ? undefined : usageSnapshot(model);
};

/**
 * @param {import("./types.ts").UsageOptions} options Lookup options.
 * @param {import("./types.ts").UsageRuntime} runtime Host-provided usage helpers.
 */
export const fetchUsage = async (options, { withUsageCache, requestJson }) => {
  const credential =
    typeof options.credential === "string" ? options.credential : "";
  return credential
    ? await withUsageCache(
        "minimax",
        credential,
        options,
        async (cachedOptions) =>
          await fetchUsageUncached(cachedOptions, requestJson)
      )
    : undefined;
};
