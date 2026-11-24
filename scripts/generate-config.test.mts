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

const catalogFile = ".codex/model_catalog.json";
const templateFile = "config/proxy.template.yaml";
const configFile = "config.example.yaml";

const assertGeneratedCheckRejects = async (
  id: string,
  edits: Readonly<Partial<Record<string, (contents: string) => string>>>
) => {
  await using fixture = await mkdtempDisposable(
    path.join(tmpdir(), "proxy-config-")
  );
  await Promise.all(
    [catalogFile, templateFile, configFile].map(async (file) => {
      const destination = path.join(fixture.path, file);
      await mkdir(path.dirname(destination), { recursive: true });
      const contents = await readFile(file, "utf-8");
      await writeFile(destination, edits[file]?.(contents) ?? contents);
    })
  );
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("generate-config.mts", import.meta.url)), "--check"],
    { cwd: fixture.path, encoding: "utf-8" }
  );
  assert.equal(result.status, 1, result.stderr);
  const diagnostic = result.stderr
    .split("\n")
    .find((line) => line.includes(id));
  assert.ok(diagnostic !== undefined, result.stderr);
  assert.match(diagnostic, /\bprefix\b/u);
  assert.match(diagnostic, /["'`]zai\/["'`]/u);
};

await test("the generated config check rejects a zai/ model alias", async () => {
  const id = "zai/test-glm";
  const model = `        - name: glm-5.4\n          alias: ${id}\n`;
  const insertModel = (anchor: string) => (contents: string) => {
    assert.ok(contents.includes(anchor), `Missing model rows at ${anchor}`);
    return contents.replace(anchor, () => `${model}${anchor}`);
  };
  await assertGeneratedCheckRejects(id, {
    [templateFile]: insertModel("        # @zai-models\n"),
    [configFile]: insertModel("        - name: glm-5.4\n          alias:")
  });
});

await test("the generated config check rejects a zai/ catalog slug", async () => {
  const id = "zai/review-probe";
  await assertGeneratedCheckRejects(id, {
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
  });
});
