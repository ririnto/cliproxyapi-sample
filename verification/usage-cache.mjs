import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { withUsageCache } from "../.claude/statusline/usage-cache.mjs";

const actions = [
  { identity: "a", outcome: "success" },
  { identity: "a", outcome: "failure" },
  { identity: "b", outcome: "success" },
  { identity: "b", outcome: "failure" }
].flatMap((action) => [1000, 6000].map((elapsed) => ({ ...action, elapsed })));
const sequences = [[]];
for (let depth = 0; depth < 3; depth += 1) {
  for (const sequence of sequences.filter((item) => item.length === depth)) {
    for (const action of actions) {
      sequences.push([...sequence, action]);
    }
  }
}

const root = await mkdtemp(path.join(tmpdir(), "verify-usage-cache-"));
try {
  const results = await Promise.allSettled(
    sequences.map(async (sequence, index) => {
      const cacheDir = path.join(root, String(index));
      const run = async (step, previousNow) => {
        const action = sequence[step];
        if (!action) {
          return;
        }
        const now = previousNow + action.elapsed;
        const snapshot = await withUsageCache(
          "zai",
          action.identity,
          {
            cacheDir,
            fetch: () => ({ status: action.outcome === "success" ? 200 : 429 }),
            now
          },
          async (options) => {
            await options.fetch();
            return { owner: action.identity };
          }
        );
        assert.ok(
          snapshot === undefined || snapshot.owner === action.identity,
          `foreign snapshot at ${JSON.stringify(sequence.slice(0, step + 1))}`
        );
        await run(step + 1, now);
      };
      await run(0, 0);
    })
  );
  for (const result of results) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
  console.log(`Credential isolation holds for ${sequences.length} sequences.`);
} finally {
  await rm(root, { force: true, recursive: true });
}
