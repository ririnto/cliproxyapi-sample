import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { fetchUsage } from "./codex-usage.mjs";

const writeAuth = async (home) => {
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(
    path.join(home, ".codex", "auth.json"),
    JSON.stringify({ tokens: { access_token: "tok", account_id: "acc" } })
  );
};

test("labels the main group with the ChatGPT plan", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-usage-"));
  try {
    await writeAuth(home);
    const snapshot = await fetchUsage({
      cache: false,
      fetch: (_url, options) => {
        assert.equal(options.headers.Authorization, "Bearer tok");
        assert.equal(options.headers["ChatGPT-Account-ID"], "acc");
        return {
          json: () => ({
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
          status: 200
        };
      },
      home
    });
    assert.equal(snapshot?.groups[0].label, "ChatGPT (Pro)");
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("omits the main group label for a missing or unknown plan", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-usage-"));
  try {
    await writeAuth(home);
    const snapshots = await Promise.all(
      [undefined, "not-a-plan"].map((plan_type) =>
        fetchUsage({
          cache: false,
          fetch: () => ({
            json: () => ({
              plan_type,
              rate_limit: {
                secondary_window: {
                  limit_window_seconds: 18_000,
                  used_percent: 1
                }
              }
            }),
            status: 200
          }),
          home
        })
      )
    );
    assert.deepEqual(
      snapshots.map((snapshot) => snapshot?.groups[0].label),
      [undefined, undefined]
    );
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("keeps the Additional label for additional rate limits", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-usage-"));
  try {
    await writeAuth(home);
    const snapshot = await fetchUsage({
      cache: false,
      fetch: () => ({
        json: () => ({
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
            secondary_window: { limit_window_seconds: 18_000, used_percent: 1 }
          }
        }),
        status: 200
      }),
      home
    });
    assert.equal(snapshot?.groups[0].label, "ChatGPT (Plus)");
    assert.equal(snapshot?.groups[1].label, "Additional");
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("normalizes finite positive ChatGPT credits without assuming a currency", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-usage-"));
  try {
    await writeAuth(home);
    const snapshot = await fetchUsage({
      cache: false,
      fetch: () => ({
        json: () => ({
          credits: { balance: "12.5", has_credits: true, unlimited: false }
        }),
        status: 200
      }),
      home
    });
    assert.deepEqual(snapshot?.groups, [
      { metrics: [{ label: "credit", remaining: 12.5, type: "credit" }] }
    ]);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("omits absent, unusable, or unowned ChatGPT credits", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-usage-"));
  try {
    await writeAuth(home);
    const balances = [undefined, 0, -1, "Infinity", "12credits"];
    const snapshots = await Promise.all(
      [
        { balance: 5, has_credits: false, unlimited: false },
        ...balances.map((balance) => ({
          balance,
          has_credits: true,
          unlimited: false
        }))
      ].map((credits) =>
        fetchUsage({
          cache: false,
          fetch: () => ({ json: () => ({ credits }), status: 200 }),
          home
        })
      )
    );
    assert.deepEqual(snapshots, Array.from({ length: snapshots.length }));
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("caches normalized ChatGPT snapshots in an isolated directory", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-usage-"));
  let calls = 0;
  try {
    await writeAuth(home);
    const options = {
      cacheDir: path.join(home, "cache"),
      fetch: () => {
        calls += 1;
        return {
          json: () => ({
            credits: { balance: 8, has_credits: true, unlimited: false }
          }),
          status: 200
        };
      },
      home,
      now: 1000
    };
    const first = await fetchUsage(options);
    const second = await fetchUsage(options);
    assert.deepEqual(second, first);
    assert.equal(calls, 1);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("retains the last snapshot after a malformed cached response", async () => {
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
        return {
          json: () => {
            if (calls > 1) {
              throw new Error("invalid body");
            }
            return {
              credits: { balance: 8, has_credits: true, unlimited: false }
            };
          },
          status: 200
        };
      },
      home,
      now
    };
    const first = await fetchUsage(options);
    now += 1;
    const second = await fetchUsage({ ...options, now });
    assert.deepEqual(second, first);
    assert.equal(calls, 2);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("shows owned credits regardless of the unlimited flag", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-usage-"));
  try {
    await writeAuth(home);
    const snapshots = await Promise.all(
      [undefined, null, "false", 0, 1, true, false].map((unlimited) =>
        fetchUsage({
          cache: false,
          fetch: () => ({
            json: () => ({
              credits: { balance: 5, has_credits: true, unlimited }
            }),
            status: 200
          }),
          home
        })
      )
    );
    assert.deepEqual(
      snapshots.map((snapshot) => snapshot?.groups[0].metrics[0].remaining),
      snapshots.map(() => 5)
    );
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("signals malformed or explicit provider-error payloads to the cache hook", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-usage-"));
  try {
    await writeAuth(home);
    const failures = await Promise.all(
      [
        () => {
          throw new Error("invalid body");
        },
        () => null,
        () => ({ error: "provider error" }),
        () => ({ success: false })
      ].map(async (json) => {
        let failureCount = 0;
        await fetchUsage({
          cache: false,
          fetch: () => ({ json, status: 200 }),
          home,
          onUsageError: () => (failureCount += 1)
        });
        return failureCount;
      })
    );
    assert.deepEqual(failures, [1, 1, 1, 1]);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("does not signal valid empty or zero-credit payloads to the cache hook", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-usage-"));
  try {
    await writeAuth(home);
    const failures = await Promise.all(
      [
        {},
        { credits: { balance: 0, has_credits: true, unlimited: false } }
      ].map(async (payload) => {
        let failureCount = 0;
        await fetchUsage({
          cache: false,
          fetch: () => ({ json: () => payload, status: 200 }),
          home,
          onUsageError: () => (failureCount += 1)
        });
        return failureCount;
      })
    );
    assert.deepEqual(failures, [0, 0]);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("returns undefined instead of throwing when the response fails", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-usage-"));
  try {
    await writeAuth(home);
    const snapshots = await Promise.all(
      [{ status: 401 }, { status: undefined }].map((response) =>
        fetchUsage({ cache: false, fetch: () => response, home })
      )
    );
    assert.deepEqual(snapshots, [undefined, undefined]);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("disposes HTTP error response bodies before returning", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-usage-"));
  let cancellations = 0;
  let requestSignal;
  const errorResponse = new Response(
    new ReadableStream({
      cancel() {
        cancellations += 1;
      }
    }),
    { status: 503 }
  );
  try {
    await writeAuth(home);
    const result = await fetchUsage({
      cache: false,
      fetch: (_url, options) => {
        requestSignal = options.signal;
        return errorResponse;
      },
      home
    });
    assert.equal(result, undefined);
    assert.equal(cancellations, 1);
    assert.equal(requestSignal.aborted, true);
    assert.equal(errorResponse.bodyUsed, true);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("returns when HTTP error body cancellation stalls until timeout", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-usage-"));
  let cancellations = 0;
  let requestSignal;
  try {
    await writeAuth(home);
    const result = await Promise.race([
      fetchUsage({
        cache: false,
        fetch: (_url, options) => {
          requestSignal = options.signal;
          return new Response(
            new ReadableStream({
              cancel() {
                cancellations += 1;
                return Promise.withResolvers().promise;
              }
            }),
            { status: 503 }
          );
        },
        home
      }),
      delay(3500, "stalled")
    ]);
    assert.notEqual(result, "stalled");
    assert.equal(result, undefined);
    assert.equal(cancellations, 1);
    assert.equal(requestSignal.aborted, true);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("keeps optional diagnostics content-free while using OpenCode credentials", async () => {
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
    const fallbackAuthorization = `Bearer ${fallbackToken}`;
    const script = `
      import { fetchUsage } from ${JSON.stringify(new URL("codex-usage.mjs", import.meta.url).href)};
      let requests = 0;
      let fallbackUsed = false;
      const snapshot = await fetchUsage({
        cache: false,
        fetch: (_url, options) => {
          requests += 1;
          fallbackUsed = options.headers.Authorization === ${JSON.stringify(fallbackAuthorization)};
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
