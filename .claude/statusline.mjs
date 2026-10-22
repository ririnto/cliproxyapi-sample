#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

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

const displayText = (value) =>
  stripVTControlCharacters(`${value}`).replaceAll(
    /[\p{Cc}\u{2028}\u{2029}]+/gu,
    " "
  );

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const metricPercentage = (metric) => {
  if (metric?.type === "usage") {
    return metric.total > 0 ? (metric.used / metric.total) * 100 : 0;
  }
  return metric?.percentage ?? 0;
};

const environmentValue = (name, environment) =>
  environment && Object.hasOwn(environment, name)
    ? (environment[name] ?? "")
    : (process.env[name] ?? "");

const homePath = (value, home) =>
  value.startsWith("~/") ? path.join(home, value.slice(2)) : value;

const replaceEnvironmentReferences = (value, environment) =>
  value.replaceAll(/\{env:(?<name>[^{}]+)\}/gu, (placeholder) =>
    String(environmentValue(placeholder.slice(5, -1), environment))
  );

const referenceText = async (reference, home, baseDir) => {
  const [, referencePath] = reference;
  if (!referencePath) {
    return reference[0];
  }
  const pathValue = homePath(referencePath, home);
  const filePath = path.isAbsolute(pathValue)
    ? pathValue
    : path.resolve(baseDir, pathValue);
  try {
    const contents = await readFile(filePath, "utf-8");
    return contents.trim();
  } catch {
    return reference[0];
  }
};

const spliceReferences = (value, references, texts) => {
  const last = references.at(-1);
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

const replaceFileReferences = async (value, options) => {
  const home = options.home ?? homedir();
  const baseDir = options.baseDir ?? process.cwd();
  const references = [
    ...value.matchAll(/\{file:(?<fileReferencePath>[^{}]*)\}/gu)
  ];
  if (!references.length) {
    return value;
  }
  const texts = await Promise.all(
    references.map((reference) => referenceText(reference, home, baseDir))
  );
  return spliceReferences(value, references, texts);
};

const resolveCredentialReference = (value, options = {}) =>
  typeof value === "string"
    ? replaceFileReferences(
        replaceEnvironmentReferences(value, options.environment),
        options
      )
    : value;

const scaledText = (number, divisor, suffix) =>
  `${(number / divisor).toFixed(1).replace(/\.0$/u, "")}${suffix}`;

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

const usageBar = (percentage) => {
  const steps = Math.max(
    percentage > 0 ? 1 : 0,
    Math.min(8, Math.round((percentage / 100) * 8))
  );
  return "▰".repeat(steps) + DIM + "▱".repeat(8 - steps);
};

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

const metricDisplay = (metric) => {
  if (!metric || typeof metric !== "object") {
    return "";
  }
  if (metric.type === "usage") {
    return `${numberText(metric.used)}/${numberText(metric.total)}`;
  }
  if (metric.type === "credit") {
    if (metric.currency === "USD") {
      return `$${metric.remaining.toFixed(2)}`;
    }
    return Number.isFinite(Number(metric.remaining))
      ? numberText(metric.remaining)
      : String(metric.remaining);
  }
  return metric.type === "budget"
    ? `$${Number(metric.used || 0).toFixed(2)}/$${Number(metric.total || 0).toFixed(2)}`
    : `${Number(Math.max(0, 100 - Number(metric.percentage || 0)).toFixed(1))}% left`;
};

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

const thresholdFor = (showAbove, groupLabel, metricLabel) =>
  showAbove && typeof showAbove === "object" && !Array.isArray(showAbove)
    ? Number(showAbove[metricLabel] ?? showAbove[groupLabel] ?? 0)
    : Number(showAbove || 0);

const renderMetric = (metric) => {
  const reset = metric.resetsInMs ?? metric.resets_in_ms;
  return `${displayText(metric.label)} ${barColor(metricPercent(metric))}${displayText(metricDisplay(metric))}${RESET}${reset === undefined ? "" : ` ${DIM}↻${resetText(reset)}${RESET}`}`;
};

const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

const windowPercentage = (window) => {
  const percentage = window?.used_percentage;
  return isFiniteNumber(percentage) && percentage >= 0 ? percentage : null;
};

const spendDollarPair = (window) => {
  const used = window?.used_usd;
  const limit = window?.limit_usd;
  return isFiniteNumber(used) && used >= 0 && isFiniteNumber(limit) && limit > 0
    ? { limit, used }
    : null;
};

const spendPercentage = (window) => {
  const percentage = window?.used_percentage;
  return isFiniteNumber(percentage) && percentage >= 0 ? percentage : null;
};

const nativeUsageFor = (rateLimits) => {
  if (!isRecord(rateLimits)) {
    return null;
  }
  const windows = [rateLimits.five_hour, rateLimits.seven_day].some(
    (window) => windowPercentage(window) !== null
  );
  return (
    windows ||
    spendPercentage(rateLimits.spend_limit) !== null ||
    spendDollarPair(rateLimits.spend_limit) !== null
  );
};

const windowRow = (key, label, rateLimits, nowMs) => {
  const window = rateLimits?.[key];
  const percentage = windowPercentage(window);
  if (percentage === null) {
    return "";
  }
  return renderMetric({
    label,
    percentage,
    resetsInMs: Math.trunc(Number(window.resets_at || 0) * 1000 - nowMs),
    type: "percentage"
  });
};

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

const spendRow = (rateLimits, nowMs) => {
  const spend = rateLimits?.spend_limit;
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

const renderRateLimits = (rateLimits, nowMs) =>
  [
    windowRow("five_hour", "5h", rateLimits, nowMs),
    windowRow("seven_day", "7d", rateLimits, nowMs),
    spendRow(rateLimits, nowMs)
  ].filter(Boolean);

const metricEntries = (group) =>
  isRecord(group) && Array.isArray(group.metrics)
    ? group.metrics.filter(
        (metric) =>
          metric &&
          typeof metric === "object" &&
          typeof metric.label === "string"
      )
    : [];

const hiddenLabel = (metric, hideLabels) =>
  Array.isArray(hideLabels) && hideLabels.includes(metric.label);

export const renderSnapshot = (addon, snapshot) => {
  if (!snapshot || !Array.isArray(snapshot.groups)) {
    return "";
  }
  return snapshot.groups
    .map((group) => {
      const metrics = metricEntries(group).filter(
        (metric) =>
          !hiddenLabel(metric, addon.hideLabels) &&
          metricPercent(metric) >=
            thresholdFor(addon.showAbove, group.label || "", metric.label)
      );
      if (!metrics.length) {
        return "";
      }
      const content = metrics.map(renderMetric).join(SEPARATOR);
      const groupName =
        typeof group.label === "string" && group.label
          ? group.label
          : addon.name;
      const displayName = group.label || !addon.hideName ? groupName : "";
      const name = displayName
        ? `${PROVIDER}${displayText(displayName).replace(/\s+\((?:Pro|Individual)\)$/u, "")}${RESET}`
        : "";
      return displayName ? `${name}  ${content}` : content;
    })
    .filter(Boolean)
    .join(GROUP_SEPARATOR);
};

const addonSettings = (addons) =>
  Array.isArray(addons)
    ? addons
        .filter(
          (addon) =>
            addon &&
            typeof addon === "object" &&
            addon.enabled !== false &&
            typeof addon.script === "string" &&
            addon.script.trim()
        )
        .map((addon) => ({ ...addon, script: addon.script.trim() }))
    : [];

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

const importAddonModule = async (addon, options) => {
  const module = await (options.importModule || ((url) => import(url)))(
    pathToFileURL(scriptPath(addon.script))
  );
  return typeof module.fetchUsage === "function" ? module : undefined;
};

const renderAddonResults = async (addons, options = {}) => {
  const settingsDir = options.settingsDir || path.join(homedir(), ".claude");
  const results = await Promise.all(
    addonSettings(addons)
      .filter((addon) => !(options.nativeUsage && addon.provider === "claude"))
      .map(async (addon) => {
        try {
          const module = await importAddonModule(addon, options);
          const snapshot = module
            ? await module.fetchUsage({
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
  return results.filter(Boolean);
};

export const renderAddons = async (addons, options = {}) => {
  const results = await renderAddonResults(addons, options);
  return results.map((result) => result.line);
};

const projectDisplay = (workspace) => {
  const currentDir =
    workspace?.current_dir || workspace?.project_dir || process.cwd();
  const projectDir = workspace?.project_dir || currentDir;
  const projectName = path.basename(projectDir);
  return currentDir === projectDir
    ? projectName
    : `${projectName}/${path.basename(currentDir)}`;
};

const renderContext = (input) => {
  const context = input.context_window || {};
  const value = Number(context.used_percentage);
  const known =
    context.used_percentage !== null &&
    context.used_percentage !== undefined &&
    Number.isFinite(value);
  const percentage = known ? Math.max(0, Math.min(100, Math.trunc(value))) : 0;
  const size = Math.trunc(Number(context.context_window_size || 0));
  return known
    ? `Context ${barColor(percentage)}${usageBar(percentage)}${RESET} ${barColor(percentage)}${percentage}%${RESET}${size ? ` ${DIM}/ ${numberText(size)}${RESET}` : ""}`
    : `Context ${DIM}${size ? numberText(size) : "waiting"}${RESET}`;
};

const renderHeader = (input, options) => {
  const model = input.model || {};
  const modelName = model.display_name || model.id || "Claude";
  const effort = input.effort?.level || model.effort || "";
  const workspace = input.workspace || {};
  const cost = input.cost || {};
  const dollars = Number(cost.total_cost_usd || 0);
  const seconds = Math.trunc(Number(cost.total_duration_ms || 0) / 1000);
  const details = [
    ...(dollars > 0 ? [`$${dollars.toFixed(2)}`] : []),
    ...(seconds > 0
      ? [seconds < 60 ? `${seconds}s` : `${Math.trunc(seconds / 60)}m`]
      : [])
  ];
  const branch =
    options.branch === undefined
      ? gitBranch(options.cwd || workspace.current_dir || process.cwd())
      : options.branch;
  return [
    `${MODEL_COLOR}${BOLD}${displayText(modelName)}${RESET}${effort ? ` ${DIM}${displayText(effort)}${RESET}` : ""}`,
    `${GREEN}${displayText(projectDisplay(workspace))}${RESET}`,
    ...(branch ? [`${BLUE}${displayText(branch)}${RESET}`] : []),
    ...(details.length ? [`${DIM}${details.join(" · ")}${RESET}`] : []),
    renderContext(input)
  ].join(SEPARATOR);
};

const renderTokens = (input) => {
  const context = input.context_window || {};
  const usage = context.current_usage || {};
  const metrics = [
    ["in", context.total_input_tokens],
    ["out", context.total_output_tokens],
    ["cache read", usage.cache_read_input_tokens],
    ["cache write", usage.cache_creation_input_tokens]
  ].filter(([, value]) => Number(value) > 0);
  return metrics.length
    ? `${DIM}${metrics.map(([label, value]) => `${label} ${numberText(value)}`).join(" · ")}${RESET}`
    : "";
};

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
    const padding = " ".repeat(
      Math.max(0, columnWidth - stripVTControlCharacters(left).length)
    );
    const combined = `${left}${padding}${GROUP_SEPARATOR}${right}`;
    return stripVTControlCharacters(combined).length <= 120
      ? [combined]
      : [left, right];
  });
};

export const renderStatusline = async (input, options = {}) => {
  const nowMs = options.nowMs ?? Date.now();
  const nativeRate = renderRateLimits(input.rate_limits || {}, nowMs);
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
  const providerRows = packProviderRows(
    [
      primary,
      ...addonResults
        .filter((_, index) => index !== primaryIndex)
        .map((result) => result.line)
    ].filter(Boolean)
  );
  return [header, ...providerRows];
};

const readSettings = async (filePath) => {
  try {
    return JSON.parse(await readFile(filePath, "utf-8"));
  } catch {
    return null;
  }
};

export const main = async () => {
  try {
    const input = JSON.parse(readFileSync(0, "utf-8"));
    const globalSettingsDir =
      process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
    const projectDir = input.workspace?.project_dir;
    const projectSettings =
      typeof projectDir === "string"
        ? await readSettings(path.join(projectDir, ".claude", "settings.json"))
        : null;
    const useProject =
      projectSettings && Array.isArray(projectSettings.statusLineAddon);
    const settings = useProject
      ? projectSettings
      : (await readSettings(path.join(globalSettingsDir, "settings.json"))) ||
        {};
    const rows = await renderStatusline(input, {
      addons: settings.statusLineAddon || [],
      cwd: input.workspace?.current_dir || process.cwd(),
      settingsDir: useProject
        ? path.join(projectDir, ".claude")
        : globalSettingsDir
    });
    process.stdout.write(`${rows.join("\n")}\n`);
  } catch (error) {
    if (process.env.STATUSLINE_DEBUG) {
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
