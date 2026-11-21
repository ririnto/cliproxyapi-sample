import assert from "node:assert/strict";
import { test } from "node:test";

import { usageRuntime } from "../../.claude/statusline.mjs";
import { fetchUsage } from "../../.claude/statusline/mistral-usage.mjs";

const BUDGET_URL = "https://api.mistral.ai/v1/billing/budget";

await test("reports the API and Vibe budget percentages with their reset", async () => {
  /** @type {{authorization: string, url: string}[]} */
  const requests = [];
  const snapshot = await fetchUsage(
    {
      cache: false,
      credential: "synthetic-mistral-key",
      fetch: (url, options) => {
        requests.push({
          authorization: options.headers.Authorization,
          url
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
    },
    usageRuntime
  );
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
