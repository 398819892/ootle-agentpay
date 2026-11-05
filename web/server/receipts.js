//   Copyright 2026 The AgentPay Authors
//   SPDX-License-Identifier: BSD-3-Clause
/**
 * A tiny on-disk store for the payment-receipt images the MCP uploads. The MCP renders the PNG
 * (it has the CJK font + Pillow); the dashboard just KEEPS a copy so the web UI can list and offer
 * them for download — the inline MCP image has no "download" affordance in most hosts. This is
 * presentation only: never the authority for money (that is the chain, see dashboard.js).
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ID_RE = /^[0-9a-z]+-[0-9a-f]{8}$/;

function createReceipts({ dir, max = 200 }) {
  const RDIR = path.resolve(dir);
  const INDEX = path.join(RDIR, "index.json");

  function loadIndex() {
    try {
      const a = JSON.parse(fs.readFileSync(INDEX, "utf8"));
      return Array.isArray(a) ? a : [];
    } catch {
      return [];
    }
  }
  function saveIndex(a) {
    fs.mkdirSync(RDIR, { recursive: true });
    const tmp = INDEX + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(a));
    fs.renameSync(tmp, INDEX); // atomic replace
  }
  const str = (v) => (v == null ? null : String(v));

  /** Persist a PNG + its figures; returns the public entry ({ id, url, ...meta }). Throws on a
   *  non-PNG or oversize payload so the caller can 400 it. */
  function save(meta, png) {
    if (!Buffer.isBuffer(png) || png.length < 8 || !png.subarray(0, 8).equals(PNG_SIG)) {
      throw new Error("receipt is not a PNG");
    }
    if (png.length > 2_000_000) throw new Error("receipt image too large");
    fs.mkdirSync(RDIR, { recursive: true });
    const id = Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex");
    fs.writeFileSync(path.join(RDIR, id + ".png"), png);
    const entry = {
      id,
      payer: str(meta.payer),
      merchant: str(meta.merchant),
      amount: str(meta.amount),
      unit: meta.unit ? String(meta.unit) : "µT",
      remaining_balance: str(meta.remaining_balance),
      remaining_in_window: str(meta.remaining_in_window),
      paid_at: str(meta.paid_at),
      saved_at: new Date().toISOString(),
      bytes: png.length,
    };
    const idx = loadIndex();
    idx.push(entry);
    while (idx.length > max) {
      const old = idx.shift(); // prune oldest, and its file
      try {
        fs.unlinkSync(path.join(RDIR, old.id + ".png"));
      } catch {
        /* already gone */
      }
    }
    saveIndex(idx);
    return { url: `/receipt/${id}.png`, ...entry };
  }

  /** The absolute file path for an id, or null if the id is malformed / escapes the dir. */
  function filePath(id) {
    if (!ID_RE.test(id)) return null;
    const p = path.join(RDIR, id + ".png");
    return p.startsWith(RDIR + path.sep) ? p : null;
  }

  /** The receipts newest-first, each with its download url (no server file paths exposed). */
  function list() {
    return loadIndex()
      .slice()
      .reverse()
      .map((e) => ({ ...e, url: `/receipt/${e.id}.png` }));
  }

  return { save, filePath, list };
}

module.exports = { createReceipts };
