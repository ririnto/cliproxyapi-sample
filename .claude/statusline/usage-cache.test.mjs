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

const snapshot = { groups: [{ metrics: [{ label: "5h", resetsInMs: 9000 }] }] };
const response = (retryAfter, status = 200) => ({
  headers: {
    get: (name) => (name.toLowerCase() === "retry-after" ? retryAfter : null)
  },
  status
});
const fetchResponse =
  (retryAfter, status = 200) =>
  () =>
    response(retryAfter, status);
const optionsFor = (cacheDir, now, retryAfter, status = 200) => ({
  cacheDir,
  fetch: fetchResponse(retryAfter, status),
  now
});
const fetchSnapshot = async (options) => {
  await options.fetch("https://example.test");
};
let cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(os.tmpdir(), "usage-cache-"));
});

afterEach(async () => {
  await rm(cacheDir, { force: true, recursive: true });
});

test("reuses a successful snapshot and counts down resetsInMs", async () => {
  let calls = 0;
  const first = await withUsageCache(
    "zai",
    "account-a",
    optionsFor(cacheDir, 1000),
    async (options) => {
      calls += 1;
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
  assert.equal(cached.groups[0].metrics[0].resetsInMs, 8000);
  assert.equal(calls, 1);
  const record = await readFile(path.join(cacheDir, "zai.json"), "utf-8");
  assert.equal(record.includes("account-a"), false);
});

test("refreshes at five seconds and leaves fresh cache bytes unchanged", async () => {
  let calls = 0;
  const load = async (options) => {
    calls += 1;
    await options.fetch("https://example.test");
    return { groups: [{ metrics: [{ percentage: calls, resetsInMs: 9000 }] }] };
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
  assert.equal(first.groups[0].metrics[0].percentage, 1);
  assert.equal(cached.groups[0].metrics[0].percentage, 1);
  assert.equal(cached.groups[0].metrics[0].resetsInMs, 4001);
  assert.equal(calls, 1);
  assert.deepEqual(await readFile(filePath), bytes);
  assert.equal(JSON.parse(bytes).nextAttemptAt, 6000);
  const refreshed = await withUsageCache(
    "zai",
    "account",
    optionsFor(cacheDir, 6000),
    load
  );
  assert.equal(refreshed.groups[0].metrics[0].percentage, 2);
  assert.equal(calls, 2);
  const record = JSON.parse(await readFile(filePath, "utf-8"));
  assert.equal(record.fetchedAt, 6000);
  assert.equal(record.nextAttemptAt, 11_000);
});

test("honors an explicit cache directory and custom TTL at its boundary", async () => {
  const directory = path.join(cacheDir, "explicit");
  let calls = 0;
  const load = async (options) => {
    calls += 1;
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
    JSON.parse(await readFile(path.join(directory, "zai.json"), "utf-8"))
      .nextAttemptAt,
    25_000
  );
});

const consumers = [
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

test("all five collectors use the home cache and refresh at five seconds", async () => {
  await Promise.all(
    consumers.map(async (consumer) => {
      const home = path.join(cacheDir, consumer.provider);
      if (consumer.authFile) {
        await mkdir(path.dirname(path.join(home, consumer.authFile)), {
          recursive: true
        });
        await writeFile(
          path.join(home, consumer.authFile),
          JSON.stringify(consumer.auth)
        );
      }
      const { fetchUsage } = await import(consumer.script);
      let calls = 0;
      const options = {
        credential: "synthetic-token",
        environment: {},
        fetch: () => {
          calls += 1;
          return { json: () => consumer.payload(calls * 10), status: 200 };
        },
        home,
        now: 1000,
        platform: "linux"
      };
      const first = await fetchUsage(options);
      const directory = path.join(home, ".claude", "cache", "usage");
      const filePath = path.join(directory, `${consumer.provider}.json`);
      const bytes = await readFile(filePath);
      assert.equal(first.groups[0].metrics[0][consumer.valueField], 10);
      assert.equal(JSON.parse(bytes).nextAttemptAt, 6000);
      assert.deepEqual(await readdir(directory), [`${consumer.provider}.json`]);
      const cached = await fetchUsage({ ...options, now: 5999 });
      assert.equal(cached.groups[0].metrics[0][consumer.valueField], 10);
      assert.equal(cached.groups[0].metrics[0].resetsInMs, 4001);
      assert.equal(calls, 1);
      assert.deepEqual(await readFile(filePath), bytes);
      const refreshed = await fetchUsage({ ...options, now: 6000 });
      assert.equal(refreshed.groups[0].metrics[0][consumer.valueField], 20);
      assert.equal(calls, 2);
      const record = JSON.parse(await readFile(filePath, "utf-8"));
      assert.equal(record.fetchedAt, 6000);
      assert.equal(record.nextAttemptAt, 11_000);
    })
  );
});

test("invalidates data when credential identity changes", async () => {
  await withUsageCache(
    "zai",
    "account-a",
    optionsFor(cacheDir, 1000),
    () => snapshot
  );
  let calls = 0;
  const result = await withUsageCache(
    "zai",
    "account-b",
    { cacheDir, now: 2000 },
    () => {
      calls += 1;
    }
  );
  assert.equal(result, undefined);
  assert.equal(calls, 1);
});

test("honors Retry-After during initial rate limiting", async () => {
  const options = optionsFor(cacheDir, 1000, "600", 429);
  await withUsageCache("zai", "account", options, fetchSnapshot);
  const cached = await withUsageCache(
    "zai",
    "account",
    { ...options, now: 2000 },
    () => assert.fail()
  );
  assert.equal(cached, undefined);
  const file = JSON.parse(
    await readFile(path.join(cacheDir, "zai.json"), "utf-8")
  );
  assert.equal(file.nextAttemptAt, 601_000);
});

test("omits expired stale data while preserving an active cooldown", async () => {
  await withUsageCache(
    "zai",
    "account",
    optionsFor(cacheDir, 1000),
    async (wrapped) => {
      await wrapped.fetch("https://example.test");
      return snapshot;
    }
  );
  await withUsageCache(
    "zai",
    "account",
    optionsFor(cacheDir, 62_000, "600", 429),
    async (wrapped) => {
      await wrapped.fetch("https://example.test");
    }
  );
  let calls = 0;
  const result = await withUsageCache(
    "zai",
    "account",
    optionsFor(cacheDir, 302_000, undefined, 429),
    () => {
      calls += 1;
      return snapshot;
    }
  );
  assert.equal(result, undefined);
  assert.equal(calls, 0);
  const file = JSON.parse(
    await readFile(path.join(cacheDir, "zai.json"), "utf-8")
  );
  assert.equal(file.nextAttemptAt, 662_000);
  assert.equal(file.snapshot, undefined);
});

test("keeps a fresh snapshot valid for a custom TTL longer than five minutes", async () => {
  let calls = 0;
  const options = {
    ...optionsFor(cacheDir, 1000),
    cacheTtlMs: 600_000
  };
  await withUsageCache("zai", "account", options, async (wrapped) => {
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
  assert.equal(result.groups[0].metrics[0].resetsInMs, 0);
  assert.equal(calls, 1);
});

test("recovers stale data after a network failure", async () => {
  await withUsageCache(
    "zai",
    "account",
    optionsFor(cacheDir, 1000),
    async (wrapped) => {
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
      await wrapped.fetch("https://example.test");
    }
  );
  assert.equal(result.groups[0].metrics[0].resetsInMs, 0);
});

test("preserves prior data when a successful HTTP body is malformed", async () => {
  await withUsageCache(
    "zai",
    "account",
    optionsFor(cacheDir, 1000),
    async (wrapped) => {
      await wrapped.fetch("https://example.test");
      return snapshot;
    }
  );
  let onUsageError;
  const result = await withUsageCache(
    "zai",
    "account",
    optionsFor(cacheDir, 62_000),
    async ({ fetch, onUsageError: markUsageError }) => {
      await fetch("https://example.test");
      onUsageError = markUsageError;
      markUsageError?.();
    }
  );
  assert.equal(typeof onUsageError, "function");
  assert.equal(result.groups[0].metrics[0].label, "5h");
  const file = JSON.parse(
    await readFile(path.join(cacheDir, "zai.json"), "utf-8")
  );
  assert.deepEqual(file.snapshot, snapshot);
});

test("resets normalization failure for a later successful HTTP attempt", async () => {
  let calls = 0;
  let hookAvailable = false;
  const result = await withUsageCache(
    "zai",
    "account",
    optionsFor(cacheDir, 1000),
    async (wrapped) => {
      await wrapped.fetch("https://example.test");
      hookAvailable = typeof wrapped.onUsageError === "function";
      wrapped.onUsageError?.();
      await wrapped.fetch("https://example.test");
      calls += 1;
      return snapshot;
    }
  );
  assert.deepEqual(result, snapshot);
  assert.equal(calls, 1);
  assert.equal(hookAvailable, true);
});

test("honors HTTP-date Retry-After cooldowns", async () => {
  const now = 1000;
  const retryAt = now + 600_000;
  const options = optionsFor(
    cacheDir,
    now,
    new Date(retryAt).toUTCString(),
    429
  );
  await withUsageCache("zai", "account", options, fetchSnapshot);
  const file = JSON.parse(
    await readFile(path.join(cacheDir, "zai.json"), "utf-8")
  );
  assert.equal(file.nextAttemptAt, retryAt);
});

test("serves prior snapshot during a rate limit", async () => {
  await withUsageCache(
    "zai",
    "account",
    optionsFor(cacheDir, 1000),
    async (wrapped) => {
      await wrapped.fetch("https://example.test");
      return snapshot;
    }
  );
  const result = await withUsageCache(
    "zai",
    "account",
    optionsFor(cacheDir, 62_000, undefined, 429),
    async (wrapped) => {
      await wrapped.fetch("https://example.test");
    }
  );
  assert.equal(result.groups[0].metrics[0].resetsInMs, 0);
});

test("clears cached credits on successful authoritative empty response", async () => {
  await withUsageCache(
    "zai",
    "account",
    optionsFor(cacheDir, 1000),
    async (wrapped) => {
      await wrapped.fetch("https://example.test");
      return snapshot;
    }
  );
  const result = await withUsageCache(
    "zai",
    "account",
    optionsFor(cacheDir, 62_000),
    async (wrapped) => {
      await wrapped.fetch("https://example.test");
    }
  );
  assert.equal(result, undefined);
  const file = JSON.parse(
    await readFile(path.join(cacheDir, "zai.json"), "utf-8")
  );
  assert.equal(file.snapshot, undefined);
});

test("ignores corrupt cache files and persists fresh results", async () => {
  const filePath = path.join(cacheDir, "zai.json");
  await writeFile(filePath, "{");
  const result = await withUsageCache(
    "zai",
    "account",
    optionsFor(cacheDir, 1000),
    async (wrapped) => {
      await wrapped.fetch("https://example.test");
      return snapshot;
    }
  );
  assert.deepEqual(result, snapshot);
  assert.deepEqual(
    JSON.parse(await readFile(filePath, "utf-8")).snapshot,
    snapshot
  );
});

test("bypasses cache when disabled", async () => {
  let calls = 0;
  const run = () =>
    withUsageCache(
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
