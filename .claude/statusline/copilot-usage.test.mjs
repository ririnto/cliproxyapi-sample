import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { fetchUsage } from "./copilot-usage.mjs";

test("reads Copilot CLI Keychain token when file credentials are absent", async () => {
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
        return {
          json: () => ({
            quota_reset_date_utc: "2026-10-01T00:00:00Z",
            quota_snapshots: {
              premium_interactions: { entitlement: 100, quota_remaining: 80 }
            }
          }),
          status: 200
        };
      },
      home,
      now: Date.parse("2026-09-23T00:00:00Z"),
      platform: "darwin"
    });
    assert.equal(snapshot?.groups[0].metrics[0].used, 20);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("does not query Keychain on non-macOS platforms", async () => {
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
      return {
        json: () => ({
          quota_snapshots: {
            premium_interactions: { entitlement: 100, quota_remaining: 80 }
          }
        }),
        status: 200
      };
    },
    home: "/nonexistent",
    platform: "linux"
  });
  assert.equal(snapshot.groups[0].metrics[0].used, 20);
  assert.deepEqual(requested, []);
});

test("0 엔타이틀먼트는 한도가 아니어서 지표를 만들지 않는다", async () => {
  const snapshot = await fetchUsage({
    cache: false,
    credential: "tok",
    environment: {},
    execFile: () => {
      throw new Error("no keychain");
    },
    fetch: () => ({
      json: () => ({
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
      status: 200
    }),
    home: "/nonexistent"
  });
  assert.equal(snapshot, undefined);
});

test("음수 엔타이틀먼트도 지표를 만들지 않는다", async () => {
  const snapshot = await fetchUsage({
    cache: false,
    credential: "tok",
    environment: {},
    execFile: () => {
      throw new Error("no keychain");
    },
    fetch: () => ({
      json: () => ({
        quota_snapshots: {
          premium_interactions: {
            entitlement: -1,
            quota_remaining: -1
          }
        }
      }),
      status: 200
    }),
    home: "/nonexistent"
  });
  assert.equal(snapshot, undefined);
});

test("잘못된 엔타이틀먼트는 해당 지표만 생략한다", async () => {
  const snapshot = await fetchUsage({
    cache: false,
    credential: "tok",
    environment: {},
    execFile: () => {
      throw new Error("no keychain");
    },
    fetch: () => ({
      json: () => ({
        quota_snapshots: {
          chat: { entitlement: "200", quota_remaining: 200 },
          premium_interactions: { entitlement: 1500, quota_remaining: 1200 }
        }
      }),
      status: 200
    }),
    home: "/nonexistent"
  });
  const metrics = snapshot?.groups[0].metrics ?? [];
  assert.deepEqual(
    metrics.map((metric) => metric.label),
    ["Premium"]
  );
});

test("모든 지표가 사라지면 스냅샷을 생략한다", async () => {
  const snapshot = await fetchUsage({
    cache: false,
    credential: "tok",
    environment: {},
    execFile: () => {
      throw new Error("no keychain");
    },
    fetch: () => ({
      json: () => ({
        copilot_plan: "individual",
        quota_snapshots: {
          chat: { entitlement: 0, quota_remaining: 0 },
          completions: { entitlement: 0, quota_remaining: 0 },
          premium_interactions: { entitlement: 0, quota_remaining: 0 }
        },
        token_based_billing: true
      }),
      status: 200
    }),
    home: "/nonexistent"
  });
  assert.equal(snapshot, undefined);
});

test("양수 엔타이틀먼트 Chat을 남기고 0 엔타이틀먼트 Premium은 생략한다", async () => {
  const snapshot = await fetchUsage({
    cache: false,
    credential: "tok",
    environment: {},
    execFile: () => {
      throw new Error("no keychain");
    },
    fetch: () => ({
      json: () => ({
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
      status: 200
    }),
    home: "/nonexistent"
  });
  const metrics = snapshot?.groups[0].metrics ?? [];
  const chat = metrics.find((metric) => metric.label === "Chat");
  const premium = metrics.find((metric) => metric.label === "Premium");
  assert.deepEqual(
    { total: chat?.total, type: chat?.type, used: chat?.used },
    { total: 200, type: "usage", used: 0 }
  );
  assert.equal(premium, undefined);
});

test("한도가 있는 Chat과 Completions만 표시하고 사용량을 한도 이내로 유지한다", async () => {
  const snapshot = await fetchUsage({
    cache: false,
    credential: "tok",
    environment: {},
    execFile: () => {
      throw new Error("no keychain");
    },
    fetch: () => ({
      json: () => ({
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
      status: 200
    }),
    home: "/nonexistent"
  });
  const metrics = snapshot?.groups[0].metrics ?? [];
  const byLabel = Object.fromEntries(
    metrics.map((metric) => [metric.label, metric])
  );
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

test("labels the group with the Copilot plan", async () => {
  const snapshot = await fetchUsage({
    cache: false,
    credential: "tok",
    environment: {},
    fetch: () => ({
      json: () => ({
        copilot_plan: "free",
        quota_snapshots: {
          premium_interactions: { entitlement: 100, quota_remaining: 90 }
        }
      }),
      status: 200
    }),
    home: "/nonexistent"
  });
  assert.equal(snapshot?.groups[0].label, "Copilot (Free)");
});

test("access_type_sku가 free_limited_copilot이면 individual 계획도 Free로 표시한다", async () => {
  const snapshot = await fetchUsage({
    cache: false,
    credential: "tok",
    environment: {},
    fetch: () => ({
      json: () => ({
        access_type_sku: "free_limited_copilot",
        copilot_plan: "individual",
        quota_snapshots: {
          premium_interactions: { entitlement: 100, quota_remaining: 90 }
        }
      }),
      status: 200
    }),
    home: "/nonexistent"
  });
  assert.equal(snapshot?.groups[0].label, "Copilot (Free)");
});

test("모든 개별 individual 계획을 Free로 바꾸지 않는다", async () => {
  const snapshot = await fetchUsage({
    cache: false,
    credential: "tok",
    environment: {},
    fetch: () => ({
      json: () => ({
        access_type_sku: "monthly_subscriber_quota",
        copilot_plan: "individual",
        quota_snapshots: {
          premium_interactions: { entitlement: 1500, quota_remaining: 1200 }
        },
        token_based_billing: true
      }),
      status: 200
    }),
    home: "/nonexistent"
  });
  assert.equal(snapshot?.groups[0].label, "Copilot (Individual)");
});

test("omits the group label for an unknown plan", async () => {
  const snapshot = await fetchUsage({
    cache: false,
    credential: "tok",
    environment: {},
    fetch: () => ({
      json: () => ({
        copilot_plan: "mystery_tier",
        quota_snapshots: {
          premium_interactions: { entitlement: 100, quota_remaining: 90 }
        }
      }),
      status: 200
    }),
    home: "/nonexistent"
  });
  assert.equal(snapshot?.groups[0].label, undefined);
});

test("preserves prior usage for malformed and provider-error responses", async () => {
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
      fetch: () => ({
        json: () => ({
          quota_snapshots: {
            premium_interactions: { entitlement: 100, quota_remaining: 80 }
          }
        }),
        status: 200
      }),
      home,
      now: 1_700_000_000_000
    };
    const initial = await fetchUsage(options);
    const providerError = await fetchUsage({
      ...options,
      fetch: () => ({
        json: () => ({ message: "temporary error" }),
        status: 200
      }),
      now: options.now + 60_000
    });
    assert.deepEqual(providerError, initial);
    const malformed = await fetchUsage({
      ...options,
      fetch: () => ({
        json: () => {
          throw new Error("malformed body");
        },
        status: 200
      }),
      now: options.now + 120_000
    });
    assert.equal(malformed.groups[0].metrics[0].used, 20);
    const empty = await fetchUsage({
      ...options,
      fetch: () => ({ json: () => ({ quota_snapshots: {} }), status: 200 }),
      now: options.now + 180_000
    });
    assert.equal(empty, undefined);
  } finally {
    await rm(home, { force: true, recursive: true });
    await rm(cacheDir, { force: true, recursive: true });
  }
});

test("resets request errors while recovering with a later Copilot candidate", async () => {
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
          return { json: () => ({}), status: 401 };
        }
        assert.equal(request.headers.Authorization, "token second-token");
        return {
          json: () => ({
            quota_snapshots: {
              premium_interactions: { entitlement: 100, quota_remaining: 70 }
            }
          }),
          status: 200
        };
      },
      home,
      now: 1_700_000_000_000
    });
    assert.equal(snapshot.groups[0].metrics[0].used, 30);
    assert.equal(calls, 2);
  } finally {
    await rm(home, { force: true, recursive: true });
    await rm(cacheDir, { force: true, recursive: true });
  }
});

test("falls back to file credentials when Keychain lookup fails", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "copilot-usage-"));
  try {
    await mkdir(path.join(home, ".config", "gh"), { recursive: true });
    await writeFile(
      path.join(home, ".config", "gh", "hosts.json"),
      JSON.stringify({ "github.com": { oauth_token: "file-token" } })
    );
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
        return {
          json: () => ({
            quota_snapshots: {
              premium_interactions: { entitlement: 100, quota_remaining: 100 }
            }
          }),
          status: 200
        };
      },
      home,
      platform: "darwin"
    });
    assert.deepEqual(requested, [
      ["security", "find-generic-password", "-s", "copilot-cli", "-w"]
    ]);
    assert.equal(snapshot?.groups[0].metrics[0].used, 0);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("disposes HTTP error response bodies before returning", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "copilot-usage-"));
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
    const result = await fetchUsage({
      cache: false,
      credential: "synthetic-copilot-token",
      environment: {
        COPILOT_GITHUB_TOKEN: "",
        GH_TOKEN: "",
        GITHUB_TOKEN: ""
      },
      fetch: (_url, options) => {
        requestSignal = options.signal;
        return errorResponse;
      },
      home,
      platform: "linux"
    });
    assert.equal(result, undefined);
    assert.equal(cancellations, 1);
    assert.equal(requestSignal.aborted, true);
    assert.equal(errorResponse.bodyUsed, true);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("disposes unauthorized responses before fallback, even when cancellation rejects", async () => {
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
        const events = [];
        const authorizations = [];
        const fallbackStates = [];
        let firstResponse;
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

test("continues fallback when HTTP error body cancellation stalls until timeout", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "copilot-usage-"));
  const events = [];
  let firstResponse;
  let firstSignal;
  let calls = 0;
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
    const snapshot = await Promise.race([
      fetchUsage({
        cache: false,
        credential: "first-token",
        environment: {
          COPILOT_GITHUB_TOKEN: "second-token",
          GH_TOKEN: "",
          GITHUB_TOKEN: ""
        },
        fetch: (_url, options) => {
          calls += 1;
          if (calls === 1) {
            firstSignal = options.signal;
            firstResponse = new Response(
              new ReadableStream({
                cancel() {
                  events.push("dispose");
                  return Promise.withResolvers().promise;
                }
              }),
              { status: 401 }
            );
            events.push("first");
            return firstResponse;
          }
          events.push("fallback");
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
        onUsageError: () => events.push("hook"),
        platform: "linux"
      }),
      delay(3500, "stalled")
    ]);
    assert.notEqual(snapshot, "stalled");
    assert.equal(snapshot.groups[0].metrics[0].used, 30);
    assert.equal(calls, 2);
    assert.deepEqual(events, ["first", "dispose", "hook", "fallback"]);
    assert.equal(firstSignal.aborted, true);
    assert.equal(firstResponse.bodyUsed, true);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("keeps optional diagnostics content-free while using environment credentials", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "copilot-usage-"));
  const diagnosticContent = "SYNTHETIC_CANARY";
  const fallbackToken = "synthetic-fallback-token";
  try {
    await Promise.all(
      [
        [[".copilot", "config.json"], diagnosticContent],
        [[".config", "github-copilot", "oauth.json"], "{}"],
        [[".local", "share", "opencode", "auth.json"], "{}"],
        [[".config", "gh", "hosts.json"], "{}"]
      ].map(async ([parts, content]) => {
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
      assert.equal(result.stderr.includes("SyntaxError:"), false);
      if (debug === "0") {
        assert.ok(result.stderr.includes("[copilot-usage]"));
      }
    }
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});
