import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { fetchUsage } from "./minimax-token-plan.mjs";

test("disposes HTTP error response bodies before returning", async () => {
  let cancellations = 0;
  let requestSignal;
  const errorResponse = new Response(
    new ReadableStream({
      cancel() {
        cancellations += 1;
      }
    }),
    { status: 503 }
  );
  const result = await fetchUsage({
    cache: false,
    credential: "synthetic-minimax-token",
    fetch: (_url, options) => {
      requestSignal = options.signal;
      return errorResponse;
    }
  });
  assert.equal(result, undefined);
  assert.equal(cancellations, 1);
  assert.equal(requestSignal.aborted, true);
  assert.equal(errorResponse.bodyUsed, true);
});

test("returns when HTTP error body cancellation stalls until timeout", async () => {
  let cancellations = 0;
  let requestSignal;
  const result = await Promise.race([
    fetchUsage({
      cache: false,
      credential: "synthetic-minimax-token",
      fetch: (_url, options) => {
        requestSignal = options.signal;
        return new Response(
          new ReadableStream({
            cancel() {
              cancellations += 1;
              return Promise.withResolvers().promise;
            }
          }),
          { status: 503 }
        );
      }
    }),
    delay(3500, "stalled")
  ]);
  assert.notEqual(result, "stalled");
  assert.equal(result, undefined);
  assert.equal(cancellations, 1);
  assert.equal(requestSignal.aborted, true);
});
