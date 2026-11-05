/**
 * N-new-1: the /api/v1 client's `pay()` must not silently double-spend on a retry.
 *
 * The idempotency key is what makes a retry after a lost response safe: the server returns the first
 * receipt instead of paying twice. The bug was that `pay()` minted a FRESH RANDOM key on every call,
 * so a caller retrying `pay({merchant, amount})` after a network blip sent a NEW key → a second
 * payment. The fix: derive the key deterministically from `invoiceId` when present (so an identical
 * retry dedups), use an explicit key verbatim, and fall back to random ONLY when neither is given.
 *     npm run build && node --test dist/api.idempotency.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

import { AgentPayApiClient } from "./api";

/** A fake fetch that records every request's Idempotency-Key header and returns a canned receipt. */
function installCapture() {
  const keys: string[] = [];
  const fetchImpl = async (_url: string, opts: any) => {
    keys.push(opts.headers["Idempotency-Key"]);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ receipt: { status: "accept" }, replayed: false }),
    };
  };
  const client = new AgentPayApiClient({ baseUrl: "http://fake", apiKey: "k", fetch: fetchImpl as any });
  return { client, keys };
}

test("pay() with the same invoiceId sends the SAME idempotency key on a retry (dedups)", async () => {
  const { client, keys } = installCapture();
  await client.pay({ merchant: "coffee", amount: 500, invoiceId: "inv0001abcd" });
  await client.pay({ merchant: "coffee", amount: 500, invoiceId: "inv0001abcd" }); // identical retry
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], "same invoiceId must map to the same idempotency key");
});

test("pay() passes an explicit idempotencyKey through verbatim", async () => {
  const { client, keys } = installCapture();
  await client.pay({ merchant: "coffee", amount: 500, idempotencyKey: "my-key-123" });
  assert.equal(keys[0], "my-key-123");
});

test("an explicit idempotencyKey wins over invoiceId", async () => {
  const { client, keys } = installCapture();
  await client.pay({ merchant: "coffee", amount: 500, invoiceId: "inv0001abcd", idempotencyKey: "explicit" });
  assert.equal(keys[0], "explicit");
});

test("pay() with NEITHER key nor invoiceId falls back to a per-call random key", async () => {
  const { client, keys } = installCapture();
  await client.pay({ merchant: "coffee", amount: 500 });
  await client.pay({ merchant: "coffee", amount: 500 });
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1], "with no stable identifier each call is distinct (documented: NOT retry-safe)");
  assert.match(keys[0], /^pay_[0-9a-f]+$/);
});
