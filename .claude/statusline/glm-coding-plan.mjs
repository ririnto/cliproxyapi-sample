const USAGE_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requestJson = async (url, headers, fetchFunction) => {
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
      return {
        payload: isRecord(payload) ? payload : undefined,
        status: response.status
      };
    } catch {
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

const percentageMetric = (label, percentage, resetsInMs) => {
  if (!isFiniteNumber(percentage) || percentage < 0 || percentage > 100) {
    return;
  }
  return {
    label,
    percentage,
    resetsInMs: Math.max(0, resetsInMs || 0),
    type: "percentage"
  };
};

const snapshot = (metrics, label) => {
  const validMetrics = metrics.filter(Boolean);
  if (!validMetrics.length) {
    return;
  }
  const group = { metrics: validMetrics };
  if (label) {
    group.label = label;
  }
  return { groups: [group] };
};

const TIER_LABELS = {
  lite: "Lite",
  max: "Max",
  pro: "Pro"
};

/**
 * Fetch and normalize Z.AI coding plan usage.
 * @param {object} [options] Input value.
 * @returns {Promise<object|undefined>} Result.
 */
export const fetchUsage = async (options = {}) => {
  const credential =
    typeof options.credential === "string" ? options.credential : "";
  if (typeof credential !== "string" || !credential) {
    return;
  }
  const response = await requestJson(
    USAGE_URL,
    {
      Authorization: `Bearer ${credential}`,
      "Content-Type": "application/json"
    },
    fetchFunction(options)
  );
  const { payload } = response;
  if (
    !payload?.success ||
    !isRecord(payload.data) ||
    !Array.isArray(payload.data.limits)
  ) {
    return;
  }
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
  return snapshot(metrics, label ? `Z.AI (${label})` : undefined);
};
