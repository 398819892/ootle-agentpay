/**
 * #1 + #2 (TS mirror of sdk/tests/test_substate.py):
 *   #1 — `readInfo()` decodes the name-keyed `AgentBudget.info` event, so a same-type field swap is
 *        caught (the positional read cannot see it); `readWindow()` falls back to positional when the
 *        info event is absent.
 *   #2 — `open()` locates the new component from the `std.component.created` event, not by guessing
 *        the first unknown component address in the result blob.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { OnChainBudget } from "./budget";

const TMPL = "template_" + "ab".repeat(32);
const OWNER = "component_" + "9".repeat(64);
const COMPONENT = "component_" + "c".repeat(64);

const PAYLOAD: Record<string, string> = {
  revoked: "false", balance: "5000", per_tx_cap: "1000", daily_cap: "1500",
  spent_in_window: "250", window_start_epoch: "2", epochs_per_window: "100",
};

function infoResult(payload: Record<string, string>): any {
  return { result: { finalize: { events: [{ topic: "AgentBudget.info", payload }] } } };
}

class FakeClient {
  dryRunResult: any = { result: { finalize: { events: [] } } };
  substateResult: any = null;
  runResult: any = null;
  epoch = 7;
  async dryRun(_m: string, _v: any) { return this.dryRunResult; }
  async getSubstate(_id: string) { return this.substateResult; }
  async run(_m: string, _v: any) { return this.runResult; }
  async currentEpoch() { return this.epoch; }
}

function budgetWith(client: FakeClient, component: string | null = COMPONENT): OnChainBudget {
  const b = new OnChainBudget(client as any, TMPL, OWNER);
  b.component = component;
  return b;
}

test("readInfo decodes the name-keyed info event", async () => {
  const c = new FakeClient(); c.dryRunResult = infoResult(PAYLOAD);
  const info = await budgetWith(c).readInfo();
  assert.equal(info.perTxCap, "1000");
  assert.equal(info.dailyCap, "1500");
  assert.equal(info.spentInWindow, "250");
  assert.equal(info.windowStartEpoch, "2");
  assert.equal(info.epochsPerWindow, "100");
  assert.equal(info.balance, "5000");
  assert.equal(info.revoked, false);
});

test("readInfo is order-independent (catches a same-type field swap)", async () => {
  const reordered: Record<string, string> = {};
  for (const k of Object.keys(PAYLOAD).reverse()) reordered[k] = PAYLOAD[k];
  const c = new FakeClient(); c.dryRunResult = infoResult(reordered);
  const info = await budgetWith(c).readInfo();
  assert.equal(info.perTxCap, "1000"); // still right despite reversed key order
  assert.equal(info.dailyCap, "1500");
});

test("readInfo throws on a missing or mistyped field", async () => {
  const c1 = new FakeClient(); c1.dryRunResult = infoResult({ ...PAYLOAD, daily_cap: "abc" });
  await assert.rejects(() => budgetWith(c1).readInfo());
  const c2 = new FakeClient(); c2.dryRunResult = infoResult({ ...PAYLOAD, revoked: "maybe" });
  await assert.rejects(() => budgetWith(c2).readInfo());
  const c3 = new FakeClient();
  const missing = { ...PAYLOAD }; delete (missing as any).per_tx_cap;
  c3.dryRunResult = infoResult(missing);
  await assert.rejects(() => budgetWith(c3).readInfo());
});

test("readInfo throws when there is no info event", async () => {
  const c = new FakeClient(); c.dryRunResult = { result: { finalize: { events: [] } } };
  await assert.rejects(() => budgetWith(c).readInfo());
});

test("readWindow falls back to the positional read when no info event", async () => {
  const c = new FakeClient();
  c.dryRunResult = { result: { finalize: { events: [] } } }; // no info event -> fallback
  c.substateResult = { substate: { Component: { body: { state: [
    { tag: 132, value: { hex: "ab".repeat(32) } },
    { tag: 131, value: { hex: "11".repeat(32) } },
    { tag: 131, value: { hex: "22".repeat(32) } },
    1000, 3000, 500, 0, 48, [], false, [],
  ] } } } };
  const w = await budgetWith(c).readWindow();
  assert.equal(w.spentInWindow, 500); // read positionally, not from an info event
});

test("open locates the new component from the std.component.created event (#2)", async () => {
  const created = "component_" + "cd".repeat(32);
  const decoy = "component_" + "ee".repeat(32);
  const c = new FakeClient();
  c.runResult = { result: { events: [
    { topic: "std.resource.create", substate_id: "resource_" + "11".repeat(32), template_address: "ab".repeat(32), payload: {} },
    { topic: "std.component.created", substate_id: created, template_address: "ab".repeat(32), payload: {} },
  ], decoy } }; // `decoy` appears in the JSON blob but is NOT the created component
  c.substateResult = { substate: { Component: { body: { state: [
    { tag: 132, value: { hex: "ab".repeat(32) } },
    { tag: 131, value: { hex: "11".repeat(32) } },
    { tag: 131, value: { hex: "22".repeat(32) } },
  ] } } } };
  const b = new OnChainBudget(c as any, TMPL, OWNER);
  await b.open({ fund: 5000, perTxCap: 1000, dailyCap: 1500, epochsPerWindow: 100, whitelist: [] });
  assert.equal(b.component, created); // the event's substate_id, never the decoy
});
