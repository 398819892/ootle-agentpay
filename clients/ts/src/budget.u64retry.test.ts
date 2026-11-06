//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause

/**
 * Batch-2 hardening regressions (6th-round review) — TypeScript client.
 *
 * - `epochs_per_window` is validated (u64: non-negative integer, in range) BEFORE it is spliced into a
 *   manifest, so a negative / NaN / Infinity value fails early instead of producing `-5u64` / `NaNu64`.
 * - A READ-ONLY status dry-run (`readInfo`) passes a SHORT retry budget to `dryRun`, so a jittery
 *   indexer stalls a status read for seconds, not the ~6 min a real submit tolerates.
 *
 * A fake WalletdClient records runs / captures the dryRun retry arg; no chain is needed.
 *     npm run build && node --test dist/budget.u64retry.test.js
 */
import assert from "node:assert/strict";
import test from "node:test";

import { OnChainBudget } from "./budget";
import { ChainError } from "./errors";
import { WalletdClient } from "./walletd";

const TPL = "template_" + "7".repeat(64);
const OWNER = "component_" + "9".repeat(64);
const SHOP = "component_" + "1".repeat(64);
const OWNER_BADGE = "resource_" + "a".repeat(64);
const AGENT_BADGE = "resource_" + "b".repeat(64);

class FakeWalletd extends WalletdClient {
  runs: Array<{ manifest: string; variables: Record<string, string> }> = [];
  dryRunRetry: { tries?: number; delayMs?: number } | undefined;
  constructor() {
    super("http://fake");
  }
  async connect(): Promise<this> {
    return this;
  }
  async run(manifest: string, variables: Record<string, string>): Promise<any> {
    this.runs.push({ manifest, variables });
    return { result: { Accept: {} } };
  }
  async dryRun(
    _manifest: string, _variables: Record<string, string>, _maxFee?: number,
    retry?: { tries?: number; delayMs?: number },
  ): Promise<any> {
    this.dryRunRetry = retry;
    return {
      result: { events: [{ topic: "AgentBudget.info", payload: {
        revoked: "false", balance: "1000", per_tx_cap: "100", daily_cap: "500",
        spent_in_window: "0", window_start_epoch: "1", epochs_per_window: "48",
      } }] },
    };
  }
}

function budget(): { b: OnChainBudget; fake: FakeWalletd } {
  const fake = new FakeWalletd();
  const b = new OnChainBudget(fake, TPL, OWNER);
  b.component = "component_" + "c".repeat(64);
  b.ownerBadge = OWNER_BADGE;
  b.agentBadge = AGENT_BADGE;
  b.perTxCap = "1000";
  b.dailyCap = "3000";
  b.whitelist = [SHOP];
  return { b, fake };
}

const BAD_U64 = [-1, 1.5, NaN, Infinity, -Infinity];

test("open() rejects an invalid epochs_per_window before submitting", async () => {
  for (const bad of BAD_U64) {
    const fake = new FakeWalletd();
    const b = new OnChainBudget(fake, TPL, OWNER);
    await assert.rejects(
      () => b.open({ fund: 1000, perTxCap: 100, dailyCap: 500, epochsPerWindow: bad, whitelist: [SHOP] }),
      ChainError,
    );
    assert.equal(fake.runs.length, 0); // rejected while building the manifest — nothing was submitted
  }
});

test("setWindow() rejects an invalid epochs_per_window", async () => {
  const { b, fake } = budget();
  await assert.rejects(() => b.setWindow(-5), ChainError);
  assert.equal(fake.runs.length, 0);
});

test("readInfo uses a short read-only dry-run retry budget (not the full submit budget)", async () => {
  const { b, fake } = budget();
  const info = await b.readInfo();
  assert.equal(info.epochsPerWindow, "48");
  assert.deepEqual(fake.dryRunRetry, { tries: 3, delayMs: 2000 });
});
