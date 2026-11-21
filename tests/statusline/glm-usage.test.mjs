import assert from "node:assert/strict";
import { test } from "node:test";

import { usageRuntime } from "../../.claude/statusline.mjs";
import { fetchUsage } from "../../.claude/statusline/glm-usage.mjs";

const NOW = 1_700_000_000_000;

/**
 * @param {number} unit - Provider quota window unit.
 * @param {string} [type] - Provider quota type.
 */
const limit = (unit, type = "TOKENS_LIMIT") => ({
  nextResetTime: NOW + 3_600_000,
  number: unit === 3 ? 5 : 1,
  percentage: unit === 3 ? 10 : 20,
  type,
  unit
});

/**
 * @param {Record<string, unknown>[]} limits - Provider quota entries.
 * @param {string} [level] - Optional subscription level.
 */
const response = (limits, level) =>
  Response.json({
    data: { limits, ...(level === undefined ? {} : { level }) },
    success: true
  });

await test("maps token and credit quota windows to statusline metrics", async () => {
  const snapshot = await fetchUsage(
    {
      cache: false,
      credential: "test-key",
      fetch: () => response([limit(3), limit(6, "CREDIT_LIMIT")]),
      now: NOW
    },
    usageRuntime
  );
  assert.deepEqual(snapshot, {
    groups: [
      {
        metrics: [
          {
            label: "5h",
            percentage: 10,
            resetsInMs: 3_600_000,
            type: "percentage"
          },
          {
            label: "7d",
            percentage: 20,
            resetsInMs: 3_600_000,
            type: "percentage"
          }
        ]
      }
    ]
  });
});

await test("labels the Pro plan and leaves other plan names unlabelled", async () => {
  const pro = await fetchUsage(
    {
      cache: false,
      credential: "test-key",
      fetch: () => response([limit(3)], "pro"),
      now: NOW
    },
    usageRuntime
  );
  const enterprise = await fetchUsage(
    {
      cache: false,
      credential: "test-key",
      fetch: () => response([limit(3)], "enterprise-ultra"),
      now: NOW
    },
    usageRuntime
  );
  assert.equal(pro?.groups[0].label, "Z.AI (Pro)");
  assert.equal(enterprise?.groups[0].label, undefined);
});
