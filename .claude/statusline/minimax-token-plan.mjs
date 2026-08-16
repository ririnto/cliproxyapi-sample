const USAGE_URL =
  "https://api.minimax.io/v1/api/openplatform/coding_plan/remains";

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

const usageMetric = (label, used, total, resetsInMs) => {
  if (
    !isFiniteNumber(used) ||
    !isFiniteNumber(total) ||
    used < 0 ||
    total < 0
  ) {
    return;
  }
  return {
    label,
    resetsInMs: Math.max(0, resetsInMs || 0),
    total,
    type: "usage",
    used
  };
};

/**
 * Fetch and normalize MiniMax coding plan usage.
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
    payload?.base_resp?.status_code !== 0 ||
    !Array.isArray(payload.model_remains)
  ) {
    return;
  }
  const model = payload.model_remains.find(
    (entry) => isRecord(entry) && entry.model_name === "MiniMax-M*"
  );
  if (!model) {
    return;
  }
  const intervalTotal = isFiniteNumber(model.current_interval_total_count)
    ? Math.max(0, model.current_interval_total_count)
    : 0;
  const intervalRemaining = isFiniteNumber(model.current_interval_usage_count)
    ? model.current_interval_usage_count
    : 0;
  const weeklyTotal = isFiniteNumber(model.current_weekly_total_count)
    ? Math.max(0, model.current_weekly_total_count)
    : 0;
  const weeklyRemaining = isFiniteNumber(model.current_weekly_usage_count)
    ? model.current_weekly_usage_count
    : 0;
  return snapshot([
    usageMetric(
      "5h",
      Math.max(0, intervalTotal - intervalRemaining),
      intervalTotal,
      isFiniteNumber(model.remains_time) ? Math.max(0, model.remains_time) : 0
    ),
    usageMetric(
      "7d",
      Math.max(0, weeklyTotal - weeklyRemaining),
      weeklyTotal,
      isFiniteNumber(model.weekly_remains_time)
        ? Math.max(0, model.weekly_remains_time)
        : 0
    )
  ]);
};
