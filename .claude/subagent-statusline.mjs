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

const clippedText = (value, width) => {
  const characters = [...value];
  return characters.length <= width
    ? value
    : `${characters.slice(0, Math.max(0, width - 1)).join("")}…`;
};

export const renderTaskContent = (task, columns) => {
  const name = displayText(task.name || task.agentType || task.type || "agent");
  const status = displayText(task.status || "running");
  const tokens =
    Number(task.tokenCount) > 0 ? `${numberText(task.tokenCount)} tok` : "";
  const head = `${NAME_COLOR}${name}${RESET}${SEPARATOR}${statusColor(task.status || "running")}${status}${RESET}`;
  const summary = displayText(task.label ?? task.description ?? "").trim();
  const tail = tokens ? `${DIM}${tokens}${RESET}` : "";
  if (!summary && !tail) {
    return head;
  }
  const summaryWidth =
    Number.isFinite(columns) && columns > 0
      ? columns -
        name.length -
        status.length -
        2 * SEPARATOR_WIDTH -
        (tail ? SEPARATOR_WIDTH + tokens.length : 0)
      : Number.POSITIVE_INFINITY;
  const clippedSummary =
    summaryWidth >= 1 ? clippedText(summary, summaryWidth) : "";
  return [
    head,
    ...(clippedSummary ? [`${DIM}${clippedSummary}${RESET}`] : []),
    ...(tail ? [tail] : [])
  ].join(SEPARATOR);
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
