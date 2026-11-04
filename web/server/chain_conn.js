//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause
/**
 * The one walletd connection: lazily opened, the owner address resolved once, and a serial mutex so
 * on-chain ops never interleave. `conn` is a shared mutable handle ({ wd, ownerAddr }) so the other
 * modules observe the live connection state (e.g. `conn.wd.lastTxId`) rather than a stale copy.
 */
"use strict";

function createChainConn({ client, url, finalizeTries, finalizeDelayMs, owner }) {
  const { WalletdClient, ChainError, PolicyViolation } = client;
  const conn = { wd: null, ownerAddr: null };

  async function walletd() {
    if (!conn.wd) {
      conn.wd = await new WalletdClient(url, { finalizeTries, finalizeDelayMs }).connect();
    }
    if (!conn.ownerAddr) conn.ownerAddr = await conn.wd.accountAddress(owner);
    return conn.wd;
  }

  // ---- a tiny serial mutex: on-chain ops must not interleave ------------------------------------
  let chainBusy = Promise.resolve();
  function serialize(fn) {
    const run = chainBusy.then(fn, fn);
    // keep the chain going even if one op throws
    chainBusy = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function chainMessage(e) {
    if (e instanceof PolicyViolation) return e.message;
    if (e instanceof ChainError) return e.message;
    return e && e.message ? e.message : "The chain rejected the transaction.";
  }

  return { conn, walletd, serialize, chainMessage };
}

module.exports = { createChainConn };
