import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

import { stringify } from "smol-toml";
import { parse } from "yaml";

interface AgentSource {
  readonly name: string;
  readonly url: string;
  readonly path: string;
}

interface AgentDefinition {
  readonly name: string;
  readonly description: string;
  readonly developer_instructions: string;
}

const sources: readonly AgentSource[] = [
  {
    name: "poteto-agent",
    url: "https://raw.githubusercontent.com/cursor/plugins/refs/heads/main/pstack/agents/poteto-agent.md",
    path: ".codex/agents/poteto-agent.toml"
  },
  {
    name: "comment-sicko",
    url: "https://raw.githubusercontent.com/cursor/plugins/refs/heads/main/pstack/agents/comment-sicko.md",
    path: ".codex/agents/comment-sicko.toml"
  }
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const adaptCodexText = (text: string) =>
  text
    .replaceAll(
      /(?<![\w/])\/poteto-mode(?![\w/])/gu,
      () => "$pstack:poteto-mode"
    )
    .replaceAll("~/.cursor/plugins/", "~/.codex/plugins/")
    .replaceAll(".cursor-plugin/plugin.json", "plugin.json");

const adaptCodexInstructions = (instructions: string) =>
  adaptCodexText(instructions).replace(
    "`eslint-disable`, `@ts-ignore`, `@ts-expect-error`, and similar suppressions stink.",
    "Inline lint-disable comments, TypeScript error directives, and similar suppressions stink."
  );

const parseAgent = (source: AgentSource, markdown: string): AgentDefinition => {
  const match =
    /^---[ \t]*\r?\n(?<frontmatter>[\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)(?<body>[\s\S]*)$/u.exec(
      markdown
    )?.groups;
  assert.ok(match, `Missing YAML frontmatter in ${source.url}`);
  const metadata: unknown = parse(match.frontmatter);
  assert.ok(isRecord(metadata), `Invalid YAML frontmatter in ${source.url}`);
  assert.equal(
    metadata.name,
    source.name,
    `Unexpected agent name in ${source.url}`
  );
  assert.ok(
    typeof metadata.description === "string" && metadata.description.trim(),
    `Missing agent description in ${source.url}`
  );
  assert.ok(match.body.trim(), `Missing agent instructions in ${source.url}`);

  return {
    name: source.name,
    description: adaptCodexText(metadata.description),
    developer_instructions: adaptCodexInstructions(
      match.body.replaceAll("\r\n", "\n").replace(/^(?:[ \t]*\n)+/u, "")
    )
  };
};

const fetchMarkdown = async (source: AgentSource) => {
  const response = await fetch(source.url, {
    headers: { accept: "text/plain" },
    signal: AbortSignal.timeout(20_000)
  });
  assert.ok(
    response.ok,
    `Could not fetch ${source.url}: HTTP ${response.status}`
  );
  return await response.text();
};

const outputs = await Promise.all(
  sources.map(async (source) => ({
    path: source.path,
    contents: stringify(parseAgent(source, await fetchMarkdown(source)))
  }))
);
await Promise.all(
  outputs.map(async ({ path, contents }) => {
    await writeFile(path, contents);
  })
);
