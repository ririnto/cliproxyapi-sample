import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  cp,
  mkdir,
  mkdtempDisposable,
  readFile,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { text } from "node:stream/consumers";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
  const run = async (expectedStatus: number, ...args: string[]) => {
    const child = spawn(process.execPath, [generator, ...args], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"]
    });
    const [stderr, result] = await Promise.all([
      text(child.stderr),
      once(child, "close")
    ]);
    const [status]: unknown[] = result;
    assert.equal(status, expectedStatus, stderr);
    return stderr;
  };
  const proxyConfig = path.join(cwd, "config.example.yaml");
  const clientCatalog = path.join(cwd, ".codex/model_catalog.json");
  const snapshot = async () =>
    await Promise.all([readFile(proxyConfig), readFile(clientCatalog)]);

  await run(0);
  const first = await snapshot();
  await run(0, "--check");
  await run(0);
  assert.deepEqual(await snapshot(), first);

  const stale = Buffer.from("stale\n");
  const checkDrift = async (file: string) => {
    const current = await readFile(file);
    await writeFile(file, stale);
    assert.match(await run(1, "--check"), /is stale/u);
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
  await Promise.all([
    writeFile(proxyConfig, stale),
    writeFile(clientCatalog, stale)
  ]);
  assert.match(await run(1), /Duplicate catalog model/u);
  assert.deepEqual(await snapshot(), [stale, stale]);
});
