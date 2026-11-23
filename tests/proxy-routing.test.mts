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

const glmRoutes = [
  { alias: "zai/glm-5.4", model: "glm-5.4" },
  { alias: "zai/glm-5.3-flash", model: "glm-5.3-flash" }
] as const;

await test("CLIProxyAPI routes the sample models", async (t) => {
  await using directory = await mkdtempDisposable(
    path.join(tmpdir(), "cliproxy-routing-")
  );
  const home = directory.path;
  const requests = new Map<string, unknown>();
  await using responsesServer = createServer((request, response) => {
    void json(request).then((body: unknown) => {
      const id = `resp_${requests.size}`;
      requests.set(id, {
        path: request.url,
        authorization: request.headers.authorization,
        body
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      const completed = {
        type: "response.completed",
        response: { id, status: "completed", output: [] }
      };
      if (isRecord(body) && body.stream === true) {
        const delta = {
          type: "response.output_text.delta",
          delta: "Synthetic output"
        };
        response.write(
          `event: ${delta.type}\ndata: ${JSON.stringify(delta)}\n\n`
        );
      }
      return response.end(
        `event: ${completed.type}\ndata: ${JSON.stringify(completed)}\n\n`
      );
    });
  });
  const upstreamPort = await listen(responsesServer);
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
  assert.equal(codexKeys.items.length, 1);
  const [group] = codexKeys.items;
  assert.ok(isMap(group));
  assert.equal(group.get("name"), "zai");
  assert.equal(group.get("prefix"), "zai");
  assert.equal(group.get("base-url"), "https://api.z.ai/api/v1");
  group.set("base-url", `http://127.0.0.1:${upstreamPort}/zai`);
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
            display_name,
            input_modalities,
            service_tiers,
            supported_reasoning_levels
          } = model;
          capabilities.set(model.slug, {
            context_window,
            display_name,
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
      "GLM advertises the configured IDs, context, and reasoning",
      async () => {
        const response = await fetch(`${url}/models`, {
          signal: AbortSignal.timeout(1000)
        });
        assert.equal(response.status, 200);
        const payload: unknown = await response.json();
        assert.ok(isRecord(payload) && Array.isArray(payload.data));
        const entries: unknown[] = payload.data;
        const glmIDs = entries.flatMap((entry) =>
          isRecord(entry) &&
          typeof entry.id === "string" &&
          entry.id.includes("glm-")
            ? [entry.id]
            : []
        );
        assert.equal(glmIDs.length, glmRoutes.length);
        assert.deepEqual(
          new Set(glmIDs),
          new Set(glmRoutes.map(({ alias }) => alias))
        );
        for (const { alias, model } of glmRoutes) {
          const capabilities = models.get(alias);
          assert.ok(capabilities, alias);
          assert.equal(capabilities.context_window, 292_000, alias);
          if (model === "glm-5.4") {
            assert.equal(capabilities.display_name, "GLM-5.4", alias);
            assert.deepEqual(
              capabilities.input_modalities,
              ["text", "image"],
              alias
            );
          }
          assert.ok(
            Array.isArray(capabilities.supported_reasoning_levels),
            alias
          );
          const levels: unknown[] = capabilities.supported_reasoning_levels;
          assert.deepEqual(
            new Set(
              levels.map((level) => {
                assert.ok(isRecord(level));
                return level.effort;
              })
            ),
            new Set(["high", "low", "max", "medium", "xhigh"]),
            alias
          );
        }
      }
    );
    await t.test(
      "GLM requests preserve explicit supported efforts and normalize only unsupported efforts",
      async () => {
        await Promise.all(
          glmRoutes.flatMap(({ alias, model }) =>
            [
              ["low", "low"],
              ["medium", "high"],
              ["high", "high"],
              ["xhigh", "max"],
              ["max", "max"]
            ].map(async ([input, expected]) => {
              const response = await fetch(`${url}/responses`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                signal: AbortSignal.timeout(5000),
                body: JSON.stringify({
                  model: alias,
                  reasoning: { effort: input },
                  input: "Synthetic input"
                })
              });
              const payload: unknown = await response.json();
              assert.equal(response.status, 200, JSON.stringify(payload));
              assert.ok(isRecord(payload) && typeof payload.id === "string");
              assert.partialDeepStrictEqual(
                requests.get(payload.id),
                {
                  path: "/zai/responses",
                  authorization: "Bearer __ZAI_API_KEY__",
                  body: { model, reasoning: { effort: expected } }
                },
                `${alias} with ${input} effort`
              );
            })
          )
        );
      }
    );
    await t.test(
      "GLM-5.4 forwards image input and function tools and streams Responses events",
      async () => {
        const tools = [
          {
            type: "function",
            name: "get_value",
            parameters: { type: "object", properties: {} }
          }
        ];
        const input = [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "Synthetic input" },
              {
                type: "input_image",
                image_url:
                  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAuoAAAAASUVORK5CYII="
              }
            ]
          }
        ];
        const response = await fetch(`${url}/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(5000),
          body: JSON.stringify({
            model: "zai/glm-5.4",
            input,
            tools,
            stream: true
          })
        });
        assert.equal(response.status, 200);
        assert.match(
          response.headers.get("content-type") ?? "",
          /^text\/event-stream/u
        );
        const events = await response.text();
        assert.match(
          events,
          /event: response\.output_text\.delta\ndata: .*Synthetic output/u
        );
        assert.match(events, /event: response\.completed/u);
        const id = /"id":"(?<id>resp_\d+)"/u.exec(events)?.groups?.id;
        assert.ok(id !== undefined, events);
        assert.partialDeepStrictEqual(requests.get(id), {
          path: "/zai/responses",
          body: { model: "glm-5.4", input, tools, stream: true }
        });
      }
    );
    await t.test(
      "Claude Code's configured GLM models use the Z.AI route",
      async () => {
        const settings: unknown = JSON.parse(
          await readFile(
            new URL("../.claude/settings.json", import.meta.url),
            "utf-8"
          )
        );
        assert.ok(isRecord(settings) && isRecord(settings.env));
        const model = settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION;
        assert.equal(model, "zai/glm-5.4");
        assert.equal(
          settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME,
          "GLM-5.4"
        );
        assert.equal(settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "292000");
        const { fallbackModel } = settings;
        assert.ok(Array.isArray(fallbackModel));
        const fallbacks: unknown[] = fallbackModel;
        const [fallback] = fallbacks;
        assert.equal(fallback, "zai/glm-5.3-flash");
        await Promise.all(
          [
            [model, "glm-5.4"],
            [fallback, "glm-5.3-flash"]
          ].map(async ([alias, upstreamModel]) => {
            const response = await fetch(`${url}/messages`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              signal: AbortSignal.timeout(5000),
              body: JSON.stringify({
                model: alias,
                max_tokens: 100,
                messages: [{ role: "user", content: "Synthetic input" }]
              })
            });
            assert.equal(response.status, 200);
            const payload: unknown = await response.json();
            assert.ok(isRecord(payload) && typeof payload.id === "string");
            assert.partialDeepStrictEqual(requests.get(payload.id), {
              path: "/zai/responses",
              body: { model: upstreamModel }
            });
          })
        );
      }
    );
    await t.test(
      "GLM rejects unsupported minimal and ultra efforts before forwarding",
      async () => {
        const forwardedCount = requests.size;
        await Promise.all(
          glmRoutes
            .flatMap(({ alias }) =>
              ["minimal", "ultra"].map((effort) => ({ model: alias, effort }))
            )
            .map(async ({ model, effort }) => {
              const response = await fetch(`${url}/responses`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                signal: AbortSignal.timeout(5000),
                body: JSON.stringify({
                  model,
                  reasoning: { effort },
                  input: "Synthetic input"
                })
              });
              assert.equal(response.status, 400, `${model}: ${effort}`);
              assert.partialDeepStrictEqual(await response.json(), {
                error: { type: "invalid_request_error" }
              });
            })
        );
        assert.equal(requests.size, forwardedCount);
      }
    );
  } finally {
    proxy.kill();
    await exited;
  }
});
