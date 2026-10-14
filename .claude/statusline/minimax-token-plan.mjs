const USAGE_URL =
  "https://api.minimax.io/v1/api/openplatform/coding_plan/remains";

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

const snapshot = (metrics, label) => {
  const validMetrics = metrics.filter(Boolean);
  const group = validMetrics.length ? { metrics: validMetrics } : undefined;
  if (group && label) {
    group.label = label;
  }
  return group ? { groups: [group] } : undefined;
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

const normalizeMiniMax = (payload) => {
  const model =
    payload?.base_resp?.status_code === 0 &&
    Array.isArray(payload.model_remains)
      ? payload.model_remains.find(
          (entry) => isRecord(entry) && entry.model_name === "MiniMax-M*"
        )
      : undefined;
  let result;
  if (model) {
    const intervalTotal = isFiniteNumber(model.current_interval_total_count)
      ? Math.max(0, model.current_interval_total_count)
      : 0;
    const weeklyTotal = isFiniteNumber(model.current_weekly_total_count)
      ? Math.max(0, model.current_weekly_total_count)
      : 0;
    result = snapshot([
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
  }
  return result;
};

/**
 * Fetch MiniMax-M* coding-plan totals and remaining usage with a supplied token.
 * Network, HTTP, and decoding failures, unsuccessful responses, missing model
 * data, and snapshots without valid metrics produce no result.
 * @param {object} [options] Credential string and optional fetch override.
 * @returns {Promise<object|undefined>} Valid five-hour and weekly usage metrics,
 * or undefined when the credential or usage data is unavailable.
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
  return response ? normalizeMiniMax(response.payload) : undefined;
};
