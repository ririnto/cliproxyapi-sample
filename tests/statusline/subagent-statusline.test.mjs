import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

import { renderRows } from "../../.claude/subagent-statusline.mjs";

/**
 * @param {string} row - Serialized row.
 * @returns {{id: string, content: string}} Validated output.
 */
const parseRow = (row) => {
  /** @type {unknown} */
  const result = JSON.parse(row);
  assert.ok(result !== null && typeof result === "object");
  assert.ok("id" in result && typeof result.id === "string");
  assert.ok("content" in result && typeof result.content === "string");
  return { content: result.content, id: result.id };
};

const nowMs = 1_700_000_000_000;

/** @param {Record<string, string | number>} [usage] - Request token usage. */
const entry = (usage) => ({
  message: { id: "same-message", role: "assistant", usage },
  type: "assistant"
});

await test("subagent rows preserve task ids and align right metrics", () => {
  const rows = renderRows(
    {
      columns: 100,
      cwd: "/workspace/project",
      tasks: [
        {
          agentType: "worker",
          contextWindowSize: 200_000,
          cwd: "/workspace/project",
          description: "Investigate fixture",
          effort: "high",
          id: "task-1",
          model: "zai-coding-plan/glm-5.4",
          name: "worker",
          startTime: nowMs - 65_000,
          status: "running",
          tokenCount: 20_000
        },
        {
          agentType: "explorer",
          id: "task-2",
          startTime: nowMs - 125_000,
          status: "completed",
          tokenCount: 0
        }
      ]
    },
    nowMs
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => parseRow(row).id),
    ["task-1", "task-2"]
  );
  assert.match(
    stripVTControlCharacters(parseRow(rows[0]).content),
    /zai-coding-plan\/glm-5\.4 high/u
  );
  assert.match(stripVTControlCharacters(parseRow(rows[0]).content), /20k tok/u);
  assert.doesNotMatch(
    stripVTControlCharacters(parseRow(rows[0]).content),
    /▰|▱|%/u
  );
  assert.match(
    stripVTControlCharacters(parseRow(rows[1]).content),
    /✔ explorer\s+0 tok\s+2m05s/u
  );
  const firstRightEdge = stripVTControlCharacters(
    parseRow(rows[0]).content
  ).length;
  const secondRightEdge = stripVTControlCharacters(
    parseRow(rows[1]).content
  ).length;
  assert.equal(firstRightEdge, secondRightEdge);
});

await test("last request input includes cache tokens without summing duplicate records", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "subagent-input-test-"));
  t.after(() => {
    rmSync(directory, { force: true, recursive: true });
  });
  assert.ok(process.getuid);
  const tasks = path.join(
    directory,
    `claude-${process.getuid()}`,
    "project",
    "session",
    "tasks"
  );
  mkdirSync(tasks, { recursive: true });
  const transcript = path.join(tasks, "input-fixture.output");
  /** @param {ReturnType<typeof entry>[]} entries - Transcript entries. */
  const run = (entries) => {
    writeFileSync(
      transcript,
      `${entries.map((item) => JSON.stringify(item)).join("\n")}\n`
    );
    const result = spawnSync(
      process.execPath,
      [
        new URL("../../.claude/subagent-statusline.mjs", import.meta.url)
          .pathname
      ],
      {
        encoding: "utf-8",
        env: { ...process.env, TMPDIR: directory },
        input: JSON.stringify({
          columns: 80,
          tasks: [{ id: "input-fixture", name: "worker", tokenCount: 99_000 }]
        })
      }
    );
    assert.equal(result.status, 0, result.stderr);
    return stripVTControlCharacters(parseRow(result.stdout).content);
  };
  const earlier = entry({
    cache_creation_input_tokens: 200,
    cache_read_input_tokens: 300,
    input_tokens: 100
  });
  const latest = entry({
    cache_creation_input_tokens: 400,
    cache_read_input_tokens: 9000,
    input_tokens: 200
  });
  assert.match(run([earlier, latest, latest]), /99k tok in 9\.6k/u);
});
