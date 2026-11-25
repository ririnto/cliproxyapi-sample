import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtempDisposable,
  readdir,
  readFile,
  stat,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { isMap, isSeq, parseDocument } from "yaml";

const catalogFile = ".codex/model_catalog.json";
const overridesFile = "cliproxyapi/config.overrides.yaml";
const configFile = "config.example.yaml";
const settingsFile = "cliproxyapi/models.yaml";
const codexOverrides = ".codex/model_catalog.override.yaml";
const catalogGenerator = "scripts/update-model-catalog.mjs";
const overriddenModels = [
  "gpt-6.2-astra",
  "gpt-6-astra",
  "gpt-6-luna",
  "gpt-5.6-luna"
] as const;

type FixtureEdits = Readonly<
  Partial<Record<string, (contents: string) => string>>
>;

const copyFixtureFiles = async (
  directory: string,
  files: readonly string[],
  edits: FixtureEdits = {}
) =>
  await Promise.all(
    [...files, settingsFile, overridesFile].map(async (file) => {
      const destination = path.join(directory, file);
      await mkdir(path.dirname(destination), { recursive: true });
      const contents = await readFile(file, "utf-8");
      await writeFile(destination, edits[file]?.(contents) ?? contents);
    })
  );

const runGenerator = (cwd: string, ...args: readonly string[]) =>
  spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../cliproxyapi/generate-config.mjs", import.meta.url)
      ),
      ...args
    ],
    { cwd, encoding: "utf-8" }
  );

const assertGeneratedCheckRejects = async (
  edits: FixtureEdits,
  id: string,
  expected: readonly RegExp[]
) => {
  await using fixture = await mkdtempDisposable(
    path.join(tmpdir(), "proxy-config-")
  );
  await copyFixtureFiles(fixture.path, [catalogFile, configFile], edits);
  const result = runGenerator(fixture.path, "--check");
  assert.equal(result.status, 1, result.stderr);
  const diagnostic = result.stderr
    .split("\n")
    .find((line) => line.includes(id));
  assert.ok(diagnostic !== undefined, result.stderr);
  for (const pattern of expected) {
    assert.match(diagnostic, pattern);
  }
};

const loadSource = async (url: string) => {
  const response = await fetch(url);
  assert.ok(response.ok, `Failed to load ${url}`);
  return await response.text();
};

const prefixRule = [/\bprefix\b/u, /["'`]zai\/["'`]/u];

await test("the generated config check rejects a zai/ model alias", async () => {
  const id = "zai/test-glm";
  const model = `        - name: glm-5.4\n          alias: ${id}\n`;
  const insertModel = (anchor: string) => (contents: string) => {
    assert.ok(contents.includes(anchor), `Missing model rows at ${anchor}`);
    return contents.replace(anchor, () => `${model}${anchor}`);
  };
  await assertGeneratedCheckRejects(
    {
      [configFile]: insertModel("        - name: glm-5.4\n          alias:")
    },
    id,
    [/\balias\b/u, ...prefixRule]
  );
});

await test("the generated check rejects violations of the GLM route rules", async () => {
  await Promise.all(
    (
      [
        [
          "base-url: https://api.z.ai/api/anthropic",
          "base-url: https://api.z.ai/api/paas/v4",
          "zai base-url",
          /expected the direct Claude endpoint/u
        ],
        [
          "alias: glm-5.4",
          "alias: glm",
          "zai glm-5.4 alias",
          /expected the bare model name/u
        ],
        [
          "max-context-length: 292000\n          is-compat: true",
          `max-context-length: \${GLM_CONTEXT}\n          is-compat: true`,
          "zai glm-5.4",
          /cannot use environment placeholders/u
        ]
      ] as const
    ).map(async ([source, replacement, id, diagnostic]) => {
      await assertGeneratedCheckRejects(
        {
          [configFile]: (contents) =>
            contents.replace(source, () => replacement)
        },
        id,
        [diagnostic]
      );
    })
  );
});

await test("proxy generation reads the two upstream sources without the local Codex catalog", async () => {
  await using fixture = await mkdtempDisposable(
    path.join(tmpdir(), "proxy-config-")
  );
  await copyFixtureFiles(fixture.path, [], {
    [settingsFile]: (contents) =>
      contents.replace(
        "display_name: GLM-5.4",
        "display_name: GLM-5.4\n          context_window: 400000"
      )
  });
  const [proxySource, upstream] = await Promise.all([
    loadSource(
      "https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/refs/heads/main/config.example.yaml"
    ),
    loadSource(
      "https://raw.githubusercontent.com/openai/codex/refs/heads/main/codex-rs/models-manager/models.json"
    )
  ]);
  await writeFile(path.join(fixture.path, "source.json"), upstream);
  const upstreamNote = "# An upstream example comment\n";
  await writeFile(
    path.join(fixture.path, "upstream.yaml"),
    proxySource + upstreamNote
  );
  const preload = `import { readFileSync } from "node:fs";
import { mock } from "node:test";
mock.method(globalThis, "fetch", (url) => {
  if (url === "https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/refs/heads/main/config.example.yaml") {
    return Promise.resolve(new Response(readFileSync("upstream.yaml", "utf-8")));
  }
  if (url !== "https://raw.githubusercontent.com/openai/codex/refs/heads/main/codex-rs/models-manager/models.json") {
    throw new Error("Unexpected catalog URL: " + url);
  }
  return Promise.resolve(new Response(readFileSync("source.json", "utf-8")));
});`;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(preload)}`,
      fileURLToPath(
        new URL("../cliproxyapi/generate-config.mjs", import.meta.url)
      )
    ],
    { cwd: fixture.path, encoding: "utf-8" }
  );
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(readFile(path.join(fixture.path, catalogFile)), {
    code: "ENOENT"
  });
  const proxy = await readFile(path.join(fixture.path, configFile), "utf-8");
  const proxyDocument = parseDocument(proxy);
  assert.equal(proxyDocument.getIn(["models", "codex-catalog"]), "");
  assert.equal(
    proxyDocument.getIn([
      "api-keys",
      "claude",
      0,
      "models",
      0,
      "max-context-length"
    ]),
    400_000
  );
  assert.equal(
    proxyDocument.getIn([
      "api-keys",
      "claude",
      0,
      "models",
      1,
      "max-context-length"
    ]),
    292_000
  );
  const oauthSettings: unknown = proxyDocument.getIn([
    "oauth",
    "settings",
    "codex"
  ]);
  assert.ok(isSeq(oauthSettings));
  for (const name of overriddenModels) {
    const row: unknown = oauthSettings.items.find(
      (entry) => isMap(entry) && entry.get("name") === name
    );
    assert.ok(isMap(row), `Missing OAuth settings for ${name}`);
    assert.equal(row.get("max-context-length"), 292_000);
  }
  for (const name of ["codex-auto-review", "gpt-5.5"]) {
    assert.ok(
      !oauthSettings.items.some(
        (entry) => isMap(entry) && entry.get("name") === name
      )
    );
  }
  const filters: unknown = proxyDocument.getIn([
    "requests",
    "payload",
    "filter"
  ]);
  assert.ok(isSeq(filters));
  assert.ok(
    filters.items.some(
      (filter) =>
        isMap(filter) && filter.getIn(["models", 0, "name"]) === "gpt-*"
    )
  );
  assert.ok(proxy.includes('  # host: ""\n  host: "127.0.0.1"\n'));
  assert.ok(
    proxy.includes(
      '  # api-keys:\n  #   - "your-api-key-1"\n  #   - "your-api-key-2"\n  #   - "your-api-key-3"\n  api-keys: []\n'
    )
  );
  assert.ok(
    proxy.includes(
      `  #         - 'input.#(type=="additional_tools")#.tools.#(name=="functions")#.tools.#(name=="apply_patch")#'\n  payload:\n`
    ),
    "Expected requests.payload immediately after the upstream payload example"
  );
  assert.ok(
    proxy.includes(
      '#         - name: "kimi-k2.5"\n#           alias: "claude-opus-4.66"\napi-keys:\n'
    ),
    "Expected top-level api-keys immediately after the upstream API key examples"
  );
  assert.ok(proxy.endsWith(upstreamNote));
});

await test("the generated check rejects stale or unformatted samples without changing files", async () => {
  const original = await readFile(configFile, "utf-8");
  const samples = [
    original.replace('  host: "127.0.0.1"\n', '  host: "0.0.0.0"\n'),
    original.replaceAll("\n", "\r\n")
  ];
  await Promise.all(
    samples.map(async (sample) => {
      assert.notEqual(sample, original);
      await using fixture = await mkdtempDisposable(
        path.join(tmpdir(), "proxy-config-")
      );
      await copyFixtureFiles(fixture.path, [catalogFile, configFile], {
        [configFile]: () => sample
      });
      const entries = await readdir(fixture.path, { recursive: true });
      const files = await Promise.all(
        [catalogFile, configFile, overridesFile, settingsFile].map(
          async (name) => {
            const file = path.join(fixture.path, name);
            await utimes(file, 0, 0);
            const { mtimeMs } = await stat(file);
            return { contents: await readFile(file), file, mtimeMs };
          }
        )
      );

      const result = runGenerator(fixture.path, "--check");
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /config\.example\.yaml is stale/u);
      const remaining = await readdir(fixture.path, { recursive: true });
      assert.deepEqual(remaining.toSorted(), entries.toSorted());
      await Promise.all(
        files.map(async ({ contents, file, mtimeMs }) => {
          assert.deepEqual(await readFile(file), contents, file);
          const current = await stat(file);
          assert.equal(current.mtimeMs, mtimeMs, file);
        })
      );
    })
  );
});

await test("generated GLM rules remap only unsupported Claude effort levels", async () => {
  await using fixture = await mkdtempDisposable(
    path.join(tmpdir(), "proxy-config-")
  );
  await copyFixtureFiles(fixture.path, [catalogFile, configFile]);
  const result = runGenerator(fixture.path, "--check");
  assert.equal(result.status, 0, result.stderr);
  const [config, catalog] = await Promise.all(
    [configFile, catalogFile].map(async (file) =>
      parseDocument(await readFile(path.join(fixture.path, file), "utf-8"))
    )
  );
  const overrides: unknown = config.getIn(["requests", "payload", "override"]);
  const catalogModels: unknown = catalog.get("models");
  assert.ok(isSeq(overrides) && isSeq(catalogModels));
  const effortField = "output_config.effort";
  for (const name of ["glm-5.4", "glm-5.3-flash"]) {
    const model: unknown = catalogModels.items.find(
      (item) => isMap(item) && item.get("slug") === name
    );
    assert.ok(isMap(model), `Missing catalog model ${name}`);
    const levels: unknown = model.get("supported_reasoning_levels");
    assert.ok(isSeq(levels));
    assert.deepEqual(
      new Set(levels.items.map((level) => isMap(level) && level.get("effort"))),
      new Set(["low", "high", "max"]),
      `Changed supported effort levels for ${name}`
    );
    const rules: { selector: unknown; effort: unknown }[] =
      overrides.items.flatMap((rule) => {
        assert.ok(isMap(rule));
        const selectors = rule.get("models");
        assert.ok(isSeq(selectors));
        return selectors.items.flatMap((selector) => {
          if (isMap(selector) && selector.get("name") === name) {
            const parsedSelector: unknown = selector.toJSON();
            const effort: unknown = rule.getIn(["params", effortField]);
            return [{ selector: parsedSelector, effort }];
          }
          return [];
        });
      });
    assert.deepEqual(
      new Set(rules),
      new Set(
        [
          ["medium", "high"],
          ["xhigh", "max"]
        ].map(([requested, effort]) => ({
          selector: {
            name,
            protocol: "claude",
            match: [{ [effortField]: requested }]
          },
          effort
        }))
      ),
      `Changed Claude effort overrides for ${name}`
    );
  }
});

await test("proxy generation rejects a prefixed upstream model ID", async () => {
  await using fixture = await mkdtempDisposable(
    path.join(tmpdir(), "proxy-config-")
  );
  await copyFixtureFiles(fixture.path, []);
  const file = path.join(fixture.path, "bad-source.json");
  await writeFile(
    file,
    JSON.stringify({ models: [{ slug: "zai/review-probe" }] })
  );
  const result = runGenerator(fixture.path, file, "--check");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /zai\/review-probe/u);
});

await test("Codex refresh reads its own overrides and does not need the proxy files", async () => {
  await using fixture = await mkdtempDisposable(
    path.join(tmpdir(), "codex-catalog-")
  );
  await Promise.all(
    [codexOverrides, catalogGenerator].map(async (file) => {
      const target = path.join(fixture.path, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await readFile(file));
    })
  );
  await symlink(
    path.resolve("node_modules"),
    path.join(fixture.path, "node_modules"),
    "dir"
  );
  await writeFile(
    path.join(fixture.path, "package.json"),
    await readFile("package.json")
  );
  await writeFile(
    path.join(fixture.path, "oxfmt.config.ts"),
    await readFile("oxfmt.config.ts")
  );
  const input = {
    models: [
      {
        slug: "gpt-6.10.2-test",
        context_window: 500_000,
        priority: 3,
        visibility: "list",
        available_in_plans: ["paid"],
        service_tiers: ["fast"],
        additional_speed_tiers: ["fast"],
        experimental_supported_tools: ["test"]
      },
      {
        slug: "gpt-6.10.11-test",
        context_window: 550_000,
        priority: 4,
        visibility: "list"
      }
    ]
  };
  await writeFile(
    path.join(fixture.path, "upstream.json"),
    JSON.stringify(input)
  );
  const runCatalog = (...args: readonly string[]) =>
    spawnSync(process.execPath, [catalogGenerator, ...args], {
      cwd: fixture.path,
      encoding: "utf-8"
    });
  const refresh = runCatalog("upstream.json");
  assert.equal(refresh.status, 0, refresh.stderr);
  const result = parseDocument(
    await readFile(path.join(fixture.path, catalogFile), "utf-8")
  );
  assert.equal(result.getIn(["models", 0, "visibility"]), "hide");
  assert.equal(result.getIn(["models", 1, "visibility"]), "list");
  assert.equal(result.getIn(["models", 1, "context_window"]), 292_000);
  for (const [index, slug] of ["glm-5.4", "glm-5.3-flash"].entries()) {
    assert.equal(result.getIn(["models", index + 2, "slug"]), slug);
    assert.equal(result.getIn(["models", index + 2, "priority"]), index + 5);
    for (const field of [
      "available_in_plans",
      "service_tiers",
      "additional_speed_tiers",
      "experimental_supported_tools"
    ]) {
      const values: unknown = result.getIn(["models", index + 2, field], true);
      assert.ok(isSeq(values));
      assert.deepEqual(values.items, []);
    }
  }
  const check = runCatalog("upstream.json", "--check");
  assert.equal(check.status, 0, check.stderr);
  const pathToOverrides = path.join(fixture.path, codexOverrides);
  const contents = await readFile(pathToOverrides, "utf-8");
  await writeFile(
    pathToOverrides,
    contents.replace("display_name: GLM-5.4", "display_name: Updated")
  );
  const stale = runCatalog("upstream.json", "--check");
  assert.equal(stale.status, 1, stale.stderr);
  assert.match(stale.stderr, /model_catalog\.json/u);
});
