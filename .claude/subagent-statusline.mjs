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
    JSON.parse(
      readFileSync(
        `${process.env.CLAUDE_CONFIG_DIR || `${process.env.HOME || ""}/.claude`}/settings.json`,
        "utf-8"
      )
    )
  ) ?? {};
const directoriesIn = (directory) => {
  try {
    return readdirSync(directory, { withFileTypes: true }).filter((entry) =>
      entry.isDirectory()
    );
  } catch {
    return [];
  }
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

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const cellWidth = (text) => {
  if (/^[\p{Mark}\p{Cf}]*$/u.test(text)) {
    return 0;
  }
  return /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꥠ-꥿가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦\u{20000}-\u{3FFFD}]/u.test(
    text
  ) || /\p{Emoji_Presentation}|\uFE0F/u.test(text)
    ? 2
    : 1;
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

const taskLabel = (task, mark) => {
  const effortText =
    task.effort === undefined
      ? settings.modelSettings?.[displayText(task.model)]?.effortLevel ||
        settings.effortLevel ||
        ""
      : displayText(task.effort);
  const label = displayText(task.label || task.description || "");
  return [
    `${mark.color}${mark.glyph}${RESET} ${SAND}${BOLD}${
      task.name && task.agentType && task.name !== task.agentType
        ? `${displayText(task.name)} ${DIM}(${displayText(task.agentType)})${RESET}`
        : displayText(task.name || task.agentType || task.type)
    }${RESET}`,
    task.model
      ? `${STEEL}${displayText(task.model)}${RESET}${effortText ? ` ${DIM}${effortText}${RESET}` : ""}`
      : "",
    label ? `${DIM}${label}${RESET}` : ""
  ]
    .filter(Boolean)
    .join(" ");
};

export const renderRows = (input, nowMs) => {
  const available = Number(input.columns || input.width);
  const columns =
    Number.isFinite(available) && available > 0 ? Math.floor(available) : 0;
  return (Array.isArray(input.tasks) ? input.tasks : [])
    .filter((task) => task && typeof task.id === "string")
    .map((task) => {
      const elapsedMs = Math.max(0, nowMs - Number(task.startTime || nowMs));
      const inputTokens = optional(() => {
        if (path.basename(task.id) !== task.id) {
          return null;
        }
        const transcriptDirectory = `claude-${process.getuid?.() ?? 501}`;
        for (const root of new Set([
          path.join("/private/tmp", transcriptDirectory),
          path.join("/tmp", transcriptDirectory),
          path.join(tmpdir(), transcriptDirectory)
        ])) {
          for (const project of directoriesIn(root)) {
            for (const session of directoriesIn(
              path.join(root, project.name)
            )) {
              const candidate = path.join(
                root,
                project.name,
                session.name,
                "tasks",
                `${task.id}.output`
              );
              if (!existsSync(candidate)) {
                continue;
              }
              const lines = readFileSync(candidate, "utf-8").trim().split("\n");
              for (let index = lines.length - 1; index >= 0; index -= 1) {
                const entry = JSON.parse(lines[index]);
                if (
                  entry.type !== "assistant" &&
                  entry.message?.role !== "assistant"
                ) {
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
                    typeof value === "number" &&
                    Number.isFinite(value) &&
                    value >= 0
                )
                  ? values.reduce((sum, value) => sum + value, 0)
                  : null;
              }
              return null;
            }
          }
        }
        return null;
      });
      const directory =
        !task.cwd || !input.cwd || task.cwd === input.cwd
          ? ""
          : `${BLUE}⌥ ${displayText(path.basename(task.cwd) || task.cwd)}${RESET}`;
      const tokens =
        typeof task.tokenCount !== "number" ||
        !Number.isFinite(task.tokenCount) ||
        task.tokenCount < 0
          ? ""
          : `${DIM}${numberText(task.tokenCount)} tok${RESET}`;
      const elapsed = elapsedText(elapsedMs);
      const left = taskLabel(
        task,
        new Map([
          ["completed", { color: GREEN, glyph: "✔" }],
          ["failed", { color: PINK, glyph: "✗" }],
          ["killed", { color: DIM, glyph: "⊘" }]
        ]).get(task.status) || {
          color: BLUE,
          glyph: SPINNER[Math.floor(elapsedMs / 1000) % SPINNER.length]
        }
      );
      let right = [
        directory,
        tokens,
        inputTokens === null
          ? ""
          : `${DIM}in ${numberText(inputTokens)}${RESET}`,
        `${DIM}${elapsed.padStart(5, " ")}${RESET}`
      ]
        .filter(Boolean)
        .join(" ");
      if (!columns) {
        return JSON.stringify({ content: `${left} ${right}`, id: task.id });
      }
      if (visibleWidth(right) > columns) {
        const compactElapsed = `${DIM}${elapsed}${RESET}`;
        const metrics = [tokens, compactElapsed].filter(Boolean).join(" ");
        const directoryBudget = columns - visibleWidth(metrics) - 1;
        right =
          directory && directoryBudget > 0
            ? `${clip(directory, directoryBudget)} ${metrics}`
            : metrics;
        if (visibleWidth(right) > columns) {
          right =
            visibleWidth(compactElapsed) <= columns
              ? compactElapsed
              : clip(compactElapsed, columns);
        }
      }
      const clippedLeft = clip(left, columns - visibleWidth(right) - 1);
      return JSON.stringify({
        content:
          clippedLeft +
          " ".repeat(
            columns - visibleWidth(right) - visibleWidth(clippedLeft)
          ) +
          right,
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
