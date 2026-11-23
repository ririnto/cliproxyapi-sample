import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  cp,
  mkdir,
  mkdtempDisposable,
  readdir,
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
  const configDir = path.join(cwd, "config");
  await mkdir(configDir);
  await mkdir(path.join(cwd, ".codex"));
  const clientCatalog = path.join(cwd, ".codex/model_catalog.json");
  await Promise.all([
    cp(
      new URL("../config/proxy.template.yaml", import.meta.url),
      path.join(configDir, "proxy.template.yaml")
    ),
    cp(new URL("../.codex/model_catalog.json", import.meta.url), clientCatalog)
  ]);
  const generator = fileURLToPath(
    new URL("../scripts/generate-config.mts", import.meta.url)
  );
  const run = async (
    expectedStatus: number,
    args: string[] = [],
    nodeArgs: string[] = []
  ) => {
    const child = spawn(process.execPath, [...nodeArgs, generator, ...args], {
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
  const snapshot = async () =>
    await Promise.all([readFile(proxyConfig), readFile(clientCatalog)]);

  await run(0);
  const first = await snapshot();
  await run(0, ["--check"]);
  await run(0);
  assert.deepEqual(await snapshot(), first);

  const stale = Buffer.from("stale\n");
  const checkDrift = async (file: string, replacement: Buffer) => {
    const current = await readFile(file);
    await writeFile(file, replacement);
    assert.match(await run(1, ["--check"]), /is stale/u);
    assert.deepEqual(await readFile(file), replacement);
    await writeFile(file, current);
  };
  await checkDrift(proxyConfig, stale);
  await checkDrift(
    clientCatalog,
    Buffer.from(
      first[1]
        .toString()
        .replace('"context_window": 292000', '"context_window": 400000')
    )
  );

  const catalog: unknown = JSON.parse(await readFile(clientCatalog, "utf-8"));
  assert.ok(
    typeof catalog === "object" && catalog !== null && "models" in catalog
  );
  assert.ok(Array.isArray(catalog.models));
  const catalogModels: unknown[] = catalog.models;
  const successors = [
    { slug: "gpt-6.10-sol", context_window: 400_000, visibility: "list" },
    { slug: "gpt-6.9-sol", context_window: 24_000, visibility: "list" },
    { slug: "gpt-99-sol", context_window: 25_000, visibility: "hide" },
    { slug: "gpt-99-astra-preview", context_window: 26_000, visibility: "list" }
  ];
  const sourceCatalog = JSON.stringify({
    models: [
      ...catalogModels.filter((model) => {
        assert.ok(
          typeof model === "object" && model !== null && "slug" in model
        );
        return (
          model.slug !== "zai-coding-plan/glm-5.4" &&
          model.slug !== "zhipuai-coding-plan/glm-5.4" &&
          model.slug !== "gpt-6.1-sol"
        );
      }),
      ...successors
    ]
  });
  const sourcePath = path.join(cwd, "upstream.json");
  await writeFile(sourcePath, sourceCatalog);
  await run(
    0,
    ["--refresh"],
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(
        'import { readFile } from "node:fs/promises"; globalThis.fetch = async () => new Response(await readFile("upstream.json"));'
      )}`
    ]
  );
  assert.equal(await readFile(sourcePath, "utf-8"), sourceCatalog);
  assert.deepEqual(await readdir(configDir), ["proxy.template.yaml"]);
  await run(0, ["--check"]);
  const proxy = parseDocument(await readFile(proxyConfig, "utf-8"));
  const aliases = proxy.getIn(["oauth", "model-alias", "codex"]);
  assert.ok(isSeq(aliases));
  assert.deepEqual(aliases.toJSON(), [
    { name: "gpt-6.2-astra", alias: "gpt-6-astra", fork: true },
    { name: "gpt-6.10-sol", alias: "gpt-5.6-sol" },
    { name: "gpt-6.10-sol", alias: "gpt-6-sol" },
    { name: "gpt-6.10-sol", alias: "gpt-6.1-sol", fork: true },
    { name: "gpt-6.10-sol", alias: "gpt-6.2-sol", fork: true },
    { name: "gpt-6.10-sol", alias: "gpt-6.9-sol", fork: true },
    { name: "gpt-6.1-terra", alias: "gpt-5.6-terra", fork: true },
    { name: "gpt-6-luna", alias: "gpt-5.6-luna", fork: true }
  ]);
  const context = proxy.getIn(["oauth", "settings", "codex"]);
  assert.ok(isSeq(context));
  assert.partialDeepStrictEqual(context.toJSON(), [
    { name: "gpt-6.2-astra", "max-context-length": 272_000 },
    { name: "gpt-6.10-sol", "max-context-length": 292_000 }
  ]);
  const refreshedCatalog = await readFile(clientCatalog, "utf-8");
  assert.doesNotMatch(refreshedCatalog, /"slug": "(?:[^"]+\/)?glm-5\.3[^"]*"/u);
  assert.partialDeepStrictEqual(JSON.parse(refreshedCatalog), {
    models: [
      {
        slug: "gpt-6.2-sol",
        visibility: "hide",
        supported_reasoning_levels: [{ effort: "ultra" }]
      },
      { slug: "gpt-6.10-sol", context_window: 292_000 },
      { slug: "gpt-6.1-sol", visibility: "hide" },
      {
        slug: "zai-coding-plan/glm-5.4",
        context_window: 292_000,
        max_context_window: 292_000,
        visibility: "list",
        input_modalities: ["text", "image"],
        supported_reasoning_levels: [
          { effort: "low" },
          { effort: "high" },
          { effort: "max" }
        ]
      },
      {
        slug: "zhipuai-coding-plan/glm-5.4",
        context_window: 292_000,
        max_context_window: 292_000,
        visibility: "list",
        input_modalities: ["text", "image"],
        supported_reasoning_levels: [
          { effort: "low" },
          { effort: "high" },
          { effort: "max" }
        ]
      }
    ]
  });
  const duplicateCatalog = Buffer.from(
    JSON.stringify({
      models: [
        { slug: "duplicate", context_window: 1 },
        { slug: "duplicate", context_window: 1 }
      ]
    })
  );
  await Promise.all([
    writeFile(proxyConfig, stale),
    writeFile(clientCatalog, duplicateCatalog)
  ]);
  assert.match(await run(1), /Duplicate catalog model/u);
  assert.deepEqual(await snapshot(), [stale, duplicateCatalog]);
});
