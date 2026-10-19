import { setTimeout as delay } from "node:timers/promises";

import { withUsageCache } from "./usage-cache.mjs";

const USAGE_URL =
  "https://api.minimax.io/v1/api/openplatform/coding_plan/remains";

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

const fetchFunction = (options) => options.fetch ?? globalThis.fetch;

const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

const compactMetrics = (metrics, index = 0) => {
  if (index >= metrics.length) {
    return [];
  }
  const rest = compactMetrics(metrics, index + 1);
  return metrics[index] ? [metrics[index], ...rest] : rest;
};

const snapshot = (metrics, label) => {
  const validMetrics = compactMetrics(metrics);
  const group = label
    ? { label, metrics: validMetrics }
    : { metrics: validMetrics };
  return validMetrics.length ? { groups: [group] } : undefined;
};

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
 * @param {object} [options] Input value.
 * @returns {Promise<object|undefined>} Result.
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
        fetchFunction(options),
        options.onUsageError
      )
    : {};
  if (
    payload?.base_resp?.status_code !== 0 ||
    !Array.isArray(payload.model_remains)
  ) {
    options.onUsageError?.();
    return;
  }
  const model = payload.model_remains.find(
    (entry) => isRecord(entry) && entry.model_name === "MiniMax-M*"
  );
  return model ? usageSnapshot(model) : undefined;
};

/**
 * 자격 증명별 영구 캐시를 사용해 MiniMax 사용량을 조회합니다.
 * @param {object} [options] 입력 옵션입니다.
 * @returns {Promise<object|undefined>} 사용량 스냅샷입니다.
 */
export const fetchUsage = (options = {}) => {
  const credential =
    typeof options.credential === "string" ? options.credential : "";
  return credential
    ? withUsageCache("minimax", credential, options, (cachedOptions) =>
        fetchUsageUncached(cachedOptions)
      )
    : undefined;
};
