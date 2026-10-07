import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

/** Apply Ultracite's core lint rules and its existing file exclusions. */
export default defineConfig({
  extends: [core],
  ignorePatterns: core.ignorePatterns
});
