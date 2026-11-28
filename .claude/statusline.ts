#!/usr/bin/env node

import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delayMs } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

import type { Snapshot } from "./statusline/types.ts";
import { withUsageCache } from "./statusline/usage-cache.ts";

type RecordValue = Record<string, unknown>;
type ProviderAddon = RecordValue & { script: string; credential: string };
interface ProviderLine {
  line: string;
  primary: boolean;
  fetchedAt: number | null;
}
interface ProviderUpdate {
  index: number;
  result: ProviderLine;
}

const responseBudgetMs = 800;
const staleUsageMs = 30 * 60_000;

/**
 * @param {unknown} value - Untrusted input.
 * @returns {RecordValue} Object fields or an empty record.
 */
const record = (value: unknown): RecordValue => (isRecord(value) ? value : {});
/**
 * @param {unknown} value - Untrusted list.
 * @returns {unknown[]} Array elements or an empty list.
 */
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
/**
 * @param {unknown} value - Untrusted path.
 * @param {string} fallback - Default path.
 */
const textOr = (value: unknown, fallback = "") =>
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
const truthyOr = (value: unknown, alternative: unknown) =>
  truthy(value) ? value : alternative;

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
const displayText = (value: unknown) =>
  stripVTControlCharacters(String(value)).replaceAll(
    /[\p{Cc}\u{2028}\u{2029}]+/gu,
    " "
  );

/**
 * @param {unknown} value - value input.
 * @returns {value is RecordValue} Whether value has object fields.
 */
const isRecord = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * @param {RecordValue} metric - metric input.
 */
const metricPercentage = (metric: RecordValue) => {
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
const scaledText = (number: number, divisor: number, suffix: string) =>
  `${(number / divisor).toFixed(1).replace(/\.0$/u, "")}${suffix}`;

/**
 * @param {unknown} value - value input.
 */
const numberText = (value: unknown) => {
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
const resetText = (milliseconds: unknown) => {
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
const barColor = (percentage: number) => {
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
const usageBar = (percentage: number) => {
  const steps = Math.max(
    percentage > 0 ? 1 : 0,
    Math.min(8, Math.round((percentage / 100) * 8))
  );
  return "▰".repeat(steps) + DIM + "▱".repeat(8 - steps);
};

/**
 * @param {string} cwd - cwd input.
 */
const gitBranch = async (cwd: string) => {
  try {
    const git = spawn("git", ["branch", "--show-current"], {
      cwd,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 150
    });
    let stdout = "";
    git.stdout.setEncoding("utf-8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 4096) {
        git.kill("SIGKILL");
      }
    });
    const result: unknown[] = await once(git, "close");
    const [code] = result;
    return code === 0 ? stdout.trim() : "";
  } catch {
    return "";
  }
};

/**
 * @param {RecordValue} metric - metric input.
 */
const metricDisplay = (metric: RecordValue) => {
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
const metricPercent = (metric: RecordValue) => {
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
const thresholdFor = (
  showAbove: unknown,
  groupLabel: string,
  metricLabel: string
) =>
  isRecord(showAbove)
    ? Number(showAbove[metricLabel] ?? showAbove[groupLabel] ?? 0)
    : Number(truthyOr(showAbove, 0));

/**
 * @param {RecordValue} metric - metric input.
 */
const renderMetric = (metric: RecordValue) => {
  const reset = metric.resetsInMs ?? metric.resets_in_ms;
  return `${displayText(metric.label)} ${barColor(metricPercent(metric))}${displayText(metricDisplay(metric))}${RESET}${reset === undefined ? "" : ` ${DIM}↻${resetText(reset)}${RESET}`}`;
};

/**
 * @param {unknown} value - value input.
 * @returns {value is number} Whether value is finite.
 */
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * @param {unknown} window - window input.
 */
const usedPercentage = (window: unknown) => {
  const percentage = record(window).used_percentage;
  return isFiniteNumber(percentage) && percentage >= 0 ? percentage : null;
};

/**
 * @param {unknown} window - window input.
 */
const spendDollarPair = (window: unknown) => {
  const used = record(window).used_usd;
  const limit = record(window).limit_usd;
  return isFiniteNumber(used) && used >= 0 && isFiniteNumber(limit) && limit > 0
    ? { limit, used }
    : null;
};

/**
 * @param {unknown} rateLimits - rateLimits input.
 */
const nativeUsageFor = (rateLimits: unknown) => {
  if (!isRecord(rateLimits)) {
    return false;
  }
  return (
    [rateLimits.five_hour, rateLimits.seven_day].some(
      (window) => usedPercentage(window) !== null
    ) ||
    usedPercentage(rateLimits.spend_limit) !== null ||
    spendDollarPair(rateLimits.spend_limit) !== null
  );
};

/**
 * @param {string} key - key input.
 * @param {string} label - label input.
 * @param {RecordValue} rateLimits - rateLimits input.
 * @param {number} nowMs - nowMs input.
 */
const windowRow = (
  key: string,
  label: string,
  rateLimits: RecordValue,
  nowMs: number
) => {
  const window = rateLimits?.[key];
  const percentage = usedPercentage(window);
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
 * @param {RecordValue} rateLimits - rateLimits input.
 * @param {number} nowMs - nowMs input.
 */
const spendRow = (rateLimits: RecordValue, nowMs: number) => {
  const spend = record(rateLimits.spend_limit);
  const dollars = spendDollarPair(spend);
  const percentage = dollars
    ? (dollars.used / dollars.limit) * 100
    : usedPercentage(spend);
  if (percentage === null) {
    return "";
  }
  const metric = dollars
    ? {
        label: "spend",
        percentage,
        total: dollars.limit,
        type: "budget",
        used: dollars.used
      }
    : { label: "spend", percentage, type: "percentage" };
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
const renderRateLimits = (rateLimits: RecordValue, nowMs: number) =>
  [
    windowRow("five_hour", "5h", rateLimits, nowMs),
    windowRow("seven_day", "7d", rateLimits, nowMs),
    spendRow(rateLimits, nowMs)
  ].filter(Boolean);

/**
 * @param {RecordValue} addon - addon input.
 * @param {unknown} snapshot - snapshot input.
 */
const renderSnapshot = (addon: RecordValue, snapshot: unknown) => {
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
 * @param {string} script - script input.
 */
const scriptPath = (script: string) => {
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

/** @type {import("./statusline/types.ts").UsageRuntime["requestJson"]} */
const requestJson: import("./statusline/types.ts").UsageRuntime["requestJson"] =
  async (url, headers, fetchFunction, onUsageError) => {
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
        const payload: unknown = await response.json();
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

const usageRuntime = { withUsageCache, requestJson };

const importAddonModule = async (script: string) => {
  /**
   * @type {unknown}
   */
  const module: unknown = await import(pathToFileURL(scriptPath(script)).href);
  if (!isRecord(module) || typeof module.fetchUsage !== "function") {
    return null;
  }
  const { fetchUsage } = module;
  /**
   * @param {RecordValue} input - Provider request.
   * @returns {unknown} Provider result.
   */
  return (input: RecordValue): unknown =>
    Reflect.apply(fetchUsage, module, [input, usageRuntime]);
};

const refreshAddons = async (nativeUsage: boolean) => {
  const addons = await readProviderAddons();
  await Promise.all(
    addons.map(async (addon, index) => {
      if (!(nativeUsage && addon.skipWhenNativeUsage === true)) {
        const publish = (snapshot: unknown) => {
          if (isRecord(snapshot) && process.connected) {
            const { fetchedAt } = snapshot;
            process.send?.(
              {
                index,
                result: {
                  line: renderSnapshot(addon, snapshot),
                  primary: Boolean(addon.primary),
                  fetchedAt:
                    isFiniteNumber(fetchedAt) &&
                    Number.isFinite(new Date(fetchedAt).getTime())
                      ? fetchedAt
                      : null
                }
              } satisfies ProviderUpdate,
              (error) => {
                if (
                  error &&
                  process.connected &&
                  process.env.STATUSLINE_DEBUG === "1"
                ) {
                  console.error(
                    "[statusline] provider usage update unavailable"
                  );
                }
              }
            );
          }
        };
        try {
          const fetchUsage = await importAddonModule(addon.script);
          if (fetchUsage !== null) {
            publish(
              await fetchUsage({
                credential: addon.credential,
                onCachedUsage: (_key: string, snapshot: Snapshot | null) => {
                  publish(snapshot);
                }
              })
            );
          }
        } catch {
          if (process.env.STATUSLINE_DEBUG === "1") {
            console.error("[statusline] provider usage unavailable");
          }
        }
      }
    })
  );
};

/**
 * @param {RecordValue} input - input input.
 */
const renderContext = (input: RecordValue) => {
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

const renderHeader = (input: RecordValue, branch: string) => {
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
  const currentDir = textOr(
    workspace.current_dir,
    textOr(workspace.project_dir, process.cwd())
  );
  const projectDir = textOr(workspace.project_dir, currentDir);
  const projectName = path.basename(projectDir);
  return [
    `${MODEL_COLOR}${BOLD}${displayText(modelName)}${RESET}${truthy(effort) ? ` ${DIM}${displayText(effort)}${RESET}` : ""}`,
    `${GREEN}${displayText(currentDir === projectDir ? projectName : `${projectName}/${path.basename(currentDir)}`)}${RESET}`,
    ...(branch ? [`${BLUE}${displayText(branch)}${RESET}`] : []),
    ...(details.length ? [`${DIM}${details.join(" · ")}${RESET}`] : []),
    renderContext(input)
  ].join(SEPARATOR);
};

/**
 * @param {RecordValue} input - input input.
 */
const renderTokens = (input: RecordValue) => {
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
const packProviderRows = (rows: string[]) => {
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

const renderStatusline = (
  input: RecordValue,
  addonResults: ProviderLine[],
  branch: string
) => {
  const now = Date.now();
  const nativeRate = renderRateLimits(record(input.rate_limits), now);
  const addonLine = ({ line, fetchedAt }: ProviderLine) =>
    fetchedAt !== null && now - fetchedAt > staleUsageMs
      ? `${line} ${DIM}· cached ${new Date(fetchedAt).toISOString().slice(0, 16).replace("T", " ")} UTC${RESET}`
      : line;
  const primaryIndex = nativeRate.length
    ? -1
    : addonResults.findIndex((result) => result.primary);
  let primary = "";
  if (nativeRate.length > 0) {
    primary = `${PROVIDER}Claude${RESET}  ${nativeRate.join(SEPARATOR)}`;
  } else if (primaryIndex >= 0) {
    primary = addonLine(addonResults[primaryIndex]);
  }
  return [
    [renderHeader(input, branch), renderTokens(input)]
      .filter(Boolean)
      .join(SEPARATOR),
    ...packProviderRows(
      [
        primary,
        ...addonResults
          .filter((_, index) => index !== primaryIndex)
          .map(addonLine)
      ].filter(Boolean)
    )
  ];
};

const readProviderAddons = async (): Promise<ProviderAddon[]> => {
  /**
   * @type {unknown}
   */
  let registry: unknown;
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
    const { enabled, name, module, credentialEnv } = provider;
    if (
      enabled === false ||
      typeof name !== "string" ||
      typeof module !== "string" ||
      path.basename(module) !== module ||
      !module.endsWith(".ts")
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

const main = async () => {
  try {
    /**
     * @type {unknown}
     */
    const parsed: unknown = JSON.parse(readFileSync(0, "utf-8"));
    const input = record(parsed);
    const deadline = performance.now() + responseBudgetMs;
    const results: ProviderLine[] = [];
    const child = fork(
      import.meta.filename,
      ["--refresh-usage", String(nativeUsageFor(input.rate_limits))],
      { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] }
    );
    child.on("message", ({ index, result }: ProviderUpdate) => {
      results[index] = result;
    });
    child.unref();
    const refresh = once(child, "close").catch(() => {
      if (process.env.STATUSLINE_DEBUG === "1") {
        console.error("[statusline] provider usage collection unavailable");
      }
    });
    let branch = "";
    const lookupBranch = async () => {
      branch = await gitBranch(
        textOr(record(input.workspace).current_dir, process.cwd())
      );
    };
    const timer = new AbortController();
    try {
      await Promise.race([
        delayMs(Math.max(0, deadline - performance.now()), null, {
          signal: timer.signal
        }),
        Promise.all([lookupBranch(), refresh])
      ]);
    } finally {
      timer.abort();
      if (child.connected) {
        child.disconnect();
      }
    }
    const rows = renderStatusline(
      input,
      results.filter(({ line }) => line.length > 0),
      branch
    );
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
    if (process.argv[2] === "--refresh-usage") {
      setTimeout(() => process.exit(1), 20_000).unref();
      await refreshAddons(process.argv[3] === "true");
    } else {
      await main();
    }
  }
}
