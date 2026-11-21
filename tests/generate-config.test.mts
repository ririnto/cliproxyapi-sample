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

import { isSeq, parseDocument } from "yaml";

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
    const [stderr] = await Promise.all([
      text(child.stderr),
      once(child, "close")
    ]);
    assert.equal(child.exitCode, expectedStatus, stderr);
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

  const catalogFile = path.join(cwd, "config/codex-models.json");
  const catalog: unknown = JSON.parse(await readFile(catalogFile, "utf-8"));
  assert.ok(
    typeof catalog === "object" && catalog !== null && "models" in catalog
  );
  assert.ok(Array.isArray(catalog.models));
  const catalogModels: unknown[] = catalog.models;
  const successors = [
    { slug: "gpt-6.10-sol", context_window: 23_000, visibility: "list" },
    { slug: "gpt-6.9-sol", context_window: 24_000, visibility: "list" },
    { slug: "gpt-99-sol", context_window: 25_000, visibility: "hide" },
    { slug: "gpt-99-astra-preview", context_window: 26_000, visibility: "list" }
  ];
  await writeFile(
    catalogFile,
    JSON.stringify({ models: [...catalogModels, ...successors] })
  );
  await run(0);
  const proxy = parseDocument(await readFile(proxyConfig, "utf-8"));
  const aliases = proxy.getIn(["oauth", "model-alias", "codex"]);
  assert.ok(isSeq(aliases));
  assert.deepEqual(aliases.toJSON(), [
    { name: "gpt-6.2-astra", alias: "gpt-6-astra", fork: true },
    { name: "gpt-6.10-sol", alias: "gpt-6.1-sol", fork: true },
    { name: "gpt-6.10-sol", alias: "gpt-6-sol" },
    { name: "gpt-6.10-sol", alias: "gpt-5.6-sol" },
    { name: "gpt-6.1-terra", alias: "gpt-5.6-terra", fork: true },
    { name: "gpt-6-luna", alias: "gpt-5.6-luna", fork: true }
  ]);
  const context = proxy.getIn(["oauth", "settings", "codex"]);
  assert.ok(isSeq(context));
  assert.ok(
    context
      .toJSON()
      .some(
        (model: unknown) =>
          typeof model === "object" &&
          model !== null &&
          "name" in model &&
          model.name === "gpt-6.10-sol" &&
          "max-context-length" in model &&
          model["max-context-length"] === 23_000
      )
  );
  await writeFile(
    catalogFile,
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
