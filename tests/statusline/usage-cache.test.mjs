import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";

import { usageRuntime } from "../../.claude/statusline.mjs";

const { withUsageCache } = usageRuntime;

/**
 * @param {number} percentage - Account usage percentage.
 * @param {number} [resetsInMs] - Reset countdown.
 * @returns {import("../../.claude/statusline/types.ts").Snapshot} Usage snapshot.
 */
const snapshot = (percentage, resetsInMs = 9000) => ({
  groups: [
    {
      metrics: [{ label: "5h", type: "percentage", percentage, resetsInMs }]
    }
  ]
});

/**
 * @param {string} cacheDir - Cache directory.
 * @param {number} now - Current time in milliseconds.
 * @param {string} [retryAfter] - Optional Retry-After value.
 * @param {number} [status] - HTTP status returned by the fake response.
 */
const optionsFor = (cacheDir, now, retryAfter, status = 200) => ({
  cacheDir,
  fetch: () =>
    new Response(null, {
      headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter },
      status
    }),
  now
});

/** @type {string} */
let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(os.tmpdir(), "usage-cache-"));
});

afterEach(async () => {
  await rm(cacheDir, { force: true, recursive: true });
});

await test("keeps cached usage isolated between accounts", async () => {
  let calls = 0;
  /**
   * @param {number} percentage - Account usage to return.
   * @returns {(options: import("../../.claude/statusline/types.ts").UsageOptions) => Promise<import("../../.claude/statusline/types.ts").Snapshot>} Collector callback.
   */
  const load = (percentage) => async (options) => {
    calls += 1;
    await (options.fetch ?? globalThis.fetch)("https://example.test", {
      headers: {},
      method: "GET",
      signal: new AbortController().signal
    });
    return snapshot(percentage);
  };

  const accountA = await withUsageCache(
    "zai",
    "account-a",
    optionsFor(cacheDir, 1000),
    load(10)
  );
  const cachedAccountA = await withUsageCache(
    "zai",
    "account-a",
    optionsFor(cacheDir, 2000),
    load(30)
  );
  const accountB = await withUsageCache(
    "zai",
    "account-b",
    optionsFor(cacheDir, 2000),
    load(20)
  );
  const accountAAfterSwitch = await withUsageCache(
    "zai",
    "account-a",
    optionsFor(cacheDir, 2000),
    load(10)
  );

  assert.deepEqual(accountA, snapshot(10));
  assert.deepEqual(cachedAccountA, snapshot(10, 8000));
  assert.deepEqual(accountB, snapshot(20));
  assert.deepEqual(accountAAfterSwitch, snapshot(10));
  assert.equal(calls, 3);
});

await test("serves recent usage during Retry-After and skips repeated requests", async () => {
  let calls = 0;
  /** @param {import("../../.claude/statusline/types.ts").UsageOptions} options - Wrapped request options. */
  const load = async (options) => {
    calls += 1;
    await (options.fetch ?? globalThis.fetch)("https://example.test", {
      headers: {},
      method: "GET",
      signal: new AbortController().signal
    });
    return snapshot(10);
  };

  await withUsageCache("zai", "account", optionsFor(cacheDir, 1000), load);
  const rateLimited = await withUsageCache(
    "zai",
    "account",
    optionsFor(cacheDir, 62_000, "600", 429),
    async (options) => {
      calls += 1;
      await (options.fetch ?? globalThis.fetch)("https://example.test", {
        headers: {},
        method: "GET",
        signal: new AbortController().signal
      });
    }
  );
  const duringCooldown = await withUsageCache(
    "zai",
    "account",
    optionsFor(cacheDir, 100_000),
    () => assert.fail("Retry-After should suppress another request")
  );

  assert.deepEqual(rateLimited, snapshot(10, 0));
  assert.deepEqual(duringCooldown, snapshot(10, 0));
  assert.equal(calls, 2);
});
