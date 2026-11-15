import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { fetchUsage } from "./codex-usage.mjs";

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

/**
 * @param {unknown} group - Returned usage group.
 * @returns {Record<string, unknown>[]} Validated metrics.
 */
const groupMetrics = (group) => {
  assert.ok(isRecord(group));
  assert.ok(Array.isArray(group.metrics));
  assert.ok(group.metrics.every(isRecord));
  return group.metrics;
};

/** @param {string} home - Temporary home directory. */
const writeAuth = async (home) => {
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(
    path.join(home, ".codex", "auth.json"),
    JSON.stringify({ tokens: { access_token: "tok", account_id: "acc" } })
  );
};

await test("labels the main group with the ChatGPT plan", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-usage-"));
  try {
    await writeAuth(home);
    const snapshot = await fetchUsage({
      cache: false,
      fetch: (_url, options) => {
        assert.equal(options.headers.Authorization, "Bearer tok");
        assert.equal(options.headers["ChatGPT-Account-ID"], "acc");
        return jsonResponse(
          () => ({
            plan_type: "pro",
            rate_limit: {
              primary_window: {
                limit_window_seconds: 604_800,
                used_percent: 10
              },
              secondary_window: {
                limit_window_seconds: 18_000,
                used_percent: 20
              }
            }
          }),
          200
        );
      },
      home
    });
    assert.equal(snapshotGroups(snapshot)[0].label, "ChatGPT (Pro)");
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

await test("omits the main group label for a missing or unknown plan", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-usage-"));
  try {
    await writeAuth(home);
    const snapshots = await Promise.all(
      [undefined, "not-a-plan"].map(
        async (plan_type) =>
          await fetchUsage({
            cache: false,
            fetch: () =>
              jsonResponse(
                () => ({
                  plan_type,
                  rate_limit: {
                    secondary_window: {
                      limit_window_seconds: 18_000,
                      used_percent: 1
                    }
                  }
                }),
                200
              ),
            home
          })
      )
    );
    assert.deepEqual(
      snapshots.map((snapshot) => snapshotGroups(snapshot)[0].label),
      [undefined, undefined]
    );
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

await test("keeps the Additional label for additional rate limits", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-usage-"));
  try {
    await writeAuth(home);
    const snapshot = await fetchUsage({
      cache: false,
      fetch: () =>
        jsonResponse(
          () => ({
            additional_rate_limits: [
              {
                limit_name: "gpt-5.3-codex-spark",
                rate_limit: {
                  secondary_window: {
                    limit_window_seconds: 18_000,
                    used_percent: 5
                  }
                }
              }
            ],
            plan_type: "plus",
            rate_limit: {
              secondary_window: {
                limit_window_seconds: 18_000,
                used_percent: 1
              }
            }
          }),
          200
        ),
      home
    });
    assert.equal(snapshotGroups(snapshot)[0].label, "ChatGPT (Plus)");
    assert.equal(snapshotGroups(snapshot)[1].label, "Additional");
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

await test("normalizes finite positive ChatGPT credits without assuming a currency", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-usage-"));
  try {
    await writeAuth(home);
    const snapshot = await fetchUsage({
      cache: false,
      fetch: () =>
        jsonResponse(
          () => ({
            credits: { balance: "12.5", has_credits: true, unlimited: false }
          }),
          200
        ),
      home
    });
    assert.deepEqual(snapshotGroups(snapshot), [
      { metrics: [{ label: "credit", remaining: 12.5, type: "credit" }] }
    ]);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

await test("omits absent, unusable, or unowned ChatGPT credits", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-usage-"));
  try {
    await writeAuth(home);
    const snapshots = await Promise.all(
      [
        { balance: 5, has_credits: false, unlimited: false },
        ...[undefined, 0, -1, "Infinity", "12credits"].map((balance) => ({
          balance,
          has_credits: true,
          unlimited: false
        }))
      ].map(
        async (credits) =>
          await fetchUsage({
            cache: false,
            fetch: () => jsonResponse(() => ({ credits }), 200),
            home
          })
      )
    );
    assert.deepEqual(snapshots, Array.from({ length: snapshots.length }));
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

await test("caches normalized ChatGPT snapshots in an isolated directory", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-usage-"));
  let calls = 0;
  try {
    await writeAuth(home);
    const options = {
      cacheDir: path.join(home, "cache"),
      fetch: () => {
        calls += 1;
        return jsonResponse(
          () => ({
            credits: { balance: 8, has_credits: true, unlimited: false }
          }),
          200
        );
      },
      home,
      now: 1000
    };
    const first = await fetchUsage(options);
    assert.deepEqual(await fetchUsage(options), first);
    assert.equal(calls, 1);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

await test("retains the last snapshot after a malformed cached response", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-usage-"));
  let now = 1000;
  let calls = 0;
  try {
    await writeAuth(home);
    const options = {
      cacheDir: path.join(home, "cache"),
      cacheTtlMs: 0,
      fetch: () => {
        calls += 1;
        return jsonResponse(() => {
          if (calls > 1) {
            throw new Error("invalid body");
          }
          return {
            credits: { balance: 8, has_credits: true, unlimited: false }
          };
        }, 200);
      },
      home,
      now
    };
    const first = await fetchUsage(options);
    now += 1;
    assert.deepEqual(await fetchUsage({ ...options, now }), first);
    assert.equal(calls, 2);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

await test("shows owned credits regardless of the unlimited flag", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-usage-"));
  try {
    await writeAuth(home);
    const snapshots = await Promise.all(
      [undefined, null, "false", 0, 1, true, false].map(
        async (unlimited) =>
          await fetchUsage({
            cache: false,
            fetch: () =>
              jsonResponse(
                () => ({
                  credits: { balance: 5, has_credits: true, unlimited }
                }),
                200
              ),
            home
          })
      )
    );
    assert.deepEqual(
      snapshots.map(
        (snapshot) => groupMetrics(snapshotGroups(snapshot)[0])[0].remaining
      ),
      snapshots.map(() => 5)
    );
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

await test("preserves cached usage for malformed and provider-error payloads", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-usage-"));
  try {
    await writeAuth(home);
    await Promise.all(
      [
        () => {
          throw new Error("invalid body");
        },
        () => null,
        () => ({ error: "provider error" }),
        () => ({ success: false })
      ].map(async (json, index) => {
        const options = {
          cacheDir: path.join(home, `cache-${index}`),
          cacheTtlMs: 0,
          fetch: () =>
            jsonResponse(
              () => ({ credits: { balance: 5, has_credits: true } }),
              200
            ),
          home,
          now: 1000
        };
        const previous = await fetchUsage(options);
        assert.equal(Boolean(previous), true);
        assert.deepEqual(
          await fetchUsage({
            ...options,
            fetch: () => jsonResponse(json, 200),
            now: 1001
          }),
          previous
        );
      })
    );
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

await test("clears cached usage for valid empty and zero-credit payloads", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-usage-"));
  try {
    await writeAuth(home);
    await Promise.all(
      [
        {},
        { credits: { balance: 0, has_credits: true, unlimited: false } }
      ].map(async (payload, index) => {
        const options = {
          cacheDir: path.join(home, `cache-${index}`),
          cacheTtlMs: 0,
          fetch: () =>
            jsonResponse(
              () => ({ credits: { balance: 5, has_credits: true } }),
              200
            ),
          home,
          now: 1000
        };
        assert.equal(Boolean(await fetchUsage(options)), true);
        assert.equal(
          await fetchUsage({
            ...options,
            fetch: () => jsonResponse(() => payload, 200),
            now: 1001
          }),
          undefined
        );
        assert.equal(
          await fetchUsage({
            ...options,
            fetch: () => {
              throw new Error("offline");
            },
            now: 1002
          }),
          undefined
        );
      })
    );
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

await test("returns undefined instead of throwing when the response fails", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-usage-"));
  try {
    await writeAuth(home);
    assert.deepEqual(
      await Promise.all(
        [{ status: 401 }, { status: undefined }].map(
          async (response) =>
            await fetchUsage({
              cache: false,
              fetch: () =>
                Object.defineProperty(new Response(null), "status", {
                  value: response.status
                }),
              home
            })
        )
      ),
      [undefined, undefined]
    );
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

await test("keeps optional diagnostics content-free while using OpenCode credentials", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-usage-"));
  const diagnosticContent = "SYNTHETIC_CANARY";
  const fallbackToken = "synthetic-fallback-token";
  try {
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await mkdir(path.join(home, ".local", "share", "opencode"), {
      recursive: true
    });
    await writeFile(path.join(home, ".codex", "auth.json"), diagnosticContent);
    await writeFile(
      path.join(home, ".local", "share", "opencode", "auth.json"),
      JSON.stringify({ openai: { access: fallbackToken } })
    );
    const script = `
      import { fetchUsage } from ${JSON.stringify(new URL("codex-usage.mjs", import.meta.url).href)};
      let requests = 0;
      let fallbackUsed = false;
      const snapshot = await fetchUsage({
        cache: false,
        fetch: (_url, options) => {
          requests += 1;
          fallbackUsed = options.headers.Authorization === ${JSON.stringify(`Bearer ${fallbackToken}`)};
          return new Response(JSON.stringify({ credits: { balance: 5, has_credits: true } }), { status: 200 });
        },
        home: process.env.HOME
      });
      process.stdout.write(JSON.stringify({ fallbackUsed, hasSnapshot: Boolean(snapshot), requests }));
    `;
    for (const debug of [undefined, "", "0"]) {
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", script],
        {
          encoding: "utf-8",
          env: {
            HOME: home,
            ...(debug === undefined ? {} : { STATUSLINE_DEBUG: debug })
          }
        }
      );
      assert.equal(result.status, 0);
      assert.deepEqual(JSON.parse(result.stdout), {
        fallbackUsed: true,
        hasSnapshot: true,
        requests: 1
      });
      assert.equal(result.stderr.length > 0, debug === "0");
      assert.equal(result.stderr.includes(home), false);
      assert.equal(result.stderr.includes(diagnosticContent), false);
      assert.equal(result.stderr.includes(fallbackToken), false);
      assert.equal(result.stderr.includes("SyntaxError:"), false);
      if (debug === "0") {
        assert.ok(result.stderr.includes("[codex-usage]"));
      }
    }
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});
