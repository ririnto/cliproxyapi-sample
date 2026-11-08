#!/usr/bin/env node

import {
  readFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  writeFileSync,
  existsSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

const RESET = "\u001B[0m";
const DIM = "\u001B[38;2;132;144;156m";
const BOLD = "\u001B[1m";
const SAND = "\u001B[38;2;246;226;183m";
const GREEN = "\u001B[38;2;171;223;167m";
const BLUE = "\u001B[38;2;143;179;239m";
const STEEL = "\u001B[38;2;166;190;211m";
const YELLOW = "\u001B[38;2;242;181;144m";
const PINK = "\u001B[38;2;233;144;169m";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const settingsDir =
  process.env.CLAUDE_CONFIG_DIR || `${process.env.HOME || ""}/.claude`;
const optional = (operation) => {
  try {
    return operation() ?? null;
  } catch (error) {
    if (process.env.STATUSLINE_DEBUG) {
      console.error(error);
    }
    return null;
  }
};
const settings =
  optional(() =>
    JSON.parse(readFileSync(`${settingsDir}/settings.json`, "utf-8"))
  ) ?? {};
const effortFor = (model) =>
  settings.modelSettings?.[model]?.effortLevel || settings.effortLevel || "";

const USAGE_CACHE = path.join(tmpdir(), "subagent-statusline-usage");
optional(() => mkdirSync(USAGE_CACHE, { recursive: true }));

const directoriesIn = (directory) => {
  try {
    return readdirSync(directory, { withFileTypes: true }).filter((entry) =>
      entry.isDirectory()
    );
  } catch {
    return [];
  }
};

const findTranscript = (taskId) => {
  const transcriptDirectory = `claude-${process.getuid?.() ?? 501}`;
  for (const root of new Set([
    path.join("/private/tmp", transcriptDirectory),
    path.join("/tmp", transcriptDirectory),
    path.join(tmpdir(), transcriptDirectory)
  ])) {
    for (const project of directoriesIn(root)) {
      for (const session of directoriesIn(path.join(root, project.name))) {
        const candidate = path.join(
          root,
          project.name,
          session.name,
          "tasks",
          `${taskId}.output`
        );
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }
  return null;
};

const totalUsage = (taskId) => {
  const transcript = findTranscript(taskId);
  if (!transcript) {
    return null;
  }
  let stat;
  try {
    stat = statSync(transcript);
  } catch {
    return null;
  }
  const cacheFile = path.join(USAGE_CACHE, `${taskId}.json`);
  const cacheKey = `2:${stat.mtimeMs}:${stat.size}`;
  const cached = optional(() => JSON.parse(readFileSync(cacheFile, "utf-8")));
  if (cached?.key === cacheKey) {
    return cached.total;
  }
  let total = 0;
  const seen = new Set();
  try {
    for (const line of readFileSync(transcript, "utf-8").split("\n")) {
      if (!line.includes('"usage"')) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line)?.message;
      } catch {
        continue;
      }
      if (!message?.id || !message.usage || seen.has(message.id)) {
        continue;
      }
      seen.add(message.id);
      const { usage } = message;
      total +=
        Number(usage.input_tokens || 0) +
        Number(usage.output_tokens || 0) +
        Number(usage.cache_creation_input_tokens || 0);
    }
  } catch {
    return null;
  }
  optional(() =>
    writeFileSync(cacheFile, JSON.stringify({ key: cacheKey, total }))
  );
  return total;
};

const displayText = (value) =>
  stripVTControlCharacters(`${value}`)
    .replaceAll(/[\p{Cc}\u{2028}\u{2029}]+/gu, " ")
    .trim();

const scaledText = (divisor, suffix) => (number) =>
  `${(number / divisor).toFixed(1).replace(/\.0$/u, "")}${suffix}`;

const numberText = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "0";
  }
  if (number >= 1_000_000) {
    return scaledText(1_000_000, "M")(number);
  }
  return number >= 1000 ? scaledText(1000, "k")(number) : String(number);
};

const elapsedText = (milliseconds) => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h${minutes ? `${minutes}m` : ""}`;
  }
  if (minutes >= 10) {
    return `${minutes}m`;
  }
  return seconds >= 60
    ? `${minutes}m${String(seconds % 60).padStart(2, "0")}s`
    : `${seconds}s`;
};

const statusMark = (status, elapsedMs) => {
  if (status === "completed") {
    return { color: GREEN, glyph: "✔" };
  }
  if (status === "failed") {
    return { color: PINK, glyph: "✗" };
  }
  if (status === "killed") {
    return { color: DIM, glyph: "⊘" };
  }
  return {
    color: BLUE,
    glyph: SPINNER[Math.floor(elapsedMs / 1000) % SPINNER.length]
  };
};

const barColor = (percentage) => {
  if (percentage <= 70) {
    return GREEN;
  }
  return percentage <= 90 ? YELLOW : PINK;
};

const usageBar = (percentage) => {
  const steps = Math.max(
    percentage > 0 ? 1 : 0,
    Math.min(8, Math.round((percentage / 100) * 8))
  );
  return "▰".repeat(steps) + DIM + "▱".repeat(8 - steps);
};

const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꥠ-꥿가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦]/gu;

const visibleWidth = (text) => {
  const plain = stripVTControlCharacters(text);
  return plain.length + (plain.match(WIDE)?.length || 0);
};

const contextPercentageFor = (task) => {
  const contextWindowSize = Number(task.contextWindowSize);
  if (!Number.isFinite(contextWindowSize) || contextWindowSize <= 0) {
    return null;
  }
  return Math.min(100, (Number(task.tokenCount) / contextWindowSize) * 100);
};

const taskTitle = (task) => {
  if (task.name && task.agentType && task.name !== task.agentType) {
    return `${displayText(task.name)} ${DIM}(${displayText(task.agentType)})${RESET}`;
  }
  return displayText(task.name || task.agentType || task.type);
};

const alternateDirectory = (task, input) => {
  if (!task.cwd || !input.cwd || task.cwd === input.cwd) {
    return "";
  }
  return `${BLUE}⌥ ${displayText(path.basename(task.cwd) || task.cwd)}${RESET}`;
};

const tokenMetric = (task, contextPercentage) => {
  if (contextPercentage === null) {
    return `${DIM}${numberText(task.tokenCount).padStart(5, " ")}${RESET}`;
  }
  return `${barColor(contextPercentage)}${numberText(task.tokenCount).padStart(5, " ")}${RESET} ${barColor(contextPercentage)}${usageBar(contextPercentage)}${RESET} ${DIM}${String(Math.round(contextPercentage)).padStart(3, " ")}%${RESET}`;
};

const usageMetric = (usageTotal) => {
  if (usageTotal === null || usageTotal <= 0) {
    return "";
  }
  return `${YELLOW}Σ${RESET}${DIM}${numberText(usageTotal).padStart(6, " ")}${RESET}`;
};

const renderRow = (task, input, nowMs) => {
  const elapsedMs = Math.max(0, nowMs - Number(task.startTime || nowMs));
  const mark = statusMark(task.status, elapsedMs);
  const effortText =
    task.effort === undefined
      ? effortFor(displayText(task.model))
      : displayText(task.effort);
  const label = displayText(task.label || task.description || "");
  return {
    left: [
      `${mark.color}${mark.glyph}${RESET} ${SAND}${BOLD}${taskTitle(task)}${RESET}`,
      task.model
        ? `${STEEL}${displayText(task.model)}${RESET}${effortText ? ` ${DIM}${effortText}${RESET}` : ""}`
        : "",
      label ? `${DIM}${label}${RESET}` : ""
    ],
    right: [
      alternateDirectory(task, input),
      tokenMetric(task, contextPercentageFor(task)),
      usageMetric(totalUsage(task.id)),
      `${DIM}${elapsedText(elapsedMs).padStart(5, " ")}${RESET}`
    ]
  };
};

export const renderRows = (input, nowMs) => {
  const rows = (Array.isArray(input.tasks) ? input.tasks : [])
    .filter((task) => task && typeof task.id === "string")
    .map((task) => {
      const cells = renderRow(task, input, nowMs);
      return {
        id: task.id,
        left: cells.left.filter((cell) => cell.length > 0).join(" "),
        right: cells.right.filter((cell) => cell.length > 0).join(" ")
      };
    });
  const columns = Number(input.columns || input.width) || 0;
  const rightWidth = Math.max(0, ...rows.map((row) => visibleWidth(row.right)));
  return rows.map((row) => {
    const gap = columns - rightWidth - visibleWidth(row.left);
    return JSON.stringify({
      content:
        columns > 0 && gap >= 1 && row.right
          ? row.left +
            " ".repeat(gap) +
            " ".repeat(rightWidth - visibleWidth(row.right)) +
            row.right
          : [row.left, row.right].filter((part) => part.length > 0).join(" "),
      id: row.id
    });
  });
};

export const main = () => {
  const rows = renderRows(JSON.parse(readFileSync(0, "utf-8")), Date.now());
  if (rows.length) {
    process.stdout.write(`${rows.join("\n")}\n`);
  }
};

if (process.argv[1]) {
  let isEntrypoint = false;
  try {
    isEntrypoint = path.resolve(process.argv[1]) === import.meta.filename;
  } catch {
    isEntrypoint = false;
  }
  if (isEntrypoint) {
    main();
  }
}
