import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const MAX_STALE_MS = 5 * 60_000;
/**
 * Default lifetime shared by persisted usage snapshots and consumer refreshes.
 */
export const DEFAULT_USAGE_CACHE_TTL_MS = 5000;

const PROVIDERS = new Set(["claude", "chatgpt", "zai", "minimax", "copilot"]);

const nowValue = (value) => {
  if (value instanceof Date) {
    return value.getTime();
  }
  return Number.isFinite(value) ? value : Date.now();
};

const isSuccessfulResponse = (status, usageError) =>
  !usageError && Number.isFinite(status) && status >= 200 && status < 300;

const identityHash = (provider, identity) =>
  createHash("sha256")
    .update(JSON.stringify([provider, identity]))
    .digest("hex");

const validRecord = (value, credentialHash) =>
  value &&
  typeof value === "object" &&
  value.credentialHash === credentialHash &&
  Number.isFinite(value.fetchedAt) &&
  Number.isFinite(value.nextAttemptAt) &&
  (value.snapshot === undefined ||
    (value.snapshot && typeof value.snapshot === "object"));

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
            Number.isFinite(metric.resetsInMs)
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

const retryDelay = (value, now) => {
  if (!value) {
    return 0;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
};

const readCache = async (filePath, credentialHash) => {
  let record;
  try {
    record = JSON.parse(await readFile(filePath, "utf-8"));
  } catch {
    record = undefined;
  }
  return validRecord(record, credentialHash) ? record : undefined;
};

const staleDuringCooldown = (cached, now, ttl) =>
  cached?.snapshot &&
  now - cached.fetchedAt > MAX_STALE_MS &&
  cached.nextAttemptAt - cached.fetchedAt > ttl;

const writeCache = async (directory, filePath, record) => {
  let temporaryPath;
  try {
    await mkdir(directory, { mode: 0o700, recursive: true });
    temporaryPath = path.join(directory, `.${randomUUID()}.tmp`);
    await writeFile(temporaryPath, JSON.stringify(record), { mode: 0o600 });
    await rename(temporaryPath, filePath);
  } catch {
    if (temporaryPath) {
      try {
        await rm(temporaryPath, { force: true });
      } catch {
        if (process.env.STATUSLINE_DEBUG) {
          console.error(
            "[statusline-usage] 임시 캐시 파일 정리에 실패했습니다."
          );
        }
      }
    }
    if (process.env.STATUSLINE_DEBUG) {
      console.error("[statusline-usage] 사용량 캐시 저장에 실패했습니다.");
    }
  }
};

const serveCached = async (directory, filePath, cached, now, ttl) => {
  if (staleDuringCooldown(cached, now, ttl)) {
    await writeCache(directory, filePath, { ...cached, snapshot: undefined });
    return;
  }
  return adjustedSnapshot(cached.snapshot, Math.max(0, now - cached.fetchedAt));
};

/**
 * 자격 증명별 영구 캐시를 통해 provider 사용량 스냅샷을 가져옵니다.
 * @param {string} provider 내부 provider 식별자입니다.
 * @param {unknown} credentialIdentity 해시 계산에만 사용하는 자격 증명 식별값입니다.
 * @param {object} options 캐시 및 요청 설정입니다.
 * @param {(options: object) => Promise<object|undefined>} fetchSnapshot 스냅샷 조회 함수입니다.
 * @returns {Promise<object|undefined>} 캐시 또는 새 사용량 스냅샷입니다.
 */
export const withUsageCache = async (
  provider,
  credentialIdentity,
  options,
  fetchSnapshot
) => {
  if (options.cache === false || !PROVIDERS.has(provider)) {
    return fetchSnapshot(options);
  }
  const now = nowValue(options.now);
  const ttl = Number.isFinite(options.cacheTtlMs)
    ? Math.max(0, options.cacheTtlMs)
    : DEFAULT_USAGE_CACHE_TTL_MS;
  const directory =
    options.cacheDir ??
    path.join(options.home ?? homedir(), ".claude", "cache", "usage");
  const filePath = path.join(directory, `${provider}.json`);
  const credentialHash = identityHash(provider, credentialIdentity);
  const cached = await readCache(filePath, credentialHash);
  if (cached && now < cached.nextAttemptAt) {
    return serveCached(directory, filePath, cached, now, ttl);
  }
  let status;
  let delay = 0;
  let usageError = false;
  const originalFetch = options.fetch ?? globalThis.fetch;
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
  const record = successful
    ? { credentialHash, fetchedAt: now, nextAttemptAt, snapshot }
    : {
        credentialHash,
        fetchedAt: cached?.fetchedAt ?? now,
        nextAttemptAt,
        snapshot:
          cached && now - cached.fetchedAt <= MAX_STALE_MS
            ? cached.snapshot
            : undefined
      };
  await writeCache(directory, filePath, record);
  if (successful) {
    return snapshot;
  }
  if (cached && now - cached.fetchedAt <= MAX_STALE_MS) {
    return adjustedSnapshot(
      cached.snapshot,
      Math.max(0, now - cached.fetchedAt)
    );
  }
};
