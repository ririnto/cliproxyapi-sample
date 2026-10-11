import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

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
