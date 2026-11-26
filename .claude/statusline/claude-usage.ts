import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * @param {unknown} value - Numeric input.
 * @returns {value is number} Finite number.
 */
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const PLAN_LABELS = new Map([
  ["pro", "Pro"],
  ["max", "Max"],
  ["team", "Team"],
  ["enterprise", "Enterprise"]
]);
const WINDOWS = [
  ["five_hour", "5h"],
  ["seven_day", "7d"]
];

/**
 * @param {unknown} value Value to validate.
 * @returns {value is import("./types.ts").JsonRecord} Record check.
 */
const isRecord = (value: unknown): value is import("./types.ts").JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * @param {string} message - Redacted message.
 */
const debug = (message: string) => {
  if (
    process.env.STATUSLINE_DEBUG !== undefined &&
    process.env.STATUSLINE_DEBUG !== ""
  ) {
    console.error(`[claude-usage] ${message}`);
  }
};

/**
 * @param {string} text - JSON document.
 * @returns {Record<string,unknown>|undefined|null} Valid result or absence.
 */
const parseRecord = (
  text: string
): Record<string, unknown> | undefined | null => {
  try {
    /**
     * @type {unknown}
     */
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    debug("native 인증 JSON을 해석할 수 없습니다.");
  }
  return null;
};

/**
 * @param {unknown} value - Timestamp.
 */
const nowValue = (value: unknown) => {
  if (value instanceof Date) {
    return value.getTime();
  }
  return isFiniteNumber(value) ? value : Date.now();
};

/**
 * @param {unknown} store - Credential document.
 * @param {number} now - Current time.
 */
/**
 * @param {unknown} value - OAuth payload.
 * @returns {value is Record<string, unknown> & {accessToken: string}} Valid token-bearing record.
 */
const hasAccessToken = (
  value: unknown
): value is Record<string, unknown> & { accessToken: string } =>
  isRecord(value) && typeof value.accessToken === "string";
/** @param {unknown} store - Credential document.
 * @param {number} now - Current time. */
const validOauth = (store: unknown, now: number) => {
  const oauth = isRecord(store) ? store.claudeAiOauth : undefined;
  return hasAccessToken(oauth) &&
    typeof oauth.accessToken === "string" &&
    oauth.accessToken.trim() !== "" &&
    (oauth.expiresAt === undefined ||
      (isFiniteNumber(oauth.expiresAt) && oauth.expiresAt > now))
    ? oauth
    : undefined;
};

/**
 * @param {import("./types.ts").UsageOptions} options - Lookup options.
 * @param {string} configDir - Configuration directory.
 * @param {string} home - Home directory.
 * @param {number} now - Current time.
 * @returns {(Record<string,unknown>&{accessToken:string})|undefined|null} Valid result or absence.
 */
const keychainOauth = (
  options: import("./types.ts").UsageOptions,
  configDir: string,
  home: string,
  now: number
): (Record<string, unknown> & { accessToken: string }) | undefined | null => {
  if (
    configDir === path.join(home, ".claude") &&
    (process.platform === "darwin" || options.execFile !== undefined) &&
    (home === homedir() || options.execFile !== undefined)
  ) {
    try {
      return validOauth(
        parseRecord(
          String(
            (options.execFile ?? execFileSync)(
              "security",
              ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
              {
                encoding: "utf-8",
                stdio: ["ignore", "pipe", "ignore"],
                timeout: 3000
              }
            )
          )
        ),
        now
      );
    } catch {
      debug("Keychain 인증을 읽을 수 없습니다.");
    }
  }
  return null;
};

/**
 * @param {import("./types.ts").UsageOptions} options - Lookup options.
 * @param {number} now - Current time.
 * @returns {Promise<(Record<string,unknown>&{accessToken:string})|undefined|null>} Valid result or absence.
 */
const nativeOauth = async (
  options: import("./types.ts").UsageOptions,
  now: number
): Promise<
  (Record<string, unknown> & { accessToken: string }) | undefined | null
> => {
  const home = options.home ?? homedir();
  const configured = (options.environment ?? process.env).CLAUDE_CONFIG_DIR;
  const configDir =
    configured !== undefined && configured !== ""
      ? path.resolve(
          configured.startsWith("~/")
            ? path.join(home, configured.slice(2))
            : configured
        )
      : path.join(home, ".claude");
  const oauth = keychainOauth(options, configDir, home, now);
  if (oauth) {
    return oauth;
  }
  try {
    return validOauth(
      parseRecord(
        await readFile(path.join(configDir, ".credentials.json"), "utf-8")
      ),
      now
    );
  } catch {
    debug("native 인증 파일을 읽을 수 없습니다.");
  }
  return null;
};

/**
 * @param {Record<string, unknown>} oauth - Credential metadata.
 */
const groupLabel = (oauth: Record<string, unknown>) => {
  const plan =
    PLAN_LABELS.get(
      typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : ""
    ) ??
    (["default_claude_max_5x", "default_claude_max_20x"].includes(
      typeof oauth.rateLimitTier === "string" ? oauth.rateLimitTier : ""
    )
      ? "Max"
      : "");
  return plan === "" ? "Claude" : `Claude (${plan})`;
};

/**
 * @param {unknown} window - Usage payload.
 * @param {string} label - Display label.
 * @param {number} now - Current time.
 * @returns {import("./types.ts").Metric | undefined} Valid metric.
 */
const windowMetric = (
  window: unknown,
  label: string,
  now: number
): import("./types.ts").Metric | undefined => {
  const reset =
    isRecord(window) && typeof window.resets_at === "string"
      ? Date.parse(window.resets_at)
      : Number.NaN;
  return isRecord(window) &&
    isFiniteNumber(window.utilization) &&
    window.utilization >= 0
    ? {
        label,
        percentage: window.utilization,
        ...(Number.isFinite(reset)
          ? { resetsInMs: Math.max(0, reset - now) }
          : {}),
        type: "percentage"
      }
    : undefined;
};

/**
 * @param {Record<string, unknown>} wallet - Wallet payload.
 */
const walletRemaining = (wallet: Record<string, unknown>) => {
  if (Object.hasOwn(wallet, "remaining_dollars")) {
    return wallet.remaining_dollars;
  }
  return isFiniteNumber(wallet.limit_dollars) &&
    wallet.limit_dollars >= 0 &&
    isFiniteNumber(wallet.used_dollars) &&
    wallet.used_dollars >= 0
    ? wallet.limit_dollars - wallet.used_dollars
    : Number.NaN;
};

/**
 * @param {unknown} wallet - Wallet payload.
 * @param {number} now - Current time.
 * @returns {import("./types.ts").Metric | undefined} Valid credit.
 */
const creditMetric = (
  wallet: unknown,
  now: number
): import("./types.ts").Metric | undefined => {
  const remaining = isRecord(wallet) ? walletRemaining(wallet) : Number.NaN;
  const expiresAt =
    isRecord(wallet) && typeof wallet.resets_at === "string"
      ? Date.parse(wallet.resets_at)
      : Number.NaN;
  return isRecord(wallet) &&
    isFiniteNumber(remaining) &&
    remaining > 0 &&
    (wallet.limit_dollars === undefined ||
      (isFiniteNumber(wallet.limit_dollars) &&
        remaining <= wallet.limit_dollars)) &&
    (wallet.locked_reason === undefined ||
      wallet.locked_reason === null ||
      wallet.locked_reason === "" ||
      wallet.locked_reason === false) &&
    (!Number.isFinite(expiresAt) || expiresAt > now)
    ? { currency: "USD", label: "credit", remaining, type: "credit" }
    : undefined;
};

/**
 * @param {unknown} budget - Budget payload.
 * @returns {import("./types.ts").Metric | undefined} Valid budget.
 */
const budgetMetric = (
  budget: unknown
): import("./types.ts").Metric | undefined => {
  const total = isRecord(budget)
    ? (budget.monthly_limit ?? budget.monthly_credit_limit)
    : undefined;
  const used = isRecord(budget) ? budget.used_credits : undefined;
  return isRecord(budget) &&
    budget.is_enabled === true &&
    (typeof budget.currency === "string"
      ? budget.currency.toUpperCase()
      : (budget.currency ?? "USD")) === "USD" &&
    isFiniteNumber(total) &&
    total > 0 &&
    isFiniteNumber(used) &&
    used >= 0
    ? {
        label: "budget",
        percentage: (used / total) * 100,
        total: total / 100,
        type: "budget",
        used: used / 100
      }
    : undefined;
};

/**
 * @param {Record<string, unknown>} payload - Usage payload.
 * @param {Record<string, unknown>} oauth - Credential metadata.
 * @param {number} now - Current time.
 */
const usageSnapshot = (
  payload: Record<string, unknown>,
  oauth: Record<string, unknown>,
  now: number
) => {
  const metrics = [
    ...WINDOWS.map(([key, label]) => windowMetric(payload?.[key], label, now)),
    creditMetric(payload?.iguana_necktie, now),
    budgetMetric(payload?.extra_usage)
  ].filter((metric) => metric !== undefined);
  return metrics.length > 0
    ? { groups: [{ label: groupLabel(oauth), metrics }] }
    : undefined;
};

/**
 * @param {Record<string, unknown> & {accessToken: string}} oauth - Validated credential.
 * @param {import("./types.ts").UsageOptions} options - Fetch options.
 * @param {number} now - Current time.
 * @returns {Promise<import("./types.ts").Snapshot|undefined|null>} Valid result or absence.
 */
const fetchSnapshot = async (
  oauth: Record<string, unknown> & { accessToken: string },
  options: import("./types.ts").UsageOptions,
  now: number
): Promise<import("./types.ts").Snapshot | undefined | null> => {
  try {
    const response = await (options.fetch ?? globalThis.fetch)(USAGE_URL, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${oauth.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20"
      },
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(3000)
    });
    if (
      Number.isFinite(response?.status) &&
      response.status >= 200 &&
      response.status < 300
    ) {
      /**
       * @type {unknown}
       */
      const payload: unknown = await response.json();
      if (
        isRecord(payload) &&
        payload.type !== "error" &&
        (payload.error === undefined ||
          payload.error === null ||
          payload.error === "" ||
          payload.error === false)
      ) {
        return usageSnapshot(payload, oauth, now);
      }
      options.onUsageError?.();
    }
  } catch {
    options.onUsageError?.();
    debug("Claude 사용량 조회에 실패했습니다.");
  }
  return null;
};

/**
 * @param {import("./types.ts").UsageOptions} options Lookup options.
 * @param {Pick<import("./types.ts").UsageRuntime, "withUsageCache">} runtime Host-provided usage helpers.
 */
export const fetchUsage = async (
  options: import("./types.ts").UsageOptions,
  { withUsageCache }: Pick<import("./types.ts").UsageRuntime, "withUsageCache">
) => {
  const now = nowValue(options.now);
  const oauth = await nativeOauth(options, now);
  return oauth
    ? await withUsageCache(
        "claude",
        oauth.accessToken,
        options,
        async (fetchOptions) =>
          (await fetchSnapshot(oauth, fetchOptions, now)) ?? undefined
      )
    : undefined;
};
