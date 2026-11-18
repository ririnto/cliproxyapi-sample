import assert from "node:assert/strict";
import { test } from "node:test";

import { lint } from "markdownlint/sync";

import noBoxDrawing from "../rules/no-box-drawing.ts";

await test("reports only the first box-drawing character per line at its UTF-16 column", () => {
  const { input } = lint({
    config: { default: false, "docs/no-box-drawing": true },
    customRules: [noBoxDrawing],
    strings: {
      input: [
        `Plain ASCII +--| and adjacent Unicode ${String.fromCodePoint(0x24_ff, 0x25_80)}`,
        String.fromCodePoint(0x1_f6_f0, 0x25_00, 0x25_7f),
        "```text",
        String.fromCodePoint(0x25_7f),
        "```",
        ""
      ].join("\n")
    }
  });
  assert.deepEqual(
    input?.map(({ lineNumber, errorRange }) => [lineNumber, errorRange]),
    [
      [2, [3, 1]],
      [4, [1, 1]]
    ]
  );
});
