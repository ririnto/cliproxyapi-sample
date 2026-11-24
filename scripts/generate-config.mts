import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import { parse, stringify } from "yaml";

interface CatalogModel {
  readonly contextWindow: number;
  readonly displayName: unknown;
  readonly reasoningLevels: unknown;
  readonly visibility: unknown;
}

interface CatalogEntry extends Record<string, unknown> {
  readonly slug: string;
  readonly context_window: number;
}

const clientContextCap = 292_000;
const settingsPath = "config/models.json";
const referencePath = "config/models.dev.json";
const referenceUrl = "https://models.dev/api.json";
const clientFields = new Map([
  ["context_window", "context_window"],
  ["description", "description"],
  ["displayName", "display_name"],
  ["input_modalities", "input_modalities"],
  ["max_context_window", "max_context_window"],
  ["supported_reasoning_levels", "supported_reasoning_levels"],
  ["visibility", "visibility"]
]);
const codexInputModalities = new Set(["text", "image", "audio"]);
const clientCatalogPath = ".codex/model_catalog.json";
const officialCatalogUrl =
  "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readModelSettings = (contents: string) => {
  const settings: unknown = JSON.parse(contents);
  assert.ok(
    isRecord(settings) && isRecord(settings.codex),
    `Expected Codex model settings in ${settingsPath}`
  );
  const { codex } = settings;
  for (const field of Object.keys(settings)) {
    assert.equal(field, "codex", `Unknown model settings section: ${field}`);
  }
  for (const group of Object.keys(codex)) {
    assert.ok(
      group === "codex" || group === "zai",
      `Unknown Codex model group: ${group}`
    );
  }
  const slugs = new Set<string>();
  return new Map(
    (["codex", "zai"] as const).flatMap((group) => {
      const section = codex[group];
      assert.ok(
        isRecord(section) &&
          Array.isArray(section.referenceProviders) &&
          section.referenceProviders.length > 0 &&
          isRecord(section.models),
        `Expected referenceProviders and models for ${group} in ${settingsPath}`
      );
      for (const field of Object.keys(section)) {
        assert.ok(
          field === "referenceProviders" || field === "models",
          `${group} ${field}: unknown model group setting`
        );
      }
      const providers = section.referenceProviders.map((id: unknown) => {
        assert.ok(
          typeof id === "string" && id.length > 0,
          `Invalid reference provider for ${group}`
        );
        return id;
      });
      return Object.entries(section.models).map(([slug, overrides]) => {
        assert.ok(isRecord(overrides), `Invalid model settings for ${slug}`);
        assert.ok(!slugs.has(slug), `Duplicate model settings for ${slug}`);
        slugs.add(slug);
        return [slug, { group, overrides, providers }] as const;
      });
    })
  );
};

const readReferenceStrings = (
  value: unknown,
  source: string
): readonly string[] => {
  const items: readonly unknown[] | undefined = Array.isArray(value)
    ? value
    : undefined;
  assert.ok(
    items !== undefined && items.every((item) => typeof item === "string"),
    `${source}: expected a list of strings in models.dev`
  );
  return items;
};

const deriveCatalogFields = (
  entry: CatalogEntry,
  model: Record<string, unknown>
) => {
  const { slug } = entry;
  const context = isRecord(model.limit) ? model.limit.context : undefined;
  assert.ok(
    context === undefined ||
      (typeof context === "number" &&
        Number.isSafeInteger(context) &&
        context > 0),
    `${slug} limit.context: expected a positive integer in models.dev`
  );
  const input = isRecord(model.modalities) ? model.modalities.input : undefined;
  const { reasoning_options: options } = model;
  assert.ok(
    options === undefined || Array.isArray(options),
    `${slug} reasoning_options: expected a list in models.dev`
  );
  const effortOption: unknown = options?.find(
    (option: unknown) => isRecord(option) && option.type === "effort"
  );
  const currentLevels: readonly unknown[] = Array.isArray(
    entry.supported_reasoning_levels
  )
    ? entry.supported_reasoning_levels
    : [];
  const supportedLevels = isRecord(effortOption)
    ? readReferenceStrings(
        effortOption.values,
        `${slug} reasoning_options.effort`
      ).map((effort) => {
        const current = currentLevels.find(
          (level) => isRecord(level) && level.effort === effort
        );
        return {
          effort,
          description:
            isRecord(current) && typeof current.description === "string"
              ? current.description
              : ""
        };
      })
    : undefined;
  if (supportedLevels && typeof entry.default_reasoning_level === "string") {
    assert.ok(
      supportedLevels.some(
        ({ effort }) => effort === entry.default_reasoning_level
      ),
      `${slug} default_reasoning_level: default effort is absent from models.dev`
    );
  }
  return new Map(
    Object.entries({
      context_window:
        context === undefined ? undefined : Math.min(context, clientContextCap),
      description: model.description,
      display_name: model.name,
      input_modalities:
        input === undefined
          ? undefined
          : readReferenceStrings(input, `${slug} modalities.input`).filter(
              (modality) => codexInputModalities.has(modality)
            ),
      max_context_window: context,
      supported_reasoning_levels: supportedLevels,
      visibility: model.visibility
    }).filter(([, value]) => value !== undefined)
  );
};

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

const fetchCatalog = async (url: string) => {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000)
  });
  assert.ok(response.ok, `Could not refresh ${url}: HTTP ${response.status}`);
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
    if (modelSettings.get(name)?.group !== "zai") {
      return [];
    }
    const { contextWindow, displayName, reasoningLevels } = model;
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
          "display-name": displayName,
          "max-context-length": contextWindow,
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
  const contextTargets = new Map<string, string>();
  for (const { name, alias } of codexAliases) {
    contextTargets.set(name, name);
    contextTargets.set(alias, name);
  }
  const codexContext = [...catalog].flatMap(([name, { contextWindow }]) => {
    const target = contextTargets.get(name);
    if (target === undefined && modelSettings.get(name)?.group !== "codex") {
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
    (args.length === 1 &&
      (args[0] === "--check" ||
        args[0] === "--refresh" ||
        args[0] === "--refresh-models-dev")),
  "Usage: node scripts/generate-config.mts [--check|--refresh|--refresh-models-dev]"
);
const check = args[0] === "--check";
const refresh = args[0] === "--refresh";
const refreshReference = args[0] === "--refresh-models-dev";
const [localContents, template, settingsContents, referenceContents] =
  await Promise.all([
    readFile(clientCatalogPath, "utf-8"),
    readFile("config/proxy.template.yaml", "utf-8"),
    readFile(settingsPath, "utf-8"),
    refreshReference
      ? fetchCatalog(referenceUrl)
      : readFile(referencePath, "utf-8")
  ]);
const modelSettings = readModelSettings(settingsContents);
const reference: unknown = JSON.parse(referenceContents);
assert.ok(isRecord(reference), "Expected models.dev providers");
const referenceProviders = new Set(
  [...modelSettings.values()].flatMap(({ providers }) => providers)
);
const snapshot = new Map(
  [...referenceProviders].map((provider) => {
    const entry = reference[provider];
    assert.ok(
      isRecord(entry) && isRecord(entry.models),
      `Missing models.dev provider: ${provider}`
    );
    const rows = entry.models;
    return [
      provider,
      {
        models: Object.fromEntries(
          [...modelSettings].flatMap(([slug, { providers }]) => {
            if (!providers.includes(provider) || !Object.hasOwn(rows, slug)) {
              return [];
            }
            const model = rows[slug];
            assert.ok(
              isRecord(model) && model.id === slug,
              `Invalid models.dev model: ${provider}/${slug}`
            );
            return [[slug, model]];
          })
        )
      }
    ] as const;
  })
);
const localCatalog = readCatalog(localContents, clientCatalogPath);
const catalog = refresh
  ? mergeCatalog(
      readCatalog(await fetchCatalog(officialCatalogUrl), officialCatalogUrl),
      localCatalog
    )
  : localCatalog;
const catalogSlugs = new Set(catalog.models.map(({ slug }) => slug));
for (const slug of modelSettings.keys()) {
  assert.ok(
    catalogSlugs.has(slug),
    `Missing configured model in Codex catalog: ${slug}`
  );
}
const clientModels = catalog.models.map((entry): CatalogEntry => {
  const settings = modelSettings.get(entry.slug);
  const model = settings?.providers
    .map((provider) => snapshot.get(provider)?.models[entry.slug])
    .find((row) => row !== undefined);
  const derived =
    model === undefined
      ? new Map<string, unknown>()
      : deriveCatalogFields(entry, model);
  const updated: Record<string, unknown> = { ...entry };
  for (const [field, value] of Object.entries(settings?.overrides ?? {})) {
    const catalogField = clientFields.get(field);
    assert.ok(
      !(model && Object.hasOwn(model, field)) &&
        !derived.has(catalogField ?? field),
      `${entry.slug} ${field}: hand-set value conflicts with models.dev`
    );
    assert.ok(
      catalogField !== undefined,
      `${entry.slug} ${field}: unknown model setting`
    );
    updated[catalogField] = value;
  }
  for (const [field, expected] of derived) {
    if (check) {
      assert.deepEqual(
        entry[field],
        expected,
        `${entry.slug} ${field}: derived value differs from models.dev`
      );
    }
    updated[field] = expected;
  }
  const contextWindow = updated.context_window;
  assert.ok(
    typeof contextWindow === "number" &&
      Number.isSafeInteger(contextWindow) &&
      contextWindow > 0,
    `Invalid context window for ${entry.slug}`
  );
  const cappedContextWindow = Math.min(contextWindow, clientContextCap);
  updated.context_window = cappedContextWindow;
  return isDeepStrictEqual(updated, entry)
    ? entry
    : { ...updated, slug: entry.slug, context_window: cappedContextWindow };
});
const config = renderConfig(
  template,
  new Map(
    clientModels.map(
      ({
        slug,
        context_window,
        display_name,
        supported_reasoning_levels,
        visibility
      }) => [
        slug,
        {
          contextWindow: context_window,
          displayName: display_name,
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
if (refreshReference) {
  outputs.push({
    path: referencePath,
    contents: `${JSON.stringify(Object.fromEntries(snapshot), null, 2)}\n`
  });
}
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
