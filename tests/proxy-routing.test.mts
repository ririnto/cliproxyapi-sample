import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtempDisposable,
  readFile,
  writeFile
} from "node:fs/promises";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { json } from "node:stream/consumers";
import test from "node:test";

import { isMap, isSeq, parseDocument } from "yaml";

const listen = async (server: Server) => {
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return address.port;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

await test("CLIProxyAPI routes the sample models", async (t) => {
  await using directory = await mkdtempDisposable(
    path.join(tmpdir(), "cliproxy-routing-")
  );
  const home = directory.path;
  const requests = new Map<string, unknown>();
  await using upstream = createServer((request, response) => {
    void json(request).then((body: unknown) => {
      const id = `resp_${requests.size}`;
      requests.set(id, { path: request.url, body });
      response.writeHead(200, { "content-type": "text/event-stream" });
      const completed = {
        type: "response.completed",
        response: { id, status: "completed", output: [] }
      };
      return response.end(`data: ${JSON.stringify(completed)}\n\n`);
    });
  });
  const upstreamPort = await listen(upstream);
  const config = parseDocument(
    await readFile(new URL("../config.example.yaml", import.meta.url), "utf-8")
  );
  const authDir = path.join(home, "auth");
  await mkdir(authDir);
  await writeFile(
    path.join(authDir, "codex.json"),
    JSON.stringify({
      type: "codex",
      plan_type: "pro",
      access_token: "synthetic",
      prefix: "chatgpt",
      proxy_url: "http://127.0.0.1:1"
    })
  );
  const listener = createServer();
  const port = await listen(listener);
  await listener[Symbol.asyncDispose]();
  config.setIn(["server", "host"], "127.0.0.1");
  config.setIn(["server", "port"], port);
  config.setIn(["oauth", "auth-dir"], authDir);
  config.setIn(["models", "codex-catalog"], "");
  config.setIn(["management", "disable-control-panel"], true);
  const codexKeys = config.getIn(["api-keys", "codex"]);
  assert.ok(isSeq(codexKeys));
  const zai = codexKeys.items.find(
    (group) => isMap(group) && group.get("name") === "zai"
  );
  assert.ok(isMap(zai));
  zai.set("base-url", `http://127.0.0.1:${upstreamPort}`);
  await writeFile(path.join(home, "config.yaml"), config.toString());
  const proxy = spawn(
    process.env.CLIPROXYAPI_TEST_BINARY ?? "cliproxyapi",
    ["--local-model", "--config", "config.yaml"],
    {
      cwd: home,
      env: { HOME: home, PATH: process.env.PATH },
      stdio: "ignore"
    }
  );
  await once(proxy, "spawn");
  const exited = once(proxy, "exit");
  try {
    const url = `http://127.0.0.1:${port}/v1`;
    const models = await t.waitFor(
      async () => {
        assert.equal(proxy.exitCode, null, "proxy exited during startup");
        const response = await fetch(`${url}/models?client_version=0.170.0`, {
          signal: AbortSignal.timeout(1000)
        });
        assert.equal(response.status, 200);
        const payload: unknown = await response.json();
        assert.ok(isRecord(payload) && Array.isArray(payload.models));
        const entries: unknown[] = payload.models;
        const capabilities = new Map<string, Record<string, unknown>>();
        for (const model of entries) {
          assert.ok(isRecord(model) && typeof model.slug === "string");
          const {
            context_window,
            input_modalities,
            service_tiers,
            supported_reasoning_levels
          } = model;
          capabilities.set(model.slug, {
            context_window,
            input_modalities,
            service_tiers,
            supported_reasoning_levels
          });
        }
        assert.ok(capabilities.has("gpt-6.2-sol"), "OAuth catalog not ready");
        return capabilities;
      },
      { timeout: 5000, interval: 50 }
    );
    await t.test(
      "Codex OAuth exposes current and legacy models with bare and account-prefixed IDs",
      () => {
        for (const [current, legacy] of [
          ["gpt-6.2-astra", ["gpt-6-astra"]],
          ["gpt-6.2-sol", ["gpt-5.6-sol", "gpt-6-sol", "gpt-6.1-sol"]],
          ["gpt-6.1-terra", ["gpt-5.6-terra"]],
          ["gpt-6-luna", ["gpt-5.6-luna"]]
        ] as const) {
          const canonical = models.get(current);
          assert.ok(canonical, current);
          assert.ok(
            typeof canonical.context_window === "number" &&
              canonical.context_window > 0
          );
          assert.ok(Array.isArray(canonical.input_modalities));
          assert.ok(Array.isArray(canonical.supported_reasoning_levels));
          for (const prefix of ["", "chatgpt/"]) {
            for (const id of [current, ...legacy]) {
              assert.deepEqual(models.get(prefix + id), canonical, prefix + id);
            }
          }
        }
      }
    );
    await t.test(
      "GLM bare and Z.ai-prefixed requests forward native and remapped efforts",
      async () => {
        const cases = [];
        for (const model of ["glm-5.3", "glm-5.3-flash"]) {
          for (const prefix of ["", "zai/"]) {
            for (const [input, expected] of [
              ["low", "high"],
              ["medium", "high"],
              ["high", "max"],

              ["xhigh", "max"],
              ["max", "max"],
              ["ultra", "max"]
            ]) {
              cases.push({
                model,
                clientModel: prefix + model,
                input,
                expected
              });
            }
          }
        }
        await Promise.all(
          cases.map(async ({ model, clientModel, input, expected }) => {
            const response = await fetch(`${url}/responses`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              signal: AbortSignal.timeout(5000),
              body: JSON.stringify({
                model: clientModel,
                reasoning: { effort: input },
                input: "Synthetic input"
              })
            });
            const payload: unknown = await response.json();
            assert.equal(response.status, 200, JSON.stringify(payload));
            assert.ok(isRecord(payload) && typeof payload.id === "string");
            assert.partialDeepStrictEqual(requests.get(payload.id), {
              path: "/responses",
              body: { model, reasoning: { effort: expected } }
            });
          })
        );
      }
    );
    await t.test(
      "GLM rejects unsupported minimal effort before forwarding",
      async () => {
        const forwardedCount = requests.size;
        await Promise.all(
          ["glm-5.3", "glm-5.3-flash", "zai/glm-5.3", "zai/glm-5.3-flash"].map(
            async (model) => {
              const response = await fetch(`${url}/responses`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                signal: AbortSignal.timeout(5000),
                body: JSON.stringify({
                  model,
                  reasoning: { effort: "minimal" },
                  input: "Synthetic input"
                })
              });
              assert.equal(response.status, 400, model);
              assert.partialDeepStrictEqual(await response.json(), {
                error: { type: "invalid_request_error" }
              });
            }
          )
        );
        assert.equal(requests.size, forwardedCount);
      }
    );
  } finally {
    proxy.kill();
    await exited;
  }
});
