#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delayMs } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

/**
 * @typedef {Record<string, unknown>} RecordValue
 */
/**
 * @typedef {{addons?: unknown, branch?: string, cwd?: string, nowMs?: number, nativeUsage?: boolean | null, importModule?: (url: URL) => unknown}} RenderOptions
 */
/**
 * @param {unknown} value - Untrusted input.
 * @returns {RecordValue} Object fields or an empty record.
 */
const record = (value) => (isRecord(value) ? value : {});
/**
 * @param {unknown} value - Untrusted list.
 * @returns {unknown[]} Array elements or an empty list.
 */
const array = (value) => (Array.isArray(value) ? value : []);
/**
 * @param {unknown} value - Untrusted path.
 * @param {string} fallback - Default path.
 */
const textOr = (value, fallback = "") =>
  typeof value === "string" && value !== "" ? value : fallback;

/**
 * @param {unknown} value - Candidate value.
 * @param {unknown} alternative - Falsy fallback.
 */
const truthy = Boolean;

/**
 * @param {unknown} value - Candidate.
 * @param {unknown} alternative - Fallback.
 */
const truthyOr = (value, alternative) => (truthy(value) ? value : alternative);

const RESET = "[0m";
const DIM = "\u001B[38;2;132;144;156m";
const BOLD = "[1m";
const MODEL_COLOR = "\u001B[38;2;246;226;183m";
const GREEN = "\u001B[38;2;171;223;167m";
const BLUE = "\u001B[38;2;143;179;239m";
const PROVIDER = "\u001B[38;2;166;190;211m";
const SEPARATOR = `${DIM} · ${RESET}`;
const GROUP_SEPARATOR = `${DIM}  │  ${RESET}`;
const PCT_GREEN = 70;
const PCT_YELLOW = 90;

/**
 * @param {unknown} value - value input.
 */
const displayText = (value) =>
  stripVTControlCharacters(String(value)).replaceAll(
    /[\p{Cc}\u{2028}\u{2029}]+/gu,
    " "
  );

/**
 * @param {unknown} value - value input.
 * @returns {value is RecordValue} Whether value has object fields.
 */
const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * @param {RecordValue} metric - metric input.
 */
const metricPercentage = (metric) => {
  if (metric?.type === "usage") {
    return Number(metric.total) > 0
      ? (Number(metric.used) / Number(metric.total)) * 100
      : 0;
  }
  return metric?.percentage ?? 0;
};

/**
 * @param {number} number - number input.
 * @param {number} divisor - divisor input.
 * @param {string} suffix - suffix input.
 */
const scaledText = (number, divisor, suffix) =>
  `${(number / divisor).toFixed(1).replace(/\.0$/u, "")}${suffix}`;

/**
 * @param {unknown} value - value input.
 */
const numberText = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "0";
  }
  if (number >= 1_000_000) {
    return scaledText(number, 1_000_000, "M");
  }
  return number >= 1000
    ? scaledText(number, 1000, "k")
    : String(Number(number.toFixed(1)));
};

/**
 * @param {unknown} milliseconds - milliseconds input.
 */
const resetText = (milliseconds) => {
  const value = Number(milliseconds);
  if (!Number.isFinite(value) || value <= 0) {
    return "unknown";
  }
  const seconds = value / 1000;
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) {
    return `${days}d${hours ? `${hours}h` : ""}`;
  }
  return hours > 0 ? `${hours}h${minutes ? `${minutes}m` : ""}` : `${minutes}m`;
};

/**
 * @param {number} percentage - percentage input.
 */
const barColor = (percentage) => {
  if (!Number.isFinite(percentage)) {
    return "";
  }
  if (percentage <= PCT_GREEN) {
    return GREEN;
  }
  return percentage <= PCT_YELLOW
    ? "\u001B[38;2;242;181;144m"
    : "\u001B[38;2;233;144;169m";
};

/**
 * @param {number} percentage - percentage input.
 */
const usageBar = (percentage) => {
  const steps = Math.max(
    percentage > 0 ? 1 : 0,
    Math.min(8, Math.round((percentage / 100) * 8))
  );
  return "▰".repeat(steps) + DIM + "▱".repeat(8 - steps);
};

/**
 * @param {string} cwd - cwd input.
 */
const gitBranch = (cwd) => {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
};

/**
 * @param {RecordValue} metric - metric input.
 */
const metricDisplay = (metric) => {
  if (!isRecord(metric)) {
    return "";
  }
  if (metric.type === "usage") {
    return `${numberText(metric.used)}/${numberText(metric.total)}`;
  }
  if (metric.type === "credit") {
    if (metric.currency === "USD") {
      return `$${Number(metric.remaining).toFixed(2)}`;
    }
    return Number.isFinite(Number(metric.remaining))
      ? numberText(metric.remaining)
      : String(metric.remaining);
  }
  return metric.type === "budget"
    ? `$${Number(truthyOr(metric.used, 0)).toFixed(2)}/$${Number(truthyOr(metric.total, 0)).toFixed(2)}`
    : `${Number(Math.max(0, 100 - Number(truthyOr(metric.percentage, 0))).toFixed(1))}% left`;
};

/**
 * @param {RecordValue} metric - metric input.
 */
const metricPercent = (metric) => {
  try {
    if (metric.type === "credit") {
      return Number.POSITIVE_INFINITY;
    }
    const value = Number(metricPercentage(metric));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
};

/**
 * @param {unknown} showAbove - showAbove input.
 * @param {string} groupLabel - groupLabel input.
 * @param {string} metricLabel - metricLabel input.
 */
const thresholdFor = (showAbove, groupLabel, metricLabel) =>
  isRecord(showAbove)
    ? Number(showAbove[metricLabel] ?? showAbove[groupLabel] ?? 0)
    : Number(truthyOr(showAbove, 0));

/**
 * @param {RecordValue} metric - metric input.
 */
const renderMetric = (metric) => {
  const reset = metric.resetsInMs ?? metric.resets_in_ms;
  return `${displayText(metric.label)} ${barColor(metricPercent(metric))}${displayText(metricDisplay(metric))}${RESET}${reset === undefined ? "" : ` ${DIM}↻${resetText(reset)}${RESET}`}`;
};

/**
 * @param {unknown} value - value input.
 * @returns {value is number} Whether value is finite.
 */
const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

/**
 * @param {unknown} window - window input.
 */
const windowPercentage = (window) => {
  const percentage = record(window).used_percentage;
  return isFiniteNumber(percentage) && percentage >= 0 ? percentage : null;
};

/**
 * @param {unknown} window - window input.
 */
const spendDollarPair = (window) => {
  const used = record(window).used_usd;
  const limit = record(window).limit_usd;
  return isFiniteNumber(used) && used >= 0 && isFiniteNumber(limit) && limit > 0
    ? { limit, used }
    : null;
};

/**
 * @param {unknown} window - window input.
 */
const spendPercentage = (window) => {
  const percentage = record(window).used_percentage;
  return isFiniteNumber(percentage) && percentage >= 0 ? percentage : null;
};

/**
 * @param {unknown} rateLimits - rateLimits input.
 */
const nativeUsageFor = (rateLimits) => {
  if (!isRecord(rateLimits)) {
    return null;
  }
  return (
    [rateLimits.five_hour, rateLimits.seven_day].some(
      (window) => windowPercentage(window) !== null
    ) ||
    spendPercentage(rateLimits.spend_limit) !== null ||
    spendDollarPair(rateLimits.spend_limit) !== null
  );
};

/**
 * @param {string} key - key input.
 * @param {string} label - label input.
 * @param {RecordValue} rateLimits - rateLimits input.
 * @param {number} nowMs - nowMs input.
 */
const windowRow = (key, label, rateLimits, nowMs) => {
  const window = rateLimits?.[key];
  const percentage = windowPercentage(window);
  if (percentage === null) {
    return "";
  }
  return renderMetric({
    label,
    percentage,
    resetsInMs: Math.trunc(
      Number(truthyOr(record(window).resets_at, 0)) * 1000 - nowMs
    ),
    type: "percentage"
  });
};

/**
 * @param {{used:number,limit:number} | null} dollars - dollars input.
 * @param {number} percentage - percentage input.
 */
const spendMetric = (dollars, percentage) =>
  dollars
    ? {
        label: "spend",
        percentage: (dollars.used / dollars.limit) * 100,
        total: dollars.limit,
        type: "budget",
        used: dollars.used
      }
    : { label: "spend", percentage, type: "percentage" };

/**
 * @param {RecordValue} rateLimits - rateLimits input.
 * @param {number} nowMs - nowMs input.
 */
const spendRow = (rateLimits, nowMs) => {
  const spend = record(rateLimits.spend_limit);
  const dollars = spendDollarPair(spend);
  const percentage = dollars
    ? (dollars.used / dollars.limit) * 100
    : spendPercentage(spend);
  if (percentage === null) {
    return "";
  }
  const metric = spendMetric(dollars, percentage);
  return renderMetric(
    isFiniteNumber(spend?.resets_at)
      ? { ...metric, resetsInMs: Math.trunc(spend.resets_at * 1000 - nowMs) }
      : metric
  );
};

/**
 * @param {RecordValue} rateLimits - rateLimits input.
 * @param {number} nowMs - nowMs input.
 */
const renderRateLimits = (rateLimits, nowMs) =>
  [
    windowRow("five_hour", "5h", rateLimits, nowMs),
    windowRow("seven_day", "7d", rateLimits, nowMs),
    spendRow(rateLimits, nowMs)
  ].filter(Boolean);

/**
 * @param {RecordValue} addon - addon input.
 * @param {unknown} snapshot - snapshot input.
 */
export const renderSnapshot = (addon, snapshot) => {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.groups)) {
    return "";
  }
  return array(snapshot.groups)
    .map(record)
    .map((group) => {
      const metrics = (
        isRecord(group)
          ? array(group.metrics)
              .filter(isRecord)
              .filter((metric) => typeof metric.label === "string")
          : []
      ).filter((metric) => {
        const { hideLabels } = addon;
        return (
          !(Array.isArray(hideLabels) && hideLabels.includes(metric.label)) &&
          metricPercent(metric) >=
            thresholdFor(
              addon.showAbove,
              textOr(group.label),
              String(metric.label)
            )
        );
      });
      if (!metrics.length) {
        return "";
      }
      const content = metrics.map(renderMetric).join(SEPARATOR);
      const groupName =
        typeof group.label === "string" && group.label
          ? group.label
          : addon.name;
      const displayName =
        truthy(group.label) || !truthy(addon.hideName) ? groupName : "";
      return truthy(displayName)
        ? `${PROVIDER}${displayText(displayName).replace(/\s+\((?:Pro|Individual)\)$/u, "")}${RESET}  ${content}`
        : content;
    })
    .filter(Boolean)
    .join(GROUP_SEPARATOR);
};

/**
 * @param {unknown} addons - addons input.
 * @returns {(RecordValue & {script:string})[]} Enabled script definitions.
 */
const addonSettings = (addons) =>
  array(addons).flatMap((addon) => {
    if (
      !isRecord(addon) ||
      addon.enabled === false ||
      typeof addon.script !== "string" ||
      addon.script.trim() === ""
    ) {
      return [];
    }
    return [{ ...addon, script: addon.script.trim() }];
  });

/**
 * @param {string} script - script input.
 */
const scriptPath = (script) => {
  const home = homedir();
  if (script === "~") {
    return home;
  }
  const expanded = script.startsWith("~/")
    ? path.join(home, script.slice(2))
    : script;
  return path.isAbsolute(expanded)
    ? expanded
    : fileURLToPath(new URL(expanded, import.meta.url));
};

/**
 * @param {unknown} value Untrusted metric.
 * @returns {value is import("./statusline/types.ts").Metric} A normalized metric.
 */
const isMetric = (value) => {
  if (
    !isRecord(value) ||
    typeof value.label !== "string" ||
    (value.resetsInMs !== undefined && !isFiniteNumber(value.resetsInMs)) ||
    (value.currency !== undefined && typeof value.currency !== "string")
  ) {
    return false;
  }
  switch (value.type) {
    case "percentage": {
      return isFiniteNumber(value.percentage);
    }
    case "usage": {
      return isFiniteNumber(value.used) && isFiniteNumber(value.total);
    }
    case "budget": {
      return (
        isFiniteNumber(value.used) &&
        isFiniteNumber(value.total) &&
        isFiniteNumber(value.percentage)
      );
    }
    case "credit": {
      return isFiniteNumber(value.remaining);
    }
    default: {
      return false;
    }
  }
};
/**
 * @param {unknown} value Persisted snapshot.
 * @returns {value is import("./statusline/types.ts").Snapshot} A normalized snapshot.
 */
const isSnapshot = (value) =>
  isRecord(value) &&
  Array.isArray(value.groups) &&
  value.groups.every(
    (group) =>
      isRecord(group) &&
      (group.label === undefined || typeof group.label === "string") &&
      (group.deduplicateWithNativeQuota === undefined ||
        typeof group.deduplicateWithNativeQuota === "boolean") &&
      Array.isArray(group.metrics) &&
      group.metrics.every(isMetric)
  );

/**
 * @typedef {object} CacheRecord
 * @property {string} credentialHash Credential identity digest.
 * @property {number | null} fetchedAt Latest successful fetch time, or null.
 * @property {number} nextAttemptAt Earliest retry timestamp.
 * @property {import("./statusline/types.ts").Snapshot} [snapshot] Validated usage snapshot.
 */

const MAX_STALE_MS = 5 * 60_000;
/**
 * Default lifetime shared by persisted usage snapshots and consumer refreshes.
 */
const DEFAULT_USAGE_CACHE_TTL_MS = 5000;

/**
 * @param {unknown} value Current timestamp.
 */
const nowValue = (value) => {
  if (value instanceof Date) {
    return value.getTime();
  }
  return isFiniteNumber(value) ? value : Date.now();
};

/**
 * @param {number | undefined} status HTTP status.
 * @param {boolean} usageError Payload failure.
 */
const isSuccessfulResponse = (status, usageError) =>
  !usageError && isFiniteNumber(status) && status >= 200 && status < 300;

/**
 * @param {unknown} value Persisted data.
 * @param {string} credentialHash Expected identity.
 * @returns {value is CacheRecord} Valid cache entry.
 */
const validRecord = (value, credentialHash) =>
  isRecord(value) &&
  value.credentialHash === credentialHash &&
  (value.fetchedAt === null || isFiniteNumber(value.fetchedAt)) &&
  isFiniteNumber(value.nextAttemptAt) &&
  (value.snapshot === undefined || isSnapshot(value.snapshot));

/**
 * @param {import("./statusline/types.ts").Snapshot | undefined} snapshot Cached data.
 * @param {number} elapsed Elapsed milliseconds.
 * @param {number} maxAge Maximum age of a usable snapshot.
 */
const adjustedSnapshot = (snapshot, elapsed, maxAge) =>
  snapshot !== undefined && elapsed <= maxAge
    ? {
        ...snapshot,
        groups: snapshot.groups.map((group) => ({
          ...group,
          metrics: group.metrics.map((metric) =>
            "resetsInMs" in metric && isFiniteNumber(metric.resetsInMs)
              ? {
                  ...metric,
                  resetsInMs: Math.max(0, metric.resetsInMs - elapsed)
                }
              : metric
          )
        }))
      }
    : undefined;

/**
 * @param {string | null | undefined} value Retry header.
 * @param {number} now Current time.
 */
const retryDelay = (value, now) => {
  if (value === undefined || value === null || value === "") {
    return 0;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
};

/**
 * @param {string} filePath Cache path.
 * @param {string} credentialHash Expected identity.
 */
const readCache = (filePath, credentialHash) => {
  /**
   * @type {unknown}
   */
  let entry;
  try {
    entry = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    entry = undefined;
  }
  return validRecord(entry, credentialHash) ? entry : undefined;
};

/**
 * Use SQLite's write lock to serialize the JSON read and rename across processes.
 * @param {string} filePath Cache path.
 * @param {CacheRecord | undefined} cached Entry observed before the request.
 * @param {CacheRecord} next Refresh result.
 * @param {number} now Refresh start time.
 */
const publishCache = async (filePath, cached, next, now) => {
  const directory = path.dirname(filePath);
  let selected = next.fetchedAt === null ? (cached ?? next) : next;
  let temporaryPath;
  try {
    await mkdir(directory, { mode: 0o700, recursive: true });
    using lock = new DatabaseSync(path.join(directory, ".publish.sqlite"), {
      timeout: 1000
    });
    lock.exec("BEGIN IMMEDIATE");
    const latest = readCache(filePath, next.credentialHash) ?? cached;
    if (
      latest &&
      (next.fetchedAt === null ||
        (latest.fetchedAt !== null && latest.fetchedAt >= next.fetchedAt))
    ) {
      selected = latest;
    }
    temporaryPath = path.join(directory, `.${randomUUID()}.tmp`);
    writeFileSync(
      temporaryPath,
      JSON.stringify({
        ...selected,
        nextAttemptAt: Math.max(
          next.nextAttemptAt,
          latest?.nextAttemptAt ?? next.nextAttemptAt
        ),
        snapshot:
          now - (selected.fetchedAt ?? now) <= MAX_STALE_MS
            ? selected.snapshot
            : undefined
      }),
      { mode: 0o600 }
    );
    renameSync(temporaryPath, filePath);
  } catch {
    if (temporaryPath !== undefined && temporaryPath !== "") {
      try {
        await rm(temporaryPath, { force: true });
      } catch {
        if ((process.env.STATUSLINE_DEBUG ?? "") !== "") {
          console.error(
            "[statusline-usage] 임시 캐시 파일 정리에 실패했습니다."
          );
        }
      }
    }
    if ((process.env.STATUSLINE_DEBUG ?? "") !== "") {
      console.error("[statusline-usage] 사용량 캐시 저장에 실패했습니다.");
    }
  }
  return selected;
};

/** @type {import("./statusline/types.ts").UsageRuntime["withUsageCache"]} */
const withUsageCache = async (
  provider,
  credentialIdentity,
  options,
  fetchSnapshot
) => {
  if (options.cache === false || !/^[a-z0-9_-]+$/u.test(provider)) {
    return await fetchSnapshot(options);
  }
  const now = nowValue(options.now);
  const { cacheTtlMs } = options;
  const ttl = isFiniteNumber(cacheTtlMs)
    ? Math.max(0, cacheTtlMs)
    : DEFAULT_USAGE_CACHE_TTL_MS;
  const directory =
    options.cacheDir ??
    path.join(options.home ?? homedir(), ".claude", "cache", "usage");
  const credentialHash = createHash("sha256")
    .update(JSON.stringify([provider, credentialIdentity]))
    .digest("hex");
  const filePath = path.join(directory, provider, `${credentialHash}.json`);
  const cached =
    readCache(filePath, credentialHash) ??
    readCache(path.join(directory, `${provider}.json`), credentialHash);
  if (cached && now < cached.nextAttemptAt) {
    const fetchedAt = cached.fetchedAt ?? now;
    return adjustedSnapshot(
      cached.snapshot,
      Math.max(0, now - fetchedAt),
      cached.nextAttemptAt - fetchedAt > ttl ? MAX_STALE_MS : Infinity
    );
  }
  /**
   * @type {number | undefined}
   */
  let status;
  let retryAt = now;
  let usageError = false;
  const originalFetch = options.fetch ?? globalThis.fetch;
  /**
   * @type {import("./statusline/types.ts").UsageOptions}
   */
  const wrappedOptions = {
    ...options,
    fetch: async (...args) => {
      status = undefined;
      retryAt = now;
      usageError = false;
      const response = await originalFetch(...args);
      status = Number.isFinite(response?.status) ? response.status : undefined;
      const responseAt = nowValue(options.now);
      retryAt =
        responseAt +
        retryDelay(response?.headers?.get?.("retry-after"), responseAt);
      return response;
    },
    onUsageError: () => {
      usageError = true;
    }
  };
  let snapshot;
  try {
    snapshot = await fetchSnapshot(wrappedOptions);
  } catch {
    status = undefined;
  }
  const successful = isSuccessfulResponse(status, usageError);
  const next = {
    credentialHash,
    fetchedAt: successful ? now : null,
    nextAttemptAt: Math.max(now + ttl, retryAt),
    snapshot: successful && isSnapshot(snapshot) ? snapshot : undefined
  };
  const selected = await publishCache(filePath, cached, next, now);
  if (successful && selected === next) {
    return snapshot;
  }
  return adjustedSnapshot(
    selected.snapshot,
    Math.max(0, now - (selected.fetchedAt ?? now)),
    MAX_STALE_MS
  );
};

/** @type {import("./statusline/types.ts").UsageRuntime["requestJson"]} */
const requestJson = async (url, headers, fetchFunction, onUsageError) => {
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
          delayMs(3000, undefined, { signal: controller.signal })
        ]);
      } catch {
        if ((process.env.STATUSLINE_DEBUG ?? "") !== "") {
          console.error(
            `[statusline-usage] Failed to cancel HTTP ${response.status} response body.`
          );
        }
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

export const usageRuntime = { withUsageCache, requestJson };

/**
 * @param {{script:string}} addon - addon input.
 * @param {RenderOptions} options - options input.
 */
const importAddonModule = async (addon, options) => {
  /**
   * @type {unknown}
   */
  const module = await (
    options.importModule ??
    (async (url) => {
      /**
       * @type {unknown}
       */
      const imported = await import(url.href);
      return imported;
    })
  )(pathToFileURL(scriptPath(addon.script)));
  if (!isRecord(module) || typeof module.fetchUsage !== "function") {
    return null;
  }
  const { fetchUsage } = module;
  /**
   * @param {RecordValue} input - Provider request.
   * @returns {unknown} Provider result.
   */
  return (input) => Reflect.apply(fetchUsage, module, [input, usageRuntime]);
};

/**
 * @param {unknown} addons - addons input.
 * @param {RenderOptions} options - options input.
 */
const renderAddonResults = async (addons, options = {}) => {
  const results = await Promise.all(
    addonSettings(addons)
      .filter(
        (addon) =>
          !(options.nativeUsage === true && addon.skipWhenNativeUsage === true)
      )
      .map(async (addon) => {
        try {
          const module = await importAddonModule(addon, options);
          /**
           * @type {unknown}
           */
          const snapshot = module
            ? await module({
                credential:
                  typeof addon.credential === "string" ? addon.credential : ""
              })
            : undefined;
          const line = renderSnapshot(addon, snapshot);
          return line ? { line, primary: Boolean(addon.primary) } : null;
        } catch {
          return null;
        }
      })
  );
  return results.filter((result) => result !== null);
};

/**
 * @param {RecordValue} workspace - workspace input.
 */
const projectDisplay = (workspace) => {
  const currentDir = textOr(
    workspace.current_dir,
    textOr(workspace.project_dir, process.cwd())
  );
  const projectDir = textOr(workspace.project_dir, currentDir);
  const projectName = path.basename(projectDir);
  return currentDir === projectDir
    ? projectName
    : `${projectName}/${path.basename(currentDir)}`;
};

/**
 * @param {RecordValue} input - input input.
 */
const renderContext = (input) => {
  const context = record(input.context_window);
  const value = Number(context.used_percentage);
  const known =
    context.used_percentage !== null &&
    context.used_percentage !== undefined &&
    Number.isFinite(value);
  const percentage = known ? Math.max(0, Math.min(100, Math.trunc(value))) : 0;
  const size = Math.trunc(Number(truthyOr(context.context_window_size, 0)));
  return known
    ? `Context ${barColor(percentage)}${usageBar(percentage)}${RESET} ${barColor(percentage)}${percentage}%${RESET}${size ? ` ${DIM}/ ${numberText(size)}${RESET}` : ""}`
    : `Context ${DIM}${size ? numberText(size) : "waiting"}${RESET}`;
};

/**
 * @param {RecordValue} input - input input.
 * @param {RenderOptions} options - options input.
 */
const renderHeader = (input, options) => {
  const model = record(input.model);
  const displayName = model.display_name;
  const modelName = truthy(displayName)
    ? displayName
    : truthyOr(model.id, "Claude");
  const effortLevel = record(input.effort).level;
  const effort = truthy(effortLevel) ? effortLevel : truthyOr(model.effort, "");
  const workspace = record(input.workspace);
  const cost = record(input.cost);
  const dollars = Number(truthyOr(cost.total_cost_usd, 0));
  const seconds = Math.trunc(
    Number(truthyOr(cost.total_duration_ms, 0)) / 1000
  );
  const details = [
    ...(dollars > 0 ? [`$${dollars.toFixed(2)}`] : []),
    ...(seconds > 0
      ? [seconds < 60 ? `${seconds}s` : `${Math.trunc(seconds / 60)}m`]
      : [])
  ];
  const branch =
    options.branch ??
    gitBranch(
      textOr(options.cwd, textOr(workspace.current_dir, process.cwd()))
    );
  return [
    `${MODEL_COLOR}${BOLD}${displayText(modelName)}${RESET}${truthy(effort) ? ` ${DIM}${displayText(effort)}${RESET}` : ""}`,
    `${GREEN}${displayText(projectDisplay(workspace))}${RESET}`,
    ...(branch ? [`${BLUE}${displayText(branch)}${RESET}`] : []),
    ...(details.length ? [`${DIM}${details.join(" · ")}${RESET}`] : []),
    renderContext(input)
  ].join(SEPARATOR);
};

/**
 * @param {RecordValue} input - input input.
 */
const renderTokens = (input) => {
  const context = record(input.context_window);
  const usage = record(context.current_usage);
  const metrics = [
    ["in", context.total_input_tokens],
    ["out", context.total_output_tokens],
    ["cache read", usage.cache_read_input_tokens],
    ["cache write", usage.cache_creation_input_tokens]
  ].filter(([, value]) => Number(value) > 0);
  return metrics.length
    ? `${DIM}${metrics.map(([label, value]) => `${String(label)} ${numberText(value)}`).join(" · ")}${RESET}`
    : "";
};

/**
 * @param {string[]} rows - rows input.
 */
const packProviderRows = (rows) => {
  const packed = [];
  let current = [];
  for (const row of rows) {
    const combined = [...current, row].join(GROUP_SEPARATOR);
    if (
      current.length &&
      (current.length >= 2 || stripVTControlCharacters(combined).length > 120)
    ) {
      packed.push(current);
      current = [];
    }
    current.push(row);
  }
  if (current.length) {
    packed.push(current);
  }
  const columnWidth = Math.max(
    0,
    ...packed
      .filter((group) => group.length === 2)
      .map(([left]) => stripVTControlCharacters(left).length)
  );
  return packed.flatMap(([left, right]) => {
    if (!right) {
      return [left];
    }
    const combined = `${left}${" ".repeat(
      Math.max(0, columnWidth - stripVTControlCharacters(left).length)
    )}${GROUP_SEPARATOR}${right}`;
    return stripVTControlCharacters(combined).length <= 120
      ? [combined]
      : [left, right];
  });
};

/**
 * @param {RecordValue} input - input input.
 * @param {RenderOptions} options - options input.
 */
export const renderStatusline = async (input, options = {}) => {
  const nowMs = options.nowMs ?? Date.now();
  const nativeRate = renderRateLimits(record(input.rate_limits), nowMs);
  const addonResults = await renderAddonResults(options.addons ?? [], {
    ...options,
    nativeUsage: nativeUsageFor(input.rate_limits)
  });
  const primaryIndex = nativeRate.length
    ? -1
    : addonResults.findIndex((result) => result.primary);
  const header = [renderHeader(input, options), renderTokens(input)]
    .filter(Boolean)
    .join(SEPARATOR);
  const primary = nativeRate.length
    ? `${PROVIDER}Claude${RESET}  ${nativeRate.join(SEPARATOR)}`
    : addonResults[primaryIndex]?.line || "";
  return [
    header,
    ...packProviderRows(
      [
        primary,
        ...addonResults
          .filter((_, index) => index !== primaryIndex)
          .map((result) => result.line)
      ].filter(Boolean)
    )
  ];
};

const readProviderAddons = async () => {
  /**
   * @type {unknown}
   */
  let registry;
  try {
    registry = JSON.parse(
      await readFile(
        new URL("statusline/providers.json", import.meta.url),
        "utf-8"
      )
    );
  } catch (error) {
    if (truthy(process.env.STATUSLINE_DEBUG)) {
      console.error("[statusline] provider registry unavailable", error);
    }
    return [];
  }
  return array(registry).flatMap((entry) => {
    const provider = record(entry);
    const { name, module, credentialEnv } = provider;
    if (
      typeof name !== "string" ||
      typeof module !== "string" ||
      path.basename(module) !== module ||
      !module.endsWith(".mjs")
    ) {
      return [];
    }
    return [
      {
        ...provider,
        credential:
          typeof credentialEnv === "string"
            ? (process.env[credentialEnv] ?? "")
            : "",
        script: `./statusline/${module}`,
        showAbove: provider.showAbove ?? 0.001
      }
    ];
  });
};

export const main = async () => {
  try {
    /**
     * @type {unknown}
     */
    const parsed = JSON.parse(readFileSync(0, "utf-8"));
    const input = record(parsed);
    const rows = await renderStatusline(input, {
      addons: await readProviderAddons(),
      cwd: textOr(record(input.workspace).current_dir, process.cwd())
    });
    process.stdout.write(`${rows.join("\n")}\n`);
  } catch (error) {
    if (truthy(process.env.STATUSLINE_DEBUG)) {
      console.error("[statusline] unavailable input or providers", error);
    }
  }
};

if (process.argv[1]) {
  let isEntrypoint = false;
  try {
    isEntrypoint =
      realpathSync(path.resolve(process.argv[1])) ===
      realpathSync(import.meta.filename);
  } catch {
    isEntrypoint = false;
  }
  if (isEntrypoint) {
    await main();
  }
}
