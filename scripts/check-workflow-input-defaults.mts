import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";

const metadataFile = ".github/action-inputs.json";
const workflowDirectory = ".github/workflows";
const commitSha = /^[\da-f]{40}$/iu;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const metadata: unknown = JSON.parse(await readFile(metadataFile, "utf-8"));
assert.ok(isRecord(metadata), `Expected an action mapping in ${metadataFile}`);

const defaultsByAction = new Map<string, Map<string, string>>();
for (const [action, entry] of Object.entries(metadata)) {
  if (
    !isRecord(entry) ||
    typeof entry.commit !== "string" ||
    !commitSha.test(entry.commit) ||
    !isRecord(entry.inputs)
  ) {
    continue;
  }
  const ref = action.slice(action.lastIndexOf("@") + 1);
  if (commitSha.test(ref) && ref.toLowerCase() !== entry.commit.toLowerCase()) {
    continue;
  }
  const defaults = new Map<string, string>();
  for (const [name, input] of Object.entries(entry.inputs)) {
    if (
      isRecord(input) &&
      typeof input.default === "string" &&
      input.contextDependent !== true &&
      !input.default.includes("${{")
    ) {
      defaults.set(name, input.default);
    }
  }
  defaultsByAction.set(action, defaults);
}

const workflowEntries = await readdir(workflowDirectory, {
  withFileTypes: true
});
const workflows = await Promise.all(
  workflowEntries
    .filter(
      (entry) =>
        entry.isFile() && [".yaml", ".yml"].includes(path.extname(entry.name))
    )
    .map(({ name }) => path.join(workflowDirectory, name))
    .toSorted((left, right) => left.localeCompare(right, "en"))
    .map(async (file) => ({ file, contents: await readFile(file, "utf-8") }))
);

for (const { file, contents } of workflows) {
  const lineCounter = new LineCounter();
  const workflow = parseDocument(contents, { lineCounter });
  assert.equal(
    workflow.errors.length,
    0,
    `${file}: ${workflow.errors.join("\n")}`
  );
  const jobs = workflow.get("jobs", true);
  const steps = isMap(jobs)
    ? jobs.items.flatMap(({ value: job }) => {
        const jobSteps = isMap(job) ? job.get("steps", true) : null;
        return isSeq(jobSteps) ? jobSteps.items : [];
      })
    : [];
  for (const step of steps) {
    if (!isMap(step)) {
      continue;
    }
    const action = step.get("uses");
    if (typeof action !== "string") {
      continue;
    }
    const defaults = defaultsByAction.get(action);
    const inputs = step.get("with", true);
    if (!defaults || !isMap(inputs)) {
      continue;
    }
    for (const { key, value } of inputs.items) {
      if (!isScalar(key) || typeof key.value !== "string" || !isScalar(value)) {
        continue;
      }
      const scalar = value.value;
      if (
        scalar !== null &&
        typeof scalar !== "string" &&
        typeof scalar !== "boolean" &&
        !(
          typeof scalar === "number" &&
          Number.isInteger(scalar) &&
          Math.abs(scalar) < 1e15
        )
      ) {
        continue;
      }
      const literal = String(scalar ?? "");
      if (!literal.includes("${{") && defaults.get(key.value) === literal) {
        const { line } = lineCounter.linePos(key.range?.[0] ?? 0);
        process.stderr.write(
          `${file}:${line}: ${action} input ${key.value} equals its declared default ${JSON.stringify(literal)}. Omit the input.\n`
        );
        process.exitCode = 1;
      }
    }
  }
}
