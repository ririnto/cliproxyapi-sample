import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { isMap, isSeq, parseDocument } from "yaml";

/** @param {unknown} value - A YAML sequence of mappings. */
const mappings = (value) => {
  assert.ok(isSeq(value));
  return value.items.map((entry) => {
    assert.ok(isMap(entry));
    return entry;
  });
};

await test("Z.ai GLM config keeps qualified and bare IDs and Codex effort overrides", () => {
  const config = parseDocument(
    readFileSync(new URL("../config.example.yaml", import.meta.url), "utf-8")
  );
  assert.deepEqual(config.errors, []);

  const codexKeys = config.getIn(["api-keys", "codex"]);
  const zai = mappings(codexKeys).find((group) => group.get("name") === "zai");
  assert.ok(zai);
  assert.equal(zai.get("prefix"), "zai");
  assert.equal(config.getIn(["routing", "force-model-prefix"]), false);

  const models = mappings(zai.get("models"));
  const overrides = mappings(config.getIn(["requests", "payload", "override"]));
  for (const id of ["glm-5.3", "glm-5.3-flash"]) {
    assert.equal(
      models.find((model) => model.get("alias") === id)?.get("name"),
      id
    );
    for (const [input, output] of [
      ["xhigh", "max"],
      ["medium", "high"],
      ["minimal", "low"]
    ]) {
      const matching = overrides.filter((rule) =>
        mappings(rule.get("models")).some(
          (model) =>
            model.get("name") === id &&
            model.get("protocol") === "codex" &&
            model.getIn(["match", 0, "reasoning.effort"]) === input
        )
      );
      assert.deepEqual(
        matching.map((rule) => rule.getIn(["params", "reasoning.effort"])),
        [output],
        `${id} ${input}`
      );
    }
  }
});
