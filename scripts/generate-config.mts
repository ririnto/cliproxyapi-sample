import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

import { stringify } from "yaml";

import { modelRoutes } from "../config/model-routes.mts";

interface CatalogModel {
  readonly contextWindow: number;
  readonly reasoningLevels: unknown;
  readonly visibility: unknown;
}

interface CatalogEntry extends Record<string, unknown> {
  readonly slug: string;
  context_window: number;
}

const maxContextWindow = 305_000;
const officialCatalogUrl =
  "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readCatalog = (contents: string, source: string) => {
  const catalog: unknown = JSON.parse(contents);
  assert.ok(
    isRecord(catalog) && Array.isArray(catalog.models),
    `Expected a models array in ${source}`
  );
  const entries: unknown[] = catalog.models;
  const models = new Map<string, CatalogModel>();
  const catalogEntries: CatalogEntry[] = [];
  let capped = false;
  for (const entry of entries) {
    assert.ok(
      isRecord(entry) && typeof entry.slug === "string" && entry.slug,
      "Expected a nonempty catalog model slug"
    );
    const { slug, context_window, supported_reasoning_levels } = entry;
    assert.ok(!models.has(slug), `Duplicate catalog model: ${slug}`);
    assert.ok(
      typeof context_window === "number" &&
        Number.isSafeInteger(context_window) &&
        context_window > 0,
      `Invalid context window for ${slug}`
    );
    const contextWindow = Math.min(context_window, maxContextWindow);
    if (contextWindow < context_window) {
      capped = true;
    }
    catalogEntries.push({ ...entry, slug, context_window: contextWindow });
    models.set(slug, {
      contextWindow,
      reasoningLevels: supported_reasoning_levels,
      visibility: entry.visibility
    });
  }
  return {
    clientCatalog: capped
      ? `${JSON.stringify({ ...catalog, models: catalogEntries }, null, 2)}\n`
      : contents,
    catalog,
    entries: catalogEntries,
    models
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

const mergeCatalog = (officialContents: string, localContents: string) => {
  const official = readCatalog(officialContents, officialCatalogUrl);
  const local = readCatalog(localContents, "config/codex-models.json");
  const merged = new Map(official.entries.map((entry) => [entry.slug, entry]));
  for (const entry of local.entries) {
    if (!merged.has(entry.slug)) {
      merged.set(entry.slug, entry);
    }
  }
  const hiddenModels = new Set(modelRoutes.codex.hiddenModels);
  const entries = [...merged.values()];
  for (const entry of local.entries) {
    if (!official.models.has(entry.slug) && isCodexLaneSlug(entry.slug)) {
      entry.visibility = "hide";
    }
  }
  for (const { alias } of deriveCodexAliases(
    entries.map(({ slug, visibility }) => ({ slug, visibility }))
  )) {
    hiddenModels.add(alias);
  }
  for (const entry of entries) {
    if (hiddenModels.has(entry.slug)) {
      entry.visibility = "hide";
    }
  }
  return `${JSON.stringify({ ...official.catalog, models: entries }, null, 2)}\n`;
};

const requireModel = (
  models: ReadonlyMap<string, CatalogModel>,
  slug: string
) => {
  const model = models.get(slug);
  assert.ok(model, `Unknown catalog model: ${slug}`);
  return model;
};

const assertUnique = (values: readonly string[], label: string) => {
  assert.equal(new Set(values).size, values.length, `Duplicate ${label}`);
};

const codexVersion = (slug: string) => {
  const version =
    /^gpt-(?<major>\d+)(?:\.(?<minor>\d+))?-(?<tier>[a-z]+)$/u.exec(
      slug
    )?.groups;
  return version?.tier === undefined
    ? undefined
    : {
        family: version.tier,
        major: Number(version.major),
        minor: Number(version.minor ?? 0)
      };
};

const isCodexLaneSlug = (slug: string) => {
  const version = codexVersion(slug);
  return (
    version !== undefined && modelRoutes.codex.lanes.includes(version.family)
  );
};

const deriveCodexAliases = (
  models: Iterable<{ slug: string; visibility: unknown }>
) => {
  const known = [...models].flatMap(({ slug, visibility }) => {
    const version = codexVersion(slug);
    return version && modelRoutes.codex.lanes.includes(version.family)
      ? [{ slug, version, visibility }]
      : [];
  });
  const latest = new Map<
    string,
    { slug: string; major: number; minor: number }
  >();
  for (const { slug, version, visibility } of known) {
    if (visibility !== "list") {
      continue;
    }
    const previous = latest.get(version.family);
    if (
      !previous ||
      version.major > previous.major ||
      (version.major === previous.major && version.minor > previous.minor)
    ) {
      latest.set(version.family, {
        slug,
        major: version.major,
        minor: version.minor
      });
    }
  }
  const nonForkAliases = new Set(modelRoutes.codex.nonForkAliases);
  return modelRoutes.codex.lanes.flatMap((family) => {
    const target = latest.get(family);
    assert.ok(target, `No visible Codex model for lane: ${family}`);
    return known
      .filter(
        ({ version }) =>
          version.family === family &&
          (version.major < target.major ||
            (version.major === target.major && version.minor < target.minor))
      )
      .toSorted(
        (left, right) =>
          left.version.major - right.version.major ||
          left.version.minor - right.version.minor
      )
      .map(({ slug }) => ({
        name: target.slug,
        alias: slug,
        ...(nonForkAliases.has(slug) ? {} : { fork: true })
      }));
  });
};

const effortOrder = ["max", "xhigh", "high", "medium", "low"];

const renderConfig = (
  template: string,
  catalog: ReadonlyMap<string, CatalogModel>
) => {
  const { codex, zai } = modelRoutes;
  const aliases = deriveCodexAliases(
    [...catalog].map(([slug, { visibility }]) => ({ slug, visibility }))
  );
  assertUnique(
    aliases.map(({ alias }) => alias),
    "Codex alias"
  );
  for (const { alias } of aliases) {
    requireModel(catalog, alias);
  }
  assertUnique(
    zai.models.map(({ slug }) => slug),
    "Z.ai model"
  );
  const zaiRoutes = zai.models.map(({ slug, displayName }) => {
    const { contextWindow, reasoningLevels } = requireModel(catalog, slug);
    assert.ok(
      Array.isArray(reasoningLevels),
      `Missing reasoning levels for ${slug}`
    );
    const catalogLevels: unknown[] = reasoningLevels;
    const supported = new Set(
      catalogLevels.map((level) => {
        assert.ok(
          isRecord(level) &&
            typeof level.effort === "string" &&
            level.effort.length > 0,
          `Invalid reasoning level for ${slug}`
        );
        return level.effort;
      })
    );
    const highest = effortOrder.find((effort) => supported.has(effort));
    assert.ok(highest !== undefined, `No usable reasoning effort for ${slug}`);
    return {
      model: {
        name: slug,
        alias: slug,
        "display-name": displayName,
        "max-context-length": contextWindow,
        "is-compat": true,
        thinking: { levels: [...effortOrder] }
      },
      supported,
      highest
    };
  });
  // The proxy applies overrides in order. Match higher efforts before promotion.
  const zaiOverrides = effortOrder.flatMap((requested, index) => {
    const byTarget = new Map<string, string[]>();
    for (const { model, supported, highest } of zaiRoutes) {
      const forwarded =
        effortOrder
          .slice(0, index)
          .findLast((effort) => supported.has(effort)) ?? highest;
      if (requested !== forwarded) {
        const models = byTarget.get(forwarded);
        if (models) {
          models.push(model.name);
        } else {
          byTarget.set(forwarded, [model.name]);
        }
      }
    }
    return [...byTarget].map(([forwarded, models]) => ({
      models: models.map((name) => ({
        name,
        protocol: "codex",
        match: [{ "reasoning.effort": requested }]
      })),
      params: { "reasoning.effort": forwarded }
    }));
  });
  const contextTargets = new Map<string, string>();
  for (const { name, alias } of aliases) {
    contextTargets.set(name, name);
    contextTargets.set(alias, name);
  }
  const codexContext = [
    ...[...catalog.keys()].filter((name) => contextTargets.has(name)),
    ...codex.standaloneContextOverrides
  ].map((name) => ({
    name,
    "max-context-length": requireModel(
      catalog,
      contextTargets.get(name) ?? name
    ).contextWindow
  }));

  const sections = [
    { indent: 6, marker: "zai-overrides", entries: zaiOverrides, quote: false },
    {
      indent: 8,
      marker: "zai-models",
      entries: zaiRoutes.map(({ model }) => model),
      quote: false
    },
    { indent: 6, marker: "codex-aliases", entries: aliases, quote: true },
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
const [localCatalog, template] = await Promise.all([
  readFile("config/codex-models.json", "utf-8"),
  readFile("config/proxy.template.yaml", "utf-8")
]);
const catalogContents = refresh
  ? mergeCatalog(await fetchOfficialCatalog(), localCatalog)
  : localCatalog;
const parsedCatalog = readCatalog(
  catalogContents,
  refresh ? officialCatalogUrl : "config/codex-models.json"
);
const config = renderConfig(template, parsedCatalog.models);
const outputs = [
  ...(refresh
    ? [
        {
          path: "config/codex-models.json",
          contents: parsedCatalog.clientCatalog
        }
      ]
    : []),
  {
    path: "config.example.yaml",
    contents: `# Generated by pnpm run generate:config. Edit the sources in config/.\n${config}`
  },
  { path: ".codex/model_catalog.json", contents: parsedCatalog.clientCatalog }
];
await Promise.all(
  outputs.map(async ({ path, contents }) => {
    if (check) {
      assert.ok(
        (await readFile(path, "utf-8")) === contents,
        `${path} is stale. Run pnpm run generate:config.`
      );
    } else {
      await writeFile(path, contents);
    }
  })
);
