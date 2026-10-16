import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

test("snapshot display text is safe while trusted color formatting and Unicode remain", () => {
  const hostileText =
    "A\nB\rC\u0000\u001FD\u007FE\u0085\u009FF\u009B2J-C1CSI-\u009D0;title\u009C-C1OSC-\u001B[2J-G-\u001B]0;title\u0007-O-\u001BPpayload\u001B\\-D-\u2028L\u2029Cafe\u0301 👩‍🚀\u001B";
  const safeText =
    "A B C D E F-C1CSI- 0;title -C1OSC--G--O-payload \\-D- L Cafe\u0301 👩‍🚀 ";
  const output = renderSnapshot(
    { name: hostileText },
    {
      groups: [
        {
          label: hostileText,
          metrics: [
            { label: hostileText, percentage: 25, type: "percentage" },
            { label: "Usage", total: "10", type: "usage", used: "5\n" }
          ]
        },
        { metrics: [{ label: "Usage", percentage: 25, type: "percentage" }] }
      ]
    }
  );
  assert.equal(
    output,
    `${safeText} | ${safeText}: \u001B[32m25%\u001B[0m | Usage: \u001B[32m5 /10\u001B[0m | ${safeText} | Usage: \u001B[32m25%\u001B[0m`
  );
});

test("snapshot filtering uses original hidden labels and threshold keys", () => {
  const hiddenLabel = "Hidden\rMetric";
  const thresholdLabel = "Threshold\nMetric\u001B[2J";
  assert.equal(
    renderSnapshot(
      {
        hideLabels: [hiddenLabel],
        name: "Fallback",
        showAbove: { [thresholdLabel]: 50, Group: 20 }
      },
      {
        groups: [
          {
            label: "Group",
            metrics: [
              { label: hiddenLabel, percentage: 100, type: "percentage" },
              { label: thresholdLabel, percentage: 49, type: "percentage" },
              { label: "Visible", percentage: 25, type: "percentage" }
            ]
          }
        ]
      }
    ),
    "Group | Visible: \u001B[32m25%\u001B[0m"
  );
});

test("status header display text does not change row shape", async () => {
  const rows = await renderStatusline(
    {
      context_window: {
        context_window_size: 100_000,
        used_percentage: 25
      },
      effort: { level: "high\u0085Reason" },
      model: { display_name: "Model\nName\u001B[2J" },
      workspace: {
        current_dir: "/workspace/Working\rTree",
        project_dir: "/project/Project\u2028Name"
      }
    },
    { branch: "feature\u2029safe\u001B", nowMs: 1000 }
  );
  assert.equal(rows.length, 2);
  assert.equal(
    rows[0],
    "\u001B[36m[Model Name (high Reason)]\u001B[0m \u001B[1mProject Name(Working Tree)\u001B[0m | \u001B[35mfeature safe \u001B[0m | \u001B[32m▓▓▓░░░░░░░\u001B[0m 25% (100k)"
  );
});

test("addon credentials preserve file-reference text and expansion order", async () => {
  const settingsDir = await mkdtemp(path.join(tmpdir(), "statusline-render-"));
  try {
    await Promise.all([
      writeFile(path.join(settingsDir, "first.txt"), " left \n"),
      writeFile(path.join(settingsDir, "second.txt"), " right \n"),
      writeFile(path.join(settingsDir, "empty.txt"), " \n\t"),
      writeFile(path.join(settingsDir, "literal.txt"), "keep {file:second.txt}")
    ]);
    const environmentName = `STATUSLINE_FILE_REFERENCE_${process.pid}_${Date.now()}`;
    const previousEnvironmentValue = process.env[environmentName];
    try {
      process.env[environmentName] = "{file:second.txt}";
      let capturedCredential;
      const output = await renderAddons(
        [
          {
            credential: [
              "\u{1F6F0}{file:first.txt}{file:second.txt}{file:first.txt}",
              "{file:empty.txt}",
              "{file:missing.txt}",
              "{file:}",
              "{file:literal.txt}",
              `{env:${environmentName}}`
            ].join("|"),
            name: "Fixture",
            script: "fixture.mjs"
          }
        ],
        {
          importModule: () => ({
            fetchUsage: ({ credential: value }) => {
              capturedCredential = value;
              return snapshot("Fixture");
            }
          }),
          settingsDir
        }
      );
      assert.equal(
        capturedCredential,
        "\u{1F6F0}leftrightleft||{file:missing.txt}|{file:}|keep {file:second.txt}|right"
      );
      assert.deepEqual(output.map(stripVTControlCharacters), [
        "Fixture | Fixture: 25%"
      ]);
    } finally {
      if (previousEnvironmentValue === undefined) {
        Reflect.deleteProperty(process.env, environmentName);
      } else {
        process.env[environmentName] = previousEnvironmentValue;
      }
    }
  } finally {
    await rm(settingsDir, { force: true, recursive: true });
  }
});

test("status header preserves context and workspace evaluation order", async () => {
  const events = [];
  const rows = await renderStatusline(
    {
      context_window: {
        context_window_size: {
          [Symbol.toPrimitive]() {
            events.push("context size");
            return 100_000;
          }
        },
        used_percentage: {
          [Symbol.toPrimitive]() {
            events.push("context percentage");
            return 25;
          }
        }
      },
      model: { display_name: "Fixture" },
      workspace: {
        get current_dir() {
          events.push("current_dir");
          return "/project/work";
        },
        get project_dir() {
          events.push("project_dir");
          return "/project/root";
        }
      }
    },
    {
      branch: {
        [Symbol.toPrimitive]() {
          events.push("branch display");
          return "feature";
        }
      },
      cwd: "/explicit-cwd",
      nowMs: 1000
    }
  );
  assert.deepEqual(events, [
    "context percentage",
    "context size",
    "current_dir",
    "project_dir",
    "branch display"
  ]);
  assert.equal(
    stripVTControlCharacters(rows[0]),
    "[Fixture] root(work) | feature | ▓▓▓░░░░░░░ 25% (100k)"
  );
});

test("context coercion failures do not access workspace directories", async () => {
  const events = [];
  const contextError = new Error("Fixture context coercion failure");
  await assert.rejects(
    renderStatusline(
      {
        context_window: {
          used_percentage: {
            [Symbol.toPrimitive]() {
              events.push("context percentage");
              throw contextError;
            }
          }
        },
        workspace: {
          get current_dir() {
            events.push("current_dir");
            return "/project/work";
          },
          get project_dir() {
            events.push("project_dir");
            return "/project/root";
          }
        }
      },
      { branch: "feature", cwd: "/explicit-cwd", nowMs: 1000 }
    ),
    (error) => error === contextError
  );
  assert.deepEqual(events, ["context percentage"]);
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
