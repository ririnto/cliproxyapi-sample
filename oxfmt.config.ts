import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

/**
 * Apply Ultracite formatting without trailing commas, preserving Markdown files
 * and the preset's existing exclusions.
 */
export default defineConfig({
  ...ultracite,
  ignorePatterns: [...(ultracite.ignorePatterns ?? []), "**/*.md"],
  trailingComma: "none"
});
