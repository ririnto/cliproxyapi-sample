#!/usr/bin/env node

import { readFileSync, readdirSync, existsSync } from "node:fs";
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
  if (path.basename(taskId) !== taskId) {
    return null;
  }
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

const latestInputTokens = (taskId) => {
  const transcript = findTranscript(taskId);
  if (!transcript) {
    return null;
  }
  return optional(() => {
    const lines = readFileSync(transcript, "utf-8").trim().split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const entry = JSON.parse(lines[index]);
      if (entry.type !== "assistant" && entry.message?.role !== "assistant") {
        continue;
      }
      const usage = entry.message?.usage;
      if (!usage || typeof usage.input_tokens !== "number") {
        return null;
      }
      const values = [
        usage.input_tokens,
        usage.cache_creation_input_tokens ?? 0,
        usage.cache_read_input_tokens ?? 0
      ];
      return values.every(
        (value) =>
          typeof value === "number" && Number.isFinite(value) && value >= 0
      )
        ? values.reduce((sum, value) => sum + value, 0)
        : null;
    }
    return null;
  });
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

const WIDE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꥠ-꥿가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦\u{20000}-\u{3FFFD}]/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const cellWidth = (text) => {
  if (/^[\p{Mark}\p{Cf}]*$/u.test(text)) {
    return 0;
  }
  return WIDE.test(text) || /\p{Emoji_Presentation}|\uFE0F/u.test(text) ? 2 : 1;
};
const visibleWidth = (text) =>
  [...graphemes.segment(stripVTControlCharacters(text))].reduce(
    (width, { segment }) => width + cellWidth(segment),
    0
  );

const clip = (text, columns) => {
  if (columns <= 0) {
    return "";
  }
  if (visibleWidth(text) <= columns) {
    return text;
  }
  let result = "";
  let width = 0;
  for (const { segment } of graphemes.segment(stripVTControlCharacters(text))) {
    const cells = cellWidth(segment);
    if (width + cells > columns - 1) {
      return `${DIM}${result}…${RESET}`;
    }
    result += segment;
    width += cells;
  }
  return result;
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

const tokenMetric = (task) => {
  const tokens = task.tokenCount;
  return typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0
    ? ""
    : `${DIM}${numberText(tokens)} tok${RESET}`;
};

const renderRow = (task, input, nowMs) => {
  const elapsedMs = Math.max(0, nowMs - Number(task.startTime || nowMs));
  const mark = statusMark(task.status, elapsedMs);
  const effortText =
    task.effort === undefined
      ? effortFor(displayText(task.model))
      : displayText(task.effort);
  const label = displayText(task.label || task.description || "");
  const inputTokens = latestInputTokens(task.id);
  return {
    compact: [
      alternateDirectory(task, input),
      tokenMetric(task),
      `${DIM}${elapsedText(elapsedMs)}${RESET}`
    ],
    left: [
      `${mark.color}${mark.glyph}${RESET} ${SAND}${BOLD}${taskTitle(task)}${RESET}`,
      task.model
        ? `${STEEL}${displayText(task.model)}${RESET}${effortText ? ` ${DIM}${effortText}${RESET}` : ""}`
        : "",
      label ? `${DIM}${label}${RESET}` : ""
    ],
    right: [
      alternateDirectory(task, input),
      tokenMetric(task),
      inputTokens === null ? "" : `${DIM}in ${numberText(inputTokens)}${RESET}`,
      `${DIM}${elapsedText(elapsedMs).padStart(5, " ")}${RESET}`
    ]
  };
};

export const renderRows = (input, nowMs) => {
  const available = Number(input.columns || input.width);
  const columns =
    Number.isFinite(available) && available > 0 ? Math.floor(available) : 0;
  return (Array.isArray(input.tasks) ? input.tasks : [])
    .filter((task) => task && typeof task.id === "string")
    .map((task) => {
      const cells = renderRow(task, input, nowMs);
      const left = cells.left.filter(Boolean).join(" ");
      let right = cells.right.filter(Boolean).join(" ");
      if (!columns) {
        return JSON.stringify({ content: `${left} ${right}`, id: task.id });
      }
      if (visibleWidth(right) > columns) {
        const [directory, tokens, elapsed] = cells.compact;
        const metrics = [tokens, elapsed].filter(Boolean).join(" ");
        const directoryBudget = columns - visibleWidth(metrics) - 1;
        right =
          directory && directoryBudget > 0
            ? `${clip(directory, directoryBudget)} ${metrics}`
            : metrics;
        if (visibleWidth(right) > columns) {
          right =
            visibleWidth(elapsed) <= columns ? elapsed : clip(elapsed, columns);
        }
      }
      const clippedLeft = clip(left, columns - visibleWidth(right) - 1);
      const gap = columns - visibleWidth(right) - visibleWidth(clippedLeft);
      return JSON.stringify({
        content: clippedLeft + " ".repeat(gap) + right,
        id: task.id
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
