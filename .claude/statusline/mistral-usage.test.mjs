import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchUsage } from "./mistral-usage.mjs";

const BUDGET_URL = "https://api.mistral.ai/v1/billing/budget";

test("reports the API and Vibe budget percentages with their reset", async () => {
  const requests = [];
  const snapshot = await fetchUsage({
    cache: false,
    credential: "synthetic-mistral-key",
    fetch: (url, options) => {
      requests.push({
        authorization: options.headers.Authorization,
        url: String(url)
      });
      return Response.json({
        api_budget: {
          currency: "USD",
          initial_budget: 15,
          payg_enabled: false,
          reset_at: "2026-12-01T00:00:00Z",
          usage_percentage: 12.5
        },
        vibe_budget: {
          currency: "USD",
          initial_budget: 150,
          payg_enabled: false,
          reset_at: "2026-12-01T00:00:00Z",
          usage_percentage: 1.5
        }
      });
    },
    now: Date.parse("2026-11-07T00:00:00Z")
  });
  assert.deepEqual(requests, [
    {
      authorization: "Bearer synthetic-mistral-key",
      url: BUDGET_URL
    }
  ]);
  assert.deepEqual(snapshot, {
    groups: [
      {
        label: "Mistral",
        metrics: [
          {
            label: "api",
            percentage: 12.5,
            resetsInMs:
              Date.parse("2026-12-01T00:00:00Z") -
              Date.parse("2026-11-07T00:00:00Z"),
            type: "percentage"
          },
          {
            label: "vibe",
            percentage: 1.5,
            resetsInMs:
              Date.parse("2026-12-01T00:00:00Z") -
              Date.parse("2026-11-07T00:00:00Z"),
            type: "percentage"
          }
        ]
      }
    ]
  });
});

test("omits a budget whose usage percentage is missing or negative", async () => {
  const snapshot = await fetchUsage({
    cache: false,
    credential: "synthetic-mistral-key",
    fetch: () =>
      Response.json({
        api_budget: { reset_at: "2026-12-01T00:00:00Z", usage_percentage: -1 },
        vibe_budget: { reset_at: "2026-12-01T00:00:00Z" }
      }),
    now: 0
  });
  assert.equal(snapshot, undefined);
});

test("omits the reset when the budget carries no parseable reset time", async () => {
  const snapshot = await fetchUsage({
    cache: false,
    credential: "synthetic-mistral-key",
    fetch: () =>
      Response.json({
        api_budget: { reset_at: null, usage_percentage: 4 },
        vibe_budget: { reset_at: "not a date", usage_percentage: 8 }
      }),
    now: 1000
  });
  assert.deepEqual(snapshot, {
    groups: [
      {
        label: "Mistral",
        metrics: [
          { label: "api", percentage: 4, resetsInMs: 0, type: "percentage" },
          { label: "vibe", percentage: 8, resetsInMs: 0, type: "percentage" }
        ]
      }
    ]
  });
});

test("reports a usage error when the budget endpoint fails", async () => {
  const requests = [];
  const errors = [];
  let signal;
  assert.equal(
    await fetchUsage({
      cache: false,
      credential: "synthetic-mistral-key",
      fetch: (url, options) => {
        requests.push(String(url));
        ({ signal } = options);
        return new Response(null, { status: 503 });
      },
      onUsageError: () => errors.push(1)
    }),
    undefined
  );
  assert.deepEqual(requests, [BUDGET_URL]);
  assert.equal(signal.aborted, true);
  assert.equal(errors.length, 1);
});

test("returns without a request when the credential is missing", () => {
  assert.equal(
    fetchUsage({
      cache: false,
      fetch: () => assert.fail("fetch must not be called")
    }),
    undefined
  );
});
