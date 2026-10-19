import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { fetchUsage } from "./glm-coding-plan.mjs";

const NOW = 1_700_000_000_000;

const response = (limits, level) => ({
  json: () => ({
    data: { limits, ...(level ? { level } : {}) },
    success: true
  }),
  ok: true,
  status: 200
});

const limit = (overrides) => ({
  nextResetTime: NOW + 3_600_000,
  number: 5,
  percentage: 42,
  type: "TOKENS_LIMIT",
  unit: 3,
  ...overrides
});

const run = (limits, level) =>
  fetchUsage({
    cache: false,
    credential: "test-key",
    fetch: () => response(limits, level),
    now: NOW
  });

assert.deepEqual(
  await run([
    limit({ number: 5, percentage: 10, unit: 3 }),
    limit({ number: 1, percentage: 20, unit: 6 })
  ]),
  {
    groups: [
      {
        metrics: [
          {
            label: "5h",
            percentage: 10,
            resetsInMs: 3_600_000,
            type: "percentage"
          },
          {
            label: "7d",
            percentage: 20,
            resetsInMs: 3_600_000,
            type: "percentage"
          }
        ]
      }
    ]
  }
);

assert.deepEqual(
  await run([
    limit({ number: 5, percentage: 30, type: "CREDIT_LIMIT", unit: 3 }),
    limit({ number: 1, percentage: 40, type: "CREDIT_LIMIT", unit: 6 })
  ]),
  {
    groups: [
      {
        metrics: [
          {
            label: "5h",
            percentage: 30,
            resetsInMs: 3_600_000,
            type: "percentage"
          },
          {
            label: "7d",
            percentage: 40,
            resetsInMs: 3_600_000,
            type: "percentage"
          }
        ]
      }
    ]
  }
);

const pro = await run([limit({ number: 5, percentage: 10, unit: 3 })], "pro");
assert.equal(pro.groups[0].label, "Z.AI (Pro)");

const unknownLevel = await run(
  [limit({ number: 5, percentage: 10, unit: 3 })],
  "enterprise-ultra"
);
assert.equal(unknownLevel.groups[0].label, undefined);

assert.equal(
  await run([limit({ type: "TIME_LIMIT" }), limit({ number: 1 })]),
  undefined
);
assert.equal(await fetchUsage({}).then((value) => value), undefined);

const cacheDir = await mkdtemp(path.join(os.tmpdir(), "zai-usage-cache-"));
try {
  let calls = 0;
  const options = {
    cacheDir,
    credential: "integration-test-key",
    fetch: () => {
      calls += 1;
      return response([limit({ percentage: 25 })]);
    },
    now: NOW
  };
  const first = await fetchUsage(options);
  const cached = await fetchUsage({ ...options, now: NOW + 1000 });
  assert.equal(first.groups[0].metrics[0].resetsInMs, 3_600_000);
  assert.equal(cached.groups[0].metrics[0].resetsInMs, 3_599_000);
  assert.equal(calls, 1);
  const errorPayload = await fetchUsage({
    ...options,
    fetch: () => {
      calls += 1;
      return { json: () => ({ success: false }), status: 200 };
    },
    now: NOW + 60_000
  });
  assert.equal(errorPayload.groups[0].metrics[0].percentage, 25);
  const malformedBody = await fetchUsage({
    ...options,
    fetch: () => {
      calls += 1;
      return {
        json: () => {
          throw new Error("malformed body");
        },
        status: 200
      };
    },
    now: NOW + 120_000
  });
  assert.equal(malformedBody.groups[0].metrics[0].percentage, 25);
  const empty = await fetchUsage({
    ...options,
    fetch: () => {
      calls += 1;
      return response([]);
    },
    now: NOW + 180_000
  });
  assert.equal(empty, undefined);
  assert.equal(calls, 4);
} finally {
  await rm(cacheDir, { force: true, recursive: true });
}

let cancellations = 0;
let requestSignal;
const httpErrorResponse = new Response(
  new ReadableStream({
    cancel() {
      cancellations += 1;
    }
  }),
  { status: 503 }
);
const unavailable = await fetchUsage({
  cache: false,
  credential: "test-key",
  fetch: (_url, options) => {
    requestSignal = options.signal;
    return httpErrorResponse;
  }
});
assert.equal(unavailable, undefined);
assert.equal(cancellations, 1);
assert.equal(requestSignal.aborted, true);
assert.equal(httpErrorResponse.bodyUsed, true);

let stalledCancellations = 0;
let stalledSignal;
const stalled = await Promise.race([
  fetchUsage({
    cache: false,
    credential: "test-key",
    fetch: (_url, options) => {
      stalledSignal = options.signal;
      return new Response(
        new ReadableStream({
          cancel() {
            stalledCancellations += 1;
            return Promise.withResolvers().promise;
          }
        }),
        { status: 503 }
      );
    }
  }),
  delay(3500, "stalled")
]);
assert.notEqual(stalled, "stalled");
assert.equal(stalled, undefined);
assert.equal(stalledCancellations, 1);
assert.equal(stalledSignal.aborted, true);

console.log("ok");
