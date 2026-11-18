import { setTimeout as delay } from "node:timers/promises";

/**
 * @param {unknown} value Value to validate.
 * @returns {value is import("./types.ts").JsonRecord} Whether the value has the required shape.
 */
const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Read a quota response and keep its status for credential fallback.
 * @param {string} url Provider endpoint.
 * @param {Record<string, string>} headers Provider request headers.
 * @param {import("./types.ts").Fetch} fetchFunction HTTP transport.
 * @param {(() => void) | undefined} onUsageError Notify the cache when a successful response contains invalid JSON or a non-object payload.
 */
export const requestJson = async (
  url,
  headers,
  fetchFunction,
  onUsageError
) => {
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
    if (!Number.isFinite(response.status)) {
      return { status: undefined };
    }
    if (response.status < 200 || response.status >= 300) {
      try {
        await Promise.race([
          response.body?.cancel(),
          delay(3000, undefined, { signal: controller.signal })
        ]);
      } catch {
        // A closed body can reject cancellation. Preserve the HTTP status for fallback.
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
