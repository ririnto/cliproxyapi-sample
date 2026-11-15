import { setTimeout as delay } from "node:timers/promises";

import { withUsageCache } from "./usage-cache.mjs";

const USAGE_URL =
  "https://api.minimax.io/v1/api/openplatform/coding_plan/remains";

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
 * @param {import("./types.ts").UsageOptions} [options] Input value.
 * @returns {Promise<import("./types.ts").Snapshot|undefined>} Result.
 */
const fetchUsageUncached = async (options = {}) => {
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
 * 자격 증명별 영구 캐시를 사용해 MiniMax 사용량을 조회합니다.
 * @param {import("./types.ts").UsageOptions} [options] 입력 옵션입니다.
 * @returns {Promise<import("./types.ts").Snapshot|undefined>} 사용량 스냅샷입니다.
 */
export const fetchUsage = async (options = {}) => {
  const credential =
    typeof options.credential === "string" ? options.credential : "";
  return credential
    ? await withUsageCache("minimax", credential, options, fetchUsageUncached)
    : undefined;
};
