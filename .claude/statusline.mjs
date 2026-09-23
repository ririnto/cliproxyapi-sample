#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RESET = "[0m";
const DIM = "[2m";
const PCT_GREEN = 70;
const PCT_YELLOW = 90;

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const metricPercentage = (metric) => {
  if (metric?.type === "usage") {
    return metric.total > 0 ? (metric.used / metric.total) * 100 : 0;
  }
  return metric?.percentage ?? 0;
};

const environmentValue = (name, environment) => {
  if (environment && Object.hasOwn(environment, name)) {
    return environment[name] ?? "";
  }
  return process.env[name] ?? "";
};

const homePath = (value, home) => {
  if (value.startsWith("~/")) {
    return path.join(home, value.slice(2));
  }
  return value;
};

const replaceEnvironmentReferences = (value, environment) =>
  value.replaceAll(/\{env:(?<name>[^{}]+)\}/gu, (placeholder) =>
    String(environmentValue(placeholder.slice(5, -1), environment))
  );

const replaceFileReferences = async (value, options) => {
  const home = options.home ?? homedir();
  const baseDir = options.baseDir ?? process.cwd();
  const references = [
    ...value.matchAll(/\{file:(?<fileReferencePath>[^{}]*)\}/gu)
  ];
  if (!references.length) {
    return value;
  }
  const referenceTexts = await Promise.all(
    references.map(async (reference) => {
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
    })
  );
  let cursor = 0;
  let result = "";
  for (const [index, reference] of references.entries()) {
    result += value.slice(cursor, reference.index) + referenceTexts[index];
    cursor = reference.index + reference[0].length;
  }
  return result + value.slice(cursor);
};

const resolveCredentialReference = async (value, options = {}) => {
  if (typeof value !== "string") {
    return value;
  }
  return await replaceFileReferences(
    replaceEnvironmentReferences(value, options.environment),
    options
  );
};

const numberText = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "0";
  }
  if (number >= 1_000_000) {
    return `${(number / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
  }
  if (number >= 1000) {
    return `${(number / 1000).toFixed(1).replace(/\.0$/u, "")}k`;
  }
  return String(Math.trunc(number));
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
  return days < 1 ? `${hours}h ${minutes}m` : `${days}d ${hours}h`;
};

const barColor = (percentage) => {
  if (percentage <= PCT_GREEN) {
    return "[32m";
  }
  if (percentage <= PCT_YELLOW) {
    return "[33m";
  }
  return "[31m";
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
    return `${metric.used}/${metric.total}`;
  }
  if (metric.type === "budget") {
    return `$${Number(metric.used || 0).toFixed(2)}/$${Number(metric.total || 0).toFixed(2)}`;
  }
  return `${Number(metric.percentage || 0)}%`;
};

const metricPercent = (metric) => {
  try {
    const value = Number(metricPercentage(metric));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
};

const thresholdFor = (showAbove, groupLabel, metricLabel) => {
  if (showAbove && typeof showAbove === "object" && !Array.isArray(showAbove)) {
    return Number(showAbove[metricLabel] ?? showAbove[groupLabel] ?? 0);
  }
  return Number(showAbove || 0);
};

const renderMetric = (metric) => {
  const reset = metric.resetsInMs ?? metric.resets_in_ms;
  return `${metric.label}: ${barColor(metricPercent(metric))}${metricDisplay(metric)}${RESET}${reset === undefined ? "" : ` (${resetText(reset)})`}`;
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
      const content = metrics.map(renderMetric).join(" | ");
      const groupName =
        typeof group.label === "string" && group.label
          ? group.label
          : addon.name;
      const displayName = group.label || !addon.hideName ? groupName : "";
      return displayName ? `${displayName} | ${content}` : content;
    })
    .filter(Boolean)
    .join(" | ");
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
  const filePath = scriptPath(addon.script);
  const importFunction = options.importModule || ((url) => import(url));
  const module = await importFunction(pathToFileURL(filePath));
  return typeof module.fetchUsage === "function" ? module : undefined;
};

const renderAddonResults = async (addons, options = {}) => {
  const settingsDir = options.settingsDir || path.join(homedir(), ".claude");
  const selected = addonSettings(addons);
  const results = await Promise.all(
    selected.map(async (addon) => {
      try {
        const credential = Object.hasOwn(addon, "credential")
          ? await resolveCredentialReference(addon.credential, {
              baseDir: settingsDir
            })
          : "";
        const module = await importAddonModule(addon, options);
        if (!module) {
          return null;
        }
        const snapshot = await module.fetchUsage({
          baseDir: settingsDir,
          credential
        });
        const line = renderSnapshot(addon, snapshot);
        return line ? { hideName: Boolean(addon.hideName), line } : null;
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
  const currentDir = workspace?.current_dir || "";
  const projectDir = workspace?.project_dir || "";
  const projectName = path.basename(projectDir);
  return currentDir === projectDir
    ? projectName
    : `${projectName}(${path.basename(currentDir)})`;
};

const renderHeader = (input, options) => {
  const model = input.model || {};
  const modelName = model.display_name || "";
  const effort = input.effort?.level || model.effort || "";
  const header = effort ? `[${modelName} (${effort})]` : `[${modelName}]`;
  const workspace = input.workspace || {};
  const cwd = options.cwd || workspace.current_dir || process.cwd();
  const branch = options.branch === undefined ? gitBranch(cwd) : options.branch;
  const context = input.context_window || {};
  const percentage = Math.trunc(Number(context.used_percentage || 0));
  const size = Math.trunc(Number(context.context_window_size || 0));
  const contextPart = `${barColor(percentage)}${usageBar(percentage)}${RESET} ${percentage}%${size ? ` (${numberText(size)})` : ""}`;
  return [
    `[36m${header}${RESET} [1m${projectDisplay(workspace)}${RESET}`,
    ...(branch ? [`[35m${branch}${RESET}`] : []),
    contextPart
  ].join(" | ");
};

const renderCost = (input) => {
  const context = input.context_window || {};
  const usage = context.current_usage || {};
  const cost = input.cost || {};
  return `${`$${Number(cost.total_cost_usd || 0).toFixed(2)}`} | ${Math.trunc(Number(cost.total_duration_ms || 0) / 60_000)}m | ${DIM}read:${numberText(context.total_input_tokens || 0)}(${numberText(usage.cache_read_input_tokens || 0)}) write:${numberText(context.total_output_tokens || 0)}(${numberText(usage.cache_creation_input_tokens || 0)})${RESET}`;
};

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

export const main = async () => {
  try {
    const input = JSON.parse(readFileSync(0, "utf-8"));
    const globalSettingsDir = path.join(homedir(), ".claude");
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
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
