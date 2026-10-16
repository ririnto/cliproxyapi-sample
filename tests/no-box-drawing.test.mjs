import assert from "node:assert/strict";
import { test } from "node:test";

import { lint } from "markdownlint/sync";

import noBoxDrawing from "../rules/no-box-drawing.ts";

const violations = (input) => {
  const result = lint({
    config: { default: false, "docs/no-box-drawing": true },
    customRules: [noBoxDrawing],
    strings: { input }
  });
  return (result.input ?? []).map((error) => ({
    lineNumber: error.lineNumber,
    range: error.errorRange
  }));
};

test("accepts ASCII-only Markdown", () => {
  assert.deepEqual(
    violations("Plain ASCII text with +-- and | markers.\n"),
    []
  );
});

test("rejects both Unicode block boundaries and reports physical line ranges", () => {
  const lowerBoundary = String.fromCodePoint(0x25_00);
  const upperBoundary = String.fromCodePoint(0x25_7f);
  assert.deepEqual(
    violations(
      [
        `Before ${lowerBoundary} ${upperBoundary}`,
        "```text",
        upperBoundary,
        "```",
        ""
      ].join("\n")
    ),
    [
      { lineNumber: 1, range: [8, 1] },
      { lineNumber: 3, range: [1, 1] }
    ]
  );
});

test("reports one violation per physical line", () => {
  const lowerBoundary = String.fromCodePoint(0x25_00);
  const upperBoundary = String.fromCodePoint(0x25_7f);
  assert.deepEqual(violations(`${lowerBoundary} a\n${upperBoundary} b\n`), [
    { lineNumber: 1, range: [1, 1] },
    { lineNumber: 2, range: [1, 1] }
  ]);
  assert.deepEqual(violations(`${lowerBoundary}${upperBoundary}\n`), [
    { lineNumber: 1, range: [1, 1] }
  ]);
});

test("reports diagnostic coordinates after an astral prefix", () => {
  assert.deepEqual(violations(`\u{1F6F0}${String.fromCodePoint(0x25_00)}\n`), [
    { lineNumber: 1, range: [3, 1] }
  ]);
});
