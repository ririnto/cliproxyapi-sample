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
const upstreamFile = "config/proxy.upstream.yaml.txt";
const overridesFile = "config/proxy.overrides.yaml";
const configFile = "config.example.yaml";
const settingsFile = "config/models.yaml";
const upstreamCatalogFile = "config/codex.upstream.json";
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
    [
      ...files,
      settingsFile,
      upstreamFile,
      overridesFile,
      upstreamCatalogFile
    ].map(async (file) => {
      const destination = path.join(directory, file);
      await mkdir(path.dirname(destination), { recursive: true });
      const contents = await readFile(file, "utf-8");
      await writeFile(destination, edits[file]?.(contents) ?? contents);
    })
  );

const runGenerator = (cwd: string, ...args: readonly string[]) =>
  spawnSync(
    process.execPath,
    [fileURLToPath(new URL("generate-config.mts", import.meta.url)), ...args],
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
  const astraOverride = 293_000;
  await copyFixtureFiles(fixture.path, [], {
    [upstreamFile]: () => "stale: true\n",
    [overridesFile]: (contents) => {
      const overrides = parseDocument(contents);
      assert.ok(isSeq(overrides.contents));
      const astraEdit: unknown = overrides.contents.items.find(
        (entry: unknown) =>
          isMap(entry) && entry.get("after") === '      - name: "gpt-6.2-astra"'
      );
      assert.ok(isMap(astraEdit));
      astraEdit.set("content", `        max-context-length: ${astraOverride}`);
      return overrides.toString();
    },
    [settingsFile]: (contents) =>
      contents.replace(
        "display_name: GLM-5.4",
        "display_name: GLM-5.4\n          context_window: 400000"
      )
  });
  const upstream = await readFile(upstreamCatalogFile, "utf-8");
  const proxySource = await readFile(upstreamFile, "utf-8");
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
  return Promise.resolve(new Response(${JSON.stringify(upstream)}));
});`;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(preload)}`,
      fileURLToPath(new URL("generate-config.mts", import.meta.url))
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
    const expected = name === "gpt-6.2-astra" ? astraOverride : 292_000;
    const row: unknown = oauthSettings.items.find(
      (entry) => isMap(entry) && entry.get("name") === name
    );
    assert.ok(isMap(row), `Missing OAuth settings for ${name}`);
    assert.equal(row.get("max-context-length"), expected);
    assert.ok(
      proxy.includes(
        `      - name: "${name}"\n        # max-context-length: 272000\n        max-context-length: ${expected}\n`
      ),
      `Missing original context directly above the override for ${name}`
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
  assert.equal(
    await readFile(path.join(fixture.path, upstreamFile), "utf-8"),
    proxySource + upstreamNote
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
  const check = runGenerator(fixture.path, "--check");
  assert.equal(check.status, 0, check.stderr);
});

await test("the generated overrides change only the four targeted OAuth settings", async () => {
  await using fixture = await mkdtempDisposable(
    path.join(tmpdir(), "proxy-config-")
  );
  await copyFixtureFiles(fixture.path, [catalogFile, configFile]);
  const withOverrides = runGenerator(fixture.path, "--check");
  assert.equal(withOverrides.status, 0, withOverrides.stderr);

  const overridesPath = path.join(fixture.path, overridesFile);
  const overrides = parseDocument(await readFile(overridesPath, "utf-8"));
  assert.ok(isSeq(overrides.contents));
  overrides.contents.items = overrides.contents.items.filter(
    (entry: unknown) => !isMap(entry) || entry.get("after-generation") !== true
  );
  await writeFile(overridesPath, overrides.toString());

  const samplePath = path.join(fixture.path, configFile);
  let expected = await readFile(samplePath, "utf-8");
  for (const name of overriddenModels) {
    const row = `      - name: "${name}"\n`;
    const overridden = `${row}        # max-context-length: 272000\n        max-context-length: 292000\n`;
    assert.ok(expected.includes(overridden), `Missing override for ${name}`);
    expected = expected.replace(
      overridden,
      `${row}        max-context-length: 272000\n`
    );
  }
  await writeFile(samplePath, expected);
  const withoutOverrides = runGenerator(fixture.path, "--check");
  assert.equal(withoutOverrides.status, 0, withoutOverrides.stderr);
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
        [
          catalogFile,
          configFile,
          overridesFile,
          settingsFile,
          upstreamFile,
          upstreamCatalogFile
        ].map(async (name) => {
          const file = path.join(fixture.path, name);
          await utimes(file, 0, 0);
          const { mtimeMs } = await stat(file);
          return { contents: await readFile(file), file, mtimeMs };
        })
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

await test("the generated config check rejects a zai/ catalog slug", async () => {
  const id = "zai/review-probe";
  await assertGeneratedCheckRejects(
    {
      [upstreamCatalogFile]: (contents) => {
        const catalog: unknown = JSON.parse(contents);
        assert.ok(
          typeof catalog === "object" &&
            catalog !== null &&
            "models" in catalog &&
            Array.isArray(catalog.models)
        );
        const rows: readonly unknown[] = catalog.models;
        const [row] = rows;
        assert.ok(typeof row === "object" && row !== null);
        return JSON.stringify({
          ...catalog,
          models: [...rows, { ...row, slug: id }]
        });
      }
    },
    id,
    [/\bslug\b/u, ...prefixRule]
  );
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
  assert.equal(result.getIn(["models", 1, "context_window"]), 550_000);
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
  const check = runCatalog("--check");
  assert.equal(check.status, 0, check.stderr);
  const pathToOverrides = path.join(fixture.path, codexOverrides);
  const contents = await readFile(pathToOverrides, "utf-8");
  await writeFile(
    pathToOverrides,
    contents.replace("display_name: GLM-5.4", "display_name: Updated")
  );
  const stale = runCatalog("--check");
  assert.equal(stale.status, 1, stale.stderr);
  assert.match(stale.stderr, /model_catalog\.json/u);
});
