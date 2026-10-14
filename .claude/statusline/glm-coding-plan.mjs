const USAGE_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeResponse = async (response) => {
  try {
    const payload = await response.json();
    return {
      payload: isRecord(payload) ? payload : undefined,
      status: response.status
    };
  } catch {
    return { status: response.status };
  }
};

const requestJson = async (url, headers, fetchFunction) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  let response;
  let result;
  try {
    response = await fetchFunction(url, {
      headers,
      method: "GET",
      signal: controller.signal
    });
    if (
      !response ||
      typeof response.status !== "number" ||
      !Number.isFinite(response.status)
    ) {
      result = { status: undefined };
    } else if (response.status < 200 || response.status >= 300) {
      result = { status: response.status };
    } else {
      result = await decodeResponse(response);
    }
  } catch {
    result = { status: undefined };
  } finally {
    controller.abort();
    clearTimeout(timeout);
    if (response?.body && !response.bodyUsed) {
      await response.body.cancel().catch(() => null);
    }
  }
  return result;
};

const fetchFunction = (options) => options.fetch ?? globalThis.fetch;

const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

const nowValue = (value) => {
  let now;
  if (value instanceof Date) {
    now = value.getTime();
  } else if (isFiniteNumber(value)) {
    now = value;
  } else {
    now = Date.now();
  }
  return now;
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
  const group = validMetrics.length ? { metrics: validMetrics } : undefined;
  if (group && label) {
    group.label = label;
  }
  return group ? { groups: [group] } : undefined;
};

const TIER_LABELS = {
  lite: "Lite",
  max: "Max",
  pro: "Pro"
};

const normalizeGlm = (payload, options) => {
  let result;
  if (
    payload?.success &&
    isRecord(payload.data) &&
    Array.isArray(payload.data.limits)
  ) {
    const now = nowValue(options.now);
    const metrics = payload.data.limits
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
    const { level } = payload.data;
    const label =
      typeof level === "string" ? TIER_LABELS[level.toLowerCase()] : undefined;
    result = snapshot(metrics, label ? `Z.AI (${label})` : undefined);
  }
  return result;
};

/**
 * Fetch Z.AI coding-plan quotas with a supplied token and normalize percentages.
 * Only five-hour and weekly token/credit limits with valid percentages are kept.
 * Missing credentials, network/HTTP/decoding failures, unsuccessful responses,
 * and snapshots without valid metrics produce no result.
 * @param {object} [options] Credential string, fetch override, and current time
 * as a Date or milliseconds for computing reset intervals.
 * @returns {Promise<object|undefined>} Normalized quota groups with an optional tier
 * label, or undefined when no usable quota is available.
 */
export const fetchUsage = async (options = {}) => {
  const credential =
    typeof options.credential === "string" ? options.credential : "";
  const response =
    typeof credential === "string" && credential
      ? await requestJson(
          USAGE_URL,
          {
            Authorization: `Bearer ${credential}`,
            "Content-Type": "application/json"
          },
          fetchFunction(options)
        )
      : undefined;
  return response ? normalizeGlm(response.payload, options) : undefined;
};
