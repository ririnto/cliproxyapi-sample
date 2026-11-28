import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delayMs } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";

import type { UsageRuntime } from "./statusline/types.ts";
import { withUsageCache } from "./statusline/usage-cache.ts";

/**
 * @param {unknown} value Candidate JSON object.
 * @returns {value is Record<string, unknown>} Result.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * @param {unknown} value Value to read as a JSON object.
 */
const record = (value: unknown) => (isRecord(value) ? value : {});

/**
 * @param {unknown} value Value to read as an array.
 * @returns {unknown[]} Result.
 */
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * @param {unknown} value Candidate numeric value.
 * @returns {value is number} Whether the value is finite.
 */
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const neutral = "#999999";

const dim = "#84909C";

/**
 * @param {unknown} value Candidate numeric value.
 */
const finite = (value: unknown) => (isFiniteNumber(value) ? value : null);

/**
 * @param {unknown} value Text from a status snapshot or addon.
 */
const display = (value: unknown) =>
  typeof value === "string"
    ? stripVTControlCharacters(value)
        .replaceAll(/[\p{Cc}\u{2028}\u{2029}]/gu, " ")
        .slice(0, 180)
    : "";

/**
 * @param {number} value Count to display.
 */
const count = (value: number) => {
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
const duration = (minutes: number) => {
  const hours = Math.floor((minutes % 1440) / 60);
  if (minutes >= 1440) {
    return `${Math.floor(minutes / 1440)}d${hours > 0 ? `${hours}h` : ""}`;
  }
  const remainder = minutes % 60;
  return hours > 0
    ? `${hours}h${remainder > 0 ? `${remainder}m` : ""}`
    : `${remainder}m`;
};

type Span =
  | string
  | {
      type: "text";
      props: { color: string; weight: "bold" | "normal" };
      children: [string];
    };

interface QuotaWindow {
  period: string;
  used: number;
  resetsAt: number;
}
interface ProviderRow {
  spans: Span[];
  codexWindows: QuotaWindow[];
}
interface ProviderUpdate {
  index: number;
  key: string | null;
  rows: ProviderRow[] | null;
  fetchedAt: number | null;
}
type RefreshMessage = ProviderUpdate | { providerCount: number };

const responseBudgetMs = 800;
const staleUsageMs = 30 * 60_000;

/**
 * @param {string} value Text to display.
 * @param {string} color Foreground color.
 * @param {"bold" | "normal"} weight Text weight.
 * @returns {Span} Result.
 */
const colored = (
  value: string,
  color: string,
  weight: "bold" | "normal" = "normal"
): Span => ({
  type: "text",
  props: { color, weight },
  children: [value]
});

/**
 * @param {string} value Allowance or context to display.
 * @param {number} percent Percentage of the total allowance remaining.
 * @returns {Span} Result.
 */
const quota = (value: string, percent: number): Span => {
  if (percent < 10) {
    return colored(value, "#E990A9");
  }
  return colored(value, percent < 30 ? "#F2B590" : "#ABDFA7");
};

/** @type {UsageRuntime["requestJson"]} */
const requestJson: UsageRuntime["requestJson"] = async (
  url,
  headers,
  fetchFunction,
  onUsageError
) => {
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
      const payload: unknown = await response.json();
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

/**
 * @param {Record<string, unknown>} metric Normalized provider metric.
 */
const allowance = (metric: Record<string, unknown>) => {
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
const renderGroup = (
  rawGroup: unknown,
  name: string,
  showAbove: number
): ProviderRow[] => {
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
const collectProvider = async (rawProvider: unknown, index: number) => {
  const noUsage: ProviderUpdate = {
    index,
    key: null,
    rows: null,
    fetchedAt: null
  };
  const { module, name, credentialEnv, enabled, showAbove } =
    record(rawProvider);
  if (
    enabled === false ||
    typeof name !== "string" ||
    typeof module !== "string" ||
    path.basename(module) !== module ||
    !module.endsWith(".ts")
  ) {
    process.send?.(noUsage);
    return;
  }
  const credential =
    typeof credentialEnv === "string" ? process.env[credentialEnv] : undefined;
  if (
    typeof credentialEnv === "string" &&
    (credential === undefined || credential.length === 0)
  ) {
    process.send?.(noUsage);
    return;
  }
  try {
    const { fetchUsage } = record(
      await import(new URL(`statusline/${module}`, import.meta.url).href)
    );
    if (typeof fetchUsage === "function") {
      let cacheKey: string | null = null;
      const publish = (key: string | null, snapshot: unknown) => {
        cacheKey = key;
        if (process.connected) {
          const update: ProviderUpdate = {
            index,
            key,
            fetchedAt: finite(record(snapshot).fetchedAt),
            rows: isRecord(snapshot)
              ? list(snapshot.groups)
                  .slice(0, 12)
                  .flatMap((group) =>
                    renderGroup(
                      group,
                      display(name),
                      finite(showAbove) ?? 0.001
                    )
                  )
              : null
          };
          process.send?.(update);
        }
      };
      const snapshot: unknown = await Reflect.apply(fetchUsage, undefined, [
        { credential, onCachedUsage: publish },
        usageRuntime
      ]);
      publish(cacheKey, snapshot);
    } else {
      process.send?.(noUsage);
    }
  } catch {
    if (process.env.STATUSLINE_DEBUG === "1") {
      console.error("[statusline] provider usage unavailable");
    }
  }
};

const collectAddons = async () => {
  let providers: unknown[] | null = null;
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
  }
  if (providers !== null) {
    process.send?.({
      providerCount: providers.length
    } satisfies RefreshMessage);
    await Promise.all(providers.map(collectProvider));
  }
};

const graphemes = new Intl.Segmenter();

/**
 * @param {Span[]} line Styled footer row.
 */
const preventSoftWrap = (line: Span[]) =>
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
const workspaceBranch = async (cwd: unknown) => {
  if (typeof cwd !== "string" || cwd.length === 0) {
    return "";
  }
  try {
    const git = spawn("git", ["branch", "--show-current"], {
      cwd,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 150
    });
    let stdout = "";
    git.stdout.setEncoding("utf-8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 4096) {
        git.kill("SIGKILL");
      }
    });
    const result: unknown[] = await once(git, "close");
    const [code] = result;
    return code === 0 ? display(stdout.trim()) : "";
  } catch {
    return "";
  }
};

/**
 * @param {unknown} rawUsage Thread context, tokens, and cost.
 */
const usageItems = (rawUsage: unknown) => {
  const { context, total, cost } = record(rawUsage);
  const { used_percentage: used, context_window_size: size } = record(context);
  const percent = finite(used);
  const capacity = finite(size);
  const dollars = finite(record(cost).total_cost_usd);
  /**
   * @type {Span[][]}
   */
  const items: Span[][] =
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
const rateLimitItems = (account: unknown, displayedWindows: QuotaWindow[]) => {
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
const width = (row: Span[]) =>
  row.reduce(
    (size, span) =>
      size + (typeof span === "string" ? span.length : span.children[0].length),
    0
  );

/**
 * @param {Span[][]} groups Provider groups in display order.
 */
const pack = (groups: Span[][]) => {
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
const render = (
  state: unknown,
  branch: string,
  addonRows: ProviderRow[],
  oldestCachedAt: string
) => {
  const { thread, account } = record(state);
  const { model, workspace, usage } = record(thread);
  const { cwd } = record(workspace);
  const { display_name: name, reasoning_level: effort } = record(model);
  const modelSpans = [colored(display(name) || "Codex", "#F6E2B7", "bold")];
  if (typeof effort === "string" && effort.length > 0) {
    modelSpans.push(colored(` ${display(effort)}`, dim));
  }
  const header = [
    modelSpans,
    ...(oldestCachedAt.length > 0
      ? [[colored(`oldest cached ${oldestCachedAt}`, dim)]]
      : []),
    ...(typeof cwd === "string" && cwd.length > 0
      ? [[colored(display(path.basename(cwd) || cwd), "#ABDFA7")]]
      : []),
    ...(branch.length > 0 ? [[colored(branch, "#8FB3EF")]] : []),
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

const formatFetchedAt = (fetchedAt: number) =>
  `${new Date(fetchedAt).toISOString().slice(0, 16).replace("T", " ")} UTC`;

const reportAddonFailure = () => {
  if (process.env.STATUSLINE_DEBUG === "1") {
    console.error("[statusline] provider usage collection unavailable");
  }
};

const runServer = async () => {
  let refresh: Promise<void> | null = null;
  let nextRefresh = 0;
  const providers: ProviderUpdate[] = [];
  const refreshAddons = async () => {
    if (refresh === null && performance.now() >= nextRefresh) {
      const collect = async () => {
        const child = fork(import.meta.filename, ["--refresh-usage"], {
          detached: true,
          stdio: ["ignore", "ignore", "ignore", "ipc"]
        });
        child.on("message", (update: RefreshMessage) => {
          if ("providerCount" in update) {
            providers.length = update.providerCount;
          } else {
            const previous = providers[update.index];
            if (
              update.rows !== null ||
              update.key !== (previous?.key ?? null)
            ) {
              providers[update.index] = update;
            }
          }
        });
        child.channel?.unref();
        child.unref();
        await once(child, "close");
      };
      refresh = collect()
        .catch(reportAddonFailure)
        .finally(() => {
          nextRefresh = performance.now() + 15_000;
          refresh = null;
        });
    }
    await refresh;
  };
  const readFooter = async (state: unknown, deadline: number) => {
    let branch = "";
    const lookupBranch = async () => {
      branch = await workspaceBranch(
        record(record(record(state).thread).workspace).cwd
      );
    };
    const timer = new AbortController();
    try {
      await Promise.race([
        delayMs(Math.max(0, deadline - performance.now()), undefined, {
          signal: timer.signal
        }),
        Promise.all([lookupBranch(), refreshAddons()])
      ]);
    } finally {
      timer.abort();
    }
    const now = Date.now();
    let oldestCachedAt = Number.POSITIVE_INFINITY;
    const addonRows = providers
      .flatMap(({ rows, fetchedAt }) => {
        if (rows === null) {
          return [];
        }
        if (fetchedAt === null || now - fetchedAt <= staleUsageMs) {
          return rows;
        }
        if (rows.length > 0) {
          oldestCachedAt = Math.min(oldestCachedAt, fetchedAt);
        }
        return rows.map((row) => ({
          ...row,
          spans: [
            ...row.spans,
            colored(` · cached ${formatFetchedAt(fetchedAt)}`, dim)
          ]
        }));
      })
      .slice(0, 12);
    return {
      contents: [
        {
          uri,
          mimeType: resource.mimeType,
          text: JSON.stringify(
            render(
              state,
              branch,
              addonRows,
              oldestCachedAt === Number.POSITIVE_INFINITY
                ? ""
                : formatFetchedAt(oldestCachedAt)
            )
          )
        }
      ]
    };
  };
  /**
   * @param {string} method MCP request method.
   * @param {unknown} rawParams MCP request parameters.
   */
  const respond = async (
    method: string,
    rawParams: unknown,
    deadline: number
  ) => {
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
        return params.uri === uri
          ? await readFooter(record(params._meta)[stateKey], deadline)
          : null;
      }
      default: {
        return null;
      }
    }
  };
  const handleRequest = async (line: string) => {
    const deadline = performance.now() + responseBudgetMs;
    let request: Record<string, unknown> | null = null;
    let reply = null;
    try {
      request = record(JSON.parse(line));
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      reply = { error: { code: -32_700, message: "Parse error" } };
    }
    if (request !== null) {
      if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
        reply = { error: { code: -32_600, message: "Invalid request" } };
      } else if (Object.hasOwn(request, "id")) {
        const result = await respond(request.method, request.params, deadline);
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
    }
    if (reply !== null) {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: request?.id ?? null, ...reply })}\n`
      );
    }
  };
  for await (const line of createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY
  })) {
    handleRequest(line).catch(() => {
      if (process.env.STATUSLINE_DEBUG === "1") {
        console.error("[statusline] MCP response unavailable");
      }
    });
  }
};

if (process.argv[2] === "--refresh-usage") {
  process.on("error", reportAddonFailure);
  setTimeout(() => process.exit(1), 20_000).unref();
  await collectAddons();
} else {
  await runServer();
}
