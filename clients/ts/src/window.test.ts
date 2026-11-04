//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause

// windowStatus derives dailyCapWorstCase = 2 * dailyCap: the daily cap binds within each FIXED epoch
// window, so spend can reach ~2x the cap across a boundary (templates/agent_budget/src/lib.rs). The
// value is surfaced so callers don't double it themselves — mirrors the Python SDK's
// `daily_cap_worst_case` (onchain.py read_onchain_state).
//     npm run build && node --test dist/window.test.js

import assert from "node:assert/strict";
import test from "node:test";

import { windowStatus } from "./window";

test("windowStatus exposes the 2x worst-case ceiling", () => {
  const s = windowStatus({
    dailyCap: 3000,
    spentInWindow: 500,
    windowStartEpoch: 10,
    epochsPerWindow: 48,
    currentEpoch: 20,
  });
  assert.equal(s.dailyCap, 3000);
  assert.equal(s.dailyCapWorstCase, 6000);
  assert.equal(s.dailyCapWorstCase, 2 * s.dailyCap);
});

test("dailyCapWorstCase clamps a negative cap to 0 like dailyCap", () => {
  const s = windowStatus({
    dailyCap: -5,
    spentInWindow: 0,
    windowStartEpoch: 0,
    epochsPerWindow: 48,
    currentEpoch: 0,
  });
  assert.equal(s.dailyCap, 0);
  assert.equal(s.dailyCapWorstCase, 0);
});
