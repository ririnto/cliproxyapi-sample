import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { fetchUsage } from "./glm-coding-plan.mjs";

/**
 * @param {() => unknown} body - Lazy payload, including malformed JSON failures.
 * @param {number} status - Fixture HTTP status.
 * @returns {Response} Fetch response preserving fixture payload values.
 */
const jsonResponse = (body, status) => {
  const response = new Response(null, { status });
  Object.defineProperty(response, "json", { value: async () => await body() });
  return response;
};

const NOW = 1_700_000_000_000;

/**
 * @param {unknown} value - The returned snapshot.
 * @returns {Record<string, unknown>} The first validated group.
 */
const firstGroup = (value) => {
  assert.ok(value !== null && typeof value === "object" && "groups" in value);
  assert.ok(Array.isArray(value.groups));
  const { groups } = value;
  /** @type {unknown[]} */
  const safeGroups = groups;
  const [group] = safeGroups;
  assert.ok(
    group !== null && typeof group === "object" && !Array.isArray(group)
  );
  return Object.fromEntries(Object.entries(group));
};

/**
 * @param {unknown} value - The returned snapshot.
 * @returns {Record<string, unknown>} The first validated metric.
 */
const firstMetric = (value) => {
  const group = firstGroup(value);
  assert.ok(Array.isArray(group.metrics));
  const { metrics } = group;
  /** @type {unknown[]} */
  const safeMetrics = metrics;
  const [metric] = safeMetrics;
  assert.ok(
    metric !== null && typeof metric === "object" && !Array.isArray(metric)
  );
  return Object.fromEntries(Object.entries(metric));
};

/**
 * @typedef {{nextResetTime: number, number: number, percentage: number, type: string, unit: number}} Limit
 */

/**
 * @param {Limit[]} limits - Quota entries.
 * @param {string} [level] - Optional subscription level.
 */
const response = (limits, level) =>
  jsonResponse(
    () => ({
      data: {
        limits,
        ...(level !== undefined && level !== "" ? { level } : {})
      },
      success: true
    }),
    200
  );

/**
 * @param {Partial<Limit>} overrides - Changed quota fields.
 * @returns {Limit} A quota entry.
 */
const limit = (overrides) => ({
  nextResetTime: NOW + 3_600_000,
  number: 5,
  percentage: 42,
  type: "TOKENS_LIMIT",
  unit: 3,
  ...overrides
});

/**
 * @param {Limit[]} limits - Quota entries.
 * @param {string} [level] - Optional subscription level.
 */
const run = async (limits, level) =>
  await fetchUsage({
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
assert.equal(firstGroup(pro).label, "Z.AI (Pro)");

const ultra = await run(
  [limit({ number: 5, percentage: 10, unit: 3 })],
  "enterprise-ultra"
);
assert.equal(firstGroup(ultra).label, undefined);

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
  assert.equal(firstMetric(first).resetsInMs, 3_600_000);
  assert.equal(firstMetric(cached).resetsInMs, 3_599_000);
  assert.equal(calls, 1);
  const errorPayload = await fetchUsage({
    ...options,
    fetch: () => {
      calls += 1;
      return jsonResponse(() => ({ success: false }), 200);
    },
    now: NOW + 60_000
  });
  assert.equal(firstMetric(errorPayload).percentage, 25);
  const malformedBody = await fetchUsage({
    ...options,
    fetch: () => {
      calls += 1;
      return jsonResponse(() => {
        throw new Error("malformed body");
      }, 200);
    },
    now: NOW + 120_000
  });
  assert.equal(firstMetric(malformedBody).percentage, 25);
  assert.equal(
    await fetchUsage({
      ...options,
      fetch: () => {
        calls += 1;
        return response([]);
      },
      now: NOW + 180_000
    }),
    undefined
  );
  assert.equal(calls, 4);
} finally {
  await rm(cacheDir, { force: true, recursive: true });
}

console.log("ok");
