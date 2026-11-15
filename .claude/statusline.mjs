#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

/**
 * @typedef {Record<string, unknown>} RecordValue
 */
/**
 * @typedef {{home?: string, baseDir?: string, environment?: Record<string, string | undefined>}} ReferenceOptions
 */
/**
 * @typedef {{addons?: unknown, branch?: string, cwd?: string, nowMs?: number, nativeUsage?: boolean | null, settingsDir?: string, importModule?: (url: URL) => unknown}} RenderOptions
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
 * @param {string} name - name input.
 * @param {ReferenceOptions["environment"]} environment - environment input.
 */
const environmentValue = (name, environment) =>
  environment !== undefined && Object.hasOwn(environment, name)
    ? (environment[name] ?? "")
    : (process.env[name] ?? "");

/**
 * @param {string} value - value input.
 * @param {ReferenceOptions["environment"]} environment - environment input.
 */
const replaceEnvironmentReferences = (value, environment) =>
  value.replaceAll(/\{env:(?<name>[^{}]+)\}/gu, (placeholder) =>
    environmentValue(placeholder.slice(5, -1), environment)
  );

/**
 * @param {RegExpExecArray} reference - reference input.
 * @param {string} home - home input.
 * @param {string} baseDir - baseDir input.
 */
const referenceText = async (reference, home, baseDir) => {
  const [, referencePath] = reference;
  if (!referencePath) {
    return reference[0];
  }
  const pathValue = referencePath.startsWith("~/")
    ? path.join(home, referencePath.slice(2))
    : referencePath;
  const filePath = path.isAbsolute(pathValue)
    ? pathValue
    : path.resolve(baseDir, pathValue);
  try {
    const text = await readFile(filePath, "utf-8");
    return text.trim();
  } catch {
    return reference[0];
  }
};

/**
 * @param {string} value - value input.
 * @param {RegExpExecArray[]} references - references input.
 * @param {string[]} texts - texts input.
 */
const spliceReferences = (value, references, texts) => {
  const last = references.at(-1);
  if (last === undefined) {
    return value;
  }
  return (
    references
      .map(
        (reference, index) =>
          value.slice(
            index
              ? references[index - 1].index + references[index - 1][0].length
              : 0,
            reference.index
          ) + texts[index]
      )
      .join("") + value.slice(last.index + last[0].length)
  );
};

/**
 * @param {string} value - value input.
 * @param {ReferenceOptions} options - options input.
 */
const replaceFileReferences = async (value, options) => {
  const home = options.home ?? homedir();
  const baseDir = options.baseDir ?? process.cwd();
  const references = [
    ...value.matchAll(/\{file:(?<fileReferencePath>[^{}]*)\}/gu)
  ];
  if (!references.length) {
    return value;
  }
  return spliceReferences(
    value,
    references,
    await Promise.all(
      references.map(
        async (reference) => await referenceText(reference, home, baseDir)
      )
    )
  );
};

/**
 * @param {unknown} value - value input.
 * @param {ReferenceOptions} options - options input.
 */
const resolveCredentialReference = async (value, options = {}) =>
  typeof value === "string"
    ? await replaceFileReferences(
        replaceEnvironmentReferences(value, options.environment),
        options
      )
    : value;

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
 * @param {unknown} group - group input.
 */
const metricEntries = (group) =>
  isRecord(group)
    ? array(group.metrics)
        .filter(isRecord)
        .filter((metric) => typeof metric.label === "string")
    : [];

/**
 * @param {RecordValue} metric - metric input.
 * @param {unknown} hideLabels - hideLabels input.
 */
const hiddenLabel = (metric, hideLabels) =>
  Array.isArray(hideLabels) && hideLabels.includes(metric.label);

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
      const metrics = metricEntries(group).filter(
        (metric) =>
          !hiddenLabel(metric, addon.hideLabels) &&
          metricPercent(metric) >=
            thresholdFor(
              addon.showAbove,
              textOr(group.label),
              String(metric.label)
            )
      );
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
   */
  const invoke = (input) => {
    /**
     * @type {unknown}
     */
    const result = Reflect.apply(fetchUsage, module, [input]);
    return result;
  };
  return invoke;
};

/**
 * @param {unknown} addons - addons input.
 * @param {RenderOptions} options - options input.
 */
const renderAddonResults = async (addons, options = {}) => {
  const settingsDir = textOr(
    options.settingsDir,
    path.join(homedir(), ".claude")
  );
  const results = await Promise.all(
    addonSettings(addons)
      .filter(
        (addon) =>
          !(options.nativeUsage === true && addon.provider === "claude")
      )
      .map(async (addon) => {
        try {
          const module = await importAddonModule(addon, options);
          /**
           * @type {unknown}
           */
          const snapshot = module
            ? await module({
                baseDir: settingsDir,
                credential: Object.hasOwn(addon, "credential")
                  ? await resolveCredentialReference(addon.credential, {
                      baseDir: settingsDir
                    })
                  : ""
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
 * @param {unknown} addons - addons input.
 * @param {RenderOptions} options - options input.
 */
export const renderAddons = async (addons, options = {}) => {
  const results = await renderAddonResults(addons, options);
  return results.map((result) => result.line);
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
  let modelName = model.display_name;
  if (!truthy(modelName)) {
    modelName = truthyOr(model.id, "Claude");
  }
  let effort = record(input.effort).level;
  if (!truthy(effort)) {
    effort = truthyOr(model.effort, "");
  }
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

/**
 * @param {string} filePath - filePath input.
 */
const readSettings = async (filePath) => {
  try {
    /**
     * @type {unknown}
     */
    const parsed = JSON.parse(await readFile(filePath, "utf-8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const main = async () => {
  try {
    /**
     * @type {unknown}
     */
    const parsed = JSON.parse(readFileSync(0, "utf-8"));
    const input = record(parsed);
    const globalSettingsDir = textOr(
      process.env.CLAUDE_CONFIG_DIR,
      path.join(homedir(), ".claude")
    );
    const projectDir = record(input.workspace).project_dir;
    const projectSettings =
      typeof projectDir === "string"
        ? await readSettings(path.join(projectDir, ".claude", "settings.json"))
        : null;
    const useProject =
      projectSettings !== null &&
      Array.isArray(projectSettings.statusLineAddon);
    const rows = await renderStatusline(input, {
      addons:
        (useProject
          ? projectSettings
          : await readSettings(path.join(globalSettingsDir, "settings.json"))
        )?.statusLineAddon ?? [],
      cwd: textOr(record(input.workspace).current_dir, process.cwd()),
      settingsDir: useProject
        ? path.join(String(projectDir), ".claude")
        : globalSettingsDir
    });
    process.stdout.write(`${rows.join("\n")}\n`);
  } catch (error) {
    if (truthy(process.env.STATUSLINE_DEBUG)) {
      console.error("[statusline] unavailable input or settings", error);
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
