import { withUsageCache } from "./usage-cache.mjs";

const USAGE_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

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

const nowValue = (value) => {
  if (value instanceof Date) {
    return value.getTime();
  }
  return isFiniteNumber(value) ? value : Date.now();
};

const resetAfter = (timestamp, now) =>
  isFiniteNumber(timestamp) && timestamp > 0
    ? Math.max(0, Math.trunc(timestamp - now))
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

const snapshot = (metrics, label) => {
  const validMetrics = metrics.filter(Boolean);
  const group = label
    ? { label, metrics: validMetrics }
    : { metrics: validMetrics };
  return validMetrics.length ? { groups: [group] } : undefined;
};

const TIER_LABELS = {
  lite: "Lite",
  max: "Max",
  pro: "Pro"
};

const fetchUsageData = async (credential, options) => {
  const { payload } = await requestJson(
    USAGE_URL,
    {
      Authorization: `Bearer ${credential}`,
      "Content-Type": "application/json"
    },
    fetchFunction(options),
    options.onUsageError
  );
  if (
    !payload?.success ||
    !isRecord(payload.data) ||
    !Array.isArray(payload.data.limits)
  ) {
    options.onUsageError?.();
    return;
  }
  const { limits } = payload.data;
  const now = nowValue(options.now);
  const metrics = limits
    .filter(
      (limit) =>
        isRecord(limit) &&
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
    )
    .filter(Boolean);
  const level =
    typeof payload?.data?.level === "string"
      ? TIER_LABELS[payload.data.level.toLowerCase()]
      : undefined;
  return snapshot(metrics, level ? `Z.AI (${level})` : undefined);
};

/**
 * Fetch and normalize Z.AI coding plan usage.
 * @param {object} [options] Input value.
 * @returns {Promise<object|undefined>} Result.
 */
export const fetchUsage = (options = {}) => {
  const credential =
    typeof options.credential === "string" ? options.credential : "";
  return credential
    ? withUsageCache("zai", credential, options, (cachedOptions) =>
        fetchUsageData(credential, cachedOptions)
      )
    : Promise.resolve();
};
