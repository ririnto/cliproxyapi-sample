import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { renderSnapshot } from "../.claude/statusline.mjs";
import { fetchUsage as codex } from "../.claude/statusline/codex-usage.mjs";
import { fetchUsage as copilot } from "../.claude/statusline/copilot-usage.mjs";
import { fetchUsage as glm } from "../.claude/statusline/glm-coding-plan.mjs";
import { fetchUsage as minimax } from "../.claude/statusline/minimax-token-plan.mjs";

const providers = { codex, copilot, glm, minimax };

const isolatedOptions = async (context) => {
  const home = await mkdtemp(path.join(tmpdir(), "statusline-provider-"));
  context.after(() => rm(home, { force: true, recursive: true }));
  return {
    credential: "fixture-token",
    environment: { COPILOT_GITHUB_TOKEN: "", GH_TOKEN: "", GITHUB_TOKEN: "" },
    execFile: () => "",
    home,
    now: 1000
  };
};

const response = (payload, status = 200) => ({
  json: () => payload,
  status
});

test("Codex limit names stay inert when rendered from fetched usage", async (context) => {
  const options = await isolatedOptions(context);
  const limitName = "Extra\r\nLimit\u001B[2J";
  const requests = [];
  const usage = await codex({
    ...options,
    fetch: (url, request) => {
      requests.push({ authorization: request.headers.Authorization, url });
      return response({
        additional_rate_limits: [
          {
            limit_name: limitName,
            rate_limit: {
              primary_window: {
                reset_after_seconds: 3600,
                used_percent: 25
              }
            }
          }
        ]
      });
    }
  });
  assert.deepEqual(requests, [
    {
      authorization: "Bearer fixture-token",
      url: "https://chatgpt.com/backend-api/wham/usage"
    }
  ]);
  assert.deepEqual(usage.groups[0], {
    label: limitName,
    metrics: [
      {
        label: "7d",
        percentage: 25,
        resetsInMs: 3_600_000,
        type: "percentage"
      }
    ]
  });
  assert.equal(
    renderSnapshot({}, usage),
    "Extra Limit | 7d: \u001B[32m25%\u001B[0m (1h 0m)"
  );
});

for (const [name, fetchUsage] of Object.entries(providers)) {
  test(`${name} preserves status evaluation and cleanup order at HTTP boundaries`, async (context) => {
    const options = await isolatedOptions(context);
    await Promise.all(
      [
        [undefined, ["status"]],
        ["200", ["status"]],
        [Number.NaN, ["status", "status"]],
        [Number.POSITIVE_INFINITY, ["status", "status"]],
        [199, ["status", "status", "status", "status"]],
        [200, ["status", "status", "status", "status", "json", "status"]],
        [299, ["status", "status", "status", "status", "json", "status"]],
        [300, ["status", "status", "status", "status", "status"]]
      ].map(async ([status, expected]) => {
        const events = [];
        const value = await fetchUsage({
          ...options,
          fetch: (_url, { signal }) => {
            signal.addEventListener("abort", () => events.push("abort"));
            return {
              body: {
                cancel: () => {
                  events.push("cancel");
                  return Promise.resolve();
                }
              },
              bodyUsed: false,
              json: () => {
                events.push("json");
                return null;
              },
              get status() {
                events.push("status");
                return status;
              }
            };
          }
        });
        assert.equal(value, undefined);
        assert.deepEqual(events, [...expected, "abort", "cancel"]);
      })
    );
  });
}

test("GLM rejects malformed quota payloads before reading the current time", async (context) => {
  const options = await isolatedOptions(context);
  await Promise.all(
    [
      { success: false },
      { data: null, success: true },
      { data: { limits: {} }, success: true }
    ].map(async (payload) => {
      assert.equal(
        await glm({
          ...options,
          fetch: () => response(payload),
          get now() {
            throw new Error("Invalid payload must not read the current time");
          }
        }),
        undefined
      );
    })
  );
});

for (const [name, fetchUsage] of Object.entries(providers)) {
  test(`${name} releases rejected streams and request timers`, async (context) => {
    const options = await isolatedOptions(context);
    const timers = new Set();
    context.mock.method(globalThis, "setTimeout", () => {
      const timer = Symbol("request timeout");
      timers.add(timer);
      return timer;
    });
    context.mock.method(globalThis, "clearTimeout", (timer) => {
      assert.equal(timers.delete(timer), true);
    });
    await Promise.all(
      [503, undefined].map(async (status) => {
        let cancellations = 0;
        let signal;
        const body = new ReadableStream({
          cancel: () => {
            cancellations += 1;
          }
        });
        const value = await fetchUsage({
          ...options,
          fetch: (_url, request) => {
            ({ signal } = request);
            return { body, status };
          }
        });
        assert.equal(value, undefined);
        assert.equal(cancellations, 1);
        assert.equal(signal.aborted, true);
      })
    );
    assert.equal(timers.size, 0);
    await Promise.all(
      [
        () => response({}),
        () => {
          throw new Error("Fixture transport failure");
        },
        () => ({
          json: () => {
            throw new Error("Fixture decoding failure");
          },
          status: 200
        })
      ].map((fetch) => fetchUsage({ ...options, fetch }))
    );
    assert.equal(timers.size, 0);
  });
}

test("Copilot releases authentication error streams before fallback even when cancellation fails", async (context) => {
  const options = await isolatedOptions(context);
  const events = [];
  const value = await copilot({
    ...options,
    environment: { ...options.environment, GH_TOKEN: "fallback-token" },
    fetch: (_url, { headers }) => {
      events.push(headers.Authorization);
      return events.length === 1
        ? new Response(
            new ReadableStream({
              cancel: () => {
                events.push("canceled");
                throw new Error("Fixture cancellation failure");
              }
            }),
            { status: 401 }
          )
        : response({
            quota_snapshots: { chat: { entitlement: 10, remaining: 5 } }
          });
    }
  });
  assert.ok(value);
  assert.deepEqual(events, [
    "token fixture-token",
    "canceled",
    "token fallback-token"
  ]);
});

for (const [name, fetchUsage, directory, filename] of [
  ["codex", codex, ".codex", "auth.json"],
  ["copilot", copilot, ".copilot", "config.json"]
]) {
  test(`${name} credential diagnostics omit secrets and retain fallback behavior`, async (context) => {
    const options = await isolatedOptions(context);
    const credentialDir = path.join(options.home, directory);
    await mkdir(credentialDir);
    await writeFile(path.join(credentialDir, filename), "synthetic-secret");
    const messages = [];
    context.mock.method(console, "error", (...args) => messages.push(args));
    const debug = process.env.STATUSLINE_DEBUG;
    context.after(() => {
      if (debug === undefined) {
        delete process.env.STATUSLINE_DEBUG;
      } else {
        process.env.STATUSLINE_DEBUG = debug;
      }
    });
    const requests = [];
    const fetch = (_url, { headers }) => {
      requests.push(headers.Authorization);
      return response(
        name === "codex"
          ? { rate_limit: { primary_window: { used_percent: 25 } } }
          : { quota_snapshots: { chat: { entitlement: 10, remaining: 5 } } }
      );
    };
    process.env.STATUSLINE_DEBUG = "";
    assert.ok(await fetchUsage({ ...options, fetch }));
    assert.deepEqual(messages, []);
    process.env.STATUSLINE_DEBUG = "1";
    assert.ok(await fetchUsage({ ...options, fetch }));
    assert.deepEqual(requests, [
      `${name === "codex" ? "Bearer" : "token"} fixture-token`,
      `${name === "codex" ? "Bearer" : "token"} fixture-token`
    ]);
    assert.ok(messages.length > 0);
    assert.ok(
      messages.every(
        (args) =>
          args.length === 1 &&
          /^\[(?:codex|copilot)-usage\] unreadable credentials \((?:invalid JSON|file read failed)\)$/u.test(
            args[0]
          )
      )
    );
    assert.ok(messages.some(([message]) => message.includes("invalid JSON")));
    assert.ok(
      messages.some(([message]) => message.includes("file read failed"))
    );
  });
}

for (const [name, fetchUsage] of Object.entries(providers)) {
  test(`${name} skips requests without credentials`, async (context) => {
    const options = await isolatedOptions(context);
    let calls = 0;
    const value = await fetchUsage({
      ...options,
      credential: "",
      fetch: () => {
        calls += 1;
        return response(null);
      }
    });
    assert.equal(value, undefined);
    assert.equal(calls, 0);
  });

  test(`${name} omits usage after transport, HTTP, and JSON failures`, async (context) => {
    const options = await isolatedOptions(context);
    let decodedHttpErrors = 0;
    const requests = [
      () => {
        throw new Error("Fixture transport failure");
      },
      () => ({
        json: () => {
          decodedHttpErrors += 1;
          return {};
        },
        status: 503
      }),
      () => ({
        json: () => {
          throw new Error("Fixture decoding failure");
        },
        status: 200
      }),
      () => response(null),
      () => response([])
    ];
    const results = await Promise.all(
      requests.map((fetch) => fetchUsage({ ...options, fetch }))
    );
    assert.equal(
      results.every((value) => value === undefined),
      true
    );
    assert.equal(decodedHttpErrors, 0);
  });
}

test(
  "all providers abort a stalled request and omit unavailable usage",
  { timeout: 10_000 },
  async (context) => {
    const options = await isolatedOptions(context);
    const requests = [];
    const results = await Promise.all(
      Object.values(providers).map((fetchUsage) =>
        fetchUsage({
          ...options,
          fetch: (_url, request) => {
            requests.push(request);
            return delay(10_000, undefined, { signal: request.signal });
          }
        })
      )
    );
    assert.equal(requests.length, 4);
    for (const request of requests) {
      assert.equal(request.method, "GET");
      assert.equal(request.signal.aborted, true);
    }
    assert.equal(
      results.every((value) => value === undefined),
      true
    );
  }
);

test("GLM filters invalid limits and computes quota tiers and reset intervals", async (context) => {
  const options = await isolatedOptions(context);
  const limit = {
    nextResetTime: 3_601_000,
    number: 5,
    percentage: 25,
    type: "TOKENS_LIMIT",
    unit: 3
  };
  const value = await glm({
    ...options,
    fetch: () =>
      response({
        data: {
          level: "PRO",
          limits: [
            limit,
            { ...limit, percentage: 101 },
            { ...limit, type: "OTHER" },
            {
              ...limit,
              nextResetTime: 500,
              number: 1,
              percentage: 50,
              type: "CREDIT_LIMIT",
              unit: 6
            }
          ]
        },
        success: true
      })
  });
  assert.deepEqual(value, {
    groups: [
      {
        label: "Z.AI (Pro)",
        metrics: [
          {
            label: "5h",
            percentage: 25,
            resetsInMs: 3_600_000,
            type: "percentage"
          },
          { label: "7d", percentage: 50, resetsInMs: 0, type: "percentage" }
        ]
      }
    ]
  });
});

test("MiniMax converts remaining quotas into used counts and ignores unrelated models", async (context) => {
  const options = await isolatedOptions(context);
  const value = await minimax({
    ...options,
    fetch: () =>
      response({
        base_resp: { status_code: 0 },
        model_remains: [
          { model_name: "Other" },
          {
            current_interval_total_count: 100,
            current_interval_usage_count: 75,
            current_weekly_total_count: 1000,
            current_weekly_usage_count: 800,
            model_name: "MiniMax-M*",
            remains_time: 3_600_000,
            weekly_remains_time: 7_200_000
          }
        ]
      })
  });
  assert.deepEqual(value, {
    groups: [
      {
        metrics: [
          {
            label: "5h",
            resetsInMs: 3_600_000,
            total: 100,
            type: "usage",
            used: 25
          },
          {
            label: "7d",
            resetsInMs: 7_200_000,
            total: 1000,
            type: "usage",
            used: 200
          }
        ]
      }
    ]
  });
  assert.equal(
    await minimax({
      ...options,
      fetch: () =>
        response({ base_resp: { status_code: 0 }, model_remains: [] })
    }),
    undefined
  );
});

test("Codex uses discovered account credentials and normalizes primary and additional windows", async (context) => {
  const options = await isolatedOptions(context);
  await mkdir(path.join(options.home, ".codex"));
  await writeFile(
    path.join(options.home, ".codex", "auth.json"),
    JSON.stringify({
      tokens: {
        access_token: "fixture-codex-token",
        account_id: "fixture-account"
      }
    })
  );
  const window = {
    limit_window_seconds: 18_000,
    reset_after_seconds: 3600,
    used_percent: 25
  };
  const value = await codex({
    ...options,
    credential: "",
    fetch: (_url, { headers }) => {
      assert.equal(headers.Authorization, "Bearer fixture-codex-token");
      assert.equal(headers["ChatGPT-Account-ID"], "fixture-account");
      return response({
        additional_rate_limits: [
          {
            limit_name: "gpt-5.3-codex-spark",
            rate_limit: { primary_window: window }
          }
        ],
        plan_type: "pro",
        rate_limit: {
          primary_window: window,
          secondary_window: { ...window, used_percent: 101 }
        }
      });
    }
  });
  const metric = {
    label: "5h",
    percentage: 25,
    resetsInMs: 3_600_000,
    type: "percentage"
  };
  assert.deepEqual(value, {
    groups: [
      { label: "ChatGPT (Pro)", metrics: [metric] },
      { label: "Additional", metrics: [metric] }
    ]
  });
});

for (const status of [401, 403]) {
  test(`Copilot advances and deduplicates credentials after HTTP ${status}`, async (context) => {
    const options = await isolatedOptions(context);
    const tokens = [];
    const value = await copilot({
      ...options,
      environment: {
        COPILOT_GITHUB_TOKEN: "fallback-token",
        GH_TOKEN: "fallback-token",
        GITHUB_TOKEN: ""
      },
      fetch: (_url, { headers }) => {
        tokens.push(headers.Authorization);
        return tokens.length === 1
          ? response(null, status)
          : response({
              copilot_plan: "pro_plus",
              quota_reset_date_utc: "1970-01-01T01:00:01Z",
              quota_snapshots: {
                chat: { entitlement: 10, remaining: 50 },
                premium_interactions: { entitlement: 100, quota_remaining: -1 }
              }
            });
      }
    });
    assert.deepEqual(tokens, ["token fixture-token", "token fallback-token"]);
    tokens.length = 0;
    const exhausted = await copilot({
      ...options,
      environment: {
        COPILOT_GITHUB_TOKEN: "fallback-token",
        GH_TOKEN: "fallback-token",
        GITHUB_TOKEN: ""
      },
      fetch: (_url, { headers }) => {
        tokens.push(headers.Authorization);
        return response(null, status);
      }
    });
    assert.equal(exhausted, undefined);
    assert.deepEqual(tokens, ["token fixture-token", "token fallback-token"]);
    assert.deepEqual(value, {
      groups: [
        {
          label: "Copilot (Pro plus)",
          metrics: [
            {
              label: "Chat",
              resetsInMs: 3_600_000,
              total: 10,
              type: "usage",
              used: 0
            },
            {
              label: "Premium",
              resetsInMs: 3_600_000,
              total: 100,
              type: "usage",
              used: 100
            }
          ]
        }
      ]
    });
  });
}

test("Copilot stops on non-authentication failures rather than trying further credentials", async (context) => {
  const options = await isolatedOptions(context);
  let calls = 0;
  const value = await copilot({
    ...options,
    environment: { ...options.environment, GH_TOKEN: "fallback-token" },
    fetch: () => {
      calls += 1;
      return response(null, 429);
    }
  });
  assert.equal(value, undefined);
  assert.equal(calls, 1);
});
