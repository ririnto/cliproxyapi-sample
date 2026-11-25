import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { isMap, isScalar, parseDocument, visit } from "yaml";

const root = path.resolve(import.meta.dirname, "..");
const overridesDocument = parseDocument(
  fs.readFileSync(
    path.join(root, ".codex/model_catalog.override.yaml"),
    "utf-8"
  ),
  { merge: true }
);
if (overridesDocument.errors.length > 0) {
  throw overridesDocument.errors[0];
}

// Unwrap the list and its anchor before applying normal YAML mapping merges.
visit(overridesDocument, {
  Pair(_key, pair) {
    if (
      !isScalar(pair.key) ||
      pair.key.value !== "supported_reasoning_levels" ||
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
/** @type {unknown} */
const catalogOverrides = overridesDocument.toJS();
const officialCatalogUrl =
  "https://raw.githubusercontent.com/openai/codex/refs/heads/main/codex-rs/models-manager/models.json";
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

/** @param {unknown} source Official Codex model catalog. */
const resolveModelCatalog = (source) => {
  const overrideModels = parseModels(catalogOverrides);
  const overridesBySlug = new Map(
    overrideModels.map((model) => [model.slug, model])
  );
  const upstreamModels = parseModels(source);
  const [template] = upstreamModels;
  if (template === undefined) {
    throw new Error("Official Codex catalog requires at least one model");
  }
  const upstreamSlugs = new Set(upstreamModels.map(({ slug }) => slug));
  const lastPriority = upstreamModels.at(-1)?.priority;
  if (typeof lastPriority !== "number" || !Number.isSafeInteger(lastPriority)) {
    throw new TypeError("Invalid final upstream model priority");
  }
  /** @type {CatalogModel[]} */
  const originalModels = [
    ...upstreamModels.map((model) => ({
      ...model,
      ...overridesBySlug.get(model.slug)
    })),
    ...overrideModels
      .filter(({ slug }) => !upstreamSlugs.has(slug))
      .map((model, index) => ({
        ...template,
        ...model,
        priority: lastPriority + index + 1
      }))
  ];

  const versions = modelVersions(originalModels);
  /** @type {Map<string, ModelVersion>} */
  const latestByLane = new Map();
  for (const { slug } of originalModels) {
    const version = versions.get(slug);
    const current = version && latestByLane.get(version.lane);
    if (
      version !== undefined &&
      (current === undefined || isNewer(version, current))
    ) {
      latestByLane.set(version.lane, version);
    }
  }
  const contextLimit = 292_000;
  /** @type {CatalogModel[]} */
  return originalModels.map((base) => {
    const { slug } = base;
    const version = versions.get(slug);
    const latest = version && latestByLane.get(version.lane);
    const hidden =
      (base.upgrade !== null && base.upgrade !== undefined) ||
      (latest !== undefined && latest.slug !== slug);
    const contextWindow = base.context_window;
    return {
      ...base,
      ...(hidden ? { visibility: "hide" } : {}),
      ...(typeof contextWindow === "number" && contextWindow > contextLimit
        ? { context_window: contextLimit }
        : {})
    };
  });
};

const check = process.argv.at(-1) === "--check";
const args = process.argv.slice(2, check ? -1 : undefined);
const sourcePath = args.at(0);
if (
  args.length > 1 ||
  sourcePath === "" ||
  sourcePath?.startsWith("--") === true
) {
  throw new Error(
    `Usage: node scripts/update-model-catalog.mjs [<source> | -] [--check]`
  );
}

/** @type {unknown} */
const source = JSON.parse(
  sourcePath === undefined
    ? await fetchSource(officialCatalogUrl)
    : fs.readFileSync(sourcePath === "-" ? 0 : sourcePath, "utf-8")
);
const input = JSON.stringify({ models: resolveModelCatalog(source) }, null, 2);
const file = ".codex/model_catalog.json";
const content = execFileSync(
  "pnpm",
  ["exec", "oxfmt", "--stdin-filepath", file],
  {
    cwd: root,
    encoding: "utf-8",
    input,
    maxBuffer: 4 * 1024 * 1024
  }
);
const target = path.join(root, file);
if (!fs.existsSync(target) || fs.readFileSync(target, "utf-8") !== content) {
  if (check) {
    throw new Error(`Regenerate stale model configuration: ${file}`);
  }
  const temporaryPath = `${target}.tmp`;
  fs.writeFileSync(temporaryPath, content);
  fs.renameSync(temporaryPath, target);
}
