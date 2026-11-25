import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempDisposable, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { isMap, isScalar, parse, parseDocument, stringify, visit } from "yaml";

interface CatalogEntry extends Record<string, unknown> {
  readonly slug: string;
}

interface CatalogModel extends CatalogEntry {
  readonly context_window: number;
}

const settingsPath = "config/models.yaml";
const upstreamCatalogPath = "config/codex.upstream.json";
const proxyUpstreamPath = "config/proxy.upstream.yaml.txt";
const officialProxyUrl =
  "https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/refs/heads/main/config.example.yaml";

const fetchText = async (url: string) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  assert.ok(response.ok, `Could not fetch ${url}: HTTP ${response.status}`);
  return await response.text();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertBareModelId = (id: string, field: "alias" | "name" | "slug") => {
  assert.ok(
    !id.startsWith("zai/"),
    `Model ${field} ${JSON.stringify(id)} cannot start with the "zai/" prefix.`
  );
};

const assertBareModelIds = (config: Record<string, unknown>) => {
  const modelLists: unknown[] = [];
  if (isRecord(config.oauth)) {
    for (const section of [
      config.oauth["model-alias"],
      config.oauth.settings
    ]) {
      if (isRecord(section)) {
        modelLists.push(...Object.values(section));
      }
    }
  }
  const sections = new Set<unknown>([config]);
  for (const section of sections) {
    if (Array.isArray(section)) {
      for (const item of section) {
        sections.add(item);
      }
    } else if (isRecord(section)) {
      modelLists.push(section.models);
      for (const value of Object.values(section)) {
        sections.add(value);
      }
    }
  }
  for (const list of modelLists) {
    if (Array.isArray(list)) {
      for (const row of list) {
        if (isRecord(row)) {
          for (const field of ["name", "alias"] as const) {
            const id = row[field];
            if (typeof id === "string") {
              assertBareModelId(id, field);
            }
          }
        }
      }
    }
  }
};

const assertProxyConfig = (contents: string) => {
  const config: unknown = parse(contents, { merge: true });
  assert.ok(isRecord(config), "Expected a proxy configuration mapping");
  assertBareModelIds(config);
  const providers = isRecord(config["api-keys"])
    ? config["api-keys"].claude
    : undefined;
  const zai = Array.isArray(providers)
    ? providers.filter(isRecord).find(({ name }) => name === "zai")
    : undefined;
  assert.ok(
    zai?.["base-url"] === "https://api.z.ai/api/anthropic",
    "zai base-url: expected the direct Claude endpoint https://api.z.ai/api/anthropic"
  );
  assert.ok(
    Array.isArray(zai.models),
    "zai models: expected Claude model rows"
  );
  const zaiModels: readonly unknown[] = zai.models;
  for (const model of zaiModels) {
    assert.ok(
      isRecord(model) && typeof model.name === "string" && model.name,
      "zai models: expected a bare model name"
    );
    assert.ok(
      !model.name.includes("/"),
      `zai ${model.name} name: expected a bare model name`
    );
    assert.equal(
      model.alias,
      model.name,
      `zai ${model.name} alias: expected the bare model name`
    );
    assert.ok(
      !JSON.stringify(model).includes("${"),
      `zai ${model.name}: model rows cannot use environment placeholders`
    );
  }
};

const codexVersion = (slug: string) => {
  const version =
    /^gpt-(?<number>[0-9]+(?:\.[0-9]+)*)-(?<lane>[A-Za-z]+)$/u.exec(
      slug
    )?.groups;
  return version?.lane === undefined || version.number === undefined
    ? undefined
    : { lane: version.lane, parts: version.number.split(".").map(BigInt) };
};

const isNewer = (a: readonly bigint[], b: readonly bigint[]) => {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index] ?? 0n;
    const right = b[index] ?? 0n;
    if (left !== right) {
      return left > right;
    }
  }
  return false;
};

interface RouteModel {
  readonly name: string;
  readonly alias: string;
  readonly display_name: string;
  readonly context_window?: number;
  readonly efforts: readonly string[];
}

interface ProxySettings {
  readonly default_context_window: number;
  readonly sources: readonly { type: string; url: string }[];
  readonly codex: { context_windows: Readonly<Record<string, number>> };
  readonly routes: {
    claude: {
      zai: { models: readonly RouteModel[] } & Record<string, unknown>;
    };
  };
}

const isProxySettings = (settings: unknown): settings is ProxySettings =>
  isRecord(settings) &&
  Array.isArray(settings.sources) &&
  Number.isSafeInteger(settings.default_context_window) &&
  isRecord(settings.codex) &&
  isRecord(settings.codex.context_windows) &&
  isRecord(settings.routes) &&
  isRecord(settings.routes.claude) &&
  isRecord(settings.routes.claude.zai) &&
  Array.isArray(settings.routes.claude.zai.models);

const readModelSettings = (contents: string): ProxySettings => {
  const document = parseDocument(contents, { merge: true });
  if (document.errors.length > 0) {
    throw document.errors[0];
  }
  // Unwrap effort sequences before applying ordinary YAML mapping merges.
  visit(document, {
    Pair(_key, pair) {
      if (
        !isScalar(pair.key) ||
        pair.key.value !== "efforts" ||
        !isMap(pair.value)
      ) {
        return;
      }
      const [entry] = pair.value.items;
      if (
        pair.value.items.length === 1 &&
        isScalar(entry?.key) &&
        entry.key.source === "<<"
      ) {
        pair.value = entry.value;
      }
    }
  });
  const settings: unknown = document.toJS();
  assert.ok(
    isProxySettings(settings),
    `Expected proxy model settings in ${settingsPath}`
  );
  return settings;
};

const deriveCodexAliases = (entries: Iterable<CatalogModel>) => {
  const known = [...entries].flatMap(({ slug, visibility }) => {
    const version = codexVersion(slug);
    return version ? [{ slug, version, visibility }] : [];
  });
  const latest = new Map<string, { slug: string; parts: bigint[] }>();
  for (const { slug, version, visibility } of known) {
    const previous = latest.get(version.lane);
    if (
      visibility === "list" &&
      (!previous || isNewer(version.parts, previous.parts))
    ) {
      latest.set(version.lane, {
        slug,
        parts: version.parts
      });
    }
  }
  return known.flatMap(({ slug, version }) => {
    const target = latest.get(version.lane);
    return target && isNewer(target.parts, version.parts)
      ? [{ name: target.slug, alias: slug, fork: true }]
      : [];
  });
};

const effortOrder = ["max", "xhigh", "high", "medium", "low"];

const readProxyOverrides = (contents: string) => {
  const overrides: unknown = parse(contents);
  assert.ok(Array.isArray(overrides), "Expected a list of proxy overrides");
  const edits: readonly unknown[] = overrides;
  return edits.map((edit) => {
    assert.ok(
      isRecord(edit) &&
        typeof edit.anchor === "string" &&
        edit.anchor &&
        typeof edit.content === "string" &&
        (edit.after === undefined ||
          (typeof edit.after === "string" && edit.after.length > 0)) &&
        (edit.replace === undefined || edit.replace === true) &&
        (edit["after-generation"] === undefined ||
          edit["after-generation"] === true),
      "Expected a proxy override with an anchor and content"
    );
    return {
      anchor: edit.anchor,
      after: edit.after ?? null,
      content: edit.content,
      replace: edit.replace === true,
      stage: edit["after-generation"] === true ? "generated" : "upstream"
    } as const;
  });
};

const applyProxyOverrides = (
  upstream: string,
  edits: Readonly<ReturnType<typeof readProxyOverrides>>
) => {
  let result = upstream;
  for (const { anchor, after, content, replace } of edits) {
    const prefix = after === null ? "\n" : `\n${after}\n`;
    const block = `${prefix}${anchor}\n`;
    assert.equal(
      result.split(block).length,
      2,
      `Expected one upstream block: ${block.slice(1, -1)}`
    );
    const indent = anchor.length - anchor.trimStart().length;
    const original = replace
      ? anchor
          .split("\n")
          .map((line) => `${" ".repeat(indent)}# ${line.slice(indent)}`)
          .join("\n")
      : anchor;
    result = result.replace(block, () => `${prefix}${original}\n${content}\n`);
  }
  return result;
};

const renderConfig = (
  template: string,
  catalog: ReadonlyMap<string, CatalogModel>,
  settings: ProxySettings
) => {
  const codexAliases = deriveCodexAliases(catalog.values());
  const route = settings.routes.claude.zai;
  const glmRoutes = route.models.map((model) => {
    const supported = new Set(model.efforts);
    const highest = effortOrder.find((effort) => supported.has(effort));
    assert.ok(
      highest !== undefined,
      `No usable reasoning effort for ${model.name}`
    );
    return {
      model: {
        name: model.name,
        alias: model.alias,
        "display-name": model.display_name,
        "max-context-length":
          model.context_window ?? settings.default_context_window,
        "is-compat": true,
        thinking: { levels: [...effortOrder] }
      },
      supported,
      highest
    };
  });
  const glmOverrides = effortOrder.flatMap((requested, index) => {
    const byTarget = new Map<string, string[]>();
    for (const { model, supported, highest } of glmRoutes) {
      if (!supported.has(requested)) {
        const forwarded =
          effortOrder
            .slice(0, index)
            .findLast((effort) => supported.has(effort)) ?? highest;
        byTarget.set(forwarded, [
          ...(byTarget.get(forwarded) ?? []),
          model.alias
        ]);
      }
    }
    return [...byTarget].map(([forwarded, names]) => ({
      models: names.map((name) => ({
        name,
        protocol: "claude",
        match: [{ "output_config.effort": requested }]
      })),
      params: { "output_config.effort": forwarded }
    }));
  });
  const contextTargets = new Map<string, number>();
  for (const { name, alias } of codexAliases) {
    const target = catalog.get(name);
    assert.ok(target, `Unknown catalog model: ${name}`);
    contextTargets.set(name, target.context_window);
    contextTargets.set(alias, target.context_window);
  }
  const codexContext = [...catalog].flatMap(([name, { context_window }]) => {
    const target = contextTargets.get(name);
    if (
      target === undefined &&
      !Object.hasOwn(settings.codex.context_windows, name)
    ) {
      return [];
    }
    return [
      {
        name,
        "max-context-length": target ?? context_window
      }
    ];
  });
  const sections = [
    { indent: 6, marker: "glm-overrides", entries: glmOverrides, quote: false },
    {
      indent: 0,
      marker: "routes",
      entries: {
        "api-keys": {
          claude: [
            {
              name: "zai",
              ...route,
              models: glmRoutes.map(({ model }) => model)
            }
          ]
        }
      },
      quote: false
    },
    { indent: 6, marker: "codex-aliases", entries: codexAliases, quote: true },
    { indent: 6, marker: "codex-context", entries: codexContext, quote: true }
  ];
  let result = template;
  for (const { indent, marker, entries, quote } of sections) {
    const padding = " ".repeat(indent);
    const placeholder = `\n${padding}# @${marker}\n`;
    assert.equal(
      result.split(placeholder).length,
      2,
      `Expected one @${marker}`
    );
    const rendered = stringify(entries, {
      defaultKeyType: "PLAIN",
      defaultStringType: quote ? "QUOTE_DOUBLE" : "PLAIN",
      lineWidth: 0
    }).trimEnd();
    const block = rendered.replaceAll(/^/gmu, padding);
    result = result.replaceAll(placeholder, () => `\n${block}\n`);
  }
  return result;
};

const args = process.argv.slice(2);
assert.ok(
  args.length === 0 || (args.length === 1 && args[0] === "--check"),
  "Usage: node scripts/generate-config.mts [--check]"
);
const check = args[0] === "--check";
const [upstreamProxy, proxyOverrides, settingsContents] = await Promise.all([
  check ? readFile(proxyUpstreamPath, "utf-8") : fetchText(officialProxyUrl),
  readFile("config/proxy.overrides.yaml", "utf-8"),
  readFile(settingsPath, "utf-8")
]);
const settings = readModelSettings(settingsContents);
const source = check
  ? await readFile(upstreamCatalogPath, "utf-8")
  : await fetchText(
      settings.sources.find(({ type }) => type === "codex-catalog")?.url ?? ""
    );
const catalog: unknown = JSON.parse(source);
assert.ok(
  isRecord(catalog) && Array.isArray(catalog.models),
  "Expected a Codex models array"
);
const models = new Map<string, CatalogModel>();
const sourceModels: readonly unknown[] = catalog.models;
const snapshot = sourceModels.map((entry) => {
  assert.ok(
    isRecord(entry) &&
      typeof entry.slug === "string" &&
      typeof entry.context_window === "number" &&
      entry.context_window > 0,
    "Expected a Codex model slug and context window"
  );
  const { slug, visibility, context_window } = entry;
  assertBareModelId(slug, "slug");
  assert.ok(!models.has(slug), `Duplicate catalog model: ${slug}`);
  const model = { slug, visibility, context_window };
  models.set(slug, {
    ...model,
    context_window:
      settings.codex.context_windows[slug] ??
      Math.min(context_window, settings.default_context_window)
  });
  return model;
});

const proxyConfigPath = "config.example.yaml";
const overrides = Object.groupBy(
  readProxyOverrides(proxyOverrides),
  ({ stage }) => stage
);
await using staging = await mkdtempDisposable(
  path.join(tmpdir(), "proxy-format-")
);
const stagedConfig = path.join(staging.path, proxyConfigPath);
await writeFile(
  stagedConfig,
  applyProxyOverrides(
    renderConfig(
      applyProxyOverrides(upstreamProxy, overrides.upstream ?? []),
      models,
      settings
    ),
    overrides.generated ?? []
  )
);
execFileSync("pnpm", ["exec", "ultracite", "fix", stagedConfig], {
  cwd: new URL("../", import.meta.url)
});
const config = await readFile(stagedConfig, "utf-8");
assertProxyConfig(config);
if (check) {
  const existing = await readFile(proxyConfigPath, "utf-8");
  if (existing !== config) {
    assertProxyConfig(existing);
  }
  assert.equal(
    existing,
    config,
    `${proxyConfigPath} is stale. Run pnpm run generate:config.`
  );
} else {
  await Promise.all([
    writeFile(proxyConfigPath, config),
    writeFile(proxyUpstreamPath, upstreamProxy),
    writeFile(
      upstreamCatalogPath,
      `${JSON.stringify({ models: snapshot }, null, 2)}\n`
    )
  ]);
}
