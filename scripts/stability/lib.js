#!/usr/bin/env node
/**
 * Shared helpers for the AgentPay stability harness (scripts/stability/*).
 *
 * - startBackend(): spawn the UNMODIFIED dashboard backend (web/server/server.js) as a child
 *   process with env overrides (its own port, isolated state/txlog files, a walletd URL pointing at
 *   the mock), wait until it is listening, and return a handle with the EXACT child PID so a crash
 *   test can send it a precise, gentle SIGKILL/SIGTERM — never pkill, never the real swarm.
 * - startMock(): spawn mock_walletd.js and return { port, ctl, state, reset, stop }.
 * - api/op clients: thin fetch wrappers for /api/v1 and the browser op endpoint.
 * - assert helpers + a tiny coloured reporter.
 *
 * Zero dependencies; Node 18 (global fetch).
 */
"use strict";
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

const REPO = path.resolve(__dirname, "..", "..");
const SERVER = path.join(REPO, "web", "server", "server.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addr = () => "component_" + crypto.randomBytes(32).toString("hex");

function tmpDir(tag) {
  const d = path.join(process.env.STAB_TMP || "/tmp/ap_stab", `${tag}_${process.pid}_${Date.now()}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

async function waitHttp(url, { tries = 100, delay = 150 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.status < 500 || r.status === 503) return true;
    } catch { /* not up yet */ }
    await sleep(delay);
  }
  throw new Error(`timed out waiting for ${url}`);
}

// ---- mock walletd -----------------------------------------------------------------------------
async function startMock({ port } = {}) {
  port = port || 13000 + Math.floor(Math.random() * 1000);
  const child = spawn("node", [path.join(__dirname, "mock_walletd.js"), String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  await waitHttp(`${base}/__state`);
  const ctl = (patch) => fetch(`${base}/__control`, { method: "POST", body: JSON.stringify(patch) }).then((r) => r.json());
  const state = () => fetch(`${base}/__state`).then((r) => r.json());
  const reset = () => fetch(`${base}/__reset`, { method: "POST" }).then((r) => r.json());
  return {
    port, base, url: `${base}/json_rpc`, ctl, state, reset,
    get log() { return log; },
    stop: () => { try { child.kill("SIGKILL"); } catch {} },
  };
}

// ---- dashboard backend ------------------------------------------------------------------------
async function startBackend({ port, walletdUrl, stateFile, txlogFile, env = {}, apiKeys, finalizeTries, finalizeDelayMs, label } = {}) {
  port = port || 8800 + Math.floor(Math.random() * 100);
  const childEnv = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    AGENTPAY_WALLETD_URL: walletdUrl,
    AGENTPAY_STATE_FILE: stateFile,
    AGENTPAY_TXLOG_FILE: txlogFile,
    AGENTPAY_OWNER_ACCOUNT: "default",
    AGENTPAY_BUDGET_TEMPLATE: "template_" + "0".repeat(64),
    AGENTPAY_API_KEYS: apiKeys != null ? apiKeys : "agent:a1:agentsecret-0123456789, admin:ad1:adminsecret-0123456789",
    AGENTPAY_FINALIZE_TRIES: String(finalizeTries != null ? finalizeTries : 8),
    AGENTPAY_FINALIZE_DELAY_MS: String(finalizeDelayMs != null ? finalizeDelayMs : 120),
    // open local-dev mode: no DASHBOARD_PASSWORD so the browser gate is off; /api/v1 uses key auth.
    ...env,
  };
  delete childEnv.DASHBOARD_PASSWORD; // ensure open mode unless a test sets it via env
  if (env.DASHBOARD_PASSWORD) childEnv.DASHBOARD_PASSWORD = env.DASHBOARD_PASSWORD;

  const child = spawn("node", [SERVER], { stdio: ["ignore", "pipe", "pipe"], env: childEnv });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  const h = {
    port, base, pid: child.pid, child, stateFile, txlogFile, label: label || `be:${port}`,
    get log() { return log; },
    kill: (sig = "SIGKILL") => new Promise((resolve) => {
      if (child.exitCode != null || child.signalCode != null) return resolve();
      child.once("exit", () => resolve());
      try { child.kill(sig); } catch { resolve(); }
    }),
  };
  try {
    await waitHttp(`${base}/api/v1`);
  } catch (e) {
    throw new Error(`backend ${h.label} did not start on ${port}: ${e.message}\n--- log ---\n${log}`);
  }
  return h;
}

// ---- API clients ------------------------------------------------------------------------------
function apiClient(base, key) {
  const H = { Authorization: "Bearer " + key, "Content-Type": "application/json" };
  return {
    base,
    async pay(body, idemKey) {
      const headers = { ...H };
      if (idemKey) headers["Idempotency-Key"] = idemKey;
      const r = await fetch(`${base}/api/v1/payments`, { method: "POST", headers, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
    async getPayment(id) {
      const r = await fetch(`${base}/api/v1/payments/${encodeURIComponent(id)}`, { headers: H });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
    async listPayments() {
      const r = await fetch(`${base}/api/v1/payments`, { headers: H });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
    async budget() {
      const r = await fetch(`${base}/api/v1/budget`, { headers: H });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
    async createBudget(body, idemKey) {
      const headers = { ...H };
      if (idemKey) headers["Idempotency-Key"] = idemKey;
      const r = await fetch(`${base}/api/v1/budgets`, { method: "POST", headers, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
  };
}

// state (browser) endpoint, no auth in open mode
async function getState(base) {
  const r = await fetch(`${base}/api/state`);
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function reconcile(base) {
  const r = await fetch(`${base}/api/reconcile`, { method: "POST" });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

// ---- reporter ---------------------------------------------------------------------------------
function makeReport(name) {
  const results = [];
  let failed = 0;
  function check(desc, cond, detail) {
    const ok = Boolean(cond);
    if (!ok) failed++;
    results.push({ ok, desc, detail });
    const tag = ok ? "  \x1b[32mPASS\x1b[0m" : "  \x1b[31mFAIL\x1b[0m";
    console.log(`${tag} ${desc}${detail != null ? "  — " + detail : ""}`);
    return ok;
  }
  function info(desc, detail) {
    results.push({ ok: null, desc, detail });
    console.log(`  \x1b[36mNOTE\x1b[0m ${desc}${detail != null ? "  — " + detail : ""}`);
  }
  function done() {
    const checks = results.filter((x) => x.ok !== null).length;
    const pass = checks - failed;
    console.log(`\n[${name}] ${pass}/${checks} checks passed${failed ? ` — \x1b[31m${failed} FAILED\x1b[0m` : " — \x1b[32mALL GREEN\x1b[0m"}`);
    return failed === 0;
  }
  return { check, info, done, get failed() { return failed; }, results };
}

module.exports = {
  REPO, SERVER, sleep, addr, tmpDir, waitHttp,
  startMock, startBackend, apiClient, getState, reconcile, readJson, makeReport,
};
