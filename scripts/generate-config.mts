import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

import { parse, stringify } from "yaml";

import models from "../config/models.json" with { type: "json" };

interface ModelSettings {
  readonly context_window?: number;
  readonly max_context_window?: number;
  readonly visibility?: string;
  readonly displayName?: string;
}

interface CatalogModel {
  readonly contextWindow: number;
  readonly reasoningLevels: unknown;
  readonly visibility: unknown;
}

interface CatalogEntry extends Record<string, unknown> {
  readonly slug: string;
  readonly context_window: number;
}

const maxContextWindow = 292_000;
const codexModels: Readonly<Record<string, ModelSettings>> = models.codex.codex;
const zai: Readonly<Record<string, ModelSettings>> = models.codex.zai;
const modelSettings = new Map([
  ...Object.entries(codexModels),
  ...Object.entries(zai)
]);
const clientCatalogPath = ".codex/model_catalog.json";
const officialCatalogUrl =
  "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertBareModelId = (id: string, field: "alias" | "name" | "slug") => {
  assert.ok(
    !id.startsWith("zai/"),
    `Model ${field} ${JSON.stringify(id)} cannot start with the "zai/" prefix.`
  );
};

const assertBareModelIds = (contents: string) => {
  const config: unknown = parse(contents, { merge: true });
  assert.ok(isRecord(config), "Expected a proxy configuration mapping");
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

const readCatalog = (contents: string, source: string) => {
  const catalog: unknown = JSON.parse(contents);
  assert.ok(
    isRecord(catalog) && Array.isArray(catalog.models),
    `Expected a models array in ${source}`
  );
  const slugs = new Set<string>();
  return {
    ...catalog,
    models: catalog.models.map((entry: unknown): CatalogEntry => {
      assert.ok(
        isRecord(entry) && typeof entry.slug === "string" && entry.slug,
        "Expected a nonempty catalog model slug"
      );
      const { slug, context_window } = entry;
      assertBareModelId(slug, "slug");
      assert.ok(!slugs.has(slug), `Duplicate catalog model: ${slug}`);
      assert.ok(
        typeof context_window === "number" &&
          Number.isSafeInteger(context_window) &&
          context_window > 0,
        `Invalid context window for ${slug}`
      );
      slugs.add(slug);
      return { ...entry, slug, context_window };
    })
  };
};

const fetchOfficialCatalog = async () => {
  const response = await fetch(officialCatalogUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000)
  });
  assert.ok(
    response.ok,
    `Could not refresh official Codex catalog: HTTP ${response.status}`
  );
  return await response.text();
};

const mergeCatalog = (
  official: ReturnType<typeof readCatalog>,
  local: ReturnType<typeof readCatalog>
) => {
  const merged = new Map(official.models.map((entry) => [entry.slug, entry]));
  for (const entry of local.models) {
    if (!merged.has(entry.slug)) {
      merged.set(
        entry.slug,
        codexVersion(entry.slug) ? { ...entry, visibility: "hide" } : entry
      );
    }
  }
  const entries = [...merged.values()];
  const aliases = new Set(
    deriveCodexAliases(
      entries.map(({ slug, visibility }) => ({ slug, visibility }))
    ).map(({ alias }) => alias)
  );
  return {
    ...official,
    models: entries.map((entry) =>
      aliases.has(entry.slug) ? { ...entry, visibility: "hide" } : entry
    )
  };
};

const requireModel = (
  catalog: ReadonlyMap<string, CatalogModel>,
  slug: string
) => {
  const model = catalog.get(slug);
  assert.ok(model, `Unknown catalog model: ${slug}`);
  return model;
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

const deriveCodexAliases = (
  entries: Iterable<{ slug: string; visibility: unknown }>
) => {
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
  const codexAliases = deriveCodexAliases(
    [...catalog].map(([slug, { visibility }]) => ({ slug, visibility }))
  );
  const glmRoutes = [...catalog].flatMap(([name, model]) => {
    const settings = Object.hasOwn(zai, name)
      ? modelSettings.get(name)
      : undefined;
    if (settings === undefined) {
      return [];
    }
    const { contextWindow, reasoningLevels } = model;
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
          "display-name": settings.displayName,
          "max-context-length": contextWindow,
          "is-compat": true,
          thinking: { levels: [...effortOrder] }
        },
        supported,
        highest
      }
    ];
  });
  assert.equal(
    glmRoutes.length,
    Object.keys(zai).length,
    "Missing ZAI model in Codex catalog"
  );
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
  const contextTargets = new Map<string, string>();
  for (const { name, alias } of codexAliases) {
    contextTargets.set(name, name);
    contextTargets.set(alias, name);
  }
  const codexContext = [...catalog].flatMap(([name, { contextWindow }]) => {
    const target = contextTargets.get(name);
    if (target === undefined && !Object.hasOwn(codexModels, name)) {
      return [];
    }
    return [
      {
        name,
        "max-context-length":
          target === undefined
            ? contextWindow
            : requireModel(catalog, target).contextWindow
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
  args.length === 0 ||
    (args.length === 1 && (args[0] === "--check" || args[0] === "--refresh")),
  "Usage: node scripts/generate-config.mts [--check|--refresh]"
);
const check = args[0] === "--check";
const refresh = args[0] === "--refresh";
const [localContents, template] = await Promise.all([
  readFile(clientCatalogPath, "utf-8"),
  readFile("config/proxy.template.yaml", "utf-8")
]);
const localCatalog = readCatalog(localContents, clientCatalogPath);
const catalog = refresh
  ? mergeCatalog(
      readCatalog(await fetchOfficialCatalog(), officialCatalogUrl),
      localCatalog
    )
  : localCatalog;
const clientModels = catalog.models.map((entry): CatalogEntry => {
  const settings = modelSettings.get(entry.slug);
  const contextWindow = Math.min(
    settings?.context_window ?? entry.context_window,
    maxContextWindow
  );
  const maxWindow = settings?.max_context_window ?? entry.max_context_window;
  const displayName = settings?.displayName ?? entry.display_name;
  const visibility = settings?.visibility ?? entry.visibility;
  return contextWindow === entry.context_window &&
    maxWindow === entry.max_context_window &&
    displayName === entry.display_name &&
    visibility === entry.visibility
    ? entry
    : {
        ...entry,
        display_name: displayName,
        context_window: contextWindow,
        max_context_window: maxWindow,
        visibility
      };
});
const config = renderConfig(
  template,
  new Map(
    clientModels.map(
      ({ slug, context_window, supported_reasoning_levels, visibility }) => [
        slug,
        {
          contextWindow: context_window,
          reasoningLevels: supported_reasoning_levels,
          visibility
        }
      ]
    )
  )
);
assertBareModelIds(config);
const proxyConfigPath = "config.example.yaml";
const outputs = [
  {
    path: proxyConfigPath,
    contents: `# Generated by pnpm run generate:config. Edit the sources in config/.\n${config}`
  },
  {
    path: clientCatalogPath,
    contents:
      refresh ||
      clientModels.some((entry, index) => entry !== catalog.models[index])
        ? `${JSON.stringify({ ...catalog, models: clientModels }, null, 2)}\n`
        : localContents
  }
];
await Promise.all(
  outputs.map(async ({ path, contents }) => {
    if (check) {
      const existing = await readFile(path, "utf-8");
      if (path === proxyConfigPath && existing !== contents) {
        assertBareModelIds(existing);
      }
      assert.ok(
        existing === contents,
        `${path} is stale. Run node scripts/generate-config.mts.`
      );
    } else {
      await writeFile(path, contents);
    }
  })
);
