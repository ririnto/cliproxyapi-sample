import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  copyFile,
  mkdir,
  mkdtempDisposable,
  writeFile
} from "node:fs/promises";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";

const provider = `
export const fetchUsage = (options, { withUsageCache, requestJson }) =>
  withUsageCache(
    "fixture",
    "synthetic",
    { ...options, now: Number(process.env.FIXTURE_NOW) },
    async ({ fetch, onUsageError }) => {
      const { payload } = await requestJson(
        process.env.FIXTURE_URL, {}, fetch, onUsageError
      );
      return payload;
    }
  );
`;

const sendSnapshot = (response: ServerResponse, label: string) => {
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      groups: [
        {
          label,
          metrics: [{ type: "percentage", label: "5h", percentage: 20 }]
        }
      ]
    })
  );
};

const readFooter = `${JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "resources/read",
  params: { uri: "ui://my-statusline/footer" }
})}\n`;

await test("statuslines preserve usage and retry deadlines across overlapping refreshes", async (t) => {
  await Promise.all(
    ["claude", "codex"].map(async (host) => {
      await t.test(host, { timeout: 10_000 }, async () => {
        await using fixture = await mkdtempDisposable(
          path.join(tmpdir(), "statusline-")
        );
        const entry = path.join(fixture.path, "statusline.mjs");
        const providers = path.join(fixture.path, "statusline");
        await mkdir(providers);
        await Promise.all([
          copyFile(
            new URL(`../.${host}/statusline.mjs`, import.meta.url),
            entry
          ),
          writeFile(path.join(providers, "fixture.mjs"), provider),
          writeFile(
            path.join(providers, "providers.json"),
            JSON.stringify([{ module: "fixture.mjs", name: "Fixture" }])
          )
        ]);

        const requests: string[] = [];
        const delayed = new Map<string, (response: ServerResponse) => void>();
        await using server = createServer((request, response) => {
          const route = request.url ?? "";
          requests.push(route);
          const release = delayed.get(route);
          if (release) {
            release(response);
          } else {
            sendSnapshot(
              response,
              route === "/seed" ? "SeedQuota" : "RefreshedQuota"
            );
          }
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        assert.ok(address !== null && typeof address === "object");

        const render = async (route: string, offset: number) => {
          const child = spawn(process.execPath, [entry], {
            cwd: fixture.path,
            env: {
              HOME: fixture.path,
              CODEX_HOME: fixture.path,
              FIXTURE_URL: `http://127.0.0.1:${address.port}${route}`,
              FIXTURE_NOW: String(1_800_000_000_000 + offset)
            },
            stdio: ["pipe", "pipe", "inherit"],
            timeout: 5000
          });
          const closed = once(child, "close");
          if (host === "codex") {
            child.stdin.write(readFooter);
          } else {
            child.stdin.end("{}");
          }
          let label: string | undefined;
          try {
            for await (const line of createInterface({ input: child.stdout })) {
              label =
                /\b(?<label>SeedQuota|LatestQuota|RefreshedQuota)\b/u.exec(
                  stripVTControlCharacters(line).replaceAll("\u2060", "")
                )?.groups?.label;
              if (label !== undefined) {
                break;
              }
              if (host === "codex") {
                await delay(5);
                child.stdin.write(readFooter);
              }
            }
          } finally {
            if (host === "codex") {
              child.stdin.end();
            }
            assert.deepEqual(await closed, [0, null], route);
          }
          assert.ok(label !== undefined, `No usage row for ${route}`);
          return label;
        };

        const inFlight: Promise<string>[] = [];
        const startRefresh = async (route: string, offset: number) => {
          const { promise, resolve } = Promise.withResolvers<ServerResponse>();
          delayed.set(route, resolve);
          const rendered = render(route, offset);
          inFlight.push(rendered);
          const response = await Promise.race([
            promise,
            rendered.then(() => assert.fail(`Expected a refresh for ${route}`))
          ]);
          delayed.delete(route);
          return { response, rendered };
        };

        try {
          assert.equal(await render("/seed", -10_000), "SeedQuota");
          const failure = await startRefresh("/failure", 100);
          const rateLimit = await startRefresh("/rate-limit", 200);
          const success = await startRefresh("/success", 300);
          sendSnapshot(success.response, "LatestQuota");
          assert.equal(await success.rendered, "LatestQuota");

          failure.response.writeHead(503).end();
          const afterFailure = await failure.rendered;
          const beforeTtl = await render("/before-ttl", 5200);

          rateLimit.response.writeHead(429, { "retry-after": "60" }).end();
          const afterRateLimit = await rateLimit.rendered;
          const beforeRetry = await render("/before-retry", 60_199);
          const atRetry = await render("/retry", 60_200);

          assert.deepEqual(
            {
              afterFailure,
              beforeTtl,
              afterRateLimit,
              beforeRetry,
              atRetry,
              requests
            },
            {
              afterFailure: "LatestQuota",
              beforeTtl: "LatestQuota",
              afterRateLimit: "LatestQuota",
              beforeRetry: "LatestQuota",
              atRetry: "RefreshedQuota",
              requests: [
                "/seed",
                "/failure",
                "/rate-limit",
                "/success",
                "/retry"
              ]
            }
          );
        } finally {
          server.closeAllConnections();
          await Promise.allSettled(inFlight);
        }
      });
    })
  );
});
