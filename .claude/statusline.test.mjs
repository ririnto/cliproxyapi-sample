import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
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

import { renderSnapshot, renderStatusline } from "./statusline.mjs";

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
const addon = { hideLabels: ["Premium"] };
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
 * @param {{name: string, metrics: Record<string, unknown>[], primary?: boolean, provider?: string, hideName?: boolean}[]} providers - Provider fixtures.
 * @param {{input?: Record<string, unknown>}} [options] - Input overrides.
 */
const renderProviderRows = async (providers, options = {}) =>
  await renderStatusline(options.input ?? {}, {
    addons: providers.map(({ name, primary, provider, hideName }) => ({
      hideName,
      name,
      primary,
      provider,
      script: `./${name}.mjs`
    })),
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

await test("explicit model and effort take precedence over fallback fields", async () => {
  const options = { branch: "" };
  const model = { display_name: "Selected", id: "Fallback", effort: "low" };
  const effort = { level: "high" };
  const selected = await renderStatusline({ model, effort }, options);
  assert.deepEqual(
    selected,
    await renderStatusline(
      {
        model: { display_name: model.display_name },
        effort
      },
      options
    )
  );
  assert.notDeepEqual(selected, await renderStatusline({ model }, options));
  assert.notDeepEqual(
    selected,
    await renderStatusline(
      {
        model: { id: model.id },
        effort
      },
      options
    )
  );
});

await test("idle output omits empty metrics and distinguishes unknown context", async () => {
  const [row] = await renderStatusline(
    { context_window: { context_window_size: 305_000 } },
    { branch: "" }
  );
  assert.match(plainText(row), /Context 305k$/u);
  assert.doesNotMatch(plainText(row), /\$0\.00|0m|in 0|out 0|cache|▰|▱/u);
  const [waiting] = await renderStatusline({}, { branch: "" });
  assert.match(plainText(waiting), /Context waiting$/u);
  const [short] = await renderStatusline(
    { cost: { total_duration_ms: 20_000 } },
    { branch: "" }
  );
  assert.match(plainText(short), /20s · Context/u);
});

await test("context uses eight cells with at least one filled cell for positive usage", async () => {
  await Promise.all(
    [0, 1, 6, 9, 50, 100, 120, -1].map(async (value) => {
      const [row] = await renderStatusline(
        { context_window: { used_percentage: value } },
        { branch: "" }
      );
      const text = plainText(row);
      const match = /Context (?<bar>[▰▱]{8}) (?<percentage>\d+)%/u.exec(text);
      assert.ok(match?.groups);
      assert.equal(
        Number(match.groups.percentage),
        Math.max(0, Math.min(100, value))
      );
      assert.equal(match.groups.bar.includes("▰"), value > 0);
    })
  );
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

await test("valid native usage skips the Claude collector; malformed limits allow fallback", async () => {
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
              name: "Claude",
              provider: "claude",
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

await test("malformed addon configuration is ignored", async () => {
  const [plainRows, nativeRows] = await Promise.all([
    renderStatusline({}, { addons: "claude", branch: "" }),
    renderStatusline(
      { rate_limits: { five_hour: { used_percentage: 10 } } },
      { addons: 42, branch: "" }
    )
  ]);
  assert.equal(plainRows.length, 1);
  assert.equal(nativeRows.length, 2);
});

await test("credits and usage counts are compact without changing raw values", () => {
  /** @type {[Record<string, string | number>, string][]} */
  const cases = [
    [{ currency: "USD", remaining: 12.5, type: "credit" }, "$12.50"],
    [{ remaining: 57_500, type: "credit" }, "57.5k"],
    [{ total: 1500, type: "usage", used: 211.3214152413 }, "211.3/1.5k"],
    [{ total: 1500, type: "usage", used: 211.39 }, "211.4/1.5k"],
    [{ total: 1500, type: "usage", used: 211 }, "211/1.5k"]
  ];
  for (const [metric, expected] of cases) {
    const original = structuredClone(metric);
    assert.equal(
      plainText(
        renderSnapshot(
          { name: "Test" },
          { groups: [{ metrics: [{ label: "value", ...metric }] }] }
        )
      ),
      `Test  value ${expected}`
    );
    assert.deepEqual(metric, original);
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

await test("hideLabels removes matching metrics and omits empty groups", () => {
  assert.match(renderSnapshot({}, snapshot), /Premium /u);
  const filtered = renderSnapshot(addon, snapshot);
  assert.doesNotMatch(filtered, /Premium /u);
  assert.match(filtered, /Chat /u);
  assert.match(filtered, /Completions /u);
  assert.equal(
    renderSnapshot(
      { hideLabels: ["Chat", "Completions", "Premium"] },
      snapshot
    ),
    ""
  );
});

await test("raw labels remain available for hideLabels and showAbove", () => {
  const groupLabel = "Group\nRAW\u001B[31m";
  const metricLabel = "Metric\nRAW\u001B[31m";
  const rawSnapshot = {
    groups: [
      {
        label: groupLabel,
        metrics: [{ label: metricLabel, percentage: 10 }]
      }
    ]
  };
  assert.equal(renderSnapshot({ hideLabels: [metricLabel] }, rawSnapshot), "");
  assert.equal(
    renderSnapshot({ showAbove: { [metricLabel]: 11 } }, rawSnapshot),
    ""
  );
  assert.equal(
    renderSnapshot({ showAbove: { [groupLabel]: 11 } }, rawSnapshot),
    ""
  );
  assert.equal(rawSnapshot.groups[0].label, groupLabel);
  assert.equal(rawSnapshot.groups[0].metrics[0].label, metricLabel);
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

await test("resolves large credential reference lists without stack overflow", async () => {
  const { renderAddons } = await import("./statusline.mjs");
  const credential = "{file:}".repeat(12_000);
  const rows = await renderAddons(
    [{ credential, name: "Test", script: "./glm-coding-plan.mjs" }],
    {
      importModule: () => ({
        fetchUsage:
          /** @param {{credential: string}} options - Resolved credential. */
          ({ credential: resolved }) =>
            resolved === credential ? snapshot : undefined
      })
    }
  );
  assert.equal(rows.length, 1);
});

await test("public CLI resolves addon settings from the configured directory", async (t) => {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), "statusline-cli-"));
  t.after(() => {
    rmSync(fixtureDir, { force: true, recursive: true });
  });
  const homeDir = path.join(fixtureDir, "home");
  const homeSettingsDir = path.join(homeDir, ".claude");
  const configDir = path.join(fixtureDir, "custom-config");
  const fallbackProjectDir = path.join(fixtureDir, "fallback-project");
  const projectDir = path.join(fixtureDir, "project");
  const projectSettingsDir = path.join(projectDir, ".claude");
  const emptyProjectDir = path.join(fixtureDir, "empty-project");
  const emptyProjectSettingsDir = path.join(emptyProjectDir, ".claude");
  const displayProjectDir = path.join(fixtureDir, "display-project");
  const displayProjectSettingsDir = path.join(displayProjectDir, ".claude");
  const addonScript = path.join(fixtureDir, "addon.mjs");
  const configuredAddon = {
    credential: "{file:credential.txt}",
    script: addonScript
  };
  mkdirSync(homeSettingsDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(fallbackProjectDir, { recursive: true });
  mkdirSync(projectSettingsDir, { recursive: true });
  mkdirSync(emptyProjectSettingsDir, { recursive: true });
  mkdirSync(displayProjectSettingsDir, { recursive: true });
  writeFileSync(
    addonScript,
    `export const fetchUsage = async ({ credential }) => {
      const [groupLabel, metricLabel = "Probe"] = credential.split("|");
      return {
        groups: [
          {
            label: groupLabel,
            metrics: [{ label: metricLabel, percentage: 10 }]
          }
        ]
      };
    };\n`
  );
  writeFileSync(
    path.join(homeSettingsDir, "settings.json"),
    JSON.stringify({ statusLineAddon: [configuredAddon] })
  );
  writeFileSync(path.join(homeSettingsDir, "credential.txt"), "HomeFixture");
  writeFileSync(
    path.join(configDir, "settings.json"),
    JSON.stringify({ statusLineAddon: [configuredAddon] })
  );
  writeFileSync(path.join(configDir, "credential.txt"), "CustomFixture");
  writeFileSync(
    path.join(projectSettingsDir, "settings.json"),
    JSON.stringify({ statusLineAddon: [configuredAddon] })
  );
  writeFileSync(
    path.join(projectSettingsDir, "credential.txt"),
    "ProjectFixture"
  );
  writeFileSync(
    path.join(emptyProjectSettingsDir, "settings.json"),
    JSON.stringify({ statusLineAddon: [] })
  );
  writeFileSync(
    path.join(displayProjectSettingsDir, "settings.json"),
    JSON.stringify({ statusLineAddon: [configuredAddon] })
  );
  writeFileSync(
    path.join(displayProjectSettingsDir, "credential.txt"),
    "EVIL\nFAKE ROW\u001B[31m|5h\nSPOOF"
  );
  const statuslinePath = fileURLToPath(
    new URL("statusline.mjs", import.meta.url)
  );
  const scriptSymlinkPath = path.join(fixtureDir, "statusline-link.mjs");
  const installationDir = path.join(fixtureDir, "installation");
  const symlinkedConfigDir = path.join(fixtureDir, "installation-link");
  mkdirSync(installationDir);
  symlinkSync(statuslinePath, scriptSymlinkPath);
  symlinkSync(statuslinePath, path.join(installationDir, "statusline.mjs"));
  symlinkSync(installationDir, symlinkedConfigDir, "dir");
  /**
   * @param {string} workspaceProjectDir - Fixture project directory.
   * @param {NodeJS.ProcessEnv} [environment] - Environment overrides.
   * @param {string} [commandPath] - Executable script path.
   */
  const run = (
    workspaceProjectDir,
    environment = {},
    commandPath = statuslinePath
  ) => {
    const result = spawnSync(process.execPath, [commandPath], {
      encoding: "utf-8",
      env: { PATH: process.env.PATH ?? "", ...environment },
      input: JSON.stringify({
        workspace: {
          current_dir: workspaceProjectDir,
          project_dir: workspaceProjectDir
        }
      })
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    return result.stdout;
  };
  /**
   * @param {string} workspaceProjectDir - Fixture project directory.
   * @param {NodeJS.ProcessEnv} [environment] - Environment overrides.
   */
  const runPlainText = (workspaceProjectDir, environment = {}) =>
    plainText(run(workspaceProjectDir, environment));
  await t.test(
    "uses nonempty CLAUDE_CONFIG_DIR when project settings omit addons",
    () => {
      const output = runPlainText(fallbackProjectDir, {
        CLAUDE_CONFIG_DIR: configDir,
        HOME: homeDir
      });
      assert.match(output, /CustomFixture {2}Probe 90% left/u);
      assert.doesNotMatch(output, /HomeFixture/u);
    }
  );
  await t.test("unset CLAUDE_CONFIG_DIR falls back to HOME", () => {
    const output = runPlainText(fallbackProjectDir, { HOME: homeDir });
    assert.match(output, /HomeFixture {2}Probe 90% left/u);
    assert.doesNotMatch(output, /CustomFixture/u);
  });
  await t.test(
    "project addon settings take priority over global settings",
    () => {
      const output = runPlainText(projectDir, {
        CLAUDE_CONFIG_DIR: configDir,
        HOME: homeDir
      });
      assert.match(output, /ProjectFixture {2}Probe 90% left/u);
      assert.doesNotMatch(output, /HomeFixture|CustomFixture/u);
    }
  );
  await t.test("an empty project addon array disables global fallback", () => {
    const output = runPlainText(emptyProjectDir, {
      CLAUDE_CONFIG_DIR: configDir,
      HOME: homeDir
    });
    assert.doesNotMatch(output, /HomeFixture|CustomFixture/u);
  });
  await t.test("project addon settings work when HOME is unset", () => {
    const output = runPlainText(projectDir, { CLAUDE_CONFIG_DIR: configDir });
    assert.match(output, /ProjectFixture {2}Probe 90% left/u);
  });
  await t.test(
    "script symlink invocation renders configured provider output",
    () => {
      const output = run(
        fallbackProjectDir,
        { HOME: homeDir },
        scriptSymlinkPath
      );
      assert.equal(output.trimEnd().split("\n").length, 2);
      assert.ok(plainText(output).includes("HomeFixture  Probe 90% left"));
    }
  );
  await t.test(
    "directory symlink invocation renders one row through the configured command",
    () => {
      const output = run(
        fallbackProjectDir,
        { CLAUDE_CONFIG_DIR: symlinkedConfigDir, HOME: homeDir },
        path.join(symlinkedConfigDir, "statusline.mjs")
      );
      assert.equal(output.trimEnd().split("\n").length, 1);
    }
  );
  await t.test(
    "directory symlink invocation renders with preserve-symlinks-main",
    () => {
      const output = run(
        fallbackProjectDir,
        {
          CLAUDE_CONFIG_DIR: symlinkedConfigDir,
          HOME: homeDir,
          NODE_OPTIONS: "--preserve-symlinks-main"
        },
        path.join(symlinkedConfigDir, "statusline.mjs")
      );
      assert.equal(output.trimEnd().split("\n").length, 1);
    }
  );
  await t.test("supplied labels stay in one plain-text display row", () => {
    const output = run(displayProjectDir, { HOME: homeDir });
    const rows = output.trimEnd().split("\n");
    assert.equal(rows.length, 2);
    assert.match(plainText(output), /EVIL FAKE ROW {2}5h SPOOF 90% left/u);

    assert.equal(output.includes(RED_TEXT), false);
  });
  await t.test("newline workspace basename stays within its header row", () => {
    const projectWithNewline = path.join(fixtureDir, "project\nname");
    mkdirSync(projectWithNewline);
    const output = run(projectWithNewline, {
      CLAUDE_CONFIG_DIR: path.join(fixtureDir, "empty-config"),
      HOME: homeDir
    });
    assert.equal(output.trimEnd().split("\n").length, 1);
    assert.match(plainText(output), /project name/u);
  });
  await t.test("malformed input through a symlink remains silent", () => {
    const result = spawnSync(process.execPath, [scriptSymlinkPath], {
      encoding: "utf-8",
      env: { HOME: homeDir, PATH: process.env.PATH ?? "" },
      input: "{"
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });
});

await test("module imports do not render for absent or unrelated argv", (t) => {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), "statusline-import-"));
  t.after(() => {
    rmSync(fixtureDir, { force: true, recursive: true });
  });
  const moduleUrl = new URL("statusline.mjs", import.meta.url).href;
  const importSource = `await import(${JSON.stringify(moduleUrl)});`;
  const unrelatedPath = path.join(fixtureDir, "unrelated.mjs");
  writeFileSync(unrelatedPath, "");
  const argumentLists = [
    [],
    [unrelatedPath],
    [path.join(fixtureDir, "missing.mjs")]
  ];
  for (const args of argumentLists) {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", importSource, ...args],
      {
        encoding: "utf-8",
        env: { PATH: process.env.PATH ?? "" }
      }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
});

await test("Codex additional-limit labels stay inside the display row", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "statusline-codex-"));
  t.after(() => {
    rmSync(home, { force: true, recursive: true });
  });
  const codexDirectory = path.join(home, ".codex");
  mkdirSync(codexDirectory);
  writeFileSync(
    path.join(codexDirectory, "auth.json"),
    JSON.stringify({ tokens: { access_token: "fixture-token" } })
  );
  const { fetchUsage } = await import("./statusline/codex-usage.mjs");
  const codexSnapshot = await fetchUsage({
    cache: false,
    fetch: () =>
      Response.json({
        additional_rate_limits: [
          {
            limit_name: "Additional\nFAKE ROW\u001B[31m",
            rate_limit: {
              secondary_window: {
                limit_window_seconds: 18_000,
                used_percent: 10
              }
            }
          }
        ]
      }),
    home
  });
  assert.ok(
    codexSnapshot !== null &&
      typeof codexSnapshot === "object" &&
      "groups" in codexSnapshot
  );
  const { groups: rawGroups } = codexSnapshot;
  assert.ok(Array.isArray(rawGroups));
  /** @type {unknown[]} */
  const groups = rawGroups;
  const [group] = groups;
  assert.ok(group !== null && typeof group === "object" && "label" in group);
  assert.equal(group.label, "Additional\nFAKE ROW\u001B[31m");
  const rows = await renderStatusline(
    {},
    {
      addons: [{ name: "Codex", script: "./codex-usage.mjs" }],
      branch: "",
      importModule: () => ({ fetchUsage: () => codexSnapshot })
    }
  );
  const output = rows.join("\n");
  assert.equal(output.trimEnd().split("\n").length, 2);
  assert.match(plainText(output), /Additional FAKE ROW {2}5h 90% left/u);
  assert.equal(output.includes(RED_TEXT), false);
});
