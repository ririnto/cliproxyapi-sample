#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

const displayText = (value) =>
  stripVTControlCharacters(`${value}`).replaceAll(
    /[\p{Cc}\u{2028}\u{2029}]+/gu,
    " "
  );

const RESET = "\u001B[0m";
const DIM = "\u001B[38;2;132;144;156m";
const GREEN = "\u001B[38;2;171;223;167m";
const NAME_COLOR = "\u001B[38;2;246;226;183m";
const ALERT_COLOR = "\u001B[38;2;233;144;169m";
const SEPARATOR = `${DIM} · ${RESET}`;
const SEPARATOR_WIDTH = displayText(SEPARATOR).length;

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

const statusColor = (status) => {
  if (status === "running") {
    return GREEN;
  }
  return status === "failed" || status === "killed" ? ALERT_COLOR : DIM;
};

const WIDE_RANGES = [
  ["\u{1100}", "\u{115F}"],
  ["\u{2E80}", "\u{303E}"],
  ["\u{3041}", "\u{33FF}"],
  ["\u{3400}", "\u{4DBF}"],
  ["\u{4E00}", "\u{9FFF}"],
  ["\u{A000}", "\u{A4CF}"],
  ["\u{AC00}", "\u{D7A3}"],
  ["\u{F900}", "\u{FAFF}"],
  ["\u{FE30}", "\u{FE4F}"],
  ["\u{FF00}", "\u{FF60}"],
  ["\u{FFE0}", "\u{FFE6}"],
  ["\u{1F300}", "\u{1FAFF}"],
  ["\u{20000}", "\u{2FFFD}"],
  ["\u{30000}", "\u{3FFFD}"]
].map(([from, to]) => [from.codePointAt(0), to.codePointAt(0)]);

const characterWidth = (character) => {
  const codePoint = character.codePointAt(0);
  return WIDE_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to)
    ? 2
    : 1;
};

const displayWidth = (value) =>
  [...value].reduce((width, character) => width + characterWidth(character), 0);

const totalWidth = (segments) =>
  segments.reduce((width, segment) => width + segment.width, 0) +
  SEPARATOR_WIDTH * Math.max(0, segments.length - 1);

export const renderTaskContent = (task, columns) => {
  const limit =
    Number.isFinite(columns) && columns > 0
      ? columns
      : Number.POSITIVE_INFINITY;
  const segments = [
    {
      color: NAME_COLOR,
      priority: 0,
      text: displayText(task.name || task.agentType || task.type || "agent")
    },
    {
      color: statusColor(task.status || "running"),
      priority: 1,
      text: displayText(task.status || "running")
    },
    {
      color: DIM,
      priority: 3,
      text: displayText(task.label ?? task.description ?? "").trim()
    },
    {
      color: DIM,
      fixed: true,
      priority: 2,
      text:
        Number(task.tokenCount) > 0 ? `${numberText(task.tokenCount)} tok` : ""
    }
  ]
    .filter((segment) => segment.text)
    .map((segment) => ({ ...segment, width: displayWidth(segment.text) }));
  for (const segment of segments.toSorted((a, b) => b.priority - a.priority)) {
    if (totalWidth(segments) <= limit) {
      break;
    }
    const others = segments.filter((entry) => entry !== segment);
    const budget =
      limit - totalWidth(others) - (others.length ? SEPARATOR_WIDTH : 0);
    if (budget < 1 || (segment.fixed && segment.width > budget)) {
      segments.splice(segments.indexOf(segment), 1);
      continue;
    }
    if (segment.width > budget) {
      const characters = [];
      let used = 0;
      for (const character of segment.text) {
        const next = characterWidth(character);
        if (used + next > budget - 1) {
          break;
        }
        characters.push(character);
        used += next;
      }
      segment.text = `${characters.join("")}…`;
      segment.width = used + 1;
    }
  }
  return segments
    .map((segment) => `${segment.color}${segment.text}${RESET}`)
    .join(SEPARATOR);
};

export const renderRows = (input) => {
  if (!input || !Array.isArray(input.tasks)) {
    return [];
  }
  return input.tasks
    .filter((task) => task && typeof task === "object" && task.id)
    .map((task) => ({
      content: renderTaskContent(task, Number(input.columns)),
      id: task.id
    }));
};

export const main = () => {
  try {
    const rows = renderRows(JSON.parse(readFileSync(0, "utf-8")));
    for (const row of rows) {
      process.stdout.write(`${JSON.stringify(row)}\n`);
    }
  } catch (error) {
    if (process.env.STATUSLINE_DEBUG) {
      console.error("[subagent-statusline] unavailable input", error);
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
    main();
  }
}
