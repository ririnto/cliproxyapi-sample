import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * @param {unknown} value Untrusted value.
 * @returns {value is Record<string, unknown>} A plain record.
 */
const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/**
 * @param {unknown} value Untrusted value.
 * @returns {value is number} A finite number.
 */
const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);
/**
 * @param {unknown} value Untrusted metric.
 * @returns {value is import("./types.ts").Metric} A normalized metric.
 */
const isMetric = (value) => {
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
const isSnapshot = (value) =>
  isRecord(value) &&
  Array.isArray(value.groups) &&
  value.groups.every(
    (group) =>
      isRecord(group) &&
      (group.label === undefined || typeof group.label === "string") &&
      Array.isArray(group.metrics) &&
      group.metrics.every(isMetric)
  );

/**
 * @typedef {object} CacheRecord
 * @property {string} credentialHash Credential identity digest.
 * @property {number} fetchedAt Snapshot fetch timestamp.
 * @property {number} nextAttemptAt Earliest retry timestamp.
 * @property {import("./types.ts").Snapshot} [snapshot] Validated usage snapshot.
 */

const MAX_STALE_MS = 5 * 60_000;
/**
 * Default lifetime shared by persisted usage snapshots and consumer refreshes.
 */
export const DEFAULT_USAGE_CACHE_TTL_MS = 5000;

const PROVIDERS = new Set([
  "claude",
  "chatgpt",
  "copilot",
  "minimax",
  "mistral",
  "zai"
]);

/**
 * @param {unknown} value Current timestamp.
 */
const nowValue = (value) => {
  if (value instanceof Date) {
    return value.getTime();
  }
  return isFiniteNumber(value) ? value : Date.now();
};

/**
 * @param {number | undefined} status HTTP status.
 * @param {boolean} usageError Payload failure.
 */
const isSuccessfulResponse = (status, usageError) =>
  !usageError && isFiniteNumber(status) && status >= 200 && status < 300;

/**
 * @param {string} provider Provider name.
 * @param {unknown} identity Credential identity.
 */
const identityHash = (provider, identity) =>
  createHash("sha256")
    .update(JSON.stringify([provider, identity]))
    .digest("hex");

/**
 * @param {unknown} value Persisted data.
 * @param {string} credentialHash Expected identity.
 * @returns {value is CacheRecord} Valid cache entry.
 */
const validRecord = (value, credentialHash) =>
  isRecord(value) &&
  value.credentialHash === credentialHash &&
  isFiniteNumber(value.fetchedAt) &&
  isFiniteNumber(value.nextAttemptAt) &&
  (value.snapshot === undefined || isSnapshot(value.snapshot));

/**
 * @param {import("./types.ts").Snapshot | undefined} snapshot Cached data.
 * @param {number} elapsed Elapsed milliseconds.
 */
const adjustedSnapshot = (snapshot, elapsed) => {
  if (!snapshot || !Array.isArray(snapshot.groups)) {
    return snapshot;
  }
  return {
    ...snapshot,
    groups: snapshot.groups.map((group) => ({
      ...group,
      metrics: Array.isArray(group.metrics)
        ? group.metrics.map((metric) =>
            "resetsInMs" in metric && isFiniteNumber(metric.resetsInMs)
              ? {
                  ...metric,
                  resetsInMs: Math.max(0, metric.resetsInMs - elapsed)
                }
              : metric
          )
        : group.metrics
    }))
  };
};

/**
 * @param {string | null | undefined} value Retry header.
 * @param {number} now Current time.
 */
const retryDelay = (value, now) => {
  if (value === undefined || value === null || value === "") {
    return 0;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
};

/**
 * @param {string} filePath Cache path.
 * @param {string} credentialHash Expected identity.
 */
const readCache = async (filePath, credentialHash) => {
  /**
   * @type {unknown}
   */
  let record;
  try {
    record = JSON.parse(await readFile(filePath, "utf-8"));
  } catch {
    record = undefined;
  }
  return validRecord(record, credentialHash) ? record : undefined;
};

/**
 * @param {CacheRecord} cached Cached entry.
 * @param {number} now Current time.
 * @param {number} ttl Cache lifetime.
 */
const staleDuringCooldown = (cached, now, ttl) =>
  cached.snapshot !== undefined &&
  now - cached.fetchedAt > MAX_STALE_MS &&
  cached.nextAttemptAt - cached.fetchedAt > ttl;

/**
 * @param {string} directory Cache directory.
 * @param {string} filePath Cache path.
 * @param {Omit<CacheRecord, "snapshot"> & {snapshot?: unknown}} record Entry to serialize; persisted snapshots are validated when read.
 */
const writeCache = async (directory, filePath, record) => {
  let temporaryPath;
  try {
    await mkdir(directory, { mode: 0o700, recursive: true });
    temporaryPath = path.join(directory, `.${randomUUID()}.tmp`);
    await writeFile(temporaryPath, JSON.stringify(record), { mode: 0o600 });
    await rename(temporaryPath, filePath);
  } catch {
    if (temporaryPath !== undefined && temporaryPath !== "") {
      try {
        await rm(temporaryPath, { force: true });
      } catch {
        if ((process.env.STATUSLINE_DEBUG ?? "") !== "") {
          console.error(
            "[statusline-usage] 임시 캐시 파일 정리에 실패했습니다."
          );
        }
      }
    }
    if ((process.env.STATUSLINE_DEBUG ?? "") !== "") {
      console.error("[statusline-usage] 사용량 캐시 저장에 실패했습니다.");
    }
  }
};

/**
 * @param {string} directory Cache directory.
 * @param {string} filePath Cache path.
 * @param {CacheRecord} cached Valid entry.
 * @param {number} now Current time.
 * @param {number} ttl Cache lifetime.
 */
const serveCached = async (directory, filePath, cached, now, ttl) => {
  if (staleDuringCooldown(cached, now, ttl)) {
    await writeCache(directory, filePath, { ...cached, snapshot: undefined });
  }
  return staleDuringCooldown(cached, now, ttl)
    ? undefined
    : adjustedSnapshot(cached.snapshot, Math.max(0, now - cached.fetchedAt));
};

/**
 * 자격 증명별 영구 캐시를 통해 provider 사용량 스냅샷을 가져옵니다.
 * @template T
 * @param {string} provider 내부 provider 식별자입니다.
 * @param {unknown} credentialIdentity 해시 계산에만 사용하는 자격 증명 식별값입니다.
 * @param {import("./types.ts").UsageOptions} options 캐시 및 요청 설정입니다.
 * @param {(options: import("./types.ts").UsageOptions) => T | Promise<T>} fetchSnapshot 스냅샷 조회 함수입니다.
 * @returns {Promise<T | import("./types.ts").Snapshot | undefined>} 캐시 또는 새 사용량 스냅샷입니다.
 */
export const withUsageCache = async (
  provider,
  credentialIdentity,
  options,
  fetchSnapshot
) => {
  if (options.cache === false || !PROVIDERS.has(provider)) {
    return await fetchSnapshot(options);
  }
  const now = nowValue(options.now);
  const ttl = isFiniteNumber(options.cacheTtlMs)
    ? Math.max(0, options.cacheTtlMs)
    : DEFAULT_USAGE_CACHE_TTL_MS;
  const directory =
    options.cacheDir ??
    path.join(options.home ?? homedir(), ".claude", "cache", "usage");
  const filePath = path.join(directory, `${provider}.json`);
  const credentialHash = identityHash(provider, credentialIdentity);
  const cached = await readCache(filePath, credentialHash);
  if (cached && now < cached.nextAttemptAt) {
    return await serveCached(directory, filePath, cached, now, ttl);
  }
  /**
   * @type {number | undefined}
   */
  let status;
  let delay = 0;
  let usageError = false;
  const originalFetch = options.fetch ?? globalThis.fetch;
  /**
   * @type {import("./types.ts").UsageOptions}
   */
  const wrappedOptions = {
    ...options,
    fetch: async (...args) => {
      status = undefined;
      delay = 0;
      usageError = false;
      const response = await originalFetch(...args);
      status = Number.isFinite(response?.status) ? response.status : undefined;
      delay = retryDelay(response?.headers?.get?.("retry-after"), now);
      return response;
    },
    onUsageError: () => {
      usageError = true;
    }
  };
  let snapshot;
  try {
    snapshot = await fetchSnapshot(wrappedOptions);
  } catch {
    status = undefined;
  }
  const successful = isSuccessfulResponse(status, usageError);
  const nextAttemptAt = now + Math.max(ttl, delay);
  await writeCache(
    directory,
    filePath,
    successful
      ? { credentialHash, fetchedAt: now, nextAttemptAt, snapshot }
      : {
          credentialHash,
          fetchedAt: cached?.fetchedAt ?? now,
          nextAttemptAt,
          snapshot:
            cached && now - cached.fetchedAt <= MAX_STALE_MS
              ? cached.snapshot
              : undefined
        }
  );
  if (successful) {
    return snapshot;
  }
  return cached && now - cached.fetchedAt <= MAX_STALE_MS
    ? adjustedSnapshot(cached.snapshot, Math.max(0, now - cached.fetchedAt))
    : undefined;
};
