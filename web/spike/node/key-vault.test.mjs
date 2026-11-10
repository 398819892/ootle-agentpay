// Tests for the at-rest key vault (node/key-vault.mjs). Pure crypto + fs, no chain/engine/key.
//   node --test node/key-vault.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { encrypt, decrypt, loadKeyFile, passphraseFromEnv } from "./key-vault.mjs";

const SAMPLE = { owner: "aa".repeat(32), view: "bb".repeat(32), account: "component_" + "c".repeat(64) };

test("encrypt -> decrypt round-trips the key object", () => {
  const enc = encrypt(SAMPLE, "correct horse battery staple");
  assert.equal(enc.v, 1);
  assert.equal(enc.cipher, "aes-256-gcm");
  assert.ok(enc.ct && enc.salt && enc.iv && enc.tag);
  assert.deepEqual(decrypt(enc, "correct horse battery staple"), SAMPLE);
});

test("a wrong passphrase fails closed (GCM auth)", () => {
  const enc = encrypt(SAMPLE, "right");
  assert.throws(() => decrypt(enc, "wrong"));
});

test("tampered ciphertext fails closed", () => {
  const enc = encrypt(SAMPLE, "pw");
  const buf = Buffer.from(enc.ct, "base64"); buf[0] ^= 0xff;
  assert.throws(() => decrypt({ ...enc, ct: buf.toString("base64") }, "pw"));
});

test("an unrecognized format is rejected", () => {
  assert.throws(() => decrypt({ v: 2 }, "pw"), /format/);
  assert.throws(() => decrypt(null, "pw"));
});

test("encrypt/decrypt require a passphrase", () => {
  assert.throws(() => encrypt(SAMPLE, ""), /passphrase/);
  assert.throws(() => decrypt(encrypt(SAMPLE, "x"), ""), /passphrase/);
});

test("passphraseFromEnv reads a literal, else a file (trailing newline trimmed), else null", () => {
  assert.equal(passphraseFromEnv({ WALLET_KEY_PASSPHRASE: "lit" }), "lit");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "kv-"));
  const pf = path.join(d, "pass"); fs.writeFileSync(pf, "filepass\n");
  assert.equal(passphraseFromEnv({ WALLET_KEY_PASSPHRASE_FILE: pf }), "filepass");
  assert.equal(passphraseFromEnv({}), null);
});

test("loadKeyFile prefers the encrypted file, falls back to plaintext, else throws", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "kv-"));
  const base = pathToFileURL(path.join(d, "node", "x.mjs")).href; // key files resolve one level up
  assert.throws(() => loadKeyFile(base, {}));                      // nothing present
  fs.writeFileSync(path.join(d, ".spike-key.json"), JSON.stringify(SAMPLE));
  assert.deepEqual(loadKeyFile(base, {}), SAMPLE);                 // plaintext fallback
  fs.writeFileSync(path.join(d, ".spike-key.enc.json"), JSON.stringify(encrypt({ ...SAMPLE, account: "component_enc" }, "pw")));
  assert.throws(() => loadKeyFile(base, {}));                      // enc present but no passphrase
  assert.equal(loadKeyFile(base, { WALLET_KEY_PASSPHRASE: "pw" }).account, "component_enc"); // enc wins
});
