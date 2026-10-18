import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { fetchUsage } from "./claude-usage.mjs";

const NOW = Date.parse("2026-10-12T00:00:00Z");
const credentials = (accessToken, subscriptionType = "max") => ({
  claudeAiOauth: {
    accessToken,
    expiresAt: NOW + 3_600_000,
    refreshToken: "unused-refresh-token",
    scopes: ["user:profile", "user:inference"],
    subscriptionType
  }
});
const usage = {
  five_hour: { resets_at: "2026-10-12T00:46:00Z", utilization: 37 },
  seven_day: { resets_at: "2026-10-14T13:00:00Z", utilization: 6 }
};
const response = (payload = usage, status = 200) => ({
  json: () => payload,
  status
});

test("API key가 있어도 native Keychain의 OAuth 인증으로 구독 사용량을 조회한다", async () => {
  const snapshot = await fetchUsage({
    cache: false,
    environment: { ANTHROPIC_API_KEY: "proxy-api-key" },
    execFile: (file, args) => {
      assert.equal(file, "security");
      assert.deepEqual(args, [
        "find-generic-password",
        "-s",
        "Claude Code-credentials",
        "-w"
      ]);
      return JSON.stringify(credentials("native-token"));
    },
    fetch: (url, options) => {
      assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
      assert.equal(options.method, "GET");
      assert.equal(options.headers.Authorization, "Bearer native-token");
      assert.equal(options.headers["anthropic-beta"], "oauth-2025-04-20");
      return response();
    },
    home: "/nonexistent",
    now: NOW
  });
  assert.deepEqual(snapshot, {
    groups: [
      {
        label: "Claude (Max)",
        metrics: [
          {
            label: "5h",
            percentage: 37,
            resetsInMs: 2_760_000,
            type: "percentage"
          },
          {
            label: "7d",
            percentage: 6,
            resetsInMs: 219_600_000,
            type: "percentage"
          }
        ]
      }
    ]
  });
});

test("Keychain 조회가 실패하면 native credentials 파일을 사용한다", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "claude-usage-"));
  try {
    await mkdir(path.join(home, ".claude"));
    await writeFile(
      path.join(home, ".claude", ".credentials.json"),
      JSON.stringify(credentials("file-token", "pro"))
    );
    const snapshot = await fetchUsage({
      cache: false,
      environment: {},
      execFile: () => {
        throw new Error("no keychain");
      },
      fetch: (_url, options) => {
        assert.equal(options.headers.Authorization, "Bearer file-token");
        return response();
      },
      home,
      now: NOW
    });
    assert.equal(snapshot?.groups[0].label, "Claude (Pro)");
    assert.equal(snapshot?.groups[0].metrics[0].percentage, 37);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("CLAUDE_CONFIG_DIR의 인증 파일을 읽고 내용을 변경하지 않는다", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "claude-usage-"));
  try {
    const configDir = path.join(home, "custom-config");
    const file = path.join(configDir, ".credentials.json");
    const original = JSON.stringify(credentials("custom-token", "pro"));
    await mkdir(configDir);
    await writeFile(file, original);
    const snapshot = await fetchUsage({
      cache: false,
      environment: { CLAUDE_CONFIG_DIR: configDir },
      execFile: () => {
        throw new Error("no keychain");
      },
      fetch: (_url, options) => {
        assert.equal(options.headers.Authorization, "Bearer custom-token");
        return response();
      },
      home,
      now: NOW
    });
    assert.equal(snapshot?.groups[0].label, "Claude (Pro)");
    assert.equal(await readFile(file, "utf-8"), original);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("만료된 Keychain 인증 대신 유효한 파일 인증을 사용한다", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "claude-usage-"));
  try {
    await mkdir(path.join(home, ".claude"));
    await writeFile(
      path.join(home, ".claude", ".credentials.json"),
      JSON.stringify(credentials("valid-file-token", "pro"))
    );
    const expired = credentials("expired-token");
    expired.claudeAiOauth.expiresAt = NOW - 1;
    const snapshot = await fetchUsage({
      cache: false,
      environment: {},
      execFile: () => JSON.stringify(expired),
      fetch: (_url, options) => {
        assert.equal(options.headers.Authorization, "Bearer valid-file-token");
        return response();
      },
      home,
      now: NOW
    });
    assert.equal(snapshot?.groups[0].metrics[0].percentage, 37);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("native OAuth 인증이 없으면 API key를 대신 사용하지 않는다", async () => {
  let requests = 0;
  const snapshot = await fetchUsage({
    cache: false,
    environment: { ANTHROPIC_API_KEY: "proxy-api-key" },
    execFile: () => {
      throw new Error("no keychain");
    },
    fetch: () => {
      requests += 1;
      return response();
    },
    home: "/nonexistent",
    now: NOW
  });
  assert.equal(snapshot, undefined);
  assert.equal(requests, 0);
});

test("만료되거나 잘못된 native 인증으로는 요청하지 않는다", async () => {
  await Promise.all(
    [
      { ...credentials("expired").claudeAiOauth, expiresAt: NOW },
      { ...credentials("token").claudeAiOauth, accessToken: "" },
      { apiKey: "not-oauth" }
    ].map(async (oauth) => {
      let requests = 0;
      const snapshot = await fetchUsage({
        cache: false,
        environment: {},
        execFile: () => JSON.stringify({ claudeAiOauth: oauth }),
        fetch: () => {
          requests += 1;
          return response();
        },
        home: "/nonexistent",
        now: NOW
      });
      assert.equal(snapshot, undefined);
      assert.equal(requests, 0);
    })
  );
});

test("조회 실패와 잘못된 응답은 사용량으로 표시하지 않는다", async () => {
  await Promise.all(
    [
      () => response(usage, 401),
      () => response(usage, 429),
      () => response(usage, 500),
      () => {
        throw new Error("network failure");
      },
      () => ({
        json: () => {
          throw new Error("invalid JSON");
        },
        status: 200
      }),
      () => response({}),
      () =>
        response({
          five_hour: { resets_at: usage.five_hour.resets_at, utilization: "37" }
        })
    ].map(async (fetch) => {
      const snapshot = await fetchUsage({
        cache: false,
        environment: {},
        execFile: () => JSON.stringify(credentials("native-token")),
        fetch,
        home: "/nonexistent",
        now: NOW
      });
      assert.equal(snapshot, undefined);
    })
  );
});

test("잘못된 window는 생략하고 유효한 0% 사용량은 유지한다", async () => {
  const snapshot = await fetchUsage({
    cache: false,
    environment: {},
    execFile: () => JSON.stringify(credentials("native-token", "unknown")),
    fetch: () =>
      response({
        five_hour: { resets_at: usage.five_hour.resets_at, utilization: -1 },
        seven_day: { resets_at: null, utilization: 0 }
      }),
    home: "/nonexistent",
    now: NOW
  });
  assert.deepEqual(snapshot, {
    groups: [
      {
        label: "Claude",
        metrics: [{ label: "7d", percentage: 0, type: "percentage" }]
      }
    ]
  });
});

const snapshotFor = (payload) =>
  fetchUsage({
    cache: false,
    environment: {},
    execFile: () => JSON.stringify(credentials("native-token")),
    fetch: () => response(payload),
    home: "/nonexistent",
    now: NOW
  });

test("선불 지갑 잔액과 월간 추가사용 예산은 별도 단위로 표시한다", async () => {
  const snapshot = await snapshotFor({
    extra_usage: {
      currency: "USD",
      is_enabled: true,
      monthly_limit: 2000,
      used_credits: 500
    },
    iguana_necktie: {
      limit_dollars: 100,
      remaining_dollars: 75,
      used_dollars: 10
    }
  });
  assert.deepEqual(snapshot?.groups[0].metrics, [
    { currency: "USD", label: "credit", remaining: 75, type: "credit" },
    { label: "budget", percentage: 25, total: 20, type: "budget", used: 5 }
  ]);
});

test("잔액이 0인 지갑은 생략하고 사용액이 0인 유효 예산은 표시한다", async () => {
  const snapshot = await snapshotFor({
    extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 0 },
    iguana_necktie: {
      limit_dollars: 100,
      remaining_dollars: 0,
      used_dollars: 100
    }
  });
  assert.deepEqual(snapshot?.groups[0].metrics, [
    { label: "budget", percentage: 0, total: 50, type: "budget", used: 0 }
  ]);
});

test("지갑 잔액이 누락되면 지갑 한도와 사용액에서 달러 잔액을 계산한다", async () => {
  const snapshot = await snapshotFor({
    iguana_necktie: { limit_dollars: 50, used_dollars: 12.5 }
  });
  assert.deepEqual(snapshot?.groups[0].metrics, [
    { currency: "USD", label: "credit", remaining: 37.5, type: "credit" }
  ]);
});

test("잘못되거나 잠기거나 만료된 지갑 잔액은 표시하지 않는다", async () => {
  await Promise.all(
    [
      { limit_dollars: 100, remaining_dollars: "75", used_dollars: 10 },
      { limit_dollars: 100, remaining_dollars: -1, used_dollars: 10 },
      { limit_dollars: 100, remaining_dollars: 101, used_dollars: 10 },
      { limit_dollars: 100, locked_reason: "locked", remaining_dollars: 75 },
      {
        limit_dollars: 100,
        remaining_dollars: 75,
        resets_at: "2026-10-11T23:59:00Z"
      }
    ].map(async (wallet) => {
      assert.equal(await snapshotFor({ iguana_necktie: wallet }), undefined);
    })
  );
});

test("비활성 또는 무제한 또는 잘못된 예산을 지갑 credit으로 취급하지 않는다", async () => {
  await Promise.all(
    [
      { is_enabled: false, monthly_limit: 2000, used_credits: 500 },
      { is_enabled: true, monthly_limit: null, used_credits: 500 },
      { is_enabled: true, monthly_limit: 0, used_credits: 500 },
      { is_enabled: true, monthly_limit: "2000", used_credits: 500 },
      { is_enabled: true, monthly_limit: 2000, used_credits: -1 },
      {
        currency: "EUR",
        is_enabled: true,
        monthly_limit: 2000,
        used_credits: 500
      }
    ].map(async (budget) => {
      assert.equal(await snapshotFor({ extra_usage: budget }), undefined);
    })
  );
});

test("월간 예산을 초과한 실제 사용액은 한도로 잘라내지 않는다", async () => {
  const snapshot = await snapshotFor({
    extra_usage: { is_enabled: true, monthly_limit: 1000, used_credits: 1250 }
  });
  assert.deepEqual(snapshot?.groups[0].metrics, [
    { label: "budget", percentage: 125, total: 10, type: "budget", used: 12.5 }
  ]);
});

test("native 인증이 같으면 캐시된 사용량을 재사용하고 reset 시간을 줄인다", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "claude-usage-cache-"));
  try {
    let requests = 0;
    const options = {
      cacheDir,
      environment: {},
      execFile: () => JSON.stringify(credentials("native-token")),
      fetch: () => {
        requests += 1;
        return response();
      },
      home: "/nonexistent",
      now: NOW
    };
    const first = await fetchUsage(options);
    const second = await fetchUsage({ ...options, now: NOW + 4999 });
    assert.equal(first?.groups[0].metrics[0].percentage, 37);
    assert.equal(second?.groups[0].metrics[0].percentage, 37);
    assert.equal(second?.groups[0].metrics[0].resetsInMs, 2_755_001);
    assert.equal(requests, 1);
    const refreshed = await fetchUsage({ ...options, now: NOW + 5000 });
    assert.equal(refreshed?.groups[0].metrics[0].resetsInMs, 2_755_000);
    assert.equal(requests, 2);
  } finally {
    await rm(cacheDir, { force: true, recursive: true });
  }
});

test("본문 조회 실패는 최근 잔액을 유지하고 정상 빈 응답은 잔액을 지운다", async () => {
  const cacheDir = await mkdtemp(
    path.join(tmpdir(), "claude-usage-body-cache-")
  );
  try {
    const options = {
      cacheDir,
      environment: {},
      execFile: () => JSON.stringify(credentials("native-token")),
      home: "/nonexistent",
      now: NOW
    };
    const first = await fetchUsage({
      ...options,
      fetch: () => response({ iguana_necktie: { remaining_dollars: 75 } })
    });
    assert.equal(first?.groups[0].metrics[0].remaining, 75);
    const malformed = await fetchUsage({
      ...options,
      fetch: () => ({
        json: () => {
          throw new Error("invalid JSON");
        },
        status: 200
      }),
      now: NOW + 61_000
    });
    assert.equal(malformed?.groups[0].metrics[0].remaining, 75);
    const providerError = await fetchUsage({
      ...options,
      fetch: () => response({ error: { type: "api_error" }, type: "error" }),
      now: NOW + 122_000
    });
    assert.equal(providerError?.groups[0].metrics[0].remaining, 75);
    const invalidBody = await fetchUsage({
      ...options,
      fetch: () => response([]),
      now: NOW + 183_000
    });
    assert.equal(invalidBody?.groups[0].metrics[0].remaining, 75);
    const empty = await fetchUsage({
      ...options,
      fetch: () => response({}),
      now: NOW + 244_000
    });
    assert.equal(empty, undefined);
  } finally {
    await rm(cacheDir, { force: true, recursive: true });
  }
});
