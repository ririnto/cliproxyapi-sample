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
const templateFile = "config/proxy.template.yaml";
const configFile = "config.example.yaml";
const settingsFile = "config/models.json";
const referenceFile = "config/models.dev.json";

type FixtureEdits = Readonly<
  Partial<Record<string, (contents: string) => string>>
>;

const copyFixtureFiles = async (
  directory: string,
  files: readonly string[],
  edits: FixtureEdits = {}
) =>
  await Promise.all(
    [...files, settingsFile, referenceFile].map(async (file) => {
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
  await copyFixtureFiles(
    fixture.path,
    [catalogFile, templateFile, configFile],
    edits
  );
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
      [templateFile]: insertModel("        # @zai-models\n"),
      [configFile]: insertModel("        - name: glm-5.4\n          alias:")
    },
    id,
    [/\balias\b/u, ...prefixRule]
  );
});

await test("generated GLM rules remap only unsupported Claude effort levels", async () => {
  await using fixture = await mkdtempDisposable(
    path.join(tmpdir(), "proxy-config-")
  );
  await copyFixtureFiles(fixture.path, [catalogFile, templateFile]);
  const result = runGenerator(fixture.path);
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

await test("the generated check rejects a hand-set reference field", async () => {
  await assertGeneratedCheckRejects(
    {
      [settingsFile]: (contents) =>
        contents.replace(
          '"glm-5.4": {}',
          '"glm-5.4": { "max_context_window": 1000000 }'
        )
    },
    "glm-5.4",
    [
      /\bmax_context_window\b/u,
      /\bhand[- ]set\b/u,
      /\bconflict\w*\b/u,
      /\bmodels\.dev\b/u
    ]
  );
});

await test("the generated check rejects a mismatched reference value", async () => {
  await assertGeneratedCheckRejects(
    {
      [catalogFile]: (contents) =>
        contents.replace(
          '"max_context_window": 1050000',
          '"max_context_window": 1049999'
        )
    },
    "gpt-5.5",
    [
      /\bmax_context_window\b/u,
      /\b(?:differs?|mismatch)\b/u,
      /\bmodels\.dev\b/u
    ]
  );
});

const referenceConflict = [/\bconflict\w*\b/u, /\bmodels\.dev\b/u];
await Promise.all(
  (
    [
      ["description", "Local GLM description", referenceConflict],
      ["input_modalities", ["text"], referenceConflict],
      ["supported_reasoning_levels", [], referenceConflict],
      ["cost", {}, referenceConflict],
      ["misspelled_setting", true, [/\bunknown\b/u]]
    ] as const
  ).map(async ([field, value, diagnostic]) => {
    await test(`the generated check rejects a hand-set ${field}`, async () => {
      await assertGeneratedCheckRejects(
        {
          [settingsFile]: (contents) =>
            contents.replace(
              '"glm-5.4": {}',
              () => `"glm-5.4": ${JSON.stringify({ [field]: value })}`
            )
        },
        "glm-5.4",
        [new RegExp(`\\b${field}\\b`, "u"), ...diagnostic]
      );
    });
  })
);

await test("generation derives the Codex metadata supported by the reference", async () => {
  await using fixture = await mkdtempDisposable(
    path.join(tmpdir(), "proxy-config-")
  );
  const referenceModel = ["openai", "models", "gpt-5.5"];
  await copyFixtureFiles(fixture.path, [catalogFile, templateFile], {
    [referenceFile]: (contents) => {
      const reference = parseDocument(contents);
      reference.setIn(
        [...referenceModel, "description"],
        "Reference description"
      );
      reference.setIn(
        [...referenceModel, "modalities", "input"],
        ["text", "audio", "video", "pdf"]
      );
      reference.setIn(
        [...referenceModel, "reasoning_options", 0, "values"],
        ["none", "minimal", "low", "medium", "high"]
      );
      const edited: unknown = reference.toJSON();
      return JSON.stringify(edited);
    }
  });
  const result = runGenerator(fixture.path);
  assert.equal(result.status, 0, result.stderr);
  const [catalog, reference] = await Promise.all(
    [catalogFile, referenceFile].map(async (file) =>
      parseDocument(await readFile(path.join(fixture.path, file), "utf-8"))
    )
  );
  const models: unknown = catalog.get("models");
  assert.ok(isSeq(models));
  const gpt: unknown = models.items.find(
    (item) => isMap(item) && item.get("slug") === "gpt-5.5"
  );
  assert.ok(isMap(gpt));
  assert.equal(
    gpt.get("description"),
    reference.getIn([...referenceModel, "description"])
  );
  const modalities: unknown = gpt.get("input_modalities");
  assert.ok(isSeq(modalities));
  assert.deepEqual(modalities.toJSON(), ["text", "audio"]);
  const levels: unknown = gpt.get("supported_reasoning_levels");
  assert.ok(isSeq(levels));
  assert.deepEqual(
    levels.items.map((level) => isMap(level) && level.get("effort")),
    ["none", "minimal", "low", "medium", "high"]
  );
  assert.equal(gpt.get("context_window"), 292_000);
  assert.equal(gpt.get("max_context_window"), 1_050_000);
});
