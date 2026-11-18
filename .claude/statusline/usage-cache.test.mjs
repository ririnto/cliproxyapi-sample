import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";

import { withUsageCache } from "./usage-cache.mjs";

/** @type {import("./types.ts").Snapshot} */
const snapshot = {
  groups: [
    {
      metrics: [
        { label: "5h", type: "percentage", percentage: 10, resetsInMs: 9000 }
      ]
    }
  ]
};

/**
 * @param {unknown} value - Candidate object.
 * @returns {value is Record<string, unknown>} Whether the value is a record.
 */
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * @param {unknown} value - Imported module to inspect.
 * @returns {value is {fetchUsage: (options: object) => unknown}} Whether the module exports a callable collector.
 */
const isCollector = (value) =>
  isRecord(value) && typeof value.fetchUsage === "function";

/**
 * @param {string} text - Serialized cache record.
 * @returns {Record<string, unknown>} Parsed and validated record.
 */
const parseRecord = (text) => {
  /** @type {unknown} */
  const parsed = JSON.parse(text);
  assert.ok(isRecord(parsed));
  return parsed;
};

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
  assert.ok(isRecord(group));
  return group;
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
  assert.ok(isRecord(metric));
  return metric;
};

/** @type {(value: object) => asserts value is {fetch: (url: string) => unknown, onUsageError?: () => void}} */
const assertCallbacks = (value) => {
  assert.ok("fetch" in value && typeof value.fetch === "function");
  if ("onUsageError" in value && value.onUsageError !== undefined) {
    assert.equal(typeof value.onUsageError, "function");
  }
};

/**
 * @param {string} [retryAfter] - Optional Retry-After value.
 * @param {number} [status] - HTTP status returned by the fake response.
 */
const response = (retryAfter, status = 200) =>
  new Response(null, {
    headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter },
    status
  });

/**
 * @param {string} [retryAfter] - Optional Retry-After value.
 * @param {number} [status] - HTTP status returned by the fake response.
 */
const fetchResponse =
  (retryAfter, status = 200) =>
  () =>
    response(retryAfter, status);
/**
 * @param {string} cacheDir - Cache directory.
 * @param {number} now - Current time in milliseconds.
 * @param {string} [retryAfter] - Optional Retry-After value.
 * @param {number} [status] - HTTP status returned by the fake response.
 */
const optionsFor = (cacheDir, now, retryAfter, status = 200) => ({
  cacheDir,
  fetch: fetchResponse(retryAfter, status),
  now
});
/** @param {object} options - Wrapped request options. */
const fetchSnapshot = async (options) => {
  assertCallbacks(options);
  await options.fetch("https://example.test");
};
/** @type {string} */
let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(os.tmpdir(), "usage-cache-"));
});

afterEach(async () => {
  await rm(cacheDir, { force: true, recursive: true });
});

await test("reuses a successful snapshot and counts down resetsInMs", async () => {
  let calls = 0;
  const first = await withUsageCache(
    "zai",
    "account-a",
    optionsFor(cacheDir, 1000),
    async (options) => {
      calls += 1;
      assertCallbacks(options);
      await options.fetch("https://example.test");
      return snapshot;
    }
  );
  const cached = await withUsageCache(
    "zai",
    "account-a",
    { cacheDir, now: 2000 },
    () => {
      calls += 1;
    }
  );
  assert.deepEqual(first, snapshot);
  assert.equal(firstMetric(cached).resetsInMs, 8000);
  assert.equal(calls, 1);
  const cacheText = await readFile(path.join(cacheDir, "zai.json"), "utf-8");
  assert.equal(cacheText.includes("account-a"), false);
});

await test("refreshes at five seconds and leaves fresh cache bytes unchanged", async () => {
  let calls = 0;
  /** @param {object} options - Wrapped request options. */
  const load = async (options) => {
    calls += 1;
    assertCallbacks(options);
    await options.fetch("https://example.test");
    return {
      groups: [
        {
          metrics: [
            {
              type: "percentage",
              label: "5h",
              percentage: calls,
              resetsInMs: 9000
            }
          ]
        }
      ]
    };
  };
  const first = await withUsageCache(
    "zai",
    "account",
    optionsFor(cacheDir, 1000),
    load
  );
  const filePath = path.join(cacheDir, "zai.json");
  const bytes = await readFile(filePath);
  const cached = await withUsageCache(
    "zai",
    "account",
    optionsFor(cacheDir, 5999),
    load
  );
  assert.equal(firstMetric(first).percentage, 1);
  assert.equal(firstMetric(cached).percentage, 1);
  assert.equal(firstMetric(cached).resetsInMs, 4001);
  assert.equal(calls, 1);
  assert.deepEqual(await readFile(filePath), bytes);
  assert.equal(parseRecord(bytes.toString("utf-8")).nextAttemptAt, 6000);
  const refreshed = await withUsageCache(
    "zai",
    "account",
    optionsFor(cacheDir, 6000),
    load
  );
  assert.equal(firstMetric(refreshed).percentage, 2);
  assert.equal(calls, 2);
  const record = parseRecord(await readFile(filePath, "utf-8"));
  assert.equal(record.fetchedAt, 6000);
  assert.equal(record.nextAttemptAt, 11_000);
});

await test("honors an explicit cache directory and custom TTL at its boundary", async () => {
  const directory = path.join(cacheDir, "explicit");
  let calls = 0;
  /** @param {object} options - Wrapped request options. */
  const load = async (options) => {
    calls += 1;
    assertCallbacks(options);
    await options.fetch("https://example.test");
    return snapshot;
  };
  const options = {
    ...optionsFor(directory, 1000),
    cacheTtlMs: 12_000,
    home: cacheDir
  };
  await withUsageCache("zai", "account", options, load);
  await withUsageCache("zai", "account", { ...options, now: 12_999 }, load);
  assert.equal(calls, 1);
  await withUsageCache("zai", "account", { ...options, now: 13_000 }, load);
  assert.equal(calls, 2);
  assert.deepEqual(await readdir(cacheDir), ["explicit"]);
  assert.equal(
    parseRecord(await readFile(path.join(directory, "zai.json"), "utf-8"))
      .nextAttemptAt,
    25_000
  );
});

/**
 * @type {{auth?: object, authFile?: string, payload: (value: number) => object, provider: string, script: string, valueField: string}[]}
 */
const consumers = [
  {
    payload: (value) => ({
      api_budget: {
        reset_at: "1970-01-01T00:00:10.000Z",
        usage_percentage: value
      }
    }),
    provider: "mistral",
    script: "./mistral-usage.mjs",
    valueField: "percentage"
  },
  {
    auth: { claudeAiOauth: { accessToken: "synthetic-token" } },
    authFile: ".claude/.credentials.json",
    payload: (value) => ({
      five_hour: { resets_at: "1970-01-01T00:00:10.000Z", utilization: value }
    }),
    provider: "claude",
    script: "./claude-usage.mjs",
    valueField: "percentage"
  },
  {
    auth: { tokens: { access_token: "synthetic-token" } },
    authFile: ".codex/auth.json",
    payload: (value) => ({
      rate_limit: {
        secondary_window: { reset_after_seconds: 9, used_percent: value }
      }
    }),
    provider: "chatgpt",
    script: "./codex-usage.mjs",
    valueField: "percentage"
  },
  {
    payload: (value) => ({
      quota_reset_date_utc: "1970-01-01T00:00:10.000Z",
      quota_snapshots: {
        premium_interactions: { entitlement: 100, quota_remaining: 100 - value }
      }
    }),
    provider: "copilot",
    script: "./copilot-usage.mjs",
    valueField: "used"
  },
  {
    payload: (value) => ({
      data: {
        limits: [
          {
            nextResetTime: 10_000,
            number: 5,
            percentage: value,
            type: "TOKENS_LIMIT",
            unit: 3
          }
        ]
      },
      success: true
    }),
    provider: "zai",
    script: "./glm-coding-plan.mjs",
    valueField: "percentage"
  },
  {
    payload: (value) => ({
      base_resp: { status_code: 0 },
      model_remains: [
        {
          current_interval_total_count: 100,
          current_interval_usage_count: 100 - value,
          model_name: "MiniMax-M*",
          remains_time: 9000
        }
      ]
    }),
    provider: "minimax",
    script: "./minimax-token-plan.mjs",
    valueField: "used"
  }
];

await test("collectors reuse the home cache until its five-second refresh", async () => {
  await Promise.all(
    consumers.map(async (consumer) => {
      const home = path.join(cacheDir, consumer.provider);
      if (consumer.authFile !== undefined && consumer.authFile !== "") {
        await mkdir(path.dirname(path.join(home, consumer.authFile)), {
          recursive: true
        });
        await writeFile(
          path.join(home, consumer.authFile),
          JSON.stringify(consumer.auth)
        );
      }
      /** @type {unknown} */
      const collector = await import(consumer.script);
      assert.ok(isCollector(collector));
      const { fetchUsage } = collector;
      let calls = 0;
      const options = {
        credential: "synthetic-token",
        environment: {},
        fetch: () => {
          calls += 1;
          return Response.json(consumer.payload(calls * 10));
        },
        home,
        now: 1000,
        platform: "linux"
      };
      const first = await fetchUsage(options);
      const directory = path.join(home, ".claude", "cache", "usage");
      assert.equal(firstMetric(first)[consumer.valueField], 10);
      assert.deepEqual(await readdir(directory), [`${consumer.provider}.json`]);
      const cached = await fetchUsage({ ...options, now: 5999 });
      assert.equal(firstMetric(cached).resetsInMs, 4001);
      assert.equal(calls, 1);
      const refreshed = await fetchUsage({ ...options, now: 6000 });
      assert.equal(firstMetric(refreshed)[consumer.valueField], 20);
      assert.equal(calls, 2);
    })
  );
});

await test("invalidates data when credential identity changes", async () => {
  await withUsageCache(
    "zai",
    "account-a",
    optionsFor(cacheDir, 1000),
    () => snapshot
  );
  let calls = 0;
  assert.equal(
    await withUsageCache("zai", "account-b", { cacheDir, now: 2000 }, () => {
      calls += 1;
    }),
    undefined
  );
  assert.equal(calls, 1);
});

await test("honors Retry-After during initial rate limiting", async () => {
  const options = optionsFor(cacheDir, 1000, "600", 429);
  await withUsageCache("zai", "account", options, fetchSnapshot);
  const cached = await withUsageCache(
    "zai",
    "account",
    { ...options, now: 2000 },
    () => assert.fail()
  );
  assert.equal(cached, undefined);
  assert.equal(
    parseRecord(await readFile(path.join(cacheDir, "zai.json"), "utf-8"))
      .nextAttemptAt,
    601_000
  );
});

await test("omits expired stale data while preserving an active cooldown", async () => {
  await withUsageCache(
    "zai",
    "account",
    optionsFor(cacheDir, 1000),
    async (wrapped) => {
      assertCallbacks(wrapped);
      await wrapped.fetch("https://example.test");
      return snapshot;
    }
  );
  await withUsageCache(
    "zai",
    "account",
    optionsFor(cacheDir, 62_000, "600", 429),
    async (wrapped) => {
      assertCallbacks(wrapped);
      await wrapped.fetch("https://example.test");
    }
  );
  let calls = 0;
  assert.equal(
    await withUsageCache(
      "zai",
      "account",
      optionsFor(cacheDir, 302_000, undefined, 429),
      () => {
        calls += 1;
        return snapshot;
      }
    ),
    undefined
  );
  assert.equal(calls, 0);
  const file = parseRecord(
    await readFile(path.join(cacheDir, "zai.json"), "utf-8")
  );
  assert.equal(file.nextAttemptAt, 662_000);
  assert.equal(file.snapshot, undefined);
});

await test("keeps a fresh snapshot valid for a custom TTL longer than five minutes", async () => {
  let calls = 0;
  const options = {
    ...optionsFor(cacheDir, 1000),
    cacheTtlMs: 600_000
  };
  await withUsageCache("zai", "account", options, async (wrapped) => {
    assertCallbacks(wrapped);
    await wrapped.fetch("https://example.test");
    calls += 1;
    return snapshot;
  });
  const result = await withUsageCache(
    "zai",
    "account",
    { ...options, now: 302_000 },
    () => {
      calls += 1;
    }
  );
  assert.equal(firstMetric(result).resetsInMs, 0);
  assert.equal(calls, 1);
});

await test("recovers stale data after a network failure", async () => {
  await withUsageCache(
    "zai",
    "account",
    optionsFor(cacheDir, 1000),
    async (wrapped) => {
      assertCallbacks(wrapped);
      await wrapped.fetch("https://example.test");
      return snapshot;
    }
  );
  const result = await withUsageCache(
    "zai",
    "account",
    {
      cacheDir,
      fetch: () => {
        throw new Error("offline");
      },
      now: 62_000
    },
    async (wrapped) => {
      assertCallbacks(wrapped);
      await wrapped.fetch("https://example.test");
    }
  );
  assert.equal(firstMetric(result).resetsInMs, 0);
});

await test("preserves prior data when a successful HTTP body is malformed", async () => {
  await withUsageCache(
    "zai",
    "account",
    optionsFor(cacheDir, 1000),
    async (wrapped) => {
      assertCallbacks(wrapped);
      await wrapped.fetch("https://example.test");
      return snapshot;
    }
  );
  const result = await withUsageCache(
    "zai",
    "account",
    optionsFor(cacheDir, 62_000),
    async (options) => {
      assertCallbacks(options);
      const { fetch, onUsageError: markUsageError } = options;
      await fetch("https://example.test");
      markUsageError?.();
    }
  );
  assert.equal(firstMetric(result).label, "5h");
  assert.deepEqual(
    parseRecord(await readFile(path.join(cacheDir, "zai.json"), "utf-8"))
      .snapshot,
    snapshot
  );
});

await test("honors HTTP-date Retry-After cooldowns", async () => {
  const now = 1000;
  const retryAt = now + 600_000;
  const options = optionsFor(
    cacheDir,
    now,
    new Date(retryAt).toUTCString(),
    429
  );
  await withUsageCache("zai", "account", options, fetchSnapshot);
  assert.equal(
    parseRecord(await readFile(path.join(cacheDir, "zai.json"), "utf-8"))
      .nextAttemptAt,
    retryAt
  );
});

await test("serves prior snapshot during a rate limit", async () => {
  await withUsageCache(
    "zai",
    "account",
    optionsFor(cacheDir, 1000),
    async (wrapped) => {
      assertCallbacks(wrapped);
      await wrapped.fetch("https://example.test");
      return snapshot;
    }
  );
  const result = await withUsageCache(
    "zai",
    "account",
    optionsFor(cacheDir, 62_000, undefined, 429),
    async (wrapped) => {
      assertCallbacks(wrapped);
      await wrapped.fetch("https://example.test");
    }
  );
  assert.equal(firstMetric(result).resetsInMs, 0);
});

await test("clears cached credits on successful authoritative empty response", async () => {
  await withUsageCache(
    "zai",
    "account",
    optionsFor(cacheDir, 1000),
    async (wrapped) => {
      assertCallbacks(wrapped);
      await wrapped.fetch("https://example.test");
      return snapshot;
    }
  );
  assert.equal(
    await withUsageCache(
      "zai",
      "account",
      optionsFor(cacheDir, 62_000),
      async (wrapped) => {
        assertCallbacks(wrapped);
        await wrapped.fetch("https://example.test");
      }
    ),
    undefined
  );
  assert.equal(
    parseRecord(await readFile(path.join(cacheDir, "zai.json"), "utf-8"))
      .snapshot,
    undefined
  );
});

await test("ignores corrupt cache files and persists fresh results", async () => {
  const filePath = path.join(cacheDir, "zai.json");
  await writeFile(filePath, "{");
  assert.deepEqual(
    await withUsageCache(
      "zai",
      "account",
      optionsFor(cacheDir, 1000),
      async (wrapped) => {
        assertCallbacks(wrapped);
        await wrapped.fetch("https://example.test");
        return snapshot;
      }
    ),
    snapshot
  );
  assert.deepEqual(
    parseRecord(await readFile(filePath, "utf-8")).snapshot,
    snapshot
  );
});

await test("generated request sequences never return another account's snapshot", async () => {
  const actions = ["a", "b"].flatMap((identity) =>
    [200, 429].flatMap((status) =>
      [1000, 6000].map((elapsed) => ({ elapsed, identity, status }))
    )
  );
  /** @type {{elapsed: number, identity: string, status: number}[][]} */
  let sequences = [[]];
  for (let depth = 0; depth < 3; depth += 1) {
    sequences = sequences.flatMap((sequence) =>
      actions.map((action) => [...sequence, action])
    );
  }
  await Promise.all(
    sequences.map(async (sequence, index) => {
      const directory = path.join(cacheDir, String(index));
      /**
       * @param {number} step - Sequence index.
       * @param {number} previousNow - Previous timestamp.
       * @returns {Promise<void>} Sequence execution.
       */
      const run = async (step, previousNow) => {
        const action = sequence[step];
        if (action === undefined) {
          return;
        }
        const now = previousNow + action.elapsed;
        const result = await withUsageCache(
          "zai",
          action.identity,
          optionsFor(directory, now, undefined, action.status),
          async (options) => {
            assertCallbacks(options);
            await options.fetch("https://example.test");
            return { owner: action.identity, groups: [] };
          }
        );
        assert.ok(
          result === undefined ||
            (isRecord(result) && result.owner === action.identity),
          JSON.stringify(sequence)
        );
        await run(step + 1, now);
      };
      await run(0, 0);
    })
  );
});

await test("generated cooldowns never serve a snapshot beyond the stale limit", async () => {
  await Promise.all(
    [299_999, 300_000, 300_001, 600_000].flatMap((age) =>
      [601, 1200].map(async (retrySeconds) => {
        const directory = path.join(cacheDir, `${age}-${retrySeconds}`);
        await withUsageCache(
          "zai",
          "account",
          optionsFor(directory, 1000),
          async (options) => {
            assertCallbacks(options);
            await options.fetch("https://example.test");
            return snapshot;
          }
        );
        await withUsageCache(
          "zai",
          "account",
          optionsFor(directory, 6000, String(retrySeconds), 429),
          fetchSnapshot
        );
        const result = await withUsageCache(
          "zai",
          "account",
          optionsFor(directory, 1000 + age),
          () => assert.fail("cooldown must prevent a request")
        );
        assert.equal(result === undefined, age > 300_000);
      })
    )
  );
});

await test("bypasses cache when disabled", async () => {
  let calls = 0;
  const run = async () =>
    await withUsageCache(
      "zai",
      "account",
      { cache: false, cacheDir, now: 1000 },
      () => {
        calls += 1;
        return snapshot;
      }
    );
  await Promise.all([run(), run()]);
  assert.equal(calls, 2);
  assert.deepEqual(await readdir(cacheDir), []);
});

await test("disabled and unsupported caches pass through results and errors", async () => {
  await Promise.all(
    [
      { provider: "zai", cache: false },
      { provider: "unknown-provider", cache: true }
    ].map(async ({ provider, cache }) => {
      const options = { cacheDir, cache };
      const failure = new Error("collector failed");
      assert.equal(
        await withUsageCache(provider, "account", options, () => 0),
        0
      );
      assert.deepEqual(
        await withUsageCache(
          provider,
          "account",
          options,
          async () => await Promise.resolve(snapshot)
        ),
        snapshot
      );
      await assert.rejects(
        withUsageCache(provider, "account", options, () => {
          throw failure;
        }),
        failure
      );
    })
  );
  assert.deepEqual(await readdir(cacheDir), []);
});

await test("cached path catches callback failures", async () => {
  let syncCalls = 0;
  let asyncCalls = 0;
  const [syncResult, asyncResult] = await Promise.all([
    withUsageCache(
      "zai",
      "account",
      { cacheDir: path.join(cacheDir, "sync"), now: 1000 },
      () => {
        syncCalls += 1;
        throw new Error("sync");
      }
    ),
    withUsageCache(
      "zai",
      "account",
      { cacheDir: path.join(cacheDir, "async"), now: 1000 },
      async () => {
        asyncCalls += 1;
        await Promise.resolve();
        throw new Error("async");
      }
    )
  ]);
  assert.equal(syncCalls, 1);
  assert.equal(asyncCalls, 1);
  assert.equal(syncResult, undefined);
  assert.equal(asyncResult, undefined);
});

await test("cached path returns primitive snapshots after a successful fetch", async () => {
  await Promise.all(
    [null, 0, "snapshot"].map(async (value, index) => {
      let calls = 0;
      const result = await withUsageCache(
        "zai",
        "account",
        optionsFor(path.join(cacheDir, String(index)), 1000),
        async (options) => {
          calls += 1;
          assertCallbacks(options);
          await options.fetch("https://example.test");
          return value;
        }
      );
      assert.equal(calls, 1);
      assert.equal(result, value);
    })
  );
});

await test("rejects persisted budget metrics with missing or string percentage and fetches fresh data", async () => {
  await Promise.all(
    [undefined, "10"].map(async (percentage) => {
      const directory = path.join(
        cacheDir,
        percentage === undefined ? "missing" : "string"
      );
      await withUsageCache(
        "zai",
        "account",
        optionsFor(directory, 1000),
        async (options) => {
          await fetchSnapshot(options);
          return snapshot;
        }
      );
      const filePath = path.join(directory, "zai.json");
      await writeFile(
        filePath,
        JSON.stringify({
          ...parseRecord(await readFile(filePath, "utf-8")),
          snapshot: {
            groups: [
              {
                metrics: [
                  {
                    label: "budget",
                    type: "budget",
                    used: 10,
                    total: 100,
                    percentage
                  }
                ]
              }
            ]
          }
        })
      );
      let calls = 0;
      assert.deepEqual(
        await withUsageCache(
          "zai",
          "account",
          optionsFor(directory, 2000),
          async (options) => {
            calls += 1;
            await fetchSnapshot(options);
            return snapshot;
          }
        ),
        snapshot
      );
      assert.equal(calls, 1);
      assert.deepEqual(
        parseRecord(await readFile(filePath, "utf-8")).snapshot,
        snapshot
      );
    })
  );
});

await test("resets normalization failure for a later successful HTTP attempt", async () => {
  let calls = 0;
  assert.deepEqual(
    await withUsageCache(
      "zai",
      "account",
      optionsFor(cacheDir, 1000),
      async (wrapped) => {
        await fetchSnapshot(wrapped);
        wrapped.onUsageError?.();
        await fetchSnapshot(wrapped);
        calls += 1;
        return snapshot;
      }
    ),
    snapshot
  );
  assert.equal(calls, 1);
});
