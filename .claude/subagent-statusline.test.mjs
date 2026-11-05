import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { renderRows } from "./subagent-statusline.mjs";

const plainText = (value) => stripVTControlCharacters(String(value));
const scriptPath = fileURLToPath(
  new URL("subagent-statusline.mjs", import.meta.url)
);

test("rows show name, model, effort, status, tokens, and summary in order", () => {
  const rows = renderRows({
    columns: 120,
    tasks: [
      {
        agentType: "Explore",
        description: "map the auth flow",
        effort: "high",
        id: "task-1",
        label: "reviewing auth flow",
        model: "claude-opus-5-5",
        status: "running",
        tokenCount: 12_345,
        type: "local_agent"
      },
      {
        agentType: "general-purpose",
        description: "search for the retry helper",
        id: "task-2",
        name: "finder",
        status: "completed"
      }
    ]
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, "task-1");
  assert.equal(
    plainText(rows[0].content),
    "Explore · claude-opus-5-5 · high · running · 12.3k tok · reviewing auth flow"
  );
  assert.equal(rows[1].id, "task-2");
  assert.equal(
    plainText(rows[1].content),
    "finder · completed · search for the retry helper"
  );
});

test("absent tasks or rows without an id keep the default rendering", () => {
  assert.deepEqual(renderRows({}), []);
  assert.deepEqual(renderRows({ columns: 80, tasks: [] }), []);
  assert.deepEqual(
    renderRows({
      columns: 80,
      tasks: [{ status: "running" }, null, { agentType: "Explore" }]
    }),
    []
  );
});

test("rows are clipped to the reported row width", () => {
  const rows = renderRows({
    columns: 40,
    tasks: [
      {
        agentType: "Explore",
        description: "a".repeat(60),
        id: "task-1",
        status: "running",
        tokenCount: 12_345
      }
    ]
  });
  assert.equal(
    plainText(rows[0].content),
    "Explore · running · 12.3k tok · aaaaaaa…"
  );
});

test("wide characters count as two cells when clipping", () => {
  const rows = renderRows({
    columns: 40,
    tasks: [
      {
        agentType: "Explore",
        description: "한".repeat(20),
        id: "task-1",
        status: "running"
      }
    ]
  });
  assert.equal(
    plainText(rows[0].content),
    `Explore · running · ${"한".repeat(9)}…`
  );
  const emojiRows = renderRows({
    columns: 30,
    tasks: [
      {
        agentType: "Explore",
        description: "🚀".repeat(20),
        id: "task-1",
        status: "running"
      }
    ]
  });
  assert.equal(
    plainText(emojiRows[0].content),
    `Explore · running · ${"🚀".repeat(4)}…`
  );
});

test("token counts drop whole instead of truncating mid-value", () => {
  const rows = renderRows({
    columns: 22,
    tasks: [
      {
        agentType: "Explore",
        id: "task-1",
        status: "running",
        tokenCount: 12_345
      }
    ]
  });
  assert.equal(plainText(rows[0].content), "Explore · running");
});

test("long names clip after lower-priority segments are dropped", () => {
  const rows = renderRows({
    columns: 40,
    tasks: [
      {
        id: "task-1",
        name: "N".repeat(50),
        status: "running"
      }
    ]
  });
  assert.equal(plainText(rows[0].content), `${"N".repeat(39)}…`);
});

test("task strings stay inside their row without escape leakage", () => {
  const rows = renderRows({
    columns: 120,
    tasks: [
      {
        description: "scan\nfiles\u001B[31m",
        id: "task-1",
        name: "Explore\nFAKE ROW\u001B[31m",
        status: "running\nROW2",
        tokenCount: 5
      }
    ]
  });
  assert.equal(rows[0].content.includes("\n"), false);
  assert.equal(rows[0].content.includes("\u001B[31m"), false);
  assert.equal(
    plainText(rows[0].content),
    "Explore FAKE ROW · running ROW2 · 5 tok · scan files"
  );
});

test("the command reads tasks from stdin and writes one JSON row per task", () => {
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf-8",
    input: JSON.stringify({
      columns: 120,
      tasks: [
        {
          agentType: "Explore",
          description: "map the auth flow",
          effort: "high",
          id: "task-1",
          model: "claude-opus-5-5",
          status: "running",
          tokenCount: 12_345
        }
      ]
    })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const lines = result.stdout.split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[1], "");
  const row = JSON.parse(lines[0]);
  assert.equal(row.id, "task-1");
  assert.deepEqual(Object.keys(row), ["content", "id"]);
  assert.equal(
    plainText(row.content),
    "Explore · claude-opus-5-5 · high · running · 12.3k tok · map the auth flow"
  );
});

test("malformed stdin exits silently without rows", () => {
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf-8",
    input: "{"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
