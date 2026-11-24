import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtempDisposable,
  readFile,
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
const settingsFile = "config/models.json";

type FixtureEdits = Readonly<
  Partial<Record<string, (contents: string) => string>>
>;

const copyFixtureFiles = async (
  directory: string,
  files: readonly string[],
  edits: FixtureEdits = {}
) =>
  await Promise.all(
    [...files, settingsFile, upstreamFile, overridesFile].map(async (file) => {
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

await test("generation applies local settings to the official catalog and proxy example", async () => {
  await using fixture = await mkdtempDisposable(
    path.join(tmpdir(), "proxy-config-")
  );
  await copyFixtureFiles(fixture.path, [catalogFile], {
    [upstreamFile]: () => "stale: true\n",
    [catalogFile]: () =>
      JSON.stringify({
        sourceVisibility: { "gpt-6.2-sol": "hide" },
        models: [{ slug: "old-local-model", context_window: 100_000 }]
      }),
    [settingsFile]: () =>
      JSON.stringify({
        finalModels: [
          "gpt-6.2-sol",
          "gpt-6.2-astra",
          "glm-5.4",
          "glm-5.3-flash"
        ],
        codex: {
          "gpt-5.5": { visibility: "hide" },
          "gpt-6.2-sol": {
            context_window: 292_000,
            supports_search_tool: false,
            local_only: true
          },
          "gpt-6.1-sol": { visibility: "list" },
          "claude-opus-5": { display_name: "Claude Opus 5" }
        },
        zai: {
          "glm-5.4": { display_name: "GLM-5.4", local_only: true },
          "glm-5.3-flash": { display_name: "GLM-5.3-Flash" }
        }
      })
  });
  const first = {
    slug: "gpt-6.2-sol",
    visibility: "list",
    context_window: 500_000,
    display_name: "Original",
    supported_reasoning_levels: [{ effort: "low", description: "Low" }],
    supports_search_tool: true,
    upstream_only: { retained: true }
  };
  const upstream = {
    models: [
      first,
      { ...first, slug: "gpt-6.1-sol", visibility: "hide" },
      { ...first, slug: "gpt-7-sol" },
      { ...first, slug: "gpt-6.2-astra", visibility: "hide" },
      { ...first, slug: "gpt-5.5" },
      { ...first, slug: "codex-auto-review", visibility: "hide" },
      { ...first, slug: "glm-5.3" },
      { ...first, slug: "glm-5.2-flash" },
      { slug: "claude-sonnet-5", context_window: 200_000, visibility: "none" },
      {
        ...first,
        slug: "upstream-search-disabled",
        supports_search_tool: false
      }
    ]
  };
  const proxySource = await readFile(upstreamFile, "utf-8");
  const upstreamNote = "# An upstream example comment\n";
  await writeFile(
    path.join(fixture.path, "upstream.yaml"),
    proxySource + upstreamNote
  );
  const preload = `import { readFileSync } from "node:fs";
import { mock } from "node:test";
mock.method(globalThis, "fetch", (url) => {
  if (url === "https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/85225381d89915595598ed13766cd79890c03a84/config.example.yaml") {
    return Promise.resolve(new Response(readFileSync("upstream.yaml", "utf-8")));
  }
  if (url !== "https://raw.githubusercontent.com/openai/codex/refs/heads/main/codex-rs/models-manager/models.json") {
    throw new Error("Unexpected catalog URL: " + url);
  }
  return Promise.resolve(Response.json(${JSON.stringify(upstream)}));
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
  const actual: unknown = JSON.parse(
    await readFile(path.join(fixture.path, catalogFile), "utf-8")
  );
  assert.deepEqual(actual, {
    models: [
      { ...first, context_window: 292_000, supports_search_tool: false },
      { ...first, slug: "gpt-6.1-sol" },
      { ...first, slug: "gpt-7-sol", visibility: "hide" },
      { ...first, slug: "gpt-6.2-astra", visibility: "hide" },
      { ...first, slug: "gpt-5.5", visibility: "hide" },
      { ...first, slug: "codex-auto-review", visibility: "hide" },
      { ...first, slug: "glm-5.3", visibility: "hide" },
      { ...first, slug: "glm-5.2-flash", visibility: "hide" },
      {
        slug: "claude-sonnet-5",
        context_window: 200_000,
        visibility: "none",
        supports_search_tool: true
      },
      {
        ...first,
        slug: "upstream-search-disabled",
        supports_search_tool: false
      },
      { ...first, slug: "claude-opus-5", display_name: "Claude Opus 5" },
      { ...first, slug: "glm-5.4", display_name: "GLM-5.4" },
      { ...first, slug: "glm-5.3-flash", display_name: "GLM-5.3-Flash" }
    ]
  });
  const proxy = await readFile(path.join(fixture.path, configFile), "utf-8");
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
  assert.ok(proxy.endsWith(upstreamNote));
  const check = runGenerator(fixture.path, "--check");
  assert.equal(check.status, 0, check.stderr);
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
      [catalogFile]: (contents) => {
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

await test("the generated check rejects a stale catalog override", async () => {
  await assertGeneratedCheckRejects(
    {
      [settingsFile]: (contents) =>
        contents.replace('"visibility": "hide"', '"visibility": "none"')
    },
    catalogFile,
    [/stale/u]
  );
});
