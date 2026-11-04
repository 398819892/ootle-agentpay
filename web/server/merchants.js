//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause
/** Merchant resolution: friendly name <-> validated component address (manifest-injection safe). */
"use strict";

const { httpError } = require("./http_util");

function createMerchants({ store, saveStore, nameByAddr, walletd, autoCreate: AUTO_CREATE_MERCHANTS, ChainError }) {
  /**
   * Resolve a merchant to a component address. A `component_…` address is used verbatim; a friendly
   * name is looked up on chain. If the account does not exist it is created + faucet-funded ONLY when
   * AUTO_CREATE_MERCHANTS is enabled (open local-dev mode); otherwise a clear error is returned so a
   * public deployment is never a free account-minting / faucet-draining endpoint.
   */
  // A component address is exactly `component_` + 64 lowercase hex. The resolved value is spliced
  // into a transaction manifest as `address!("…")`, so it must match this exactly — a loose
  // `startsWith("component_")` would let `component_x") ; owner.withdraw(…` break out of the literal
  // and inject manifest instructions (issue #7). Account-name lookups below return a chain-minted
  // address, which we re-validate to the same shape before it can reach a manifest (defence in depth).
  const COMPONENT_ADDR_RE = /^component_[0-9a-f]{64}$/;

  async function resolveMerchant(nameOrAddr) {
    const raw = String(nameOrAddr || "").trim();
    if (!raw) throw httpError(400, "A merchant name or component address is required.");
    if (raw.startsWith("component_")) {
      // Validate the address shape BEFORE any daemon call: this value is spliced into a manifest.
      if (!COMPONENT_ADDR_RE.test(raw)) {
        throw httpError(400, "That is not a valid component_… address (expected component_ + 64 hex chars).");
      }
      return raw; // already a (now validated) address
    }
    const key = raw.toLowerCase();
    if (store.merchants[key]) {
      const cached = store.merchants[key];
      // A snapshot written before this check could hold a malformed address; re-validate on read.
      if (!COMPONENT_ADDR_RE.test(String(cached))) {
        throw httpError(502, "A cached merchant address has an unexpected shape; re-resolve the merchant.");
      }
      return cached;
    }
    const c = await walletd();
    let addr;
    try {
      addr = await c.accountAddress(key);
    } catch (e) {
      if (!(e instanceof ChainError)) throw e;
      if (!AUTO_CREATE_MERCHANTS) {
        throw httpError(
          400,
          `No account named "${key}" was found on chain. Paste the merchant's component_… address, ` +
            `or provision and fund the account out of band. (Auto-creating merchant accounts is ` +
            `disabled on this deployment.)`,
        );
      }
      addr = await c.createAccount(key);
      await c.fund(key);
    }
    if (!COMPONENT_ADDR_RE.test(String(addr))) {
      throw httpError(502, "The wallet returned an unexpected merchant address shape.");
    }
    // Confirm the account is actually COMMITTED ON CHAIN before we cache it or hand it to add_merchant.
    // On a network where the faucet cannot provision a new account (e.g. the esmeralda public testnet,
    // where `create_free_test_coins` is effectively a no-op), creation "succeeds" in the wallet but no
    // substate is committed — add_merchant would then fail with a confusing engine 404 ("Substate …
    // does not exist"), and we must NOT poison the cache with a non-existent address (a re-add of the
    // same name would keep failing). A clear error here tells the operator exactly what to do instead.
    try {
      await c.getSubstate(String(addr));
    } catch (e) {
      if (!(e instanceof ChainError)) throw e;
      throw httpError(
        400,
        `Merchant account "${key}" (${addr}) is not on chain: this network could not auto-provision it ` +
          `(the faucet is unavailable on a public testnet like esmeralda). Create and fund the account ` +
          `out of band, then paste its component_… address here instead of a name.`,
      );
    }
    store.merchants[key] = addr;
    saveStore();
    return addr;
  }

  /**
   * Resolve a merchant for REMOVAL: a validated `component_…` address, or a name already known to the
   * local alias table. Unlike `resolveMerchant` this never asks walletd and never auto-creates an
   * account — you cannot remove what was never added, and a typo must not provision a devnet account.
   */
  function lookupMerchant(nameOrAddr) {
    const raw = String(nameOrAddr || "").trim();
    if (!raw) throw httpError(400, "A merchant name or component address is required.");
    if (raw.startsWith("component_")) {
      if (!COMPONENT_ADDR_RE.test(raw)) {
        throw httpError(400, "That is not a valid component_… address (expected component_ + 64 hex chars).");
      }
      return { name: nameByAddr()[raw] || null, address: raw };
    }
    const key = raw.toLowerCase();
    const cached = store.merchants[key];
    if (!cached || !COMPONENT_ADDR_RE.test(String(cached))) {
      throw httpError(400, `No merchant named "${key}" is known here. Paste its component_… address instead.`);
    }
    return { name: key, address: cached };
  }

  return { COMPONENT_ADDR_RE, resolveMerchant, lookupMerchant };
}

module.exports = { createMerchants };
