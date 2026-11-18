import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { fetchUsage } from "./copilot-usage.mjs";

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
    const snapshot = await fetchUsage({
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
    });
    assertSnapshot(snapshot);
    assert.equal(snapshot.groups[0].metrics[0].used, 20);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

await test("does not query Keychain on non-macOS platforms", async () => {
  /** @type {string[][]} */
  const requested = [];
  const snapshot = await fetchUsage({
    cache: false,
    credential: "file-token",
    environment: { COPILOT_GITHUB_TOKEN: "", GH_TOKEN: "", GITHUB_TOKEN: "" },
    execFile: (file, args) => {
      requested.push([file, ...args]);
      return "keychain-token";
    },
    fetch: (_url, options) => {
      assert.equal(options.headers.Authorization, "token file-token");
      return jsonResponse(
        () => ({
          quota_snapshots: {
            premium_interactions: { entitlement: 100, quota_remaining: 80 }
          }
        }),
        200
      );
    },
    home: "/nonexistent",
    platform: "linux"
  });
  assertSnapshot(snapshot);
  assert.equal(snapshot.groups[0].metrics[0].used, 20);
  assert.deepEqual(requested, []);
});

await test("0 엔타이틀먼트는 한도가 아니어서 지표를 만들지 않는다", async () => {
  assert.equal(
    await fetchUsage({
      cache: false,
      credential: "tok",
      environment: {},
      execFile: () => {
        throw new Error("no keychain");
      },
      fetch: () =>
        jsonResponse(
          () => ({
            quota_snapshots: {
              premium_interactions: {
                credits_used: 0,
                entitlement: 0,
                quota_remaining: 0,
                remaining: 0
              }
            },
            token_based_billing: true
          }),
          200
        ),
      home: "/nonexistent"
    }),
    undefined
  );
});

await test("잘못된 엔타이틀먼트는 해당 지표만 생략한다", async () => {
  const snapshot = await fetchUsage({
    cache: false,
    credential: "tok",
    environment: {},
    execFile: () => {
      throw new Error("no keychain");
    },
    fetch: () =>
      jsonResponse(
        () => ({
          quota_snapshots: {
            chat: { entitlement: "200", quota_remaining: 200 },
            premium_interactions: { entitlement: 1500, quota_remaining: 1200 }
          }
        }),
        200
      ),
    home: "/nonexistent"
  });
  assertSnapshot(snapshot);
  assert.deepEqual(
    snapshot.groups[0].metrics.map((metric) => metric.label),
    ["Premium"]
  );
});

await test("모든 지표가 사라지면 스냅샷을 생략한다", async () => {
  assert.equal(
    await fetchUsage({
      cache: false,
      credential: "tok",
      environment: {},
      execFile: () => {
        throw new Error("no keychain");
      },
      fetch: () =>
        jsonResponse(
          () => ({
            copilot_plan: "individual",
            quota_snapshots: {
              chat: { entitlement: 0, quota_remaining: 0 },
              completions: { entitlement: 0, quota_remaining: 0 },
              premium_interactions: { entitlement: 0, quota_remaining: 0 }
            },
            token_based_billing: true
          }),
          200
        ),
      home: "/nonexistent"
    }),
    undefined
  );
});

await test("양수 엔타이틀먼트 Chat을 남기고 0 엔타이틀먼트 Premium은 생략한다", async () => {
  const snapshot = await fetchUsage({
    cache: false,
    credential: "tok",
    environment: {},
    execFile: () => {
      throw new Error("no keychain");
    },
    fetch: () =>
      jsonResponse(
        () => ({
          quota_snapshots: {
            chat: {
              credits_used: 0,
              entitlement: 200,
              has_quota: true,
              quota_remaining: 200
            },
            premium_interactions: {
              credits_used: 0,
              entitlement: 0,
              has_quota: false,
              quota_remaining: 0,
              remaining: 0
            }
          },
          token_based_billing: true
        }),
        200
      ),
    home: "/nonexistent"
  });
  assertSnapshot(snapshot);
  const [{ metrics }] = snapshot.groups;
  const chat = metrics.find((metric) => metric.label === "Chat");
  const premium = metrics.find((metric) => metric.label === "Premium");
  assert.equal(chat?.type, "usage");
  assert.ok(chat?.type === "usage");
  assert.deepEqual(
    { total: chat?.total, type: chat?.type, used: chat?.used },
    { total: 200, type: "usage", used: 0 }
  );
  assert.equal(premium, undefined);
});

await test("한도가 있는 Chat과 Completions만 표시하고 사용량을 한도 이내로 유지한다", async () => {
  const snapshot = await fetchUsage({
    cache: false,
    credential: "tok",
    environment: {},
    execFile: () => {
      throw new Error("no keychain");
    },
    fetch: () =>
      jsonResponse(
        () => ({
          quota_snapshots: {
            chat: {
              credits_used: 0,
              entitlement: 200,
              has_quota: true,
              quota_remaining: 200
            },
            completions: {
              credits_used: 2001,
              entitlement: 2000,
              has_quota: false,
              overage_count: 1,
              quota_remaining: -1
            },
            premium_interactions: {
              credits_used: 0,
              entitlement: 0,
              has_quota: false,
              quota_remaining: 0,
              remaining: 0
            }
          },
          token_based_billing: true
        }),
        200
      ),
    home: "/nonexistent"
  });
  assertSnapshot(snapshot);
  const [{ metrics }] = snapshot.groups;
  const byLabel = Object.fromEntries(
    metrics.map((metric) => [metric.label, metric])
  );
  assert.ok(byLabel.Chat.type === "usage");
  assert.ok(byLabel.Completions.type === "usage");
  assert.deepEqual(
    { total: byLabel.Chat?.total, used: byLabel.Chat?.used },
    { total: 200, used: 0 }
  );
  assert.deepEqual(
    {
      total: byLabel.Completions?.total,
      type: byLabel.Completions?.type,
      used: byLabel.Completions?.used
    },
    { total: 2000, type: "usage", used: 2000 }
  );
  assert.ok(byLabel.Completions.used <= byLabel.Completions.total);
  assert.equal(byLabel.Premium, undefined);
});

await test("free-limited accounts use the free tier while paid individual accounts retain their tier", async () => {
  const groups = await Promise.all(
    [
      { copilot_plan: "free" },
      { copilot_plan: "individual", access_type_sku: "free_limited_copilot" },
      {
        copilot_plan: "individual",
        access_type_sku: "monthly_subscriber_quota"
      },
      { copilot_plan: "unknown" }
    ].map(async (account) => {
      const snapshot = await fetchUsage({
        cache: false,
        credential: "tok",
        environment: {},
        home: "/nonexistent",
        fetch: () =>
          Response.json({
            ...account,
            quota_snapshots: {
              premium_interactions: { entitlement: 100, quota_remaining: 90 }
            }
          })
      });
      const group = snapshot?.groups[0];
      assert.ok(group);
      assert.partialDeepStrictEqual(group.metrics, [{ total: 100, used: 10 }]);
      return group;
    })
  );
  const [free, limited, paid, unknown] = groups;
  assert.equal(typeof free.label, "string");
  assert.equal(typeof paid.label, "string");
  assert.equal(limited.label, free.label);
  assert.notEqual(paid.label, free.label);
  assert.equal(unknown.label, undefined);
});

await test("preserves prior usage for malformed and provider-error responses", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "copilot-usage-"));
  const cacheDir = await mkdtemp(path.join(tmpdir(), "copilot-cache-"));
  try {
    const options = {
      cacheDir,
      credential: "cache-test-token",
      environment: {},
      execFile: () => {
        throw new Error("no keychain");
      },
      fetch: () =>
        jsonResponse(
          () => ({
            quota_snapshots: {
              premium_interactions: { entitlement: 100, quota_remaining: 80 }
            }
          }),
          200
        ),
      home,
      now: 1_700_000_000_000
    };
    const initial = await fetchUsage(options);
    assert.deepEqual(
      await fetchUsage({
        ...options,
        fetch: () => jsonResponse(() => ({ message: "temporary error" }), 200),
        now: options.now + 60_000
      }),
      initial
    );
    const malformed = await fetchUsage({
      ...options,
      fetch: () =>
        jsonResponse(() => {
          throw new Error("malformed body");
        }, 200),
      now: options.now + 120_000
    });
    assertSnapshot(malformed);
    assert.equal(malformed.groups[0].metrics[0].used, 20);
    assert.equal(
      await fetchUsage({
        ...options,
        fetch: () => jsonResponse(() => ({ quota_snapshots: {} }), 200),
        now: options.now + 180_000
      }),
      undefined
    );
  } finally {
    await rm(home, { force: true, recursive: true });
    await rm(cacheDir, { force: true, recursive: true });
  }
});

await test("resets request errors while recovering with a later Copilot candidate", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "copilot-usage-"));
  const cacheDir = await mkdtemp(path.join(tmpdir(), "copilot-cache-"));
  try {
    let calls = 0;
    const snapshot = await fetchUsage({
      cacheDir,
      credential: "first-token",
      environment: {
        COPILOT_GITHUB_TOKEN: "second-token",
        GH_TOKEN: "",
        GITHUB_TOKEN: ""
      },
      execFile: () => {
        throw new Error("no keychain");
      },
      fetch: (_url, request) => {
        calls += 1;
        if (calls === 1) {
          assert.equal(request.headers.Authorization, "token first-token");
          return jsonResponse(() => ({}), 401);
        }
        assert.equal(request.headers.Authorization, "token second-token");
        return jsonResponse(
          () => ({
            quota_snapshots: {
              premium_interactions: { entitlement: 100, quota_remaining: 70 }
            }
          }),
          200
        );
      },
      home,
      now: 1_700_000_000_000
    });
    assertSnapshot(snapshot);
    assert.equal(snapshot.groups[0].metrics[0].used, 30);
    assert.equal(calls, 2);
  } finally {
    await rm(home, { force: true, recursive: true });
    await rm(cacheDir, { force: true, recursive: true });
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
    const snapshot = await fetchUsage({
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
    });
    assert.deepEqual(requested, [
      ["security", "find-generic-password", "-s", "copilot-cli", "-w"]
    ]);
    assertSnapshot(snapshot);
    assert.equal(snapshot.groups[0].metrics[0].used, 0);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

await test("disposes unauthorized responses before fallback, even when cancellation rejects", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "copilot-usage-"));
  try {
    await Promise.all(
      [
        [".copilot", "config.json"],
        [".config", "github-copilot", "oauth.json"],
        [".local", "share", "opencode", "auth.json"],
        [".config", "gh", "hosts.json"]
      ].map(async (parts) => {
        const filePath = path.join(home, ...parts);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, "{}");
      })
    );
    await Promise.all(
      [401, 403].map(async (status) => {
        /** @type {string[]} */
        const events = [];
        /** @type {string[]} */
        const authorizations = [];
        /** @type {{bodyUsed: boolean, signalAborted: boolean}[]} */
        const fallbackStates = [];
        /** @type {Response | undefined} */
        let firstResponse;
        /** @type {AbortSignal | undefined} */
        let firstSignal;
        let calls = 0;
        let usageErrors = 0;
        const snapshot = await fetchUsage({
          cache: false,
          credential: "first-token",
          environment: {
            COPILOT_GITHUB_TOKEN: "second-token",
            GH_TOKEN: "",
            GITHUB_TOKEN: ""
          },
          fetch: (_url, options) => {
            calls += 1;
            authorizations.push(options.headers.Authorization);
            if (calls === 1) {
              firstSignal = options.signal;
              firstResponse = new Response(
                new ReadableStream({
                  cancel() {
                    events.push("dispose");
                    if (status === 403) {
                      throw new Error("synthetic cancellation failure");
                    }
                  }
                }),
                { status }
              );
              events.push("first");
              return firstResponse;
            }
            events.push("fallback");
            assert.ok(firstResponse);
            assert.ok(firstSignal);
            fallbackStates.push({
              bodyUsed: firstResponse.bodyUsed,
              signalAborted: firstSignal.aborted
            });
            return Response.json(
              {
                quota_snapshots: {
                  premium_interactions: {
                    entitlement: 100,
                    quota_remaining: 70
                  }
                }
              },
              { status: 200 }
            );
          },
          home,
          onUsageError: () => {
            usageErrors += 1;
            events.push("hook");
          },
          platform: "linux"
        });
        assertSnapshot(snapshot);
        assert.equal(snapshot.groups[0].metrics[0].used, 30);
        assert.equal(calls, 2);
        assert.equal(usageErrors, 1);
        assert.deepEqual(events, ["first", "dispose", "hook", "fallback"]);
        assert.deepEqual(authorizations, [
          "token first-token",
          "token second-token"
        ]);
        assert.deepEqual(fallbackStates, [
          { bodyUsed: true, signalAborted: true }
        ]);
      })
    );
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

await test("keeps optional diagnostics content-free while using environment credentials", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "copilot-usage-"));
  const diagnosticContent = "SYNTHETIC_CANARY";
  const fallbackToken = "synthetic-fallback-token";
  try {
    /** @type {[string[], string][]} */
    const files = [
      [[".copilot", "config.json"], diagnosticContent],
      [[".config", "github-copilot", "oauth.json"], "{}"],
      [[".local", "share", "opencode", "auth.json"], "{}"],
      [[".config", "gh", "hosts.json"], "{}"]
    ];
    await Promise.all(
      files.map(async ([parts, content]) => {
        const filePath = path.join(home, ...parts);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, content);
      })
    );
    const script = `
      import { fetchUsage } from ${JSON.stringify(new URL("copilot-usage.mjs", import.meta.url).href)};
      let requests = 0;
      let fallbackUsed = false;
      const snapshot = await fetchUsage({
        cache: false,
        environment: {
          COPILOT_GITHUB_TOKEN: "${fallbackToken}",
          GH_TOKEN: "",
          GITHUB_TOKEN: ""
        },
        fetch: (_url, options) => {
          requests += 1;
          fallbackUsed = options.headers.Authorization === "token ${fallbackToken}";
          return new Response(JSON.stringify({ quota_snapshots: { premium_interactions: { entitlement: 100, quota_remaining: 90 } } }), { status: 200 });
        },
        home: process.env.HOME,
        platform: "linux"
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
    }
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});
