import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { renderSnapshot, renderStatusline } from "../../.claude/statusline.mjs";

const snapshot = {
  groups: [
    {
      label: "Claude",
      metrics: [
        { label: "Chat", total: 4, type: "usage", used: 1 },
        { label: "Completions", percentage: 10, type: "percentage" },
        { label: "Premium", percentage: 90, type: "percentage" }
      ]
    }
  ]
};
/** @param {unknown} value - Value to render as plain text. */
const plainText = (value) => stripVTControlCharacters(String(value));
const RED_TEXT = "\u001B[31m";
const nowMs = 1_700_000_000_000;
/**
 * @param {string} label - Metric label.
 * @param {number} value - Usage percentage.
 * @param {number} [minutes] - Minutes until reset.
 */
const percentage = (label, value, minutes) => ({
  label,
  percentage: value,
  type: "percentage",
  ...(minutes === undefined ? {} : { resetsInMs: minutes * 60_000 })
});

/**
 * @param {{name: string, metrics: Record<string, unknown>[], primary?: boolean, skipWhenNativeUsage?: boolean, hideName?: boolean}[]} providers - Provider fixtures.
 * @param {{input?: Record<string, unknown>}} [options] - Input overrides.
 */
const renderProviderRows = async (providers, options = {}) =>
  await renderStatusline(options.input ?? {}, {
    addons: providers.map(
      ({ name, primary, skipWhenNativeUsage, hideName }) => ({
        hideName,
        name,
        primary,
        skipWhenNativeUsage,
        script: `./${name}.mjs`
      })
    ),
    branch: "",
    importModule:
      /** @param {URL} url - Imported provider location. */
      (url) => {
        const provider = providers.find(({ name }) =>
          decodeURIComponent(url.pathname).endsWith(`${name}.mjs`)
        );
        assert.ok(provider);
        return {
          fetchUsage: () => ({
            groups: [{ label: provider.name, metrics: provider.metrics }]
          })
        };
      },
    nowMs,
    ...options
  });

await test("column alignment follows reset-length transitions", async () => {
  await Promise.all(
    [
      [1439, 1439],
      [1440, 1439],
      [1439, 1440],
      [60, 59]
    ].map(async ([left, right]) => {
      const rows = await renderProviderRows([
        { metrics: [percentage("7d", 18, left)], name: "Claude" },
        { metrics: [percentage("5h", 21, 20)], name: "Z.AI" },
        { metrics: [percentage("7d", 94, right)], name: "ChatGPT" },
        { metrics: [percentage("Premium", 14)], name: "Copilot" }
      ]);
      assert.equal(rows.length, 3);
      assert.equal(
        plainText(rows[1]).indexOf("│"),
        plainText(rows[2]).indexOf("│")
      );
    })
  );
});

await test("provider wrapping ignores ANSI and respects the 120-character limit", async () => {
  await Promise.all(
    [0, 1].map(async (extra) => {
      const rows = await renderProviderRows([
        { metrics: [percentage("x", 1)], name: "A".repeat(30) },
        { metrics: [percentage("x", 1)], name: "B".repeat(61 + extra) }
      ]);
      assert.equal(rows.length, extra ? 3 : 2);
      if (!extra) {
        assert.equal(plainText(rows[1]).length, 120);
      }
    })
  );
  const rows = await renderProviderRows([
    { metrics: [percentage("5h", 10)], name: "P".repeat(130) }
  ]);
  assert.equal(rows.length, 2);
  assert.ok(plainText(rows[1]).startsWith("P".repeat(130)));
});

await test("alignment padding does not push a pair beyond the row budget", async () => {
  const rows = await renderProviderRows([
    { metrics: [percentage("x", 1)], name: "A".repeat(55) },
    { metrics: [percentage("x", 1)], name: "B" },
    { metrics: [percentage("x", 1)], name: "C" },
    { metrics: [percentage("x", 1)], name: "D".repeat(70) }
  ]);
  assert.equal(rows.length, 4);
  assert.ok(rows.slice(1).every((row) => plainText(row).length <= 120));
});

await test("primary provider stays below session information and precedes other providers", async () => {
  await Promise.all(
    [
      undefined,
      {},
      {
        five_hour: { resets_at: nowMs / 1000 },
        spend_limit: { used_percentage: null }
      }
    ].map(async (rateLimits) => {
      const rows = await renderProviderRows(
        [
          { metrics: [percentage("7d", 20)], name: "Other" },
          {
            hideName: true,
            metrics: [percentage("5h", 10)],
            name: "Primary",
            primary: true
          }
        ],
        { input: { rate_limits: rateLimits } }
      );
      assert.equal(rows.length, 2);
      assert.doesNotMatch(plainText(rows[0]), /Primary|Other/u);
      assert.match(
        plainText(rows[1]),
        /^Primary {2}5h 90% left {2}│ {2}Other {2}7d 80% left$/u
      );
    })
  );
});

await test("native windows display remaining usage before addon providers", async () => {
  const rows = await renderProviderRows(
    [
      { metrics: [percentage("5h", 10)], name: "Primary", primary: true },
      { metrics: [percentage("7d", 20)], name: "Other" }
    ],
    {
      input: {
        rate_limits: {
          five_hour: { resets_at: nowMs / 1000 + 2760, used_percentage: 37 },
          seven_day: { resets_at: nowMs / 1000 + 219_600, used_percentage: 6 }
        }
      }
    }
  );
  assert.equal(rows.length, 3);
  assert.match(
    plainText(rows[1]),
    /^Claude {2}5h 63% left ↻46m · 7d 94% left ↻2d13h {2}│ {2}Primary/u
  );
  assert.match(plainText(rows[2]), /^Other/u);
});

await test("valid native usage skips its configured fallback; malformed limits allow it", async () => {
  await Promise.all(
    [
      { five_hour: { used_percentage: 0 } },
      { spend_limit: { limit_usd: 2, used_usd: 1 } },
      {},
      {
        five_hour: { resets_at: nowMs / 1000 },
        seven_day: { used_percentage: -5 },
        spend_limit: { used_percentage: null, used_usd: "x" }
      },
      { spend_limit: { limit_usd: 500, used_percentage: -1, used_usd: -10 } }
    ].map(async (rateLimits) => {
      /** @type {string[]} */
      const imported = [];
      const rows = await renderStatusline(
        { rate_limits: rateLimits },
        {
          addons: [
            {
              name: "Native fallback",
              skipWhenNativeUsage: true,
              script: "./claude-usage.mjs"
            },
            { name: "ZAI", script: "./zai.mjs" }
          ],
          branch: "",
          importModule:
            /** @param {URL} url - Imported provider location. */
            (url) => {
              imported.push(url.pathname);
              return {
                fetchUsage: () =>
                  url.pathname.endsWith("claude-usage.mjs")
                    ? snapshot
                    : {
                        groups: [
                          { label: "ZAI", metrics: [percentage("5h", 10)] }
                        ]
                      }
              };
            },
          nowMs
        }
      );
      const native =
        rateLimits.five_hour?.used_percentage === 0 ||
        rateLimits.spend_limit?.used_usd === 1;
      assert.equal(
        imported.some((file) => file.endsWith("claude-usage.mjs")),
        !native
      );
      assert.match(plainText(rows.slice(1).join("\n")), /ZAI {2}5h 90% left/u);
      assert.equal(
        plainText(rows.slice(1).join("\n")).includes("Chat 1/4"),
        !native
      );
    })
  );
});

await test("spend limits preserve budgets and fall back only to valid percentages", async () => {
  const cases = [
    [
      {
        limit_usd: 500,
        resets_at: nowMs / 1000 + 2760,
        used_percentage: 62.8,
        used_usd: 314.12
      },
      "Claude  spend $314.12/$500.00 ↻46m"
    ],
    [{ used_percentage: 62.8 }, "Claude  spend 37.2% left"],
    [
      { limit_usd: null, used_percentage: 40, used_usd: "12" },
      "Claude  spend 60% left"
    ],
    [
      { limit_usd: 500, used_percentage: 40, used_usd: -1 },
      "Claude  spend 60% left"
    ],
    [
      { limit_usd: 0, used_percentage: 40, used_usd: 10 },
      "Claude  spend 60% left"
    ],
    [
      { limit_usd: -500, used_percentage: 40, used_usd: 10 },
      "Claude  spend 60% left"
    ],
    [{ limit_usd: 500, used_usd: -1 }, ""],
    [{ used_percentage: -5 }, ""]
  ];
  await Promise.all(
    cases.map(async ([spendLimit, expected]) => {
      const rows = await renderStatusline(
        { rate_limits: { spend_limit: spendLimit } },
        { branch: "", nowMs }
      );
      assert.equal(plainText(rows[1] || ""), expected);
    })
  );
  await Promise.all(
    [
      { limit_usd: 500, used_percentage: 120, used_usd: 600 },
      { used_percentage: 120 }
    ].map(async (spendLimit) => {
      const rows = await renderStatusline(
        { rate_limits: { spend_limit: spendLimit } },
        { branch: "", nowMs }
      );

      assert.match(
        plainText(rows[1]),
        /spend (?:\$600\.00\/\$500\.00|0% left)/u
      );
    })
  );
});

await test("usage totals and credits render compactly", () => {
  /** @type {[Record<string, string | number>, string][]} */
  const cases = [
    [{ currency: "USD", remaining: 12.5, type: "credit" }, "$12.50"],
    [{ remaining: 57_500, type: "credit" }, "57.5k"],
    [{ total: 1500, type: "usage", used: 211.3214152413 }, "211.3/1.5k"],
    [{ total: 1500, type: "usage", used: 211.39 }, "211.4/1.5k"],
    [{ total: 1500, type: "usage", used: 211 }, "211/1.5k"]
  ];
  for (const [metric, expected] of cases) {
    assert.equal(
      plainText(
        renderSnapshot(
          { name: "Test" },
          { groups: [{ metrics: [{ label: "value", ...metric }] }] }
        )
      ),
      `Test  value ${expected}`
    );
  }
  const line = renderSnapshot(
    { name: "Test", showAbove: 5 },
    {
      groups: [
        {
          metrics: [
            percentage("5h", 2),
            { currency: "USD", label: "credit", remaining: 3, type: "credit" }
          ]
        }
      ]
    }
  );
  assert.equal(plainText(line), "Test  credit $3.00");
});

await test("hideName drops the addon name and retains its metrics", () => {
  const usage = { groups: [{ metrics: [percentage("5h", 10)] }] };
  const named = renderSnapshot({ name: "Example" }, usage);
  const hidden = renderSnapshot({ name: "Example", hideName: true }, usage);
  assert.notEqual(named, hidden);
  assert.ok(hidden.length > 0);
  assert.equal(hidden, renderSnapshot({}, usage));
});

await test("external addon names and metric values stay on one plain-text row", async () => {
  const rows = await renderStatusline(
    {},
    {
      addons: [{ name: "Credit\nFAKE GROUP\u001B[31m", script: "credit.mjs" }],
      branch: "",
      importModule: () => ({
        fetchUsage: () => ({
          groups: [
            {
              metrics: [
                {
                  currency: "EUR",
                  label: "Remaining",
                  remaining:
                    "10\nFAKE ROW\u001B[31m\u2028PARAGRAPH\u2029END\u0085C1",
                  type: "credit"
                }
              ]
            }
          ]
        })
      })
    }
  );
  const output = rows.join("\n");
  assert.equal(output.split("\n").length, 2);
  assert.ok(
    plainText(output).includes(
      "Credit FAKE GROUP  Remaining 10 FAKE ROW PARAGRAPH END C1"
    )
  );
  assert.equal(output.includes(RED_TEXT), false);
});

await test("external header strings stay on one plain-text row", async () => {
  const rows = await renderStatusline(
    {
      effort: { level: "High\r\nFAKE ROW\u001B[31m" },
      model: { display_name: "Model\nFAKE ROW\u001B[31m" },
      workspace: {
        current_dir: "/workspace/current\nFAKE ROW",
        project_dir: "/workspace/project"
      }
    },
    { branch: "branch\nFAKE ROW\u001B[31m" }
  );
  const output = rows.join("\n");
  assert.equal(output.split("\n").length, 1);
  assert.ok(
    plainText(rows[0]).includes(
      "Model FAKE ROW High FAKE ROW · project/current FAKE ROW · branch FAKE ROW"
    )
  );
  assert.equal(output.includes(RED_TEXT), false);
});

await test("public CLI renders its entry script's provider registry", (t) => {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), "statusline-cli-"));
  t.after(() => {
    rmSync(fixtureDir, { force: true, recursive: true });
  });
  const installationDir = path.join(fixtureDir, "installation");
  const statuslineDir = path.join(installationDir, "statusline");
  const homeDir = path.join(fixtureDir, "home");
  const projectDir = path.join(fixtureDir, "project");
  const entryPath = path.join(installationDir, "statusline.mjs");
  const registryPath = path.join(statuslineDir, "providers.json");
  const providerPath = path.join(statuslineDir, "probe.mjs");
  const installationSymlink = path.join(fixtureDir, "installation-link");
  mkdirSync(statuslineDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  copyFileSync(
    fileURLToPath(new URL("../../.claude/statusline.mjs", import.meta.url)),
    entryPath
  );
  writeFileSync(
    registryPath,
    JSON.stringify([{ module: "probe.mjs", name: "RegistryFixture" }])
  );
  writeFileSync(
    providerPath,
    `export const fetchUsage = async () => ({
      groups: [{
        label: "RegistryFixture",
        metrics: [{ label: "5h", percentage: 12, type: "percentage" }]
      }]
    });\n`
  );
  symlinkSync(installationDir, installationSymlink, "dir");
  /**
   * @param {string} commandPath Entry script path.
   * @param {string} workspaceDir Workspace path.
   * @param {NodeJS.ProcessEnv} [environment] Environment overrides.
   */
  const run = (commandPath, workspaceDir, environment = {}) => {
    const result = spawnSync(process.execPath, [commandPath], {
      encoding: "utf-8",
      env: { PATH: process.env.PATH ?? "", HOME: homeDir, ...environment },
      input: JSON.stringify({
        workspace: { current_dir: workspaceDir, project_dir: workspaceDir }
      })
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    return result.stdout;
  };
  const expectedProvider = /RegistryFixture {2}5h 88% left/u;
  assert.match(
    plainText(
      run(path.join(installationSymlink, "statusline.mjs"), projectDir, {
        NODE_OPTIONS: "--preserve-symlinks-main"
      })
    ),
    expectedProvider
  );
});
