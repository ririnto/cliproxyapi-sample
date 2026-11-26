import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/**
 * @param {unknown} value Value to validate.
 * @returns {value is import("./types.ts").JsonRecord} Whether the value has the required shape.
 */
const isRecord = (value: unknown): value is import("./types.ts").JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * @param {unknown} value Value to validate.
 * @returns {value is number} Whether the value has the required shape.
 */
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * @param {string} filePath Auth file.
 */
const readJson = async (filePath: string) => {
  try {
    /**
     * @type {unknown}
     */
    const value: unknown = JSON.parse(await readFile(filePath, "utf-8"));
    return isRecord(value) ? value : null;
  } catch {
    if ((process.env.STATUSLINE_DEBUG ?? "") !== "") {
      console.error("[codex-usage] unreadable credential data");
    }
    return null;
  }
};

/**
 * @param {unknown} value Seconds.
 */
const secondsToMs = (value: unknown) =>
  isFiniteNumber(value) && value > 0
    ? Math.max(0, Math.trunc(value * 1000))
    : 0;

/**
 * @param {string} label Window.
 * @param {unknown} percentage Usage.
 * @param {number} resetsInMs Delay.
 * @returns {import("./types.ts").Metric | undefined} Metric.
 */
const percentageMetric = (
  label: string,
  percentage: unknown,
  resetsInMs: number
): import("./types.ts").Metric | undefined =>
  isFiniteNumber(percentage) && percentage >= 0 && percentage <= 100
    ? {
        label,
        percentage,
        resetsInMs: Math.max(0, resetsInMs || 0),
        type: "percentage"
      }
    : undefined;

/**
 * @param {unknown} data Untrusted auth.
 */
const readChatgptAuth = (data: unknown) => {
  const tokens = isRecord(data) ? data.tokens : undefined;
  return isRecord(tokens) &&
    typeof tokens.access_token === "string" &&
    tokens.access_token !== ""
    ? {
        accountId:
          typeof tokens.account_id === "string" ? tokens.account_id : "",
        token: tokens.access_token
      }
    : undefined;
};

/**
 * @param {unknown} data Untrusted auth.
 */
const readOpenCodeOpenAiAuth = (data: unknown) => {
  const tokens = isRecord(data) ? data.openai : undefined;
  return isRecord(tokens) &&
    typeof tokens.access === "string" &&
    tokens.access !== ""
    ? {
        accountId: typeof tokens.accountId === "string" ? tokens.accountId : "",
        token: tokens.access
      }
    : undefined;
};

/**
 * @param {import("./types.ts").UsageOptions} options Auth options.
 */
const chatgptAuth = async (options: import("./types.ts").UsageOptions) => {
  const home = options.home ?? homedir();
  const codex = readChatgptAuth(
    await readJson(path.join(home, ".codex", "auth.json"))
  );
  const openCode = readOpenCodeOpenAiAuth(
    await readJson(path.join(home, ".local", "share", "opencode", "auth.json"))
  );
  return {
    accountId:
      (codex?.accountId ?? "") === ""
        ? (openCode?.accountId ?? "")
        : (codex?.accountId ?? ""),
    codex,
    openCode
  };
};

/**
 * @param {unknown} seconds Window length.
 * @param {string} fallback Default.
 */
const windowLabel = (seconds: unknown, fallback: string) => {
  if (
    typeof seconds !== "number" ||
    !Number.isFinite(seconds) ||
    seconds <= 0
  ) {
    return fallback;
  }
  if (seconds % 86_400 === 0) {
    return `${seconds / 86_400}d`;
  }
  return seconds % 3600 === 0 ? `${seconds / 3600}h` : fallback;
};

/**
 * @param {unknown} window Untrusted window.
 * @param {string} fallback Default label.
 */
const chatgptWindow = (window: unknown, fallback: string) =>
  isRecord(window)
    ? percentageMetric(
        windowLabel(window.limit_window_seconds, fallback),
        window.used_percent,
        secondsToMs(window.reset_after_seconds)
      )
    : undefined;

/**
 * @param {unknown} rateLimit Untrusted limit.
 * @param {string} label Label.
 * @param {import("./types.ts").Metric} [credit] Credit.
 */
const chatgptGroup = (
  rateLimit: unknown,
  label: string,
  credit?: import("./types.ts").Metric
) => {
  const metrics = (
    isRecord(rateLimit)
      ? [
          chatgptWindow(rateLimit.secondary_window, "5h"),
          chatgptWindow(rateLimit.primary_window, "7d"),
          credit
        ]
      : [credit]
  ).filter((metric) => metric !== undefined);
  return metrics.length
    ? { metrics, ...(label === "" ? {} : { label }) }
    : undefined;
};

/**
 * @param {unknown} credits Untrusted balance.
 * @returns {import("./types.ts").Metric | undefined} Metric.
 */
const chatgptCredit = (
  credits: unknown
): import("./types.ts").Metric | undefined => {
  const creditBalance =
    isRecord(credits) && credits.has_credits === true
      ? credits.balance
      : undefined;
  const balance =
    typeof creditBalance === "number" ||
    (typeof creditBalance === "string" && creditBalance.trim() !== "")
      ? Number(creditBalance)
      : Number.NaN;
  return isFiniteNumber(balance) && balance > 0
    ? { label: "credit", remaining: balance, type: "credit" }
    : undefined;
};

/**
 * @param {unknown} planType Untrusted plan.
 */
const chatgptPlanLabel = (planType: unknown) => {
  if (
    typeof planType !== "string" ||
    !["free", "plus", "pro", "team", "enterprise", "edu"].includes(planType)
  ) {
    return "";
  }
  return planType.charAt(0).toUpperCase() + planType.slice(1);
};

/**
 * @param {{ token: string, accountId: string }} selected Auth.
 * @param {import("./types.ts").UsageOptions} options Options.
 * @param {import("./types.ts").UsageRuntime["requestJson"]} requestJson Host HTTP transport.
 */
const usageSnapshot = async (
  selected: { token: string; accountId: string },
  options: import("./types.ts").UsageOptions,
  requestJson: import("./types.ts").UsageRuntime["requestJson"]
) => {
  let { payload } = await requestJson(
    USAGE_URL,
    {
      Authorization: `Bearer ${selected.token}`,
      "Content-Type": "application/json",
      "User-Agent": "codex",
      ...(selected.accountId === ""
        ? {}
        : { "ChatGPT-Account-ID": selected.accountId })
    },
    options.fetch ?? globalThis.fetch,
    options.onUsageError
  );
  if (payload && (Boolean(payload.error) || payload.success === false)) {
    options.onUsageError?.();
    payload = undefined;
  }
  const plan = chatgptPlanLabel(payload?.plan_type);
  const primaryGroup = payload
    ? chatgptGroup(
        payload.rate_limit,
        plan === "" ? "" : `ChatGPT (${plan})`,
        chatgptCredit(payload.credits)
      )
    : undefined;
  const primary =
    primaryGroup === undefined
      ? []
      : [
          primaryGroup.metrics.some((metric) => metric.type === "percentage")
            ? { ...primaryGroup, deduplicateWithNativeQuota: true }
            : primaryGroup
        ];
  const additional = Array.isArray(payload?.additional_rate_limits)
    ? payload.additional_rate_limits.filter(isRecord).flatMap((limit) => {
        const { limit_name: label, rate_limit: rateLimit } = limit;
        if (typeof label === "string" && label !== "") {
          const group = chatgptGroup(
            rateLimit,
            label === "gpt-5.3-codex-spark" ? "Additional" : label
          );
          return group === undefined ? [] : [group];
        }
        return [];
      })
    : [];
  const groups = [...primary, ...additional];
  return groups.length ? { groups } : undefined;
};

/**
 * @param {import("./types.ts").Snapshot | undefined} snapshot Cached or freshly fetched usage.
 * @returns {import("./types.ts").Snapshot | undefined} Snapshot with legacy quota metadata restored.
 */
const preserveNativeQuotaDeduplication = (
  snapshot: import("./types.ts").Snapshot | undefined
): import("./types.ts").Snapshot | undefined => {
  if (snapshot === undefined) {
    return snapshot;
  }
  const groups = snapshot.groups.map((group) => {
    if (
      group.deduplicateWithNativeQuota !== undefined ||
      !group.metrics.some(
        (metric) =>
          metric.type === "percentage" &&
          isFiniteNumber(metric.resetsInMs) &&
          metric.resetsInMs > 0
      )
    ) {
      return group;
    }
    const { label } = group;
    const primaryQuotaGroup =
      label === undefined ||
      label === "" ||
      label === "ChatGPT" ||
      (typeof label === "string" && label.startsWith("ChatGPT ("));
    return primaryQuotaGroup
      ? { ...group, deduplicateWithNativeQuota: true }
      : group;
  });
  return { ...snapshot, groups };
};

/**
 * @param {import("./types.ts").UsageOptions} options Lookup options.
 * @param {import("./types.ts").UsageRuntime} runtime Host-provided usage helpers.
 * @returns {Promise<import("./types.ts").Snapshot | undefined>} Usage snapshot.
 */
export const fetchUsage = async (
  options: import("./types.ts").UsageOptions,
  { withUsageCache, requestJson }: import("./types.ts").UsageRuntime
): Promise<import("./types.ts").Snapshot | undefined> => {
  const auth = await chatgptAuth(options);
  const explicit =
    typeof options.credential === "string" && options.credential !== ""
      ? options.credential
      : "";
  const selected = explicit
    ? { accountId: auth.accountId, token: explicit }
    : (auth.codex ?? auth.openCode);
  return selected !== undefined && selected.token !== ""
    ? preserveNativeQuotaDeduplication(
        await withUsageCache(
          "chatgpt",
          { accountId: selected.accountId, token: selected.token },
          options,
          async (fetchOptions) =>
            await usageSnapshot(selected, fetchOptions, requestJson)
        )
      )
    : undefined;
};
