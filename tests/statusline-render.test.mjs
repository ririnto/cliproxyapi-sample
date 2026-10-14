import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

import {
  renderAddons,
  renderSnapshot,
  renderStatusline
} from "../.claude/statusline.mjs";

const snapshot = (label, percentage = 25) => ({
  groups: [{ metrics: [{ label, percentage, type: "percentage" }] }]
});

test("invalid snapshots and empty groups do not evaluate addon display options", () => {
  const addon = {
    get hideName() {
      throw new Error("Empty groups must not read display options");
    },
    get name() {
      throw new Error("Empty groups must not read display options");
    }
  };
  for (const value of [undefined, null, {}, { groups: [] }, { groups: [{}] }]) {
    assert.equal(renderSnapshot(addon, value), "");
  }
});

test("snapshot filtering respects metric thresholds, group thresholds, and hidden labels", () => {
  const output = stripVTControlCharacters(
    renderSnapshot(
      {
        hideLabels: ["Hidden"],
        name: "Fallback",
        showAbove: { Group: 50, Low: 20 }
      },
      {
        groups: [
          {
            label: "Group",
            metrics: [
              { label: "Low", percentage: 25, type: "percentage" },
              { label: "Below", percentage: 49, type: "percentage" },
              { label: "Hidden", percentage: 100, type: "percentage" },
              { label: "Usage", total: 10, type: "usage", used: 5 }
            ]
          }
        ]
      }
    )
  );
  assert.equal(output, "Group | Low: 25% | Usage: 5/10");
  assert.equal(
    renderSnapshot({ name: "Fallback", showAbove: 50 }, snapshot("5h")),
    ""
  );
  assert.equal(renderSnapshot({}), "");
});

test("addon fetching is concurrent, preserves order, and isolates import and fetch failures", async () => {
  const { promise: firstReady, resolve: releaseFirst } =
    Promise.withResolvers();
  const imports = [];
  const output = await renderAddons(
    [
      "first",
      "second",
      "import-failure",
      "fetch-failure",
      "empty",
      "disabled"
    ].map((name) => ({
      enabled: name !== "disabled",
      name,
      script: `${name}.mjs`
    })),
    {
      importModule: (url) => {
        const name = path.basename(url.pathname, ".mjs");
        imports.push(name);
        if (name === "import-failure") {
          throw new Error("Fixture import failure");
        }
        return {
          fetchUsage: async () => {
            if (name === "first") {
              await firstReady;
            }
            if (name === "second") {
              releaseFirst();
            }
            if (name === "fetch-failure") {
              throw new Error("Fixture fetch failure");
            }
            return name === "empty" ? { groups: [] } : snapshot(name);
          }
        };
      }
    }
  );
  assert.equal(imports.includes("disabled"), false);
  assert.deepEqual(output.map(stripVTControlCharacters), [
    "first | first: 25%",
    "second | second: 25%"
  ]);
});

test("status rows render model, context, cost, and reset windows without side effects", async () => {
  const rawRows = await renderStatusline(
    {
      context_window: { context_window_size: 100_000, used_percentage: 25 },
      cost: { total_cost_usd: 1.25, total_duration_ms: 120_000 },
      effort: { level: "high" },
      model: { display_name: "Fixture model" },
      rate_limits: { five_hour: { resets_at: 3601, used_percentage: 50 } },
      workspace: { current_dir: "/project", project_dir: "/project" }
    },
    { branch: "fixture-branch", nowMs: 1000 }
  );
  const rows = rawRows.map(stripVTControlCharacters);
  assert.match(
    rows[0],
    /Fixture model \(high\).*fixture-branch.*25% \(100k\)/u
  );
  assert.match(rows[1], /\$1\.25 \| 2m/u);
  assert.equal(rows[2], "5h: 50% (1h 0m)");
});

test("hidden addons merge only when built-in rates are absent and merging is enabled", async () => {
  const options = {
    addons: [{ hideName: true, name: "Fixture", script: "fixture.mjs" }],
    branch: "",
    importModule: () => ({ fetchUsage: () => snapshot("Addon") }),
    nowMs: 1000
  };
  const rawMerged = await renderStatusline({}, options);
  const merged = rawMerged.map(stripVTControlCharacters);
  assert.equal(merged.length, 2);
  assert.match(merged[1], /Addon: 25%/u);
  const separate = await renderStatusline(
    {},
    { ...options, mergeHidden: false }
  );
  assert.equal(separate.length, 3);
  const rawRates = await renderStatusline(
    {
      rate_limits: { five_hour: { resets_at: 3601, used_percentage: 10 } }
    },
    options
  );
  const rates = rawRates.map(stripVTControlCharacters);
  assert.equal(rates.length, 4);
  assert.doesNotMatch(rates[1], /Addon/u);
  assert.equal(rates[3], "Addon: 25%");
});
