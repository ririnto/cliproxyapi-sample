#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

const RESET = "[0m";
const DIM = "[2m";
const PCT_GREEN = 70;
const PCT_YELLOW = 90;

const displayText = (value) =>
  stripVTControlCharacters(String(value)).replaceAll(
    /[\p{Cc}\u2028\u2029]+/gu,
    " "
  );

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const metricPercentage = (metric) => {
  let percentage;
  if (metric?.type === "usage") {
    percentage = metric.total > 0 ? (metric.used / metric.total) * 100 : 0;
  } else {
    percentage = metric?.percentage ?? 0;
  }
  return percentage;
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

const readFileReference = async (reference, home, baseDir) => {
  const pathValue = homePath(reference[1], home);
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

const substituteFileReferences = async (value, references, home, baseDir) => {
  const referenceTexts = await Promise.all(
    references.map(async (reference) =>
      reference[1]
        ? await readFileReference(reference, home, baseDir)
        : reference[0]
    )
  );
  let cursor = 0;
  let result = "";
  for (const [index, reference] of references.entries()) {
    result += value.slice(cursor, reference.index) + referenceTexts[index];
    cursor = reference.index + reference[0].length;
  }
  return result + value.slice(cursor);
};

const replaceFileReferences = async (value, options) => {
  const home = options.home ?? homedir();
  const baseDir = options.baseDir ?? process.cwd();
  const references = [
    ...value.matchAll(/\{file:(?<fileReferencePath>[^{}]*)\}/gu)
  ];
  return references.length
    ? await substituteFileReferences(value, references, home, baseDir)
    : value;
};

const resolveCredentialReference = async (value, options = {}) =>
  typeof value === "string"
    ? await replaceFileReferences(
        replaceEnvironmentReferences(value, options.environment),
        options
      )
    : value;

const numberText = (value) => {
  const number = Number(value);
  let result;
  if (!Number.isFinite(number)) {
    result = "0";
  } else if (number >= 1_000_000) {
    result = `${(number / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
  } else if (number >= 1000) {
    result = `${(number / 1000).toFixed(1).replace(/\.0$/u, "")}k`;
  } else {
    result = String(Math.trunc(number));
  }
  return result;
};

const resetText = (milliseconds) => {
  const value = Number(milliseconds);
  let result = "unknown";
  if (Number.isFinite(value) && value > 0) {
    const seconds = value / 1000;
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    result = days < 1 ? `${hours}h ${minutes}m` : `${days}d ${hours}h`;
  }
  return result;
};

const barColor = (percentage) => {
  let color;
  if (percentage <= PCT_GREEN) {
    color = "\u001B[32m";
  } else if (percentage <= PCT_YELLOW) {
    color = "\u001B[33m";
  } else {
    color = "\u001B[31m";
  }
  return color;
};

const usageBar = (percentage) => {
  const steps = Math.max(0, Math.min(10, Math.floor((percentage + 9) / 10)));
  return "▓".repeat(steps) + "░".repeat(10 - steps);
};

const gitBranch = (cwd) => {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf-8",
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000
    }).trim();
  } catch {
    return "";
  }
};

const metricDisplay = (metric) => {
  let display;
  if (!metric || typeof metric !== "object") {
    display = "";
  } else if (metric.type === "usage") {
    display = `${metric.used}/${metric.total}`;
  } else if (metric.type === "budget") {
    display = `$${Number(metric.used || 0).toFixed(2)}/$${Number(metric.total || 0).toFixed(2)}`;
  } else {
    display = `${Number(metric.percentage || 0)}%`;
  }
  return display;
};

const metricPercent = (metric) => {
  try {
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
  return `${displayText(metric.label)}: ${barColor(metricPercent(metric))}${displayText(metricDisplay(metric))}${RESET}${reset === undefined ? "" : ` (${resetText(reset)})`}`;
};

const renderRateLimits = (rateLimits, nowMs) =>
  [
    ["five_hour", "5h"],
    ["seven_day", "7d"]
  ]
    .map(([key, label]) => {
      const window = rateLimits?.[key];
      return isRecord(window)
        ? renderMetric({
            label,
            percentage: Number(window.used_percentage || 0),
            resetsInMs: Math.trunc(
              Number(window.resets_at || 0) * 1000 - nowMs
            ),
            type: "percentage"
          })
        : "";
    })
    .filter(Boolean)
    .join(" | ");

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

/**
 * Format a usage snapshot as one ANSI-colored line without fetching data.
 * Rendering errors propagate to the caller.
 * @param {object} addon Display name, hidden metric labels, and usage thresholds.
 * @param {object} snapshot Usage groups containing labeled metrics.
 * @returns {string} Visible groups joined by separators, or an empty string when
 * the snapshot has no groups or every metric is filtered out.
 */
export const renderSnapshot = (addon, snapshot) =>
  snapshot && Array.isArray(snapshot.groups)
    ? snapshot.groups
        .map((group) => {
          const metrics = metricEntries(group).filter(
            (metric) =>
              !hiddenLabel(metric, addon.hideLabels) &&
              metricPercent(metric) >=
                thresholdFor(addon.showAbove, group.label || "", metric.label)
          );
          let line = "";
          if (metrics.length) {
            const content = metrics.map(renderMetric).join(" | ");
            const groupName =
              typeof group.label === "string" && group.label
                ? group.label
                : addon.name;
            const displayName = group.label || !addon.hideName ? groupName : "";
            line = displayName
              ? `${displayText(displayName)} | ${content}`
              : content;
          }
          return line;
        })
        .filter(Boolean)
        .join(" | ")
    : "";

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
  let result;
  if (script === "~") {
    result = home;
  } else {
    const expanded = script.startsWith("~/")
      ? path.join(home, script.slice(2))
      : script;
    result = path.isAbsolute(expanded)
      ? expanded
      : fileURLToPath(new URL(expanded, import.meta.url));
  }
  return result;
};

const importAddonModule = async (addon, options) => {
  const filePath = scriptPath(addon.script);
  const importFunction = options.importModule || ((url) => import(url));
  const module = await importFunction(pathToFileURL(filePath));
  return typeof module.fetchUsage === "function" ? module : undefined;
};

const renderAddonResults = async (addons, options = {}) => {
  const settingsDir =
    options.settingsDir ||
    process.env.CLAUDE_CONFIG_DIR ||
    path.join(homedir(), ".claude");
  const selected = addonSettings(addons);
  const results = await Promise.all(
    selected.map(async (addon) => {
      let result = null;
      try {
        const credential = Object.hasOwn(addon, "credential")
          ? await resolveCredentialReference(addon.credential, {
              baseDir: settingsDir
            })
          : "";
        const module = await importAddonModule(addon, options);
        if (module) {
          const line = renderSnapshot(
            addon,
            await module.fetchUsage({
              baseDir: settingsDir,
              credential
            })
          );
          result = line ? { hideName: Boolean(addon.hideName), line } : null;
        }
      } catch {
        result = null;
      }
      return result;
    })
  );
  return results.filter(Boolean);
};

/**
 * Load enabled addons and fetch their usage concurrently, retaining input order.
 * Relative scripts resolve against this module; credential file references use
 * the settings directory. Import, credential, fetch, and render failures omit
 * only the affected addon, as do snapshots with no visible metrics.
 * @param {object[]} addons Addon script and display settings; non-arrays are empty.
 * @param {object} [options] Settings directory and optional module importer.
 * @returns {Promise<string[]>} Nonempty formatted addon lines in input order.
 */
export const renderAddons = async (addons, options = {}) => {
  const results = await renderAddonResults(addons, options);
  return results.map((result) => result.line);
};

const projectDisplay = (workspace) => {
  const currentDir = workspace?.current_dir || "";
  const projectDir = workspace?.project_dir || "";
  const projectName = path.basename(projectDir);
  return currentDir === projectDir
    ? projectName
    : `${projectName}(${path.basename(currentDir)})`;
};

const renderHeader = (input, options) => {
  const model = input.model || {};
  const modelName = displayText(model.display_name || "");
  const effort = displayText(input.effort?.level || model.effort || "");
  const header = effort ? `[${modelName} (${effort})]` : `[${modelName}]`;
  const workspace = input.workspace || {};
  const cwd = options.cwd || workspace.current_dir || process.cwd();
  const branch = options.branch === undefined ? gitBranch(cwd) : options.branch;
  const context = input.context_window || {};
  const percentage = Math.trunc(Number(context.used_percentage || 0));
  const size = Math.trunc(Number(context.context_window_size || 0));
  const contextPart = `${barColor(percentage)}${usageBar(percentage)}${RESET} ${percentage}%${size ? ` (${numberText(size)})` : ""}`;
  return [
    `[36m${header}${RESET} [1m${displayText(projectDisplay(workspace))}${RESET}`,
    ...(branch ? [`[35m${displayText(branch)}${RESET}`] : []),
    contextPart
  ].join(" | ");
};

const renderCost = (input) => {
  const context = input.context_window || {};
  const usage = context.current_usage || {};
  const cost = input.cost || {};
  return `${`$${Number(cost.total_cost_usd || 0).toFixed(2)}`} | ${Math.trunc(Number(cost.total_duration_ms || 0) / 60_000)}m | ${DIM}read:${numberText(context.total_input_tokens || 0)}(${numberText(usage.cache_read_input_tokens || 0)}) write:${numberText(context.total_output_tokens || 0)}(${numberText(usage.cache_creation_input_tokens || 0)})${RESET}`;
};

/**
 * Build ANSI-colored status rows from Claude input and optional usage addons.
 * Fetches addons concurrently and reads the Git branch unless overridden.
 * Without built-in rate limits, the first addon hiding its name shares the cost
 * row unless merging is disabled. Addon failures are omitted individually;
 * errors while rendering the built-in rows reject the returned promise.
 * @param {object} input Claude model, workspace, context, cost, and rate-limit data.
 * @param {object} [options] Addons, current time, branch, working directory,
 * settings directory, importer, and hidden-addon merge preference.
 * @returns {Promise<string[]>} Header, cost, and any visible usage rows.
 */
export const renderStatusline = async (input, options = {}) => {
  const nowMs = options.nowMs ?? Date.now();
  const addons = options.addons ?? [];
  const rate = renderRateLimits(input.rate_limits || {}, nowMs);
  const addonResults = await renderAddonResults(addons, options);
  const hiddenIndex =
    !rate && options.mergeHidden !== false
      ? addonResults.findIndex((result) => result.hideName)
      : -1;
  const visibleRows = addonResults
    .filter((_, index) => index !== hiddenIndex)
    .map((result) => result.line);
  const costRow =
    hiddenIndex >= 0
      ? `${renderCost(input)} | ${addonResults[hiddenIndex].line}`
      : renderCost(input);
  return [
    renderHeader(input, options),
    costRow,
    ...(rate ? [rate] : []),
    ...visibleRows
  ];
};

const readSettings = async (filePath) => {
  try {
    return JSON.parse(await readFile(filePath, "utf-8"));
  } catch {
    return null;
  }
};

/**
 * Read Claude JSON from stdin, load addon settings, and write status rows.
 * Project settings take precedence when they contain an addon array; otherwise
 * the user's Claude settings are used. Unreadable settings fall back to global
 * settings or an empty configuration. Rows end with a newline; input, rendering,
 * and synchronous output failures are swallowed without diagnostic output.
 * @returns {Promise<void>} Resolves after the output attempt, including failure.
 */
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
  } catch {
    // The command must remain silent when input or settings are unavailable.
  }
};

if (
  process.argv[1] &&
  (await realpath(process.argv[1]).catch(() => "")) ===
    (await realpath(new URL(import.meta.url)))
) {
  await main();
}
