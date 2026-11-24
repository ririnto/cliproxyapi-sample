import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import { parse, stringify } from "yaml";

interface CatalogEntry extends Record<string, unknown> {
  readonly slug: string;
}

interface CatalogModel extends CatalogEntry {
  readonly context_window: number;
}

const settingsPath = "config/models.json";
const clientCatalogPath = ".codex/model_catalog.json";
const officialCatalogUrl =
  "https://raw.githubusercontent.com/openai/codex/refs/heads/main/codex-rs/models-manager/models.json";

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
  if (isRecord(config.upstream) && isRecord(config.upstream.claude)) {
    const toolSearch = config.upstream.claude["tool-search"];
    assert.ok(
      toolSearch === undefined || toolSearch === true,
      "upstream.claude.tool-search: omit the default false and use literal true to enable"
    );
  }
};

const codexVersion = (slug: string) => {
  const version =
    /^gpt-(?<major>\d+)(?:\.(?<minor>\d+))?-(?<lane>[a-zA-Z]+)$/u.exec(
      slug
    )?.groups;
  return version?.lane === undefined
    ? undefined
    : {
        lane: version.lane,
        major: Number(version.major),
        minor: Number(version.minor ?? 0)
      };
};

const modelLane = (slug: string) => {
  const codex = codexVersion(slug);
  if (codex) {
    return `gpt-${codex.lane}`;
  }
  const glm = /^glm-\d+(?:\.\d+)?(?<variant>-flash)?$/u.exec(slug)?.groups;
  return glm === undefined ? undefined : `glm${glm.variant ?? ""}`;
};

const readModelSettings = (contents: string) => {
  const settings: unknown = JSON.parse(contents);
  assert.ok(
    isRecord(settings) && Array.isArray(settings.finalModels),
    `Expected finalModels in ${settingsPath}`
  );
  const laneFinals = new Map<string, string>();
  const finalModels: readonly unknown[] = settings.finalModels;
  for (const slug of finalModels) {
    assert.ok(typeof slug === "string", "Expected a model slug in finalModels");
    const lane = modelLane(slug);
    assert.ok(lane !== undefined, `${slug} finalModels: model lane is unknown`);
    assert.ok(
      !laneFinals.has(lane),
      `${slug} finalModels: duplicate lane ${lane}`
    );
    laneFinals.set(lane, slug);
  }
  const models = new Map<
    string,
    { group: "codex" | "zai"; overrides: Record<string, unknown> }
  >();
  for (const group of ["codex", "zai"] as const) {
    const entries = settings[group];
    assert.ok(isRecord(entries), `Expected ${group} in ${settingsPath}`);
    for (const [slug, overrides] of Object.entries(entries)) {
      assertBareModelId(slug, "slug");
      assert.ok(isRecord(overrides), `Invalid model settings for ${slug}`);
      assert.ok(!models.has(slug), `Duplicate model settings for ${slug}`);
      models.set(slug, { group, overrides });
    }
  }
  return { laneFinals, models };
};

const deriveCodexAliases = (entries: Iterable<CatalogModel>) => {
  const known = [...entries].flatMap(({ slug, visibility }) => {
    const version = codexVersion(slug);
    return version ? [{ slug, version, visibility }] : [];
  });
  const latest = new Map<
    string,
    { slug: string; major: number; minor: number }
  >();
  for (const { slug, version, visibility } of known) {
    const previous = latest.get(version.lane);
    if (
      visibility === "list" &&
      (!previous ||
        version.major > previous.major ||
        (version.major === previous.major && version.minor > previous.minor))
    ) {
      latest.set(version.lane, {
        slug,
        major: version.major,
        minor: version.minor
      });
    }
  }
  return known.flatMap(({ slug, version }) => {
    const target = latest.get(version.lane);
    return target &&
      (version.major < target.major ||
        (version.major === target.major && version.minor < target.minor))
      ? [{ name: target.slug, alias: slug, fork: true }]
      : [];
  });
};

const effortOrder = ["max", "xhigh", "high", "medium", "low"];

const renderConfig = (
  template: string,
  catalog: ReadonlyMap<string, CatalogModel>
) => {
  const codexAliases = deriveCodexAliases(catalog.values());
  const glmRoutes = [...catalog].flatMap(([name, model]) => {
    if (modelSettings.get(name)?.group !== "zai") {
      return [];
    }
    const {
      context_window,
      display_name,
      supported_reasoning_levels: reasoningLevels
    } = model;
    assert.ok(
      Array.isArray(reasoningLevels),
      `Missing reasoning levels for ${name}`
    );
    const supported = new Set(
      reasoningLevels.map((level: unknown) => {
        assert.ok(
          isRecord(level) &&
            typeof level.effort === "string" &&
            level.effort.length > 0,
          `Invalid reasoning level for ${name}`
        );
        return level.effort;
      })
    );
    const highest = effortOrder.find((effort) => supported.has(effort));
    assert.ok(highest !== undefined, `No usable reasoning effort for ${name}`);
    return [
      {
        model: {
          name,
          alias: name,
          "display-name": display_name,
          "max-context-length": context_window,
          "is-compat": true,
          thinking: { levels: [...effortOrder] }
        },
        supported,
        highest
      }
    ];
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
    if (target === undefined && modelSettings.get(name)?.group !== "codex") {
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
      indent: 8,
      marker: "zai-models",
      entries: glmRoutes.map(({ model }) => model),
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
const [template, settingsContents, source] = await Promise.all([
  readFile("config/proxy.template.yaml", "utf-8"),
  readFile(settingsPath, "utf-8"),
  check
    ? readFile(clientCatalogPath, "utf-8")
    : (async () => {
        const response = await fetch(officialCatalogUrl, {
          signal: AbortSignal.timeout(20_000)
        });
        assert.ok(
          response.ok,
          `Could not fetch Codex catalog: HTTP ${response.status}`
        );
        return await response.text();
      })()
]);
const { laneFinals, models: modelSettings } =
  readModelSettings(settingsContents);
const catalog: unknown = JSON.parse(source);
assert.ok(
  isRecord(catalog) && Array.isArray(catalog.models),
  "Expected a Codex models array"
);
const entries = new Map<string, CatalogEntry>();
const sourceModels: readonly unknown[] = catalog.models;
for (const entry of sourceModels) {
  assert.ok(
    isRecord(entry) && typeof entry.slug === "string" && entry.slug,
    "Expected a nonempty catalog model slug"
  );
  assertBareModelId(entry.slug, "slug");
  assert.ok(!entries.has(entry.slug), `Duplicate catalog model: ${entry.slug}`);
  entries.set(entry.slug, { ...entry, slug: entry.slug });
}
const first = entries.values().next().value;
assert.ok(first, "Expected at least one Codex model");
const hasSearchTool = [...entries.values()].some((entry) =>
  Object.hasOwn(entry, "supports_search_tool")
);
for (const slug of modelSettings.keys()) {
  if (!entries.has(slug)) {
    entries.set(slug, { ...first, slug });
  }
}
for (const slug of laneFinals.values()) {
  assert.ok(
    entries.has(slug),
    `${slug} finalModels: missing from Codex catalog`
  );
}
const models = new Map<string, CatalogModel>();
for (const [slug, entry] of entries) {
  const updated = { ...entry };
  const final = laneFinals.get(modelLane(slug) ?? "");
  if (final !== undefined && updated.visibility !== "hide") {
    updated.visibility = final === slug ? "list" : "hide";
  }
  if (hasSearchTool && !Object.hasOwn(updated, "supports_search_tool")) {
    updated.supports_search_tool = true;
  }
  for (const [field, value] of Object.entries(
    modelSettings.get(slug)?.overrides ?? {}
  )) {
    if (field !== "slug" && Object.hasOwn(updated, field)) {
      updated[field] = value;
    }
  }
  const { context_window } = updated;
  assert.ok(
    typeof context_window === "number" &&
      Number.isSafeInteger(context_window) &&
      context_window > 0,
    `Invalid context window for ${slug}`
  );
  models.set(slug, { ...updated, context_window });
}

const proxyConfigPath = "config.example.yaml";
const config = `# Generated by pnpm run generate:config. Edit the sources in config/.\n${renderConfig(template, models)}`;
const generatedCatalog = { models: [...models.values()] };
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
  assert.ok(
    isDeepStrictEqual(catalog, generatedCatalog),
    `${clientCatalogPath} is stale. Run pnpm run generate:config.`
  );
} else {
  await Promise.all([
    writeFile(proxyConfigPath, config),
    writeFile(
      clientCatalogPath,
      `${JSON.stringify(generatedCatalog, null, 2)}\n`
    )
  ]);
}
