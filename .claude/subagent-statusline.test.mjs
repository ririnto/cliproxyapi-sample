import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

import { renderRows } from "./subagent-statusline.mjs";

const nowMs = 1_700_000_000_000;

test("subagent rows preserve task ids and align right metrics", () => {
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
          model: "glm-5.3",
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
    rows.map((row) => JSON.parse(row).id),
    ["task-1", "task-2"]
  );
  assert.match(
    stripVTControlCharacters(JSON.parse(rows[0]).content),
    /glm-5.3 high/u
  );
  assert.match(
    stripVTControlCharacters(JSON.parse(rows[0]).content),
    /20k tok/u
  );
  assert.doesNotMatch(
    stripVTControlCharacters(JSON.parse(rows[0]).content),
    /▰|▱|%/u
  );
  assert.match(
    stripVTControlCharacters(JSON.parse(rows[1]).content),
    /✔ explorer\s+0 tok\s+2m05s/u
  );
  const firstRightEdge = stripVTControlCharacters(
    JSON.parse(rows[0]).content
  ).length;
  const secondRightEdge = stripVTControlCharacters(
    JSON.parse(rows[1]).content
  ).length;
  assert.equal(firstRightEdge, secondRightEdge);
});

test("subagent rows omit missing metrics and sanitize task labels", () => {
  const [row] = renderRows(
    {
      columns: 0,
      tasks: [
        {
          agentType: "worker",
          description: "safe\u000Blabel\nvalue",
          effort: "low",
          id: "task",
          model: "gpt-6.1-sol",
          startTime: nowMs,
          status: "failed",
          tokenCount: 0
        }
      ]
    },
    nowMs
  );
  const content = stripVTControlCharacters(JSON.parse(row).content);

  assert.match(
    content,
    /✗ worker gpt-6.1-sol low safe label value\s+0 tok\s+0s/u
  );
  assert.doesNotMatch(content, /▰|▱|⌥/u);
});

test("long descriptions give way to right-aligned worktree and metrics", () => {
  const input = {
    columns: 80,
    cwd: "/project",
    tasks: [
      {
        contextWindowSize: 200_000,
        cwd: "/worktree/feature",
        description: "A long description ".repeat(40),
        effort: "high",
        id: "layout-fixture",
        model: "model",
        name: "worker",
        startTime: nowMs - 65_000,
        status: "running",
        tokenCount: 12_345
      }
    ]
  };
  const plain = stripVTControlCharacters(
    JSON.parse(renderRows(input, nowMs)[0]).content
  );
  assert.equal(plain.length, 80);
  assert.match(plain, /…\s+⌥ feature\s+12\.3k.*1m05s$/u);
  for (const columns of [16, 20, 30]) {
    const compact = stripVTControlCharacters(
      JSON.parse(renderRows({ ...input, columns }, nowMs)[0]).content
    );
    assert.equal(compact.length, columns);
    assert.match(compact, /12\.3k tok 1m05s$/u);
  }
});

test("wide and combined descriptions clip on grapheme boundaries", () => {
  const [row] = renderRows(
    {
      columns: 40,
      tasks: [
        {
          description: "한𠀀👩‍💻e\u0301".repeat(30),
          id: "unicode-layout-fixture",
          name: "worker",
          startTime: nowMs - 65_000,
          status: "running",
          tokenCount: 12_345
        }
      ]
    },
    nowMs
  );
  const plain = stripVTControlCharacters(JSON.parse(row).content);
  assert.equal(
    plain
      .replaceAll("한", "HH")
      .replaceAll("𠀀", "CC")
      .replaceAll("👩‍💻", "EE")
      .replaceAll("e\u0301", "e").length,
    40
  );
  assert.match(plain, /…\s+12\.3k tok\s+1m05s$/u);
  assert.doesNotMatch(plain.replaceAll("👩‍💻", ""), /👩|💻|\u200D/u);
});

test("tokens use the supplied task count, not a context ratio", () => {
  const [row] = renderRows(
    {
      columns: 50,
      tasks: [
        {
          contextWindowSize: 200_000,
          id: "token-fixture",
          name: "worker",
          tokenCount: 450_000
        }
      ]
    },
    nowMs
  );
  const plain = stripVTControlCharacters(JSON.parse(row).content);
  assert.match(plain, /450k tok/u);
  assert.doesNotMatch(plain, /%|▰|▱/u);
  for (const tokenCount of [undefined, null, false, "", "invalid", -1]) {
    const [unknown] = renderRows(
      { columns: 50, tasks: [{ id: "unknown", name: "worker", tokenCount }] },
      nowMs
    );
    assert.doesNotMatch(
      stripVTControlCharacters(JSON.parse(unknown).content),
      /Σ|tok|%/u
    );
  }
});

const entry = (usage) => ({
  message: { id: "same-message", role: "assistant", usage },
  type: "assistant"
});

test("last request input includes cache tokens without summing duplicate records", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "subagent-input-test-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const tasks = path.join(
    directory,
    `claude-${process.getuid()}`,
    "project",
    "session",
    "tasks"
  );
  mkdirSync(tasks, { recursive: true });
  const transcript = path.join(tasks, "input-fixture.output");
  const run = (entries) => {
    writeFileSync(
      transcript,
      `${entries.map((item) => JSON.stringify(item)).join("\n")}\n`
    );
    const result = spawnSync(
      process.execPath,
      [new URL("subagent-statusline.mjs", import.meta.url).pathname],
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
    return stripVTControlCharacters(JSON.parse(result.stdout).content);
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
  assert.match(run([latest, entry({ input_tokens: 123 })]), /in 123/u);
  assert.doesNotMatch(run([latest, entry()]), / in /u);
  assert.doesNotMatch(run([latest, entry({ input_tokens: -1 })]), / in /u);
  assert.doesNotMatch(
    run([
      latest,
      entry({ cache_read_input_tokens: "unknown", input_tokens: 1 })
    ]),
    / in /u
  );
});
