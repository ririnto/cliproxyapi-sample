import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtempDisposable,
  readFile,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

await test("the generated config check rejects a zai/ model alias", async () => {
  await using fixture = await mkdtempDisposable(
    path.join(tmpdir(), "proxy-config-")
  );
  await mkdir(path.join(fixture.path, ".codex"));
  await mkdir(path.join(fixture.path, "config"));
  await copyFile(
    ".codex/model_catalog.json",
    path.join(fixture.path, ".codex/model_catalog.json")
  );
  const model = "        - name: glm-5.4\n          alias: zai/test-glm\n";
  await Promise.all(
    [
      ["config/proxy.template.yaml", "        # @zai-models\n"],
      ["config.example.yaml", "        - name: glm-5.4\n          alias:"]
    ].map(async ([file, anchor]) => {
      const contents = await readFile(file, "utf-8");
      assert.ok(contents.includes(anchor), `Missing model rows in ${file}`);
      await writeFile(
        path.join(fixture.path, file),
        contents.replace(anchor, () => `${model}${anchor}`)
      );
    })
  );
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("generate-config.mts", import.meta.url)), "--check"],
    { cwd: fixture.path, encoding: "utf-8" }
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /Model alias "zai\/test-glm" cannot start with the "zai\/" prefix/u
  );
});
