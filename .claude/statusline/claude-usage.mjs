import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { withUsageCache } from "./usage-cache.mjs";

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

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const debug = (message) => {
  if (process.env.STATUSLINE_DEBUG) {
    console.error(`[claude-usage] ${message}`);
  }
};

const parseRecord = (text) => {
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    debug("native 인증 JSON을 해석할 수 없습니다.");
  }
};

const nowValue = (value) => {
  if (value instanceof Date) {
    return value.getTime();
  }
  return Number.isFinite(value) ? value : Date.now();
};

const validOauth = (store, now) => {
  const oauth = store?.claudeAiOauth;
  return isRecord(oauth) &&
    typeof oauth.accessToken === "string" &&
    oauth.accessToken.trim() &&
    (oauth.expiresAt === undefined ||
      (Number.isFinite(oauth.expiresAt) && oauth.expiresAt > now))
    ? oauth
    : undefined;
};

const keychainOauth = (options, configDir, home, now) => {
  if (
    configDir === path.join(home, ".claude") &&
    (process.platform === "darwin" || options.execFile) &&
    (home === homedir() || options.execFile)
  ) {
    try {
      const text = (options.execFile ?? execFileSync)(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 3000
        }
      );
      return validOauth(parseRecord(text), now);
    } catch {
      debug("Keychain 인증을 읽을 수 없습니다.");
    }
  }
};

const nativeOauth = async (options, now) => {
  const home = options.home ?? homedir();
  const environment = options.environment ?? process.env;
  const configured = environment.CLAUDE_CONFIG_DIR;
  const configDir = configured
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
};

const groupLabel = (oauth) => {
  const plan =
    PLAN_LABELS.get(oauth.subscriptionType) ||
    (["default_claude_max_5x", "default_claude_max_20x"].includes(
      oauth.rateLimitTier
    )
      ? "Max"
      : "");
  return plan ? `Claude (${plan})` : "Claude";
};

const windowMetric = (window, label, now) => {
  if (
    isRecord(window) &&
    Number.isFinite(window.utilization) &&
    window.utilization >= 0
  ) {
    const reset =
      typeof window.resets_at === "string"
        ? Date.parse(window.resets_at)
        : Number.NaN;
    return {
      label,
      percentage: window.utilization,
      ...(Number.isFinite(reset)
        ? { resetsInMs: Math.max(0, reset - now) }
        : {}),
      type: "percentage"
    };
  }
};

const walletRemaining = (wallet) => {
  if (Object.hasOwn(wallet, "remaining_dollars")) {
    return wallet.remaining_dollars;
  }
  return Number.isFinite(wallet.limit_dollars) &&
    wallet.limit_dollars >= 0 &&
    Number.isFinite(wallet.used_dollars) &&
    wallet.used_dollars >= 0
    ? wallet.limit_dollars - wallet.used_dollars
    : Number.NaN;
};

const creditMetric = (wallet, now) => {
  if (isRecord(wallet)) {
    const remaining = walletRemaining(wallet);
    const expiresAt =
      typeof wallet.resets_at === "string"
        ? Date.parse(wallet.resets_at)
        : Number.NaN;
    const bounded =
      wallet.limit_dollars === undefined ||
      (Number.isFinite(wallet.limit_dollars) &&
        remaining <= wallet.limit_dollars);
    if (
      Number.isFinite(remaining) &&
      remaining > 0 &&
      bounded &&
      !wallet.locked_reason &&
      (!Number.isFinite(expiresAt) || expiresAt > now)
    ) {
      return { currency: "USD", label: "credit", remaining, type: "credit" };
    }
  }
};

const budgetMetric = (budget) => {
  if (isRecord(budget) && budget.is_enabled === true) {
    const total = budget.monthly_limit ?? budget.monthly_credit_limit;
    const used = budget.used_credits;
    const currency =
      typeof budget.currency === "string"
        ? budget.currency.toUpperCase()
        : (budget.currency ?? "USD");
    if (
      currency === "USD" &&
      Number.isFinite(total) &&
      total > 0 &&
      Number.isFinite(used) &&
      used >= 0
    ) {
      return {
        label: "budget",
        percentage: (used / total) * 100,
        total: total / 100,
        type: "budget",
        used: used / 100
      };
    }
  }
};

const usageSnapshot = (payload, oauth, now) => {
  const metrics = [
    ...WINDOWS.map(([key, label]) => windowMetric(payload?.[key], label, now)),
    creditMetric(payload?.iguana_necktie, now),
    budgetMetric(payload?.extra_usage)
  ].filter(Boolean);
  return metrics.length
    ? { groups: [{ label: groupLabel(oauth), metrics }] }
    : undefined;
};

const fetchSnapshot = async (oauth, options, now) => {
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
      const payload = await response.json();
      if (isRecord(payload) && payload.type !== "error" && !payload.error) {
        return usageSnapshot(payload, oauth, now);
      }
      options.onUsageError?.();
    }
  } catch {
    options.onUsageError?.();
    debug("Claude 사용량 조회에 실패했습니다.");
  }
};

/**
 * 현재 API key와 별개로 native OAuth 인증을 읽어 Claude 사용량과 예산을 캐시한다.
 */
export const fetchUsage = async (options = {}) => {
  const now = nowValue(options.now);
  const oauth = await nativeOauth(options, now);
  return oauth
    ? withUsageCache("claude", oauth.accessToken, options, (fetchOptions) =>
        fetchSnapshot(oauth, fetchOptions, now)
      )
    : undefined;
};
