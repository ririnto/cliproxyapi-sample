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

  const expectedModels = ["glm-5.3", "glm-5.3-flash"];
  assert.deepEqual(
    mappings(zai.get("models")).map((model) => [
      model.get("name"),
      model.get("alias")
    ]),
    expectedModels.map((model) => [model, model])
  );
  const overrides = config.getIn(["requests", "payload", "override"]);
  for (const [incoming, outgoing] of [
    ["xhigh", "max"],
    ["medium", "high"],
    ["minimal", "low"]
  ]) {
    const rule = mappings(overrides).find(
      (entry) => entry.getIn(["params", "reasoning.effort"]) === outgoing
    );
    assert.ok(rule);
    assert.deepEqual(
      mappings(rule.get("models")).map((model) => [
        model.get("name"),
        model.get("protocol"),
        model.getIn(["match", 0, "reasoning.effort"])
      ]),
      expectedModels.map((model) => [model, "codex", incoming])
    );
  }
});
