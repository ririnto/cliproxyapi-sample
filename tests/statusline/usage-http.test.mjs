import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { usageRuntime } from "../../.claude/statusline.mjs";

const { requestJson } = usageRuntime;

await test("returns the HTTP status and aborts a stalled error body", async (t) => {
  const stream = new EventTarget();
  t.after(() => {
    stream.dispatchEvent(new Event("close"));
  });
  const cancel = t.mock.fn(async () => {
    await once(stream, "close");
  });
  const response = new Response(new ReadableStream({ cancel }), {
    status: 401
  });
  const aborted = t.mock.fn();
  const result = await requestJson(
    "https://example.test/usage",
    {},
    (_url, options) => {
      options.signal.addEventListener("abort", aborted, { once: true });
      return response;
    },
    undefined
  );
  assert.deepEqual(result, { status: 401 });
  assert.equal(cancel.mock.callCount(), 1);
  assert.equal(aborted.mock.callCount(), 1);
});
