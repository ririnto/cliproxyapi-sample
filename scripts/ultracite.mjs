import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";

const [mode, ...args] = process.argv.slice(2);
const files = execFileSync(
  "git",
  [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--deduplicate"
  ],
  {
    encoding: "utf-8"
  }
)
  .split("\0")
  .filter(
    (path) => lstatSync(path, { throwIfNoEntry: false })?.isFile() === true
  );

const result = spawnSync(
  "pnpm",
  [
    "exec",
    "ultracite",
    mode === "fix" ? "fix" : "check",
    ...(args.length > 0 ? args : files)
  ],
  {
    stdio: "inherit"
  }
);
if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
