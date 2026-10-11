import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const settings = JSON.parse(
  await readFile(new URL("../.claude/settings.json", import.meta.url), "utf-8")
);

const withSettings = async (run) => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "statusline-config-"))
  );
  try {
    const home = path.join(root, "home with spaces");
    const global = path.join(home, ".claude");
    const custom = path.join(root, "custom with spaces");
    const project = path.join(root, "project");
    const local = path.join(project, ".claude");
    await Promise.all(
      [global, custom, local].map((dir) => mkdir(dir, { recursive: true }))
    );
    const addon = path.join(root, "addon.mjs");
    await writeFile(
      addon,
      'export const fetchUsage = async ({credential}) => ({groups:[{label:credential,metrics:[{label:"5h",type:"percentage",percentage:42}]}]});'
    );
    await Promise.all(
      [
        [global, "Default credential"],
        [custom, "Custom credential"],
        [local, "Project credential"]
      ].map(async ([dir, label]) => {
        await Promise.all([
          writeFile(path.join(dir, "credential.txt"), label),
          writeFile(
            path.join(dir, "settings.json"),
            JSON.stringify({
              statusLineAddon: [
                {
                  credential: "{file:credential.txt}",
                  name: "Fixture",
                  script: addon
                }
              ]
            })
          )
        ]);
      })
    );
    await Promise.all(
      [global, custom].map((dir) =>
        copyFile(
          new URL("../.claude/statusline.mjs", import.meta.url),
          path.join(dir, "statusline.mjs")
        )
      )
    );
    const render = (configDir) => {
      const result = spawnSync("sh", ["-c", settings.statusLine.command], {
        encoding: "utf-8",
        env: {
          CLAUDE_CONFIG_DIR: configDir,
          HOME: home,
          PATH: process.env.PATH
        },
        input: JSON.stringify({
          workspace: { current_dir: project, project_dir: project }
        }),
        timeout: 5000
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    await run({ custom, local, render });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

test("custom configuration directory loads global settings and credential files", async () => {
  await withSettings(async ({ custom, local, render }) => {
    await rm(path.join(local, "settings.json"));
    assert.match(render(custom), /Custom credential/u);
  });
});

test("empty configuration directory retains the default home settings", async () => {
  await withSettings(async ({ local, render }) => {
    await rm(path.join(local, "settings.json"));
    assert.match(render(""), /Default credential/u);
  });
});

test("project addon settings and credential directory override custom global settings", async () => {
  await withSettings(({ custom, render }) => {
    const output = render(custom);
    assert.match(output, /Project credential/u);
    assert.doesNotMatch(output, /Custom credential/u);
  });
});

test("an empty project addon list suppresses global addons", async () => {
  await withSettings(async ({ custom, local, render }) => {
    await writeFile(
      path.join(local, "settings.json"),
      JSON.stringify({ statusLineAddon: [] })
    );
    assert.doesNotMatch(render(custom), /credential/u);
  });
});

test("unreadable project settings fall back to custom global settings", async () => {
  await withSettings(async ({ custom, local, render }) => {
    await writeFile(path.join(local, "settings.json"), "invalid JSON");
    assert.match(render(custom), /Custom credential/u);
  });
});
