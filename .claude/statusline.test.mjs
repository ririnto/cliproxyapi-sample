import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

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

const plainText = (value) => stripVTControlCharacters(String(value));

const RED_TEXT = "[31m";
const BOLD = "[1m";
const RESET_CODE = "[0m";

test("main provider의 사용량을 read 및 write와 같은 줄에 표시한다", async () => {
  const { renderStatusline } = await import("./statusline.mjs");
  const nowMs = 1_700_000_000_000;
  const fiveHour = {
    resets_at: nowMs / 1000 + 2760,
    used_percentage: 37
  };
  const sevenDay = {
    resets_at: nowMs / 1000 + 219_600,
    used_percentage: 6
  };
  const cases = [
    { rateLimits: undefined, suffix: "" },
    { rateLimits: {}, suffix: "" },
    { rateLimits: { five_hour: fiveHour }, suffix: " | 5h: 37% (0h 46m)" },
    { rateLimits: { seven_day: sevenDay }, suffix: " | 7d: 6% (2d 13h)" },
    {
      rateLimits: { five_hour: fiveHour, seven_day: sevenDay },
      suffix: " | 5h: 37% (0h 46m) | 7d: 6% (2d 13h)"
    }
  ];
  const rowsList = await Promise.all(
    cases.map(({ rateLimits, suffix }) =>
      renderStatusline(
        {
          context_window: {
            current_usage: {
              cache_creation_input_tokens: 1000,
              cache_read_input_tokens: 158_800
            },
            total_input_tokens: 159_800,
            total_output_tokens: 822
          },
          cost: { total_cost_usd: 3.81, total_duration_ms: 1_200_000 },
          rate_limits: rateLimits
        },
        { branch: "", nowMs }
      ).then((rows) => ({ rows, suffix }))
    )
  );
  for (const { rows, suffix } of rowsList) {
    assert.equal(rows.length, 2);
    assert.equal(
      plainText(rows[1]),
      `$3.81 | 20m | read:159.8k(158.8k) write:822(1k)${suffix}`
    );
  }
});

const renderProviderRows = async (providers, options = {}) => {
  const { renderStatusline } = await import("./statusline.mjs");
  return renderStatusline(options.input || {}, {
    addons: providers.map(({ hideName, name, primary }) => ({
      hideName,
      name,
      primary,
      script: `./${name}.mjs`
    })),
    branch: "",
    importModule: (url) => {
      const provider = providers.find(({ name }) =>
        decodeURIComponent(url.pathname).endsWith(`${name}.mjs`)
      );
      return {
        fetchUsage: () => ({
          groups: [
            {
              label: provider.name,
              metrics: [
                {
                  label: provider.label,
                  percentage: provider.percentage,
                  resetsInMs: provider.resetsInMs
                }
              ]
            }
          ]
        })
      };
    },
    ...options
  });
};

test("세 개의 짧은 제공자 사용량을 순서대로 한 줄에 묶는다", async () => {
  const providers = [
    { label: "5h", name: "Z.AI (Pro)", percentage: 2, resetsInMs: 4_020_000 },
    {
      label: "7d",
      name: "ChatGPT (Pro)",
      percentage: 3,
      resetsInMs: 565_200_000
    },
    { label: "5h", name: "GLM", percentage: 8 }
  ];
  const rows = await renderProviderRows(providers, {
    nowMs: 1_700_000_000_000
  });
  assert.equal(rows.length, 3);
  assert.match(
    plainText(rows[2]),
    /^Z\.AI \(Pro\) \| 5h: 2% \(1h 7m\) \| ChatGPT \(Pro\) \| 7d: 3% \(6d 13h\) \| GLM \| 5h: 8%$/u
  );
});

test("제공자 행의 표시 길이가 정확히 120자이면 같은 줄에 둔다", async () => {
  const providers = [
    { label: "x", name: "A".repeat(30), percentage: 1 },
    { label: "x", name: "B".repeat(71), percentage: 1 }
  ];
  const rows = await renderProviderRows(providers);
  assert.equal(rows.length, 3);
  assert.equal(plainText(rows[2]).length, 120);
});

test("결합한 제공자 행이 121자이면 다음 제공자를 새 줄에 둔다", async () => {
  const providers = [
    { label: "x", name: "A".repeat(30), percentage: 1 },
    { label: "x", name: "B".repeat(72), percentage: 1 }
  ];
  const rows = await renderProviderRows(providers);
  assert.equal(rows.length, 4);
});

test("긴 제공자 행은 자르거나 나누지 않고 단독 행으로 유지한다", async () => {
  const providers = [{ label: "5h", name: "P".repeat(130), percentage: 10 }];
  const rows = await renderProviderRows(providers);
  assert.equal(rows.length, 3);
  assert.match(
    plainText(rows[2]),
    new RegExp(`${"P".repeat(130)} \\| 5h: `, "u")
  );
});

test("짧은 제공자들은 이전 예산에서와 같이 한 줄에 묶인다", async () => {
  const providers = [
    { label: "5h", name: "Z.AI (Pro)", percentage: 2 },
    { label: "7d", name: "GLM", percentage: 8 }
  ];
  const rows = await renderProviderRows(providers);
  assert.equal(rows.length, 3);
  assert.equal(plainText(rows[2]), "Z.AI (Pro) | 5h: 2% | GLM | 7d: 8%");
});

test("ANSI 색상 제어 문자는 행 길이에 포함하지 않는다", async () => {
  const providers = [
    { label: "x", name: "A".repeat(30), percentage: 1 },
    { label: "x", name: "B".repeat(71), percentage: 1 }
  ];
  const rows = await renderProviderRows(providers);
  assert.equal(rows.length, 3);
  assert.equal(plainText(rows[2]).length, 120);
});

test("헤더는 제공자 사용량 행과 합치지 않는다", async () => {
  const rows = await renderProviderRows(
    [{ label: "5h", name: "Short", percentage: 10 }],
    { input: { model: { display_name: "Model" } } }
  );
  assert.equal(rows.length, 3);
  assert.match(rows[0], /Model/u);
  assert.match(plainText(rows[2]), /Short \| 5h: /u);
});

test("primary 설정은 hideName과 무관하게 사용량을 원가 행에 붙인다", async () => {
  const rows = await renderProviderRows([
    { label: "5h", name: "Primary", percentage: 10, primary: true }
  ]);
  assert.equal(rows.length, 2);
  assert.match(plainText(rows[1]), /write:.* \| Primary \| 5h: /u);
});

test("hideName만 설정된 제공자는 원가 행에 붙이지 않는다", async () => {
  const rows = await renderProviderRows([
    { hideName: true, label: "5h", name: "Hidden", percentage: 10 }
  ]);
  assert.equal(rows.length, 3);
  assert.match(plainText(rows[1]), /write:/u);
  assert.match(plainText(rows[2]), /Hidden \| 5h: /u);
});

test("native rate_limits가 비어 있으면 primary 제공자를 원가 행에 붙인다", async () => {
  const rows = await renderProviderRows(
    [{ label: "5h", name: "Primary", percentage: 10, primary: true }],
    { input: { rate_limits: {} } }
  );
  assert.equal(rows.length, 2);
  assert.match(plainText(rows[1]), /write:.* \| Primary \| 5h: /u);
});

test("native rate_limits가 malformed여도 primary 제공자를 원가 행에 붙인다", async () => {
  const rows = await renderProviderRows(
    [{ label: "5h", name: "Primary", percentage: 10, primary: true }],
    {
      input: {
        rate_limits: {
          five_hour: { resets_at: 1_700_000_000 },
          spend_limit: { used_percentage: null }
        }
      }
    }
  );
  assert.equal(rows.length, 2);
  assert.match(plainText(rows[1]), /write:.* \| Primary \| 5h: /u);
  assert.equal(plainText(rows[1]).match(/5h:/gu)?.length, 1);
});

test("native rate_limits가 있으면 primary 제공자를 다른 제공자와 함께 묶는다", async () => {
  const rows = await renderProviderRows(
    [
      { label: "5h", name: "Primary", percentage: 10, primary: true },
      { label: "7d", name: "Other", percentage: 20 }
    ],
    { input: { rate_limits: { five_hour: { used_percentage: 0 } } } }
  );
  assert.equal(rows.length, 3);
  assert.match(rows[1], /5h:/u);
  assert.doesNotMatch(rows[1], /Primary/u);
  assert.equal(plainText(rows[2]), "Primary | 5h: 10% | Other | 7d: 20%");
});

test("spend_limit은 금액 쌍이 있으면 budget 형식으로 표시한다", async () => {
  const { renderStatusline } = await import("./statusline.mjs");
  const nowMs = 1_700_000_000_000;
  const rows = await renderStatusline(
    {
      cost: {},
      rate_limits: {
        spend_limit: {
          limit_usd: 500,
          resets_at: nowMs / 1000 + 2760,
          used_percentage: 62.8,
          used_usd: 314.12
        }
      }
    },
    { branch: "", nowMs }
  );
  assert.equal(
    plainText(rows[1]),
    "$0.00 | 0m | read:0(0) write:0(0) | spend: $314.12/$500.00 (0h 46m)"
  );
});

test("spend_limit은 금액 없이 백분율만 있으면 백분율로 표시한다", async () => {
  const { renderStatusline } = await import("./statusline.mjs");
  const nowMs = 1_700_000_000_000;
  const rows = await renderStatusline(
    {
      cost: {},
      rate_limits: {
        spend_limit: { resets_at: nowMs / 1000 + 2760, used_percentage: 62.8 }
      }
    },
    { branch: "", nowMs }
  );
  assert.equal(
    plainText(rows[1]),
    "$0.00 | 0m | read:0(0) write:0(0) | spend: 62.8% (0h 46m)"
  );
});

test("spend_limit 금액이 잘못되면 유효한 백분율로 표시한다", async () => {
  const { renderStatusline } = await import("./statusline.mjs");
  const rows = await renderStatusline(
    {
      cost: {},
      rate_limits: {
        spend_limit: { limit_usd: null, used_percentage: 40, used_usd: "12" }
      }
    },
    { branch: "", nowMs: 1_700_000_000_000 }
  );
  assert.equal(
    plainText(rows[1]),
    "$0.00 | 0m | read:0(0) write:0(0) | spend: 40%"
  );
});

test("spend 금액이 음수이거나 상한이 0 이하이면 백분율 폴백 또는 무시한다", async () => {
  const { renderStatusline } = await import("./statusline.mjs");
  const cases = [
    {
      expected: "spend: 40%",
      spendLimit: { limit_usd: 500, used_percentage: 40, used_usd: -1 }
    },
    {
      expected: "spend: 40%",
      spendLimit: { limit_usd: 0, used_percentage: 40, used_usd: 10 }
    },
    {
      expected: "spend: 40%",
      spendLimit: { limit_usd: -500, used_percentage: 40, used_usd: 10 }
    },
    {
      expected: "",
      spendLimit: { limit_usd: 500, used_usd: -1 }
    },
    {
      expected: "",
      spendLimit: { used_percentage: -5 }
    }
  ];
  const rowsList = await Promise.all(
    cases.map(({ spendLimit }) =>
      renderStatusline(
        { cost: {}, rate_limits: { spend_limit: spendLimit } },
        { branch: "", nowMs: 1_700_000_000_000 }
      )
    )
  );
  for (const [index, rows] of rowsList.entries()) {
    const plainCost = plainText(rows[1]);
    if (cases[index].expected) {
      assert.ok(plainCost.includes(cases[index].expected), plainCost);
      assert.ok(!plainCost.includes("$-"), plainCost);
      assert.ok(!plainCost.includes("/$0.00"), plainCost);
    } else {
      assert.ok(!plainCost.includes("spend:"), plainCost);
    }
  }
});

test("음수 백분율만 있는 spend는 Claude addon 폴백을 허용한다", async () => {
  const { renderStatusline } = await import("./statusline.mjs");
  const imported = [];
  const rows = await renderStatusline(
    {
      cost: {},
      rate_limits: {
        spend_limit: { limit_usd: 500, used_percentage: -1, used_usd: -10 }
      }
    },
    {
      addons: [
        { name: "Claude", provider: "claude", script: "./claude-usage.mjs" }
      ],
      branch: "",
      importModule: (url) => {
        imported.push(decodeURIComponent(url.pathname));
        return { fetchUsage: () => snapshot };
      },
      nowMs: 1_700_000_000_000
    }
  );
  assert.ok(imported.some((filePath) => filePath.endsWith("claude-usage.mjs")));
  assert.ok(!plainText(rows[1]).includes("spend:"));
  assert.match(plainText(rows[2]), /Claude \| Chat: 1\/4/u);
});

test("spend 백분율이 100을 넘으면 붉게 표시한다", async () => {
  const { renderStatusline } = await import("./statusline.mjs");
  const cases = [
    { limit_usd: 500, used_percentage: 120, used_usd: 600 },
    { used_percentage: 120 }
  ];
  const rowsList = await Promise.all(
    cases.map((spendLimit) =>
      renderStatusline(
        { cost: {}, rate_limits: { spend_limit: spendLimit } },
        { branch: "", nowMs: 1_700_000_000_000 }
      )
    )
  );
  for (const rows of rowsList) {
    const plainRow = plainText(rows[1]);
    assert.match(plainRow, /spend: \$600\.00\/\$500\.00|spend: 120%/u);
    assert.ok(rows[1].includes(`spend: ${RED_TEXT}`));
  }
});

test("유효한 native 사용량이 있으면 Claude addon을 불러오지 않는다", async () => {
  const { renderStatusline } = await import("./statusline.mjs");
  const imported = [];
  const rows = await renderStatusline(
    { cost: {}, rate_limits: { five_hour: { used_percentage: 0 } } },
    {
      addons: [
        { name: "Claude", provider: "claude", script: "./claude-usage.mjs" },
        { name: "ZAI", provider: "zai", script: "./zai.mjs" }
      ],
      branch: "",
      importModule: (url) => {
        imported.push(decodeURIComponent(url.pathname));
        return {
          fetchUsage: () => ({
            groups: [
              {
                label: "ZAI",
                metrics: [{ label: "5h", percentage: 10 }]
              }
            ]
          })
        };
      },
      nowMs: 1_700_000_000_000
    }
  );
  assert.ok(
    !imported.some((filePath) => filePath.endsWith("claude-usage.mjs"))
  );
  assert.ok(imported.some((filePath) => filePath.endsWith("zai.mjs")));
  assert.doesNotMatch(plainText(rows.join("\n")), /Claude/u);
  assert.match(plainText(rows[2]), /ZAI \| 5h: 10%/u);
});

test("spend_limit 금액 쌍만 있어도 Claude addon을 불러오지 않는다", async () => {
  const { renderStatusline } = await import("./statusline.mjs");
  const imported = [];
  const rows = await renderStatusline(
    { cost: {}, rate_limits: { spend_limit: { limit_usd: 2, used_usd: 1 } } },
    {
      addons: [
        { name: "Claude", provider: "claude", script: "./claude-usage.mjs" }
      ],
      branch: "",
      importModule: (url) => {
        imported.push(decodeURIComponent(url.pathname));
        return {
          fetchUsage: () => null
        };
      },
      nowMs: 1_700_000_000_000
    }
  );
  assert.deepEqual(imported, []);
  assert.match(plainText(rows[1]), /spend: \$1\.00\/\$2\.00/u);
});

test("native rate_limits가 비어 있으면 Claude addon을 일반 제공자로 표시한다", async () => {
  const { renderStatusline } = await import("./statusline.mjs");
  const imported = [];
  const rows = await renderStatusline(
    { cost: {}, rate_limits: {} },
    {
      addons: [
        { name: "Claude", provider: "claude", script: "./claude-usage.mjs" }
      ],
      branch: "",
      importModule: (url) => {
        imported.push(decodeURIComponent(url.pathname));
        return {
          fetchUsage: () => ({
            groups: [
              {
                label: "Claude",
                metrics: [{ label: "5h", percentage: 10 }]
              }
            ]
          })
        };
      },
      nowMs: 1_700_000_000_000
    }
  );
  assert.ok(imported.some((filePath) => filePath.endsWith("claude-usage.mjs")));
  assert.doesNotMatch(plainText(rows[1]), /Claude/u);
  assert.match(plainText(rows[2]), /Claude \| 5h: 10%/u);
});

test("native 사용량이 malformed면 Claude addon fallback을 허용한다", async () => {
  const { renderStatusline } = await import("./statusline.mjs");
  const imported = [];
  const rows = await renderStatusline(
    {
      cost: {},
      rate_limits: {
        five_hour: { resets_at: 1_700_000_000 },
        seven_day: { used_percentage: -5 },
        spend_limit: { used_percentage: null, used_usd: "x" }
      }
    },
    {
      addons: [
        { name: "Claude", provider: "claude", script: "./claude-usage.mjs" }
      ],
      branch: "",
      importModule: (url) => {
        imported.push(decodeURIComponent(url.pathname));
        return { fetchUsage: () => snapshot };
      },
      nowMs: 1_700_000_000_000
    }
  );
  assert.ok(imported.some((filePath) => filePath.endsWith("claude-usage.mjs")));
  assert.doesNotMatch(plainText(rows[1]), /5h:|7d:|spend:/u);
  assert.match(plainText(rows[2]), /Claude \| Chat: 1\/4/u);
});

test("배열이 아닌 addon 설정은 안전하게 무시한다", async () => {
  const { renderStatusline } = await import("./statusline.mjs");
  const plainRows = await renderStatusline(
    {},
    { addons: "claude", branch: "" }
  );
  assert.equal(plainRows.length, 2);
  const nativeRows = await renderStatusline(
    { rate_limits: { five_hour: { used_percentage: 10 } } },
    { addons: 42, branch: "" }
  );
  assert.equal(nativeRows.length, 2);
});

test("credit 지표는 USD 금액과 일반 크레딧을 백분율 없이 표시한다", async () => {
  const { renderSnapshot } = await import("./statusline.mjs");
  const usdLine = renderSnapshot(
    { name: "Claude" },
    {
      groups: [
        {
          label: "Claude",
          metrics: [
            {
              currency: "USD",
              label: "credit",
              remaining: 12.5,
              type: "credit"
            }
          ]
        }
      ]
    }
  );
  assert.equal(plainText(usdLine), "Claude | credit: $12.50");
  const genericLine = renderSnapshot(
    { name: "ChatGPT" },
    {
      groups: [
        {
          label: "ChatGPT",
          metrics: [{ label: "credit", remaining: 2500, type: "credit" }]
        }
      ]
    }
  );
  assert.equal(plainText(genericLine), "ChatGPT | credit: 2500");
});

test("credit 지표는 showAbove 임계값에 숨겨지지 않는다", async () => {
  const { renderSnapshot } = await import("./statusline.mjs");
  const line = renderSnapshot(
    { name: "Claude", showAbove: 5 },
    {
      groups: [
        {
          label: "Claude",
          metrics: [
            { label: "5h", percentage: 2, type: "percentage" },
            { currency: "USD", label: "credit", remaining: 3, type: "credit" }
          ]
        }
      ]
    }
  );
  const plainLine = plainText(line);
  assert.doesNotMatch(plainLine, /5h:/u);
  assert.match(plainLine, /credit: \$3\.00/u);
});

test("제공자·그룹 제목은 굵게 표시하고 숨긴 제목에는 굵기를 넣지 않는다", async () => {
  const { renderSnapshot } = await import("./statusline.mjs");
  const labeled = renderSnapshot(
    { name: "Fallback" },
    {
      groups: [{ label: "ZAI", metrics: [{ label: "5h", percentage: 10 }] }]
    }
  );
  assert.ok(labeled.startsWith(`${BOLD}ZAI${RESET_CODE} | `));
  const fallback = renderSnapshot(
    { name: "Fallback" },
    {
      groups: [{ metrics: [{ label: "5h", percentage: 10 }] }]
    }
  );
  assert.ok(fallback.startsWith(`${BOLD}Fallback${RESET_CODE} | `));
  const hidden = renderSnapshot(
    { hideName: true, name: "Fallback" },
    {
      groups: [{ metrics: [{ label: "5h", percentage: 10 }] }]
    }
  );
  assert.ok(!hidden.includes(BOLD));
  assert.match(plainText(hidden), /5h: 10%/u);
});

test("hideLabels filters metric rows", async () => {
  const { renderSnapshot } = await import("./statusline.mjs");
  const line = renderSnapshot(addon, snapshot);
  assert.match(line, /Chat: /u);
  assert.match(line, /Completions: /u);
  assert.doesNotMatch(line, /Premium/u);
});

test("all metrics hidden yields no bare group", async () => {
  const { renderSnapshot } = await import("./statusline.mjs");
  const line = renderSnapshot(
    { hideLabels: ["Chat", "Completions", "Premium"] },
    snapshot
  );
  assert.equal(line, "");
});

test("no hideLabels keeps all metrics visible", async () => {
  const { renderSnapshot } = await import("./statusline.mjs");
  const line = renderSnapshot({}, snapshot);
  assert.match(line, /Premium: /u);
});

test("resolves large credential reference lists without stack overflow", async () => {
  const { renderAddons } = await import("./statusline.mjs");
  const credential = "{file:}".repeat(12_000);
  const rows = await renderAddons(
    [{ credential, name: "Test", script: "./glm-coding-plan.mjs" }],
    {
      importModule: () => ({
        fetchUsage: ({ credential: resolved }) =>
          resolved === credential ? snapshot : undefined
      })
    }
  );
  assert.equal(rows.length, 1);
});

test("public CLI resolves addon settings from the configured directory", async (t) => {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), "statusline-cli-"));
  t.after(() => rmSync(fixtureDir, { force: true, recursive: true }));
  const homeDir = path.join(fixtureDir, "home");
  const homeSettingsDir = path.join(homeDir, ".claude");
  const configDir = path.join(fixtureDir, "custom-config");
  const fallbackProjectDir = path.join(fixtureDir, "fallback-project");
  const projectDir = path.join(fixtureDir, "project");
  const projectSettingsDir = path.join(projectDir, ".claude");
  const emptyProjectDir = path.join(fixtureDir, "empty-project");
  const emptyProjectSettingsDir = path.join(emptyProjectDir, ".claude");
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
  writeFileSync(
    addonScript,
    `export const fetchUsage = async ({ credential }) => ({ groups: [{ label: credential, metrics: [{ label: "Probe", percentage: 10 }] }] });\n`
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
  const statuslinePath = fileURLToPath(
    new URL("statusline.mjs", import.meta.url)
  );
  const run = (workspaceProjectDir, environment = {}) => {
    const result = spawnSync(process.execPath, [statuslinePath], {
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
    return plainText(result.stdout);
  };
  await t.test(
    "uses nonempty CLAUDE_CONFIG_DIR when project settings omit addons",
    () => {
      const output = run(fallbackProjectDir, {
        CLAUDE_CONFIG_DIR: configDir,
        HOME: homeDir
      });
      assert.match(output, /CustomFixture \| Probe: 10%/u);
      assert.doesNotMatch(output, /HomeFixture/u);
    }
  );
  await t.test("empty CLAUDE_CONFIG_DIR falls back to HOME", () => {
    const output = run(fallbackProjectDir, {
      CLAUDE_CONFIG_DIR: "",
      HOME: homeDir
    });
    assert.match(output, /HomeFixture \| Probe: 10%/u);
    assert.doesNotMatch(output, /CustomFixture/u);
  });
  await t.test("unset CLAUDE_CONFIG_DIR falls back to HOME", () => {
    const output = run(fallbackProjectDir, { HOME: homeDir });
    assert.match(output, /HomeFixture \| Probe: 10%/u);
    assert.doesNotMatch(output, /CustomFixture/u);
  });
  await t.test(
    "project addon settings take priority over global settings",
    () => {
      const output = run(projectDir, {
        CLAUDE_CONFIG_DIR: configDir,
        HOME: homeDir
      });
      assert.match(output, /ProjectFixture \| Probe: 10%/u);
      assert.doesNotMatch(output, /HomeFixture|CustomFixture/u);
    }
  );
  await t.test("an empty project addon array disables global fallback", () => {
    const output = run(emptyProjectDir, {
      CLAUDE_CONFIG_DIR: configDir,
      HOME: homeDir
    });
    assert.doesNotMatch(output, /HomeFixture|CustomFixture/u);
  });
  await t.test("project addon settings work when HOME is unset", () => {
    const output = run(projectDir, { CLAUDE_CONFIG_DIR: configDir });
    assert.match(output, /ProjectFixture \| Probe: 10%/u);
  });
});
