import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

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

const readJson = async (filePath) => {
  try {
    const value = JSON.parse(await readFile(filePath, "utf-8"));
    return isRecord(value) ? value : undefined;
  } catch (error) {
    if (process.env.STATUSLINE_DEBUG) {
      console.error(
        `[codex-usage] unreadable credentials (${error instanceof SyntaxError ? "invalid JSON" : "file read failed"})`
      );
    }
  }
};

const secondsToMs = (value) =>
  isFiniteNumber(value) && value > 0
    ? Math.max(0, Math.trunc(value * 1000))
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

const readChatgptAuth = (data) => {
  const tokens = data?.tokens;
  return isRecord(tokens) &&
    typeof tokens.access_token === "string" &&
    tokens.access_token
    ? {
        accountId:
          typeof tokens.account_id === "string" ? tokens.account_id : "",
        token: tokens.access_token
      }
    : undefined;
};

const readOpenCodeOpenAiAuth = (data) => {
  const tokens = data?.openai;
  return isRecord(tokens) && typeof tokens.access === "string" && tokens.access
    ? {
        accountId: typeof tokens.accountId === "string" ? tokens.accountId : "",
        token: tokens.access
      }
    : undefined;
};

const chatgptAuth = async (options) => {
  const home = options.home ?? homedir();
  const codex = readChatgptAuth(
    await readJson(path.join(home, ".codex", "auth.json"))
  );
  const openCode = readOpenCodeOpenAiAuth(
    await readJson(path.join(home, ".local", "share", "opencode", "auth.json"))
  );
  return {
    accountId: codex?.accountId || openCode?.accountId || "",
    codex,
    openCode
  };
};

const windowLabel = (seconds, fallback) => {
  let label;
  if (
    typeof seconds === "number" &&
    Number.isFinite(seconds) &&
    seconds > 0 &&
    seconds % 86_400 === 0
  ) {
    label = `${seconds / 86_400}d`;
  } else if (
    typeof seconds === "number" &&
    Number.isFinite(seconds) &&
    seconds > 0 &&
    seconds % 3600 === 0
  ) {
    label = `${seconds / 3600}h`;
  } else {
    label = fallback;
  }
  return label;
};

const chatgptWindow = (window, fallback) =>
  isRecord(window)
    ? percentageMetric(
        windowLabel(window.limit_window_seconds, fallback),
        window.used_percent,
        secondsToMs(window.reset_after_seconds)
      )
    : undefined;

const chatgptGroup = (rateLimit, label) => {
  const metrics = isRecord(rateLimit)
    ? [
        chatgptWindow(rateLimit.secondary_window, "5h"),
        chatgptWindow(rateLimit.primary_window, "7d")
      ].filter(Boolean)
    : undefined;
  const group = metrics?.length ? { metrics } : undefined;
  if (group && label) {
    group.label = label;
  }
  return group;
};

const chatgptPlanLabel = (planType) => {
  const known = ["free", "plus", "pro", "team", "enterprise", "edu"];
  return typeof planType === "string" && known.includes(planType)
    ? planType.charAt(0).toUpperCase() + planType.slice(1)
    : "";
};

/**
 * Read local Codex/OpenCode auth and fetch normalized ChatGPT usage windows.
 * An explicit credential overrides the discovered token. Network, HTTP, and
 * response-decoding failures return no snapshot; unreadable auth files are
 * ignored. A successful payload can contain an empty groups array.
 * @param {object} [options] Credential, auth home directory, and fetch override.
 * @returns {Promise<object|undefined>} Usage groups, or undefined when no token
 * or usable response is available.
 */
export const fetchUsage = async (options = {}) => {
  const auth = await chatgptAuth(options);
  const explicit =
    typeof options.credential === "string" && options.credential
      ? options.credential
      : "";
  const selected = explicit
    ? { accountId: auth.accountId, token: explicit }
    : (auth.codex ?? auth.openCode);
  let result;
  if (selected?.token) {
    const headers = {
      Authorization: `Bearer ${selected.token}`,
      "Content-Type": "application/json",
      "User-Agent": "codex",
      ...(selected.accountId
        ? { "ChatGPT-Account-ID": selected.accountId }
        : {})
    };
    const { payload } = await requestJson(
      USAGE_URL,
      headers,
      fetchFunction(options)
    );
    const plan = chatgptPlanLabel(payload?.plan_type);
    result = payload
      ? {
          groups: [
            chatgptGroup(payload.rate_limit, plan && `ChatGPT (${plan})`),
            ...(Array.isArray(payload.additional_rate_limits)
              ? payload.additional_rate_limits.filter(
                  (limit) =>
                    isRecord(limit) &&
                    typeof limit.limit_name === "string" &&
                    limit.limit_name
                )
              : []
            ).map((limit) =>
              chatgptGroup(
                limit.rate_limit,
                limit.limit_name === "gpt-5.3-codex-spark"
                  ? "Additional"
                  : limit.limit_name
              )
            )
          ].filter(Boolean)
        }
      : undefined;
  }
  return result;
};
