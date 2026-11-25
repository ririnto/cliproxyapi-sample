import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtempDisposable,
  readFile,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

await test("the workflow check reports only equal literal inputs for approved action refs", async () => {
  await using fixture = await mkdtempDisposable(
    path.join(tmpdir(), "workflow-input-defaults-")
  );
  const workflow = ".github/workflows/check.yml";
  const metadata = ".github/action-inputs.json";
  const approvedInputs: unknown = JSON.parse(
    await readFile(new URL(`../${metadata}`, import.meta.url), "utf-8")
  );
  assert.ok(
    typeof approvedInputs === "object" &&
      approvedInputs !== null &&
      !Array.isArray(approvedInputs)
  );
  await mkdir(path.join(fixture.path, path.dirname(workflow)), {
    recursive: true
  });
  await writeFile(
    path.join(fixture.path, metadata),
    JSON.stringify({
      ...approvedInputs,
      "pnpm/action-setup@unresolved": {
        commit: null,
        inputs: { cache: { default: "false" } }
      },
      "astral-sh/setup-uv@v7": {
        commit: "37802adc94f370d6bfd71619e3f0bf239e1f3b78",
        inputs: { "enable-cache": { default: "auto", contextDependent: true } }
      }
    })
  );
  const check = async (cache: string) => {
    await writeFile(
      path.join(fixture.path, workflow),
      `name: Check fixture
on: push
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: pnpm/action-setup@v6
        with:
          cache: ${cache}
          version: ""
      - uses: pnpm/action-setup@v6
        with:
          cache: \${{ false }}
      - uses: pnpm/action-setup@v6.0.1
        with:
          cache: false
      - uses: pnpm/action-setup@unresolved
        with:
          cache: false
      - uses: owner/unlisted@v1
        with:
          cache: false
      - uses: astral-sh/setup-uv@v7
        with:
          enable-cache: auto
      - uses: actions/checkout@v7
        with:
          sparse-checkout: ""
          filter: null
`
    );
    return spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("check-workflow-input-defaults.mts", import.meta.url)
        )
      ],
      { cwd: fixture.path, encoding: "utf-8" }
    );
  };

  const passing = await check("true");
  assert.equal(passing.status, 0, passing.stderr);
  assert.equal(passing.stderr, "");

  const failing = await check("false");
  assert.equal(failing.status, 1, failing.stderr);
  assert.equal(failing.stderr.trim().split("\n").length, 1, failing.stderr);
  assert.match(failing.stderr, /\bpnpm\/action-setup@v6(?![\w.-])/u);
  assert.match(failing.stderr, /\bcache\b/u);
});
