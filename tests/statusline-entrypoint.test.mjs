import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const fixture = async (context) => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "statusline-entry-"))
  );
  context.after(() => rm(root, { force: true, recursive: true }));
  const installed = path.join(root, "installed");
  const project = path.join(root, "project");
  await Promise.all([
    mkdir(installed),
    mkdir(path.join(project, ".claude"), { recursive: true })
  ]);
  await writeFile(
    path.join(project, ".claude", "settings.json"),
    JSON.stringify({ statusLineAddon: [] })
  );
  const script = path.join(installed, "statusline.mjs");
  await copyFile(new URL("../.claude/statusline.mjs", import.meta.url), script);
  const directoryLink = path.join(root, "linked directory");
  const scriptLink = path.join(root, "linked script.mjs");
  await Promise.all([
    symlink(installed, directoryLink, "dir"),
    symlink(script, scriptLink, "file")
  ]);
  const input = JSON.stringify({
    model: { display_name: "Fixture model" },
    workspace: { current_dir: project, project_dir: project }
  });
  const run = (args, stdin = input, environment = {}) => {
    const result = spawnSync(process.execPath, args, {
      encoding: "utf-8",
      env: {
        HOME: root,
        STATUSLINE_MODULE: pathToFileURL(script).href,
        ...environment
      },
      input: stdin,
      timeout: 5000
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    return result.stdout;
  };
  return { directoryLink, root, run, script, scriptLink };
};

test("Git branch lookup terminates a stalled child that ignores SIGTERM", async (context) => {
  const { root, run, script } = await fixture(context);
  const git = path.join(root, "git");
  const pidFile = path.join(root, "git.pid");
  const environment = { PATH: root };
  await writeFile(
    git,
    `#!${process.execPath}\nconsole.log("fixture-branch");\n`
  );
  await chmod(git, 0o755);
  assert.match(run([script], undefined, environment), /fixture-branch/u);
  await writeFile(
    git,
    `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nprocess.on("SIGTERM", () => {});\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`
  );
  let pid;
  try {
    const output = run([script], undefined, environment);
    pid = Number(await readFile(pidFile, "utf-8"));
    assert.match(output, /Fixture model/u);
    assert.equal(output.trim().split("\n").length, 2);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    pid ??= Number(await readFile(pidFile, "utf-8"));
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      assert.equal(error.code, "ESRCH");
    }
  }
});

test("direct execution through a script or directory symlink renders exactly once", async (context) => {
  const { directoryLink, run, script, scriptLink } = await fixture(context);
  for (const target of [
    script,
    scriptLink,
    path.join(directoryLink, "statusline.mjs")
  ]) {
    const output = run([target]);
    assert.match(output, /Fixture model/u);
    assert.equal(output.trim().split("\n").length, 2);
    const preserved = run(["--preserve-symlinks-main", target]);
    assert.match(preserved, /Fixture model/u);
    assert.equal(preserved.trim().split("\n").length, 2);
  }
});

test("importing the module does not consume stdin or render status rows", async (context) => {
  const { run } = await fixture(context);
  const output = run([
    "--input-type=module",
    "-e",
    'await import(process.env.STATUSLINE_MODULE); console.log("Imported");'
  ]);
  assert.equal(output, "Imported\n");
});

test("an unrelated missing argv entrypoint does not break module import", async (context) => {
  const { run } = await fixture(context);
  const output = run([
    "--input-type=module",
    "-e",
    'await import(process.env.STATUSLINE_MODULE); console.log("Imported");',
    "missing-entrypoint"
  ]);
  assert.equal(output, "Imported\n");
});

test("malformed stdin remains silent through a symlinked entrypoint", async (context) => {
  const { run, scriptLink } = await fixture(context);
  assert.equal(run([scriptLink], "invalid JSON"), "");
});

test("provider labels render on one line without control characters", async (context) => {
  const { root, run, script } = await fixture(context);
  const addon = path.join(root, "hostile.mjs");
  await writeFile(
    addon,
    'export const fetchUsage = async () => ({groups:[{label:"EVIL\\nFAKE ROW\\u001B[31m",metrics:[{label:"5h\\nSPOOF",type:"percentage",percentage:42}]}]});'
  );
  await writeFile(
    path.join(root, "project", ".claude", "settings.json"),
    JSON.stringify({ statusLineAddon: [{ name: "Fixture", script: addon }] })
  );
  const output = run([script]);
  assert.match(output, /EVIL FAKE ROW/u);
  assert.match(output, /5h SPOOF/u);
  assert.equal(output.trim().split("\n").length, 3);
  assert.equal(output.includes("\u001B[31m"), false);
});
