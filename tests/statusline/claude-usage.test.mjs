import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { usageRuntime } from "../../.claude/statusline.mjs";
import { fetchUsage } from "../../.claude/statusline/claude-usage.mjs";

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
 * @param {unknown} value - Value to inspect.
 * @returns {value is Record<string, unknown>} Whether the value is a non-null object.
 */
const isRecord = (value) => typeof value === "object" && value !== null;

/** @type {(value: unknown) => asserts value is {groups: {label?: unknown, metrics: Record<string, unknown>[]}[]}} */
const assertSnapshot = (value) => {
  assert.ok(isRecord(value));
  assert.ok(Array.isArray(value.groups));
  for (const group of value.groups) {
    assert.ok(isRecord(group));
    assert.ok(Array.isArray(group.metrics));
    assert.ok(group.metrics.every(isRecord));
  }
};

/** @param {unknown} metric - Metric under assertion.
 * @param {string} field - Expected field.
 * @returns {unknown} Validated field value.
 */
const metricField = (metric, field) => {
  assert.ok(isRecord(metric));
  assert.ok(field in metric);
  return metric[field];
};

const NOW = Date.parse("2026-10-12T00:00:00Z");
/**
 * @param {string} accessToken - OAuth token for the fixture.
 * @param {string} [subscriptionType] - Subscription name.
 */
const credentials = (accessToken, subscriptionType = "max") => ({
  claudeAiOauth: {
    accessToken,
    expiresAt: NOW + 3_600_000,
    refreshToken: "unused-refresh-token",
    scopes: ["user:profile", "user:inference"],
    subscriptionType
  }
});
const usage = {
  five_hour: { resets_at: "2026-10-12T00:46:00Z", utilization: 37 },
  seven_day: { resets_at: "2026-10-14T13:00:00Z", utilization: 6 }
};
/**
 * @param {unknown} [payload] - Response payload.
 * @param {number} [status] - HTTP status.
 */
const response = (payload = usage, status = 200) =>
  jsonResponse(() => payload, status);

await test("API key가 있어도 native Keychain의 OAuth 인증으로 구독 사용량을 조회한다", async () => {
  assert.deepEqual(
    await fetchUsage(
      {
        cache: false,
        environment: { ANTHROPIC_API_KEY: "proxy-api-key" },
        execFile: (file, args) => {
          assert.equal(file, "security");
          assert.deepEqual(args, [
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w"
          ]);
          return JSON.stringify(credentials("native-token"));
        },
        fetch: (url, options) => {
          assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
          assert.equal(options.method, "GET");
          assert.equal(options.headers.Authorization, "Bearer native-token");
          assert.equal(options.headers["anthropic-beta"], "oauth-2025-04-20");
          return response();
        },
        home: "/nonexistent",
        now: NOW
      },
      usageRuntime
    ),
    {
      groups: [
        {
          label: "Claude (Max)",
          metrics: [
            {
              label: "5h",
              percentage: 37,
              resetsInMs: 2_760_000,
              type: "percentage"
            },
            {
              label: "7d",
              percentage: 6,
              resetsInMs: 219_600_000,
              type: "percentage"
            }
          ]
        }
      ]
    }
  );
});
await test("Keychain 조회가 실패하면 native credentials 파일을 사용한다", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "claude-usage-"));
  try {
    await mkdir(path.join(home, ".claude"));
    await writeFile(
      path.join(home, ".claude", ".credentials.json"),
      JSON.stringify(credentials("file-token", "pro"))
    );
    const snapshot = await fetchUsage(
      {
        cache: false,
        environment: {},
        execFile: () => {
          throw new Error("no keychain");
        },
        fetch: (_url, options) => {
          assert.equal(options.headers.Authorization, "Bearer file-token");
          return response();
        },
        home,
        now: NOW
      },
      usageRuntime
    );
    assertSnapshot(snapshot);
    assert.equal(snapshot.groups[0].label, "Claude (Pro)");
    assert.equal(metricField(snapshot.groups[0].metrics[0], "percentage"), 37);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});
