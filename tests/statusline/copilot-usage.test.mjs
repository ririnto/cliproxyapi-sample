import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { usageRuntime } from "../../.claude/statusline.mjs";
import { fetchUsage } from "../../.claude/statusline/copilot-usage.mjs";

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

/** @typedef {{label: string, type: string, used: number, total: number, resetsInMs: number}} SnapshotMetric */
/** @typedef {{groups: {label?: string, metrics: SnapshotMetric[]}[]}} Snapshot */
/** @type {(value: unknown) => asserts value is Snapshot} */
const assertSnapshot = (value) => {
  assert.ok(value !== null && typeof value === "object" && "groups" in value);
  const { groups: rawGroups } = value;
  assert.ok(Array.isArray(rawGroups));
  /** @type {unknown[]} */
  const groups = rawGroups;
  assert.ok(groups.length > 0);
  for (const group of groups) {
    assert.ok(
      group !== null && typeof group === "object" && "metrics" in group
    );
    if ("label" in group && group.label !== undefined) {
      assert.equal(typeof group.label, "string");
    }
    const { metrics: rawMetrics } = group;
    assert.ok(Array.isArray(rawMetrics));
    /** @type {unknown[]} */
    const metrics = rawMetrics;
    for (const metric of metrics) {
      assert.ok(metric !== null && typeof metric === "object");
      assert.ok("label" in metric && typeof metric.label === "string");
      assert.ok("type" in metric && typeof metric.type === "string");
      assert.ok("used" in metric && typeof metric.used === "number");
      assert.ok("total" in metric && typeof metric.total === "number");
      assert.ok(
        "resetsInMs" in metric && typeof metric.resetsInMs === "number"
      );
    }
  }
};

await test("reads Copilot CLI Keychain token when file credentials are absent", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "copilot-usage-"));
  try {
    const snapshot = await fetchUsage(
      {
        cache: false,
        environment: {
          COPILOT_GITHUB_TOKEN: "",
          GH_TOKEN: "",
          GITHUB_TOKEN: ""
        },
        execFile: (file, args) => {
          assert.equal(file, "security");
          assert.deepEqual(args, [
            "find-generic-password",
            "-s",
            "copilot-cli",
            "-w"
          ]);
          return "keychain-token\n";
        },
        fetch: (_url, options) => {
          assert.equal(options.headers.Authorization, "token keychain-token");
          return jsonResponse(
            () => ({
              quota_reset_date_utc: "2026-10-01T00:00:00Z",
              quota_snapshots: {
                premium_interactions: { entitlement: 100, quota_remaining: 80 }
              }
            }),
            200
          );
        },
        home,
        now: Date.parse("2026-09-23T00:00:00Z"),
        platform: "darwin"
      },
      usageRuntime
    );
    assertSnapshot(snapshot);
    assert.equal(snapshot.groups[0].metrics[0].used, 20);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});
await test("falls back to file credentials when Keychain lookup fails", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "copilot-usage-"));
  try {
    await mkdir(path.join(home, ".config", "gh"), { recursive: true });
    await writeFile(
      path.join(home, ".config", "gh", "hosts.json"),
      JSON.stringify({ "github.com": { oauth_token: "file-token" } })
    );
    /** @type {string[][]} */
    const requested = [];
    const snapshot = await fetchUsage(
      {
        cache: false,
        environment: {},
        execFile: (file, args) => {
          requested.push([file, ...args]);
          throw new Error("no keychain entry");
        },
        fetch: (_url, options) => {
          assert.equal(options.headers.Authorization, "token file-token");
          return jsonResponse(
            () => ({
              quota_snapshots: {
                premium_interactions: { entitlement: 100, quota_remaining: 100 }
              }
            }),
            200
          );
        },
        home,
        platform: "darwin"
      },
      usageRuntime
    );
    assert.deepEqual(requested, [
      ["security", "find-generic-password", "-s", "copilot-cli", "-w"]
    ]);
    assertSnapshot(snapshot);
    assert.equal(snapshot.groups[0].metrics[0].used, 0);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});
