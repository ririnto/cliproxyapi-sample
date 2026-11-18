#!/usr/bin/env node

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

/**
 * @typedef {Record<string, unknown>} RecordValue
 */
/**
 * @param {unknown} value - Untrusted input.
 * @returns {value is RecordValue} Object shape.
 */
const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/**
 * @param {unknown} value - Untrusted input.
 * @returns {RecordValue} Object fields.
 */
const record = (value) => (isRecord(value) ? value : {});
/**
 * @param {unknown} value - Untrusted list.
 * @returns {unknown[]} Elements.
 */
const array = (value) => (Array.isArray(value) ? value : []);
const truthy = Boolean;
/**
 * @param {unknown} value - Preferred field.
 * @param {() => unknown} fallback - Read the fallback field if needed.
 */
const truthyOr = (value, fallback) => (truthy(value) ? value : fallback());
/**
 * @param {unknown} value - Path input.
 * @param {string} fallback - Default path.
 */
const textOr = (value, fallback = "") =>
  typeof value === "string" && value !== "" ? value : fallback;

/** @param {unknown} value - Task boundary.
 * @returns {value is RecordValue & {id: string}} Task with an identifier.
 */
const isTask = (value) => isRecord(value) && typeof value.id === "string";
const RESET = "\u001B[0m";
const DIM = "\u001B[38;2;132;144;156m";
const BOLD = "\u001B[1m";
const SAND = "\u001B[38;2;246;226;183m";
const GREEN = "\u001B[38;2;171;223;167m";
const BLUE = "\u001B[38;2;143;179;239m";
const STEEL = "\u001B[38;2;166;190;211m";
const PINK = "\u001B[38;2;233;144;169m";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const statusMarks = new Map([
  ["completed", { color: GREEN, glyph: "✔" }],
  ["failed", { color: PINK, glyph: "✗" }],
  ["killed", { color: DIM, glyph: "⊘" }]
]);

/** @template T
 * @param {() => T} operation - Optional operation.
 * @returns {NonNullable<T> | null} Result when available.
 */
const optional = (operation) => {
  try {
    return operation() ?? null;
  } catch (error) {
    if (truthy(process.env.STATUSLINE_DEBUG)) {
      console.error(error);
    }
    return null;
  }
};
/**
 * @param {string} text - JSON text.
 * @returns {unknown} Parsed input.
 */
const parseJson = (text) => JSON.parse(text);

const settings =
  optional(() =>
    record(
      parseJson(
        readFileSync(
          `${textOr(process.env.CLAUDE_CONFIG_DIR, `${textOr(process.env.HOME)}/.claude`)}/settings.json`,
          "utf-8"
        )
      )
    )
  ) ?? {};
/**
 * @param {string} directory - directory input.
 */
const directoriesIn = (directory) => {
  try {
    return readdirSync(directory, { withFileTypes: true }).filter((entry) =>
      entry.isDirectory()
    );
  } catch {
    return [];
  }
};

/**
 * @param {unknown} value - value input.
 */
const displayText = (value) =>
  stripVTControlCharacters(String(value))
    .replaceAll(/[\p{Cc}\u{2028}\u{2029}]+/gu, " ")
    .trim();

/**
 * @param {number} divisor - divisor input.
 * @param {string} suffix - suffix input.
 * @returns {(number:number)=>string} Numeric formatter.
 */
const scaledText = (divisor, suffix) => (number) =>
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
    return scaledText(1_000_000, "M")(number);
  }
  return number >= 1000 ? scaledText(1000, "k")(number) : String(number);
};

/**
 * @param {number} milliseconds - milliseconds input.
 */
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
/**
 * @param {string} text - text input.
 */
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
/**
 * @param {string} text - text input.
 */
const visibleWidth = (text) =>
  [...graphemes.segment(stripVTControlCharacters(text))].reduce(
    (width, { segment }) => width + cellWidth(segment),
    0
  );

/**
 * @param {string} text - text input.
 * @param {number} columns - columns input.
 */
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

/**
 * @param {RecordValue} task - task input.
 * @param {{color:string,glyph:string}} mark - mark input.
 */
const taskLabel = (task, mark) => {
  const effortText =
    task.effort === undefined
      ? truthyOr(
          record(record(settings.modelSettings)[displayText(task.model)])
            .effortLevel,
          () => truthyOr(settings.effortLevel, () => "")
        )
      : displayText(task.effort);
  const label = displayText(
    truthyOr(task.label, () => truthyOr(task.description, () => ""))
  );
  return [
    `${mark.color}${mark.glyph}${RESET} ${SAND}${BOLD}${
      truthy(task.name) &&
      truthy(task.agentType) &&
      task.name !== task.agentType
        ? `${displayText(task.name)} ${DIM}(${displayText(task.agentType)})${RESET}`
        : displayText(
            truthyOr(task.name, () => truthyOr(task.agentType, () => task.type))
          )
    }${RESET}`,
    truthy(task.model)
      ? `${STEEL}${displayText(task.model)}${RESET}${truthy(effortText) ? ` ${DIM}${displayText(effortText)}${RESET}` : ""}`
      : "",
    label ? `${DIM}${label}${RESET}` : ""
  ]
    .filter(Boolean)
    .join(" ");
};

/**
 * @param {unknown} input - input input.
 * @param {number} nowMs - nowMs input.
 */
export const renderRows = (input, nowMs) => {
  if (!isRecord(input)) {
    throw new TypeError("Status payload must be an object");
  }
  const available = Number(truthyOr(input.columns, () => input.width));
  const columns =
    Number.isFinite(available) && available > 0 ? Math.floor(available) : 0;
  return array(input.tasks)
    .filter(isTask)
    .map((task) => {
      const elapsedMs = Math.max(
        0,
        nowMs - Number(truthyOr(task.startTime, () => nowMs))
      );
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
              for (const line of readFileSync(candidate, "utf-8")
                .trim()
                .split("\n")
                .toReversed()) {
                const entry = record(parseJson(line));
                if (
                  entry.type !== "assistant" &&
                  record(entry.message).role !== "assistant"
                ) {
                  continue;
                }
                const usage = record(record(entry.message).usage);
                if (typeof usage.input_tokens !== "number") {
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
                  ? values.reduce(
                      (sum, value) => Number(sum) + Number(value),
                      0
                    )
                  : null;
              }
              return null;
            }
          }
        }
        return null;
      });
      const directory =
        !truthy(task.cwd) || !truthy(input.cwd) || task.cwd === input.cwd
          ? ""
          : `${BLUE}⌥ ${displayText(path.basename(String(task.cwd)) || String(task.cwd))}${RESET}`;
      const tokens =
        typeof task.tokenCount !== "number" ||
        !Number.isFinite(task.tokenCount) ||
        task.tokenCount < 0
          ? ""
          : `${DIM}${numberText(task.tokenCount)} tok${RESET}`;
      const elapsed = elapsedText(elapsedMs);
      const left = taskLabel(
        task,
        statusMarks.get(String(task.status)) ?? {
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
  const rows = renderRows(
    record(parseJson(readFileSync(0, "utf-8"))),
    Date.now()
  );
  if (rows.length) {
    process.stdout.write(`${rows.join("\n")}\n`);
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
