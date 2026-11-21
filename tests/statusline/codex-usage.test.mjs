import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { usageRuntime } from "../../.claude/statusline.mjs";
import { fetchUsage } from "../../.claude/statusline/codex-usage.mjs";

/**
 * @param {() => unknown} body - Lazy payload, including malformed JSON failures.
 * @param {number} status - Fixture HTTP status.
 * @returns {Response} Fetch response preserving fixture payload values.
 */
const jsonResponse = (body, status) => {
  const response = new Response(null, { status });
  Object.defineProperty(response, "json", { value: async () => await body() });
  return response;
};

/**
 * @param {unknown} value - Data to inspect.
 * @returns {value is Record<string, unknown>} Whether the value is a record.
 */
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * @param {unknown} snapshot - Returned usage snapshot.
 * @returns {Record<string, unknown>[]} Validated groups.
 */
const snapshotGroups = (snapshot) => {
  assert.ok(isRecord(snapshot));
  assert.ok(Array.isArray(snapshot.groups));
  assert.ok(snapshot.groups.every(isRecord));
  return snapshot.groups;
};

/** @param {string} home - Temporary home directory. */
const writeAuth = async (home) => {
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(
    path.join(home, ".codex", "auth.json"),
    JSON.stringify({ tokens: { access_token: "tok", account_id: "acc" } })
  );
};

await test("fetches account limits and keeps additional quota windows separate", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-usage-"));
  try {
    await writeAuth(home);
    const snapshot = await fetchUsage(
      {
        cache: false,
        home,
        fetch: (_url, options) => {
          assert.equal(options.headers.Authorization, "Bearer tok");
          assert.equal(options.headers["ChatGPT-Account-ID"], "acc");
          return Response.json({
            rate_limit: {
              primary_window: {
                limit_window_seconds: 18_000,
                used_percent: 20,
                reset_after_seconds: 3
              },
              secondary_window: {
                limit_window_seconds: 604_800,
                used_percent: 10
              }
            },
            additional_rate_limits: [
              {
                limit_name: "extra",
                rate_limit: {
                  primary_window: {
                    limit_window_seconds: 7200,
                    used_percent: 5
                  }
                }
              }
            ]
          });
        }
      },
      usageRuntime
    );
    assert.deepEqual(
      snapshot?.groups.map((group) => group.metrics),
      [
        [
          { label: "7d", type: "percentage", percentage: 10, resetsInMs: 0 },
          { label: "5h", type: "percentage", percentage: 20, resetsInMs: 3000 }
        ],
        [{ label: "2h", type: "percentage", percentage: 5, resetsInMs: 0 }]
      ]
    );
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});
await test("normalizes finite positive ChatGPT credits without assuming a currency", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-usage-"));
  try {
    await writeAuth(home);
    const snapshot = await fetchUsage(
      {
        cache: false,
        fetch: () =>
          jsonResponse(
            () => ({
              credits: { balance: "12.5", has_credits: true, unlimited: false }
            }),
            200
          ),
        home
      },
      usageRuntime
    );
    assert.deepEqual(snapshotGroups(snapshot), [
      { metrics: [{ label: "credit", remaining: 12.5, type: "credit" }] }
    ]);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});
