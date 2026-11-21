import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

import { stringify } from "yaml";

import { modelRoutes } from "../config/model-routes.mts";

interface CatalogModel {
  readonly contextWindow: number;
  readonly reasoningLevels: unknown;
  readonly visibility: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readCatalog = (contents: string) => {
  const catalog: unknown = JSON.parse(contents);
  assert.ok(
    isRecord(catalog) && Array.isArray(catalog.models),
    "Expected a models array in config/codex-models.json"
  );
  const entries: unknown[] = catalog.models;
  const models = new Map<string, CatalogModel>();
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
    models.set(slug, {
      contextWindow: context_window,
      reasoningLevels: supported_reasoning_levels,
      visibility: entry.visibility
    });
  }
  return models;
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

const effortOrder = ["ultra", "max", "xhigh", "high", "medium", "low"];

const renderConfig = (
  template: string,
  catalog: ReadonlyMap<string, CatalogModel>
) => {
  const { codex, zai } = modelRoutes;
  const legacyAliases = new Set(codex.aliases.map(({ alias }) => alias));
  assert.equal(
    legacyAliases.size,
    codex.aliases.length,
    "Duplicate Codex alias"
  );
  const latest = new Map<
    string,
    { slug: string; major: number; minor: number }
  >();
  for (const [slug, { visibility }] of catalog) {
    const version = codexVersion(slug);
    if (version && visibility === "list" && !legacyAliases.has(slug)) {
      const { family, major, minor } = version;
      const previous = latest.get(family);
      if (
        !previous ||
        major > previous.major ||
        (major === previous.major && minor > previous.minor)
      ) {
        latest.set(family, { slug, major, minor });
      }
    }
  }
  const aliases = codex.aliases.map(({ alias, fork }) => {
    requireModel(catalog, alias);
    const version = codexVersion(alias);
    const target = version && latest.get(version.family);
    assert.ok(target, `No visible successor for Codex alias: ${alias}`);
    assert.ok(
      target.major > version.major ||
        (target.major === version.major && target.minor > version.minor),
      `Codex alias would not advance: ${alias}`
    );
    return { name: target.slug, alias, ...(fork === true ? { fork } : {}) };
  });
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
  const contextNames = new Set(
    aliases.flatMap(({ name, alias }) => [name, alias])
  );
  const codexContext = [
    ...[...catalog.keys()].filter((name) => contextNames.has(name)),
    ...codex.standaloneContextOverrides
  ].map((name) => ({
    name,
    "max-context-length": requireModel(catalog, name).contextWindow
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

const check = process.argv[2] === "--check";
assert.ok(
  process.argv.length === 2 || (check && process.argv.length === 3),
  "Usage: node scripts/generate-config.mts [--check]"
);
const [catalog, template] = await Promise.all([
  readFile("config/codex-models.json", "utf-8"),
  readFile("config/proxy.template.yaml", "utf-8")
]);
const config = renderConfig(template, readCatalog(catalog));
const outputs = [
  {
    path: "config.example.yaml",
    contents: `# Generated by pnpm run generate. Edit the sources in config/.\n${config}`
  },
  { path: ".codex/model_catalog.json", contents: catalog }
];
await Promise.all(
  outputs.map(async ({ path, contents }) => {
    if (check) {
      assert.ok(
        (await readFile(path, "utf-8")) === contents,
        `${path} is stale. Run pnpm run generate.`
      );
    } else {
      await writeFile(path, contents);
    }
  })
);
