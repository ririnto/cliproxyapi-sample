import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtempDisposable,
  readFile,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

await test("generates configs and rejects drift or invalid input", async () => {
  await using directory = await mkdtempDisposable(
    path.join(tmpdir(), "cliproxy-generate-")
  );
  const cwd = directory.path;
  await cp(new URL("../config/", import.meta.url), path.join(cwd, "config"), {
    recursive: true
  });
  await mkdir(path.join(cwd, ".codex"));
  const generator = fileURLToPath(
    new URL("../scripts/generate-config.mts", import.meta.url)
  );
  const run = (...args: string[]) =>
    execFileAsync(process.execPath, [generator, ...args], { cwd });
  const proxyConfig = path.join(cwd, "config.example.yaml");
  const clientCatalog = path.join(cwd, ".codex/model_catalog.json");
  const outputs = [proxyConfig, clientCatalog];
  const snapshot = () => Promise.all(outputs.map((file) => readFile(file)));

  await run();
  const first = await snapshot();
  await run("--check");
  await run();
  assert.deepEqual(await snapshot(), first);

  const stale = Buffer.from("stale\n");
  const checkDrift = async (file: string) => {
    const current = await readFile(file);
    await writeFile(file, stale);
    await assert.rejects(run("--check"), { code: 1, stderr: /is stale/ });
    assert.deepEqual(await readFile(file), stale);
    await writeFile(file, current);
  };
  await checkDrift(proxyConfig);
  await checkDrift(clientCatalog);

  await writeFile(
    path.join(cwd, "config/codex-models.json"),
    JSON.stringify({
      models: [
        { slug: "duplicate", context_window: 1 },
        { slug: "duplicate", context_window: 1 }
      ]
    })
  );
  await Promise.all(outputs.map((file) => writeFile(file, stale)));
  await assert.rejects(run(), { code: 1, stderr: /Duplicate catalog model/ });
  assert.deepEqual(await snapshot(), [stale, stale]);
});
