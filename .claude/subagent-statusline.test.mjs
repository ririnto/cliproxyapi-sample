import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

import { renderRows } from "./subagent-statusline.mjs";

const nowMs = 1_700_000_000_000;

test("reads transcript usage from the current user directory", (t) => {
  if (typeof process.getuid !== "function") {
    t.skip("POSIX user ID is unavailable");
    return;
  }
  const directory = mkdtempSync(
    path.join(tmpdir(), "subagent-statusline-test-")
  );
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const tasks = path.join(
    directory,
    `claude-${process.getuid()}`,
    "project",
    "session",
    "tasks"
  );
  mkdirSync(tasks, { recursive: true });
  const transcript = path.join(tasks, "fixture.output");
  const message = {
    id: "message-1",
    usage: {
      cache_creation_input_tokens: 400,
      cache_read_input_tokens: 9000,
      input_tokens: 1200,
      output_tokens: 300
    }
  };
  writeFileSync(
    transcript,
    [message, message]
      .map((item) => JSON.stringify({ message: item }))
      .join("\n")
  );
  const cache = path.join(directory, "subagent-statusline-usage");
  mkdirSync(cache, { recursive: true });
  const stat = statSync(transcript);
  writeFileSync(
    path.join(cache, "fixture.json"),
    JSON.stringify({ key: `${stat.mtimeMs}:${stat.size}`, total: 99_999 })
  );
  const run = () =>
    spawnSync(
      process.execPath,
      [new URL("subagent-statusline.mjs", import.meta.url).pathname],
      {
        encoding: "utf-8",
        env: { ...process.env, TMPDIR: directory },
        input: JSON.stringify({
          tasks: [
            {
              agentType: "worker",
              id: "fixture",
              status: "completed",
              tokenCount: 0
            }
          ]
        })
      }
    );
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    stripVTControlCharacters(JSON.parse(result.stdout).content),
    /Σ\s*1\.9k/u
  );
  writeFileSync(
    transcript,
    `${JSON.stringify({ message })}\n${JSON.stringify({ message: { id: "message-2", usage: { input_tokens: 100 } } })}`
  );
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    stripVTControlCharacters(JSON.parse(result.stdout).content),
    /Σ\s*2k/u
  );
});

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
  assert.match(stripVTControlCharacters(JSON.parse(rows[0]).content), /▰▱/u);
  assert.match(
    stripVTControlCharacters(JSON.parse(rows[1]).content),
    /✔ explorer\s+0\s+2m05s/u
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

  assert.match(content, /✗ worker gpt-6.1-sol low safe label value\s+0\s+0s/u);
  assert.doesNotMatch(content, /▰|▱|⌥|Σ/u);
});
