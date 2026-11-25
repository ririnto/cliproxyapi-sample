import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delayMs } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { isMainThread, parentPort, Worker } from "node:worker_threads";

/**
 * @param {unknown} value Candidate JSON object.
 * @returns {value is Record<string, unknown>} Result.
 */
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * @param {unknown} value Value to read as a JSON object.
 */
const record = (value) => (isRecord(value) ? value : {});

/**
 * @param {unknown} value Value to read as an array.
 * @returns {unknown[]} Result.
 */
const list = (value) => (Array.isArray(value) ? value : []);

/**
 * @param {unknown} value Candidate numeric value.
 * @returns {value is number} Whether the value is finite.
 */
const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

const neutral = "#999999";

const dim = "#84909C";

/**
 * @param {unknown} value Candidate numeric value.
 */
const finite = (value) => (isFiniteNumber(value) ? value : null);

/**
 * @param {unknown} value Text from a status snapshot or addon.
 */
const display = (value) =>
  typeof value === "string"
    ? stripVTControlCharacters(value)
        .replaceAll(/[\p{Cc}\u{2028}\u{2029}]/gu, " ")
        .slice(0, 180)
    : "";

/**
 * @param {number} value Count to display.
 */
const count = (value) => {
  if (value >= 1_000_000) {
    return `${Number((value / 1_000_000).toFixed(1))}M`;
  }
  return value >= 1000
    ? `${Number((value / 1000).toFixed(1))}k`
    : String(Number(value.toFixed(1)));
};

/**
 * @param {number} minutes Duration in minutes.
 */
const duration = (minutes) => {
  const hours = Math.floor((minutes % 1440) / 60);
  if (minutes >= 1440) {
    return `${Math.floor(minutes / 1440)}d${hours > 0 ? `${hours}h` : ""}`;
  }
  const remainder = minutes % 60;
  return hours > 0
    ? `${hours}h${remainder > 0 ? `${remainder}m` : ""}`
    : `${remainder}m`;
};

/**
 * @typedef {string | {type: "text", props: {color: string, weight: "bold" | "normal"}, children: [string]}} Span
 */

/**
 * @typedef {{period: string, used: number, resetsAt: number}} QuotaWindow
 * @typedef {{spans: Span[], codexWindows: QuotaWindow[]}} ProviderRow
 */

/**
 * @param {string} value Text to display.
 * @param {string} color Foreground color.
 * @param {"bold" | "normal"} weight Text weight.
 * @returns {Span} Result.
 */
const colored = (value, color, weight = "normal") => ({
  type: "text",
  props: { color, weight },
  children: [value]
});

/**
 * @param {string} value Allowance or context to display.
 * @param {number} percent Percentage of the total allowance remaining.
 * @returns {Span} Result.
 */
const quota = (value, percent) => {
  if (percent < 10) {
    return colored(value, "#E990A9");
  }
  return colored(value, percent < 30 ? "#F2B590" : "#ABDFA7");
};

/**
 * @param {unknown} value Untrusted metric.
 * @returns {value is import("./statusline/types.ts").Metric} Result.
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
 * @returns {value is import("./statusline/types.ts").Snapshot} Result.
 */
const isSnapshot = (value) =>
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
 * @typedef {{
 *   credentialHash: string,
 *   fetchedAt: number | null,
 *   nextAttemptAt: number,
 *   snapshot?: import("./statusline/types.ts").Snapshot
 * }} CacheRecord
 */

const MAX_STALE_MS = 5 * 60_000;

const DEFAULT_USAGE_CACHE_TTL_MS = 5000;

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
 * @param {unknown} value Persisted data.
 * @param {string} credentialHash Expected identity.
 * @returns {value is CacheRecord} Result.
 */
const validRecord = (value, credentialHash) =>
  isRecord(value) &&
  value.credentialHash === credentialHash &&
  (value.fetchedAt === null || isFiniteNumber(value.fetchedAt)) &&
  isFiniteNumber(value.nextAttemptAt) &&
  (value.snapshot === undefined || isSnapshot(value.snapshot));

/**
 * @type {(
 *   snapshot: import("./statusline/types.ts").Snapshot | undefined,
 *   elapsed: number,
 *   maxAge: number
 * ) => import("./statusline/types.ts").Snapshot | undefined}
 */
const adjustedSnapshot = (snapshot, elapsed, maxAge) =>
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
const readCache = (filePath, credentialHash) => {
  /**
   * @type {unknown}
   */
  let entry;
  try {
    entry = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    entry = undefined;
  }
  return validRecord(entry, credentialHash) ? entry : undefined;
};

/**
 * @type {(
 *   filePath: string,
 *   cached: CacheRecord | undefined,
 *   next: CacheRecord,
 *   now: number
 * ) => Promise<CacheRecord>}
 */
const publishCache = async (filePath, cached, next, now) => {
  const directory = path.dirname(filePath);
  let selected = next.fetchedAt === null ? (cached ?? next) : next;
  let temporaryPath;
  try {
    await mkdir(directory, { mode: 0o700, recursive: true });
    using lock = new DatabaseSync(path.join(directory, ".publish.sqlite"), {
      timeout: 1000
    });
    lock.exec("BEGIN IMMEDIATE");
    const latest = readCache(filePath, next.credentialHash) ?? cached;
    if (
      latest &&
      (next.fetchedAt === null ||
        (latest.fetchedAt !== null && latest.fetchedAt >= next.fetchedAt))
    ) {
      selected = latest;
    }
    temporaryPath = path.join(directory, `.${randomUUID()}.tmp`);
    writeFileSync(
      temporaryPath,
      JSON.stringify({
        ...selected,
        nextAttemptAt: Math.max(
          next.nextAttemptAt,
          latest?.nextAttemptAt ?? next.nextAttemptAt
        ),
        snapshot:
          now - (selected.fetchedAt ?? now) <= MAX_STALE_MS
            ? selected.snapshot
            : undefined
      }),
      { mode: 0o600 }
    );
    renameSync(temporaryPath, filePath);
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
  return selected;
};

/** @type {import("./statusline/types.ts").UsageRuntime["withUsageCache"]} */
const withUsageCache = async (
  provider,
  credentialIdentity,
  options,
  fetchSnapshot
) => {
  if (options.cache === false || !/^[a-z0-9_-]+$/u.test(provider)) {
    return await fetchSnapshot(options);
  }
  const now = nowValue(options.now);
  const { cacheTtlMs } = options;
  const ttl = isFiniteNumber(cacheTtlMs)
    ? Math.max(0, cacheTtlMs)
    : DEFAULT_USAGE_CACHE_TTL_MS;
  const directory = options.cacheDir ?? cacheDir;
  const credentialHash = createHash("sha256")
    .update(JSON.stringify([provider, credentialIdentity]))
    .digest("hex");
  const filePath = path.join(directory, provider, `${credentialHash}.json`);
  const cached =
    readCache(filePath, credentialHash) ??
    readCache(path.join(directory, `${provider}.json`), credentialHash);
  if (cached && now < cached.nextAttemptAt) {
    const fetchedAt = cached.fetchedAt ?? now;
    return adjustedSnapshot(
      cached.snapshot,
      Math.max(0, now - fetchedAt),
      cached.nextAttemptAt - fetchedAt > ttl ? MAX_STALE_MS : Infinity
    );
  }
  /**
   * @type {number | undefined}
   */
  let status;
  let retryAt = now;
  let usageError = false;
  const originalFetch = options.fetch ?? globalThis.fetch;
  /**
   * @type {import("./statusline/types.ts").UsageOptions}
   */
  const wrappedOptions = {
    ...options,
    fetch: async (...args) => {
      status = undefined;
      retryAt = now;
      usageError = false;
      const response = await originalFetch(...args);
      status = Number.isFinite(response?.status) ? response.status : undefined;
      const responseAt = nowValue(options.now);
      retryAt =
        responseAt +
        retryDelay(response?.headers?.get?.("retry-after"), responseAt);
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
  const next = {
    credentialHash,
    fetchedAt: successful ? now : null,
    nextAttemptAt: Math.max(now + ttl, retryAt),
    snapshot: successful && isSnapshot(snapshot) ? snapshot : undefined
  };
  const selected = await publishCache(filePath, cached, next, now);
  if (successful && selected === next) {
    return snapshot;
  }
  return adjustedSnapshot(
    selected.snapshot,
    Math.max(0, now - (selected.fetchedAt ?? now)),
    MAX_STALE_MS
  );
};

/** @type {import("./statusline/types.ts").UsageRuntime["requestJson"]} */
const requestJson = async (url, headers, fetchFunction, onUsageError) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 3000);
  try {
    const response = await fetchFunction(url, {
      headers,
      method: "GET",
      signal: controller.signal
    });
    if (!Number.isFinite(response.status)) {
      return { status: undefined };
    }
    if (response.status < 200 || response.status >= 300) {
      try {
        await Promise.race([
          response.body?.cancel(),
          delayMs(3000, undefined, { signal: controller.signal })
        ]);
      } catch {
        if ((process.env.STATUSLINE_DEBUG ?? "") !== "") {
          console.error(
            `[statusline-usage] Failed to cancel HTTP ${response.status} response body.`
          );
        }
      }
      controller.abort();
      return { status: response.status };
    }
    try {
      /**
       * @type {unknown}
       */
      const payload = await response.json();
      if (!isRecord(payload)) {
        onUsageError?.();
        return { status: response.status };
      }
      return { payload, status: response.status };
    } catch {
      onUsageError?.();
      return { status: response.status };
    }
  } catch {
    return { status: undefined };
  } finally {
    clearTimeout(timeout);
  }
};

const usageRuntime = { withUsageCache, requestJson };
const cacheDir = path.join(
  process.env.CODEX_HOME ?? path.join(homedir(), ".codex"),
  "cache",
  "statusline"
);

/**
 * @param {Record<string, unknown>} metric Normalized provider metric.
 */
const allowance = (metric) => {
  if (metric.type === "credit") {
    const remaining = finite(metric.remaining);
    if (remaining !== null) {
      const value =
        metric.currency === "USD"
          ? `$${remaining.toFixed(2)}`
          : count(remaining);
      return {
        span: colored(value, neutral),
        usedPercent: 100
      };
    }
  }
  if (metric.type === "percentage") {
    const used = finite(metric.percentage);
    if (used !== null) {
      const left = Math.max(0, 100 - used);
      return {
        span: quota(`${Number(left.toFixed(1))}% left`, left),
        usedPercent: used
      };
    }
  }
  const used = finite(metric.used);
  const total = finite(metric.total);
  if (
    (metric.type === "usage" || metric.type === "budget") &&
    used !== null &&
    total !== null &&
    total > 0
  ) {
    const left = Math.max(0, total - used);
    const value =
      metric.type === "budget" ? `$${used.toFixed(2)}` : count(used);
    const maximum =
      metric.type === "budget" ? `$${total.toFixed(2)}` : count(total);
    return {
      span: quota(`${value}/${maximum}`, (left * 100) / total),
      usedPercent: (used * 100) / total
    };
  }
  return null;
};

/**
 * @param {unknown} rawGroup Provider group received from a collector.
 * @param {string} name Configured provider name.
 * @param {number} showAbove Minimum percentage used.
 * @returns {ProviderRow[]} Result.
 */
const renderGroup = (rawGroup, name, showAbove) => {
  const group = record(rawGroup);
  const groupLabel = display(group.label).replace(
    /\s+\((?:Pro|Individual)\)$/u,
    ""
  );
  const now = Date.now() / 1000;
  const metrics = list(group.metrics)
    .flatMap((rawMetric) => {
      const metric = record(rawMetric);
      const label = display(metric.label);
      const remaining = allowance(metric);
      if (
        label.length === 0 ||
        remaining === null ||
        remaining.usedPercent < showAbove
      ) {
        return [];
      }
      const reset = finite(metric.resetsInMs);
      const countdown =
        reset !== null && reset > 0
          ? ` ↻${duration(Math.floor(reset / 60_000))}`
          : "";
      const window =
        group.deduplicateWithNativeQuota === true &&
        metric.type === "percentage" &&
        reset !== null &&
        reset > 0
          ? {
              period: label,
              used: remaining.usedPercent,
              resetsAt: now + reset / 1000
            }
          : null;
      return [
        {
          label,
          remaining: remaining.span,
          countdown,
          window
        }
      ];
    })
    .slice(0, 4);
  if (metrics.length === 0) {
    return [];
  }
  return [
    {
      spans: [
        colored(groupLabel || name, "#A6BED3"),
        ...metrics.flatMap(
          ({ label: metricLabel, remaining, countdown }, index) => [
            index === 0 ? "\u00A0\u00A0" : colored(" · ", dim),
            colored(`${metricLabel} `, neutral),
            remaining,
            colored(countdown, dim)
          ]
        )
      ],
      codexWindows: metrics.flatMap(({ window }) =>
        window === null ? [] : [window]
      )
    }
  ];
};

/**
 * @param {unknown} rawProvider One entry from the Codex provider list.
 */
const collectProvider = async (rawProvider) => {
  const { module, name, credentialEnv, enabled, showAbove } =
    record(rawProvider);
  if (
    enabled === false ||
    typeof name !== "string" ||
    typeof module !== "string" ||
    path.basename(module) !== module ||
    !module.endsWith(".mjs")
  ) {
    return [];
  }
  const credential =
    typeof credentialEnv === "string" ? process.env[credentialEnv] : undefined;
  if (
    typeof credentialEnv === "string" &&
    (credential === undefined || credential.length === 0)
  ) {
    return [];
  }
  try {
    const { fetchUsage } = record(
      await import(new URL(`statusline/${module}`, import.meta.url).href)
    );
    if (typeof fetchUsage !== "function") {
      return [];
    }
    const { groups } = record(
      await Reflect.apply(fetchUsage, undefined, [
        { cacheDir, credential },
        usageRuntime
      ])
    );
    return list(groups).flatMap((group) =>
      renderGroup(group, display(name), finite(showAbove) ?? 0.001)
    );
  } catch {
    if (process.env.STATUSLINE_DEBUG === "1") {
      console.error("[statusline] provider usage unavailable");
    }
    return [];
  }
};

const collectAddons = async () => {
  let providers;
  try {
    providers = list(
      JSON.parse(
        await readFile(
          new URL("statusline/providers.json", import.meta.url),
          "utf-8"
        )
      )
    );
  } catch {
    if (process.env.STATUSLINE_DEBUG === "1") {
      console.error("[statusline] provider registry unavailable");
    }
    return [];
  }
  const rows = await Promise.all(providers.map(collectProvider));
  return rows.flat().slice(0, 12);
};

const graphemes = new Intl.Segmenter();

/**
 * @param {Span[]} line Styled footer row.
 */
const preventSoftWrap = (line) =>
  line.map((span) => {
    const value = typeof span === "string" ? span : span.children[0];
    const wordJoiner = "\u2060";
    const joined = Array.from(graphemes.segment(value), ({ segment }) =>
      wordJoiner.concat(segment)
    ).join("");
    return typeof span === "string"
      ? joined
      : colored(joined, span.props.color, span.props.weight);
  });

/**
 * @param {unknown} cwd Active thread working directory.
 */
const workspaceItems = (cwd) => {
  if (typeof cwd !== "string" || cwd.length === 0) {
    return [];
  }
  const items = [colored(display(path.basename(cwd) || cwd), "#ABDFA7")];
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 150
    }).trim();
    if (branch.length > 0) {
      items.push(colored(display(branch), "#8FB3EF"));
    }
  } catch {
    return items;
  }
  return items;
};

/**
 * @param {unknown} rawUsage Thread context, tokens, and cost.
 */
const usageItems = (rawUsage) => {
  const { context, total, cost } = record(rawUsage);
  const { used_percentage: used, context_window_size: size } = record(context);
  const percent = finite(used);
  const capacity = finite(size);
  const dollars = finite(record(cost).total_cost_usd);
  /**
   * @type {Span[][]}
   */
  const items =
    dollars !== null && dollars > 0
      ? [[colored(`$${dollars.toFixed(2)}`, dim)]]
      : [];
  if (percent !== null) {
    const usedPercent = Math.max(0, Math.min(100, Math.trunc(percent)));
    const filled = Math.max(
      Number(usedPercent > 0),
      Math.round((usedPercent * 8) / 100)
    );
    items.push([
      colored("Context ", neutral),
      quota("▰".repeat(filled), 100 - usedPercent),
      colored("▱".repeat(8 - filled), dim),
      " ",
      quota(`${usedPercent}%`, 100 - usedPercent),
      colored(capacity === null ? "" : ` / ${count(capacity)}`, dim)
    ]);
  } else if (capacity !== null) {
    items.push([colored("Context ", neutral), colored(count(capacity), dim)]);
  }
  const tokens = record(total);
  for (const [key, label] of Object.entries({
    total_input_tokens: "in",
    output_tokens: "out",
    cache_read_input_tokens: "cache read",
    cache_write_input_tokens: "cache write"
  })) {
    const value = finite(tokens[key]);
    if (value !== null && value > 0) {
      items.push([colored(`${label} ${count(value)}`, dim)]);
    }
  }
  return items;
};

/**
 * @param {unknown} account Codex account snapshot.
 * @param {QuotaWindow[]} displayedWindows Provider windows already shown.
 */
const rateLimitItems = (account, displayedWindows) => {
  const now = Date.now() / 1000;
  return list(record(account).rate_limits)
    .slice(0, 6)
    .flatMap((limit) => {
      const {
        limit_name: name,
        limit_id: id,
        primary_limit: primary,
        secondary_limit: secondary
      } = record(limit);
      return [primary, secondary].flatMap((window) => {
        const {
          used_percent: used,
          window_minutes: minutes,
          resets_at: at
        } = record(window);
        const percent = finite(used);
        if (percent === null) {
          return [];
        }
        const period =
          typeof minutes === "number" && minutes > 0
            ? duration(minutes)
            : "limit";
        if (
          id === "codex" &&
          typeof at === "number" &&
          displayedWindows.some(
            (other) =>
              other.period === period &&
              Math.abs(other.used - percent) < 0.1 &&
              Math.abs(other.resetsAt - at) <= 90
          )
        ) {
          return [];
        }
        const left = Math.max(0, Math.round(100 - percent));
        const reset =
          typeof at === "number" && at > now
            ? ` ↻${duration(Math.floor((at - now) / 60))}`
            : "";
        return [
          {
            name: name === "codex" ? "Codex" : display(name) || "Codex",
            label: `${period} `,
            remaining: quota(`${left}% left`, left),
            reset
          }
        ];
      });
    });
};

/**
 * @param {Span[]} row Provider line.
 */
const width = (row) =>
  row.reduce(
    (size, span) =>
      size + (typeof span === "string" ? span.length : span.children[0].length),
    0
  );

/**
 * @param {Span[][]} groups Provider groups in display order.
 */
const pack = (groups) => {
  const pairs = [];
  for (let index = 0; index < groups.length; index += 1) {
    const first = groups[index];
    const second = groups[index + 1];
    if (second !== undefined && width(first) + width(second) + 5 <= 120) {
      pairs.push({ first, second });
      index += 1;
    } else {
      pairs.push({ first });
    }
  }
  const column = Math.max(
    0,
    ...pairs.flatMap(({ first, second }) =>
      second === undefined ? [] : [width(first)]
    )
  );
  return pairs.flatMap(({ first, second }) => {
    if (second === undefined) {
      return [first];
    }
    if (column + width(second) + 5 > 120) {
      return [first, second];
    }
    const padding = "\u00A0".repeat(column - width(first) + 2);
    return [[...first, colored(`${padding}│\u00A0\u00A0`, dim), ...second]];
  });
};

/**
 * @param {unknown} state Codex statusline snapshot.
 * @param {ProviderRow[]} addonRows Rendered usage from installed addons.
 */
const render = (state, addonRows) => {
  const { thread, account } = record(state);
  const { model, workspace, usage } = record(thread);
  const { display_name: name, reasoning_level: effort } = record(model);
  const modelSpans = [colored(display(name) || "Codex", "#F6E2B7", "bold")];
  if (typeof effort === "string" && effort.length > 0) {
    modelSpans.push(colored(` ${display(effort)}`, dim));
  }
  const header = [
    modelSpans,
    ...workspaceItems(record(workspace).cwd).map((item) => [item]),
    ...usageItems(usage)
  ].flatMap((group, index) =>
    index === 0 ? group : [colored(" · ", dim), ...group]
  );
  const nativeLimitRows = rateLimitItems(
    account,
    addonRows.flatMap((row) => row.codexWindows)
  );
  const nativeLimits = nativeLimitRows.flatMap(
    ({ name: provider, label, remaining, reset }, index) => [
      ...(index === 0 ? [] : [colored(" · ", dim)]),
      ...(index === 0 || nativeLimitRows[index - 1].name !== provider
        ? [colored(provider, "#A6BED3"), colored("\u00A0\u00A0", neutral)]
        : []),
      colored(label, neutral),
      remaining,
      colored(reset, dim)
    ]
  );
  const providerRows = addonRows.map((row) => row.spans);
  if (nativeLimits.length > 0) {
    providerRows.unshift(nativeLimits);
  }
  return {
    type: "text",
    children: [
      ...preventSoftWrap(header),
      ...pack(providerRows).flatMap((line) => ["\n", ...preventSoftWrap(line)])
    ]
  };
};

const uri = "ui://my-statusline/footer";
const stateKey = "com.openai/codex-statusline-state";
const tool = {
  name: "statusline",
  title: "Statusline",
  inputSchema: { type: "object", properties: {} },
  _meta: {
    "openai/ui": { entrypoints: [{ type: "statusline", resourceUri: uri }] }
  }
};
const resource = { name: "footer", uri, mimeType: "application/json" };

const reportAddonFailure = () => {
  if (process.env.STATUSLINE_DEBUG === "1") {
    console.error("[statusline] provider usage collection unavailable");
  }
};

const runServer = async () => {
  /**
   * @type {Worker | null}
   */
  let worker = null;
  let nextRefresh = 0;
  /**
   * @type {ProviderRow[]}
   */
  let addonRows = [];

  const refreshAddons = () => {
    if (worker !== null || performance.now() < nextRefresh) {
      return;
    }
    // Keep Keychain and network calls outside the MCP resource deadline.
    const current = new Worker(new URL(import.meta.url), {
      stdout: true,
      stderr: true
    });
    worker = current;
    current.stdout.resume();
    current.stderr.resume();
    const deadline = setTimeout(() => {
      current.terminate().catch(reportAddonFailure);
    }, 12_000).unref();
    /**
     * @type {ProviderRow[]}
     */
    let lines = [];
    /**
     * @param {ProviderRow[]} result Rendered addon lines sent by the worker.
     */
    const receiveLines = (result) => {
      lines = result;
    };
    current.once("message", receiveLines);
    current.once("error", reportAddonFailure);
    current.once("exit", () => {
      clearTimeout(deadline);
      addonRows = lines;
      nextRefresh = performance.now() + 15_000;
      worker = null;
    });
    current.unref();
  };

  /**
   * @param {string} method MCP request method.
   * @param {unknown} rawParams MCP request parameters.
   */
  const respond = (method, rawParams) => {
    const params = record(rawParams);
    switch (method) {
      case "initialize": {
        return {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "statusline", version: "2.0" }
        };
      }
      case "ping": {
        return {};
      }
      case "tools/list": {
        return { tools: [tool] };
      }
      case "tools/call": {
        return params.name === tool.name
          ? {
              content: [
                { type: "text", text: `The statusline resource is ${uri}.` }
              ]
            }
          : null;
      }
      case "resources/list": {
        return { resources: [resource] };
      }
      case "resources/templates/list": {
        return { resourceTemplates: [] };
      }
      case "resources/read": {
        if (params.uri !== uri) {
          return null;
        }
        refreshAddons();
        return {
          contents: [
            {
              uri,
              mimeType: resource.mimeType,
              text: JSON.stringify(
                render(record(params._meta)[stateKey], addonRows)
              )
            }
          ]
        };
      }
      default: {
        return null;
      }
    }
  };

  for await (const line of createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY
  })) {
    let request;
    try {
      request = record(JSON.parse(line));
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32_700, message: "Parse error" } })}\n`
      );
      continue;
    }
    let reply;
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      reply = { error: { code: -32_600, message: "Invalid request" } };
    } else if (Object.hasOwn(request, "id")) {
      const result = respond(request.method, request.params);
      if (result !== null) {
        reply = { result };
      } else if (
        request.method === "resources/read" ||
        request.method === "tools/call"
      ) {
        reply = { error: { code: -32_602, message: "Invalid parameters" } };
      } else {
        reply = { error: { code: -32_601, message: "Method not found" } };
      }
    }
    if (reply !== undefined) {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: request.id ?? null, ...reply })}\n`
      );
    }
  }
};

if (isMainThread) {
  await runServer();
} else {
  parentPort?.postMessage(await collectAddons(), []);
}
