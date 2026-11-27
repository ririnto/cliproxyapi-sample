import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

import matter from "@11ty/gray-matter";
import { stringify } from "smol-toml";

interface AgentSource {
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
    url: "https://raw.githubusercontent.com/cursor/plugins/refs/heads/main/pstack/agents/poteto-agent.md",
    path: ".codex/agents/poteto-agent.toml"
  },
  {
    url: "https://raw.githubusercontent.com/cursor/plugins/refs/heads/main/pstack/agents/comment-sicko.md",
    path: ".codex/agents/comment-sicko.toml"
  }
];

const adaptPotetoCommand = (text: string) =>
  text.replaceAll(/(?<![\w/])\/poteto-mode(?![\w/])/gu, "$pstack:poteto-mode");

const parseAgent = (markdown: string): AgentDefinition => {
  const { data, content } = matter(markdown);
  return {
    name: String(data.name),
    description: adaptPotetoCommand(String(data.description)),
    developer_instructions: adaptPotetoCommand(content)
  };
};

const outputs = await Promise.all(
  sources.map(async ({ url, path }) => {
    const response = await fetch(url, {
      headers: { accept: "text/plain" },
      signal: AbortSignal.timeout(20_000)
    });
    assert.ok(response.ok, `Could not fetch ${url}: HTTP ${response.status}`);
    return { path, contents: stringify(parseAgent(await response.text())) };
  })
);
await Promise.all(
  outputs.map(async ({ path, contents }) => {
    await writeFile(path, contents);
  })
);
