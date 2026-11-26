import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * @param {unknown} value Candidate object.
 * @returns {value is Record<string, unknown>} Whether the value has fields.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * @param {unknown} value Candidate timestamp or metric.
 * @returns {value is number} Whether the value is finite.
 */
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const MAX_STALE_MS = 5 * 60_000;
const DEFAULT_USAGE_CACHE_TTL_MS = 30_000;
const REFRESH_LEASE_MS = 15_000;
const REFRESH_DEADLINE_MS = 9000;
const PUBLISH_WAIT_MS = 40;

/**
 * @param {unknown} value Untrusted metric.
 * @returns {value is import("./types.ts").Metric} A normalized metric.
 */
const isMetric = (value: unknown): value is import("./types.ts").Metric => {
  if (
    !isRecord(value) ||
    typeof value.label !== "string" ||
    (value.resetsInMs !== undefined && !isFiniteNumber(value.resetsInMs)) ||
    (value.currency !== undefined && typeof value.currency !== "string")
  ) {
    return false;
  }
  switch (value.type) {
    case "percentage": {
      return isFiniteNumber(value.percentage);
    }
    case "usage": {
      return isFiniteNumber(value.used) && isFiniteNumber(value.total);
    }
    case "budget": {
      return (
        isFiniteNumber(value.used) &&
        isFiniteNumber(value.total) &&
        isFiniteNumber(value.percentage)
      );
    }
    case "credit": {
      return isFiniteNumber(value.remaining);
    }
    default: {
      return false;
    }
  }
};
/**
 * @param {unknown} value Persisted snapshot.
 * @returns {value is import("./types.ts").Snapshot} A normalized snapshot.
 */
const isSnapshot = (value: unknown): value is import("./types.ts").Snapshot =>
  isRecord(value) &&
  Array.isArray(value.groups) &&
  value.groups.every(
    (group) =>
      isRecord(group) &&
      (group.label === undefined || typeof group.label === "string") &&
      (group.deduplicateWithNativeQuota === undefined ||
        typeof group.deduplicateWithNativeQuota === "boolean") &&
      Array.isArray(group.metrics) &&
      group.metrics.every(isMetric)
  );

/**
 * @param {unknown} value Current timestamp.
 */
const nowValue = (value: unknown) => {
  const time = value instanceof Date ? value.getTime() : value;
  return isFiniteNumber(time) ? time : Date.now();
};

/**
 * @type {(
 *   snapshot: import("./types.ts").Snapshot | undefined,
 *   elapsed: number,
 *   maxAge: number
 * ) => import("./types.ts").Snapshot | undefined}
 */
const adjustedSnapshot: (
  snapshot: import("./types.ts").Snapshot | undefined,
  elapsed: number,
  maxAge: number
) => import("./types.ts").Snapshot | undefined = (
  snapshot,
  elapsed,
  maxAge
): import("./types.ts").Snapshot | undefined =>
  snapshot !== undefined && elapsed <= maxAge
    ? {
        ...snapshot,
        groups: snapshot.groups.map((group) => ({
          ...group,
          metrics: group.metrics.map((metric) =>
            "resetsInMs" in metric && isFiniteNumber(metric.resetsInMs)
              ? {
                  ...metric,
                  resetsInMs: Math.max(0, metric.resetsInMs - elapsed)
                }
              : metric
          )
        }))
      }
    : undefined;

/**
 * @param {string | null | undefined} value Retry header.
 * @param {number} now Current time.
 */
const retryDelay = (value: string | null | undefined, now: number) => {
  if (value === undefined || value === null || value === "") {
    return 0;
  }
  const milliseconds = Number(value) * 1000;
  if (Number.isFinite(milliseconds) && milliseconds >= 0) {
    return milliseconds;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
};

const schema = `
  CREATE TABLE IF NOT EXISTS usage (
    cache_key TEXT PRIMARY KEY,
    fetched_at REAL,
    next_attempt_at REAL NOT NULL,
    snapshot TEXT,
    lease_token TEXT,
    lease_until INTEGER NOT NULL
  ) STRICT
`;

/**
 * @param {DatabaseSync} db Shared usage database.
 * @param {string} key Hashed provider and query identity.
 */
const readRow = (db: DatabaseSync, key: string) =>
  db
    .prepare(
      "SELECT fetched_at, next_attempt_at, snapshot, lease_until FROM usage WHERE cache_key = ?"
    )
    .get(key);

/**
 * @param {ReturnType<typeof readRow>} row Persisted usage row.
 * @param {number} now Current cache time.
 * @returns {import("./types.ts").Snapshot | undefined} Usable cached snapshot.
 */
const readSnapshot = (
  row: ReturnType<typeof readRow>,
  now: number
): import("./types.ts").Snapshot | undefined => {
  let snapshot;
  if (typeof row?.snapshot === "string" && isFiniteNumber(row.fetched_at)) {
    try {
      /** @type {unknown} */
      const parsed: unknown = JSON.parse(row.snapshot);
      snapshot = isSnapshot(parsed)
        ? adjustedSnapshot(
            parsed,
            Math.max(0, now - row.fetched_at),
            MAX_STALE_MS
          )
        : undefined;
    } catch {
      snapshot = undefined;
    }
  }
  return snapshot;
};

/**
 * @param {string} file Database file.
 * @param {string} key Hashed provider and query identity.
 * @param {number} now Current cache time.
 * @param {string} token Candidate lease token.
 */
const claimRefresh = (
  file: string,
  key: string,
  now: number,
  token: string
) => {
  let snapshot;
  let claimed = false;
  try {
    mkdirSync(path.dirname(file), { mode: 0o700, recursive: true });
    closeSync(openSync(file, "a", 0o600));
    using db = new DatabaseSync(file, { timeout: 0 });
    db.exec(schema);
    const row = readRow(db, key);
    snapshot = readSnapshot(row, now);
    const clock = Date.now();
    if (
      !row ||
      (isFiniteNumber(row.next_attempt_at) &&
        row.next_attempt_at <= now &&
        isFiniteNumber(row.lease_until) &&
        row.lease_until <= clock)
    ) {
      claimed =
        db
          .prepare(`
          INSERT INTO usage (cache_key, next_attempt_at, lease_token, lease_until)
          VALUES (?, 0, ?, ?)
          ON CONFLICT (cache_key) DO UPDATE SET
            lease_token = excluded.lease_token,
            lease_until = excluded.lease_until
          WHERE usage.next_attempt_at <= ? AND usage.lease_until <= ?
        `)
          .run(key, token, clock + REFRESH_LEASE_MS, now, clock).changes === 1;
      if (!claimed) {
        snapshot = readSnapshot(readRow(db, key), now);
      }
    }
  } catch {
    return { claimed: false, snapshot };
  }
  return { claimed, snapshot };
};

/**
 * @param {string} file Database file.
 * @param {string} key Hashed provider and query identity.
 * @param {string} token Active lease token.
 * @param {number} now Timestamp of a successful sample.
 * @param {number} nextAttemptAt Cache expiry or server retry deadline.
 * @param {import("./types.ts").Snapshot | undefined} snapshot New normalized usage on success.
 */
const finishRefresh = (
  file: string,
  key: string,
  token: string,
  now: number,
  nextAttemptAt: number,
  snapshot: import("./types.ts").Snapshot | undefined
) => {
  try {
    using db = new DatabaseSync(file, { timeout: PUBLISH_WAIT_MS });
    const result = db
      .prepare(`
      UPDATE usage SET
        fetched_at = COALESCE(?, fetched_at),
        snapshot = COALESCE(?, snapshot),
        next_attempt_at = MAX(next_attempt_at, ?),
        lease_token = NULL,
        lease_until = 0
      WHERE cache_key = ? AND lease_token = ? AND lease_until > ?
    `)
      .run(
        snapshot === undefined ? null : now,
        snapshot === undefined ? null : JSON.stringify(snapshot),
        nextAttemptAt,
        key,
        token,
        Date.now()
      );
    return result.changes === 1
      ? snapshot
      : readSnapshot(readRow(db, key), now);
  } catch {
    return snapshot;
  }
};

/** @type {import("./types.ts").UsageRuntime["withUsageCache"]} */
export const withUsageCache: import("./types.ts").UsageRuntime["withUsageCache"] =
  async (provider, credentialIdentity, options, fetchSnapshot) => {
    if (options.cache === false || !/^[a-z0-9_-]+$/u.test(provider)) {
      return await fetchSnapshot(options);
    }
    const now = nowValue(options.now);
    const ttl = isFiniteNumber(options.cacheTtlMs)
      ? Math.max(0, options.cacheTtlMs)
      : DEFAULT_USAGE_CACHE_TTL_MS;
    const file = path.join(
      options.cacheDir ??
        path.join(options.home ?? homedir(), ".cache", "statusline"),
      "usage.sqlite"
    );
    const key = createHash("sha256")
      .update(JSON.stringify([provider, credentialIdentity]))
      .digest("hex");
    const token = randomUUID();
    const prior = claimRefresh(file, key, now, token);
    if (!prior.claimed) {
      return prior.snapshot;
    }
    let goodResponse = false;
    let usageError = false;
    let retryAt = now;
    const fetch = options.fetch ?? globalThis.fetch;
    const deadline = AbortSignal.timeout(REFRESH_DEADLINE_MS);
    let snapshot;
    try {
      const candidate = await fetchSnapshot({
        ...options,
        fetch: async (url, init) => {
          goodResponse = false;
          usageError = false;
          deadline.throwIfAborted();
          const response = await fetch(url, {
            ...init,
            signal: AbortSignal.any([init.signal, deadline])
          });
          goodResponse = response.ok;
          const seenAt = nowValue(options.now);
          retryAt = Math.max(
            retryAt,
            seenAt + retryDelay(response.headers.get("retry-after"), seenAt)
          );
          return response;
        },
        onUsageError: () => {
          usageError = true;
        }
      });
      snapshot =
        !deadline.aborted &&
        goodResponse &&
        !usageError &&
        isSnapshot(candidate)
          ? candidate
          : undefined;
    } catch {
      snapshot = undefined;
    }
    const result = finishRefresh(
      file,
      key,
      token,
      now,
      Math.max(nowValue(options.now) + ttl, retryAt),
      snapshot
    );
    return result ?? prior.snapshot;
  };
