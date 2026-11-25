import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { isMap, isScalar, parse, parseDocument, stringify, visit } from "yaml";

const root = path.resolve(import.meta.dirname, "..");
/** @param {string} url URL of the upstream source file. */
const fetchSource = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    throw new Error(`Could not load ${url}: HTTP ${response.status}`);
  }
  return await response.text();
};

/**
 * @param {unknown} value Untrusted source catalog.
 * @returns {value is Record<string, unknown>} Whether the value is an object.
 */
const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** @typedef {Record<string, unknown> & {slug: string}} CatalogModel */

/**
 * @param {unknown} value Untrusted source catalog.
 * @returns {CatalogModel[]} Source model records.
 */
const parseModels = (value) => {
  if (!isRecord(value) || !Array.isArray(value.models)) {
    throw new TypeError("Model catalog requires a models array");
  }
  const models = value.models.map((model) => {
    if (!isRecord(model) || typeof model.slug !== "string") {
      throw new TypeError("Model catalog entry requires a slug");
    }
    return { ...model, slug: model.slug };
  });
  if (new Set(models.map(({ slug }) => slug)).size !== models.length) {
    throw new Error("Duplicate model slug");
  }
  return models;
};

const versionedLanePattern =
  /^gpt-(?<version>[0-9]+(?:\.[0-9]+)*)-(?<lane>[A-Za-z]+)$/u;

/** @typedef {{slug: string, lane: string, version: bigint[]}} ModelVersion */

/** @type {(candidate: ModelVersion, current: ModelVersion) => boolean} */
const isNewer = (candidate, current) => {
  for (
    let index = 0;
    index < Math.max(candidate.version.length, current.version.length);
    index += 1
  ) {
    const part = candidate.version[index] ?? 0n;
    const previous = current.version[index] ?? 0n;
    if (part !== previous) {
      return part > previous;
    }
  }
  return false;
};

/** @param {CatalogModel[]} models Source model records. */
const modelVersions = (models) => {
  /** @type {Map<string, ModelVersion>} */
  const versions = new Map();
  for (const { slug } of models) {
    const { lane, version } = versionedLanePattern.exec(slug)?.groups ?? {};
    if (lane !== undefined && version !== undefined) {
      versions.set(slug, {
        slug,
        lane,
        version: version.split(".").map(BigInt)
      });
    }
  }
  return versions;
};

/** @param {CatalogModel[]} upstreamModels Official upstream model records. */
const resolveUpstreamAliases = (upstreamModels) => {
  const versions = modelVersions(upstreamModels);
  /** @type {Map<string, ModelVersion>} */
  const latestListedByLane = new Map();
  for (const { slug, visibility } of upstreamModels) {
    const version = versions.get(slug);
    const current = version && latestListedByLane.get(version.lane);
    if (
      visibility === "list" &&
      version !== undefined &&
      (current === undefined || isNewer(version, current))
    ) {
      latestListedByLane.set(version.lane, version);
    }
  }

  /** @type {Record<string, string>} */
  const aliases = Object.fromEntries(
    upstreamModels.flatMap(({ slug }) => {
      const version = versions.get(slug);
      if (version === undefined) {
        return [];
      }
      const target = latestListedByLane.get(version.lane);
      return target !== undefined && isNewer(target, version)
        ? [[slug, target.slug]]
        : [];
    })
  );
  return { aliases, latestListedByLane };
};

/** @param {unknown} value YAML mapping. */
const readMap = (value) => {
  if (!isRecord(value)) {
    throw new TypeError("Expected a YAML mapping");
  }
  return value;
};

/** @param {unknown} value YAML sequence. */
const readList = (value) => {
  if (!Array.isArray(value)) {
    throw new TypeError("Expected a YAML sequence");
  }
  /** @type {unknown[]} */
  const items = value;
  return items;
};

/** @param {unknown} value YAML string. */
const readString = (value) => {
  if (typeof value !== "string") {
    throw new TypeError("Expected a YAML string");
  }
  return value;
};

/** @param {unknown} value Context size. */
const readWindow = (value) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Expected a positive context window");
  }
  return value;
};

/** @param {unknown} raw Configured model. */
const readRouteModel = (raw) => {
  const model = readMap(raw);
  return {
    alias: readString(model.alias),
    name: readString(model.name),
    display_name: readString(model.display_name),
    efforts: readList(model.efforts).map(readString),
    context_window:
      model.context_window === undefined
        ? undefined
        : readWindow(model.context_window)
  };
};

const modelsDocument = parseDocument(
  fs.readFileSync(path.join(process.cwd(), "cliproxyapi/models.yaml"), "utf-8"),
  { merge: true }
);
if (modelsDocument.errors.length > 0) {
  throw modelsDocument.errors[0];
}

// Unwrap the list and its anchor before applying normal YAML mapping merges.
visit(modelsDocument, {
  Pair(_key, pair) {
    if (
      isScalar(pair.key) &&
      pair.key.value === "efforts" &&
      isMap(pair.value)
    ) {
      const [entry] = pair.value.items;
      if (
        pair.value.items.length === 1 &&
        isScalar(entry?.key) &&
        entry.key.source === "<<"
      ) {
        pair.value = entry.value;
      }
    }
  }
});
/** @type {unknown} */
const rawConfig = modelsDocument.toJS();
const modelConfig = readMap(rawConfig);
const defaultContextWindow = readWindow(modelConfig.default_context_window);
const zai = readMap(readMap(readMap(modelConfig.routes).claude).zai);
const sources = readList(modelConfig.sources).map(readMap);

/**
 * @param {string} upstream Upstream configuration.
 */
const applyTemplate = (upstream) => {
  /** @type {unknown} */
  const proxyOverrides = parse(
    fs.readFileSync("cliproxyapi/config.overrides.yaml", "utf-8")
  );
  if (!Array.isArray(proxyOverrides)) {
    throw new TypeError("CLIProxyAPI overrides require a list of edits");
  }
  let proxy = upstream;
  for (const override of proxyOverrides) {
    if (
      !isRecord(override) ||
      typeof override.anchor !== "string" ||
      typeof override.insert !== "string"
    ) {
      throw new TypeError("CLIProxyAPI override requires an anchor and insert");
    }
    const { anchor, comment, insert } = override;
    const original = `\n${anchor}\n`;
    if (proxy.split(original).length !== 2) {
      throw new Error(`Expected one CLIProxyAPI upstream anchor: ${anchor}`);
    }
    const indent = anchor.length - anchor.trimStart().length;
    const retained =
      comment === true
        ? anchor
            .split("\n")
            .map((line) => `${line.slice(0, indent)}# ${line.slice(indent)}`)
            .join("\n")
        : anchor;
    proxy = proxy.replace(original, () => `\n${retained}\n${insert}\n`);
  }
  return proxy;
};

/**
 * @param {string} template Upstream sample.
 * @param {CatalogModel[]} catalog Official Codex models.
 */
const renderConfig = (template, catalog) => {
  const { aliases, latestListedByLane } = resolveUpstreamAliases(catalog);
  const codexAliases = Object.entries(aliases).map(([alias, name]) => ({
    name,
    alias,
    fork: true
  }));
  const effortOrder = ["max", "xhigh", "high", "medium", "low"];
  const glmRoutes = readList(zai.models)
    .map(readRouteModel)
    .map((model) => {
      const supported = new Set(model.efforts);
      const highest = effortOrder.find((effort) => supported.has(effort));
      if (highest === undefined) {
        throw new Error(`No usable reasoning effort for ${model.name}`);
      }
      return {
        model: {
          name: model.name,
          alias: model.alias,
          "display-name": model.display_name,
          "max-context-length": model.context_window ?? defaultContextWindow,
          "is-compat": true,
          thinking: { levels: effortOrder }
        },
        supported,
        highest
      };
    });
  const rules = effortOrder.flatMap((requested, index) => {
    /** @type {Map<string, string[]>} */
    const byTarget = new Map();
    for (const { model, supported, highest } of glmRoutes) {
      if (!supported.has(requested)) {
        const forwarded =
          effortOrder
            .slice(0, index)
            .findLast((level) => supported.has(level)) ?? highest;
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
  const entries = new Map(catalog.map((model) => [model.slug, model]));
  const codexContext = [
    ...[...latestListedByLane.values()].map(({ slug }) => slug),
    ...Object.keys(aliases)
  ].map((slug) => {
    const target = entries.get(aliases[slug] ?? slug);
    const maximum = target?.max_context_window ?? target?.context_window;
    const context = readWindow(maximum);
    return {
      name: slug,
      "max-context-length": Math.min(context, defaultContextWindow)
    };
  });
  const sections = [
    {
      marker: "routes",
      indent: 0,
      quote: false,
      value: {
        "api-keys": {
          claude: [
            { name: "zai", ...zai, models: glmRoutes.map(({ model }) => model) }
          ]
        }
      }
    },
    { marker: "glm-overrides", indent: 6, quote: false, value: rules },
    { marker: "codex-aliases", indent: 6, quote: true, value: codexAliases },
    { marker: "codex-context", indent: 6, quote: true, value: codexContext }
  ];
  let proxy = template;
  for (const { marker, indent, quote, value } of sections) {
    const padding = " ".repeat(indent);
    const placeholder = `\n${padding}# @${marker}\n`;
    if (proxy.split(placeholder).length !== 2) {
      throw new Error(`Expected one @${marker} in CLIProxyAPI template`);
    }
    const block = stringify(value, {
      aliasDuplicateObjects: false,
      defaultKeyType: "PLAIN",
      defaultStringType: quote ? "QUOTE_DOUBLE" : "PLAIN",
      lineWidth: 0
    })
      .trimEnd()
      .replaceAll(/^/gmu, padding);
    proxy = proxy.replaceAll(placeholder, () => `\n${block}\n`);
  }

  return proxy;
};

const [sourcePath] = process.argv.slice(2);
const url = readString(
  sources.find(({ type }) => type === "codex-catalog")?.url
);
const [catalogText, upstream] = await Promise.all([
  sourcePath === undefined
    ? fetchSource(url)
    : fs.readFileSync(sourcePath === "-" ? 0 : sourcePath, "utf-8"),
  fetchSource(
    "https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/refs/heads/main/config.example.yaml"
  )
]);
const catalog = parseModels(JSON.parse(catalogText));
const input = renderConfig(applyTemplate(upstream), catalog);
const file = "config.example.yaml";
using staging = fs.mkdtempDisposableSync(
  path.join(tmpdir(), "model-generation-")
);
const staged = path.join(staging.path, path.basename(file));
fs.writeFileSync(staged, input);
execFileSync("pnpm", ["exec", "ultracite", "fix", staged], { cwd: root });
const content = fs.readFileSync(staged, "utf-8");
const target = path.resolve(file);
if (!fs.existsSync(target) || fs.readFileSync(target, "utf-8") !== content) {
  const temporaryPath = `${target}.tmp`;
  fs.writeFileSync(temporaryPath, content);
  fs.renameSync(temporaryPath, target);
}
