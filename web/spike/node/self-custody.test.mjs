// Verifies src/self-custody.mjs against the REAL installed ootle WASM (0.50.1 / 0.14):
//   - every generated scalar is a canonical secret the WASM accepts (the broken RNG workaround holds)
//   - 48-word phrase round-trips to the same secrets AND the same on-key address
//   - checksum / word-count tampering is rejected
//   - AES-GCM vault round-trips; wrong passphrase or tampered ciphertext is rejected
//
// Run: node --test --experimental-wasm-modules node/self-custody.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;

import {
  GROUP_ORDER, TOTAL_WORDS, randomScalar, generateKeyMaterial,
  keyMaterialToMnemonic, mnemonicToKeyMaterial, encryptVault, decryptVault,
  newWalletSecret, toHex, fromHex,
} from "../src/self-custody.mjs";
import { Network } from "@tari-project/ootle";
import { publicKeyFromSecretKey } from "@tari-project/ootle-wasm";
import { SecretKeyWallet } from "@tari-project/ootle-secret-key-wallet";

const leToBig = (b) => { let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]); return n; };
const addrOf = (owner, view) =>
  SecretKeyWallet.fromSecretKey(owner, Network.LocalNet, view).getAddress();

test("randomScalar: canonical (< L) and accepted by the WASM, 200x", () => {
  for (let i = 0; i < 200; i++) {
    const s = randomScalar();
    assert.equal(s.length, 32);
    assert.ok(leToBig(s) < GROUP_ORDER, "scalar must be < group order");
    assert.doesNotThrow(() => publicKeyFromSecretKey(s), "WASM must accept the reduced scalar");
  }
});

test("mnemonic: 48 words, round-trips to identical secrets", () => {
  const km = generateKeyMaterial();
  const phrase = keyMaterialToMnemonic(km);
  assert.equal(phrase.split(/\s+/).length, TOTAL_WORDS);
  const back = mnemonicToKeyMaterial(phrase);
  assert.equal(toHex(back.owner), toHex(km.owner));
  assert.equal(toHex(back.view), toHex(km.view));
});

test("mnemonic restore reproduces the same on-key address", async () => {
  const km = generateKeyMaterial();
  const a1 = await addrOf(km.owner, km.view);
  const back = mnemonicToKeyMaterial(keyMaterialToMnemonic(km));
  const a2 = await addrOf(back.owner, back.view);
  assert.equal(a1, a2);
  assert.match(a1, /^otl_/);
});

test("distinct keys -> distinct addresses", async () => {
  const a = await addrOf(...Object.values(generateKeyMaterial()));
  const b = await addrOf(...Object.values(generateKeyMaterial()));
  assert.notEqual(a, b);
});

test("mnemonic: tampered checksum and wrong word count are rejected", () => {
  const km = generateKeyMaterial();
  const words = keyMaterialToMnemonic(km).split(" ");
  // swap two words within the owner half to break its checksum (abandon is index 0)
  const bad = [...words]; bad[0] = bad[0] === "abandon" ? "ability" : "abandon";
  assert.throws(() => mnemonicToKeyMaterial(bad.join(" ")), /checksum/);
  assert.throws(() => mnemonicToKeyMaterial(words.slice(0, 24).join(" ")), /48 words/);
  assert.throws(() => mnemonicToKeyMaterial("not real bip39 words here"), /48 words/);
});

test("vault: AES-GCM round-trip, wrong passphrase and tampering rejected", async () => {
  const secret = newWalletSecret();
  assert.equal(secret.mnemonic.split(/\s+/).length, TOTAL_WORDS);
  const blob = await encryptVault({ owner: secret.owner, view: secret.view }, "correct horse battery staple");
  assert.ok(!JSON.stringify(blob).includes(secret.owner), "ciphertext must not leak the secret");
  const opened = await decryptVault(blob, "correct horse battery staple");
  assert.equal(opened.owner, secret.owner);
  assert.equal(opened.view, secret.view);
  await assert.rejects(decryptVault(blob, "wrong passphrase"), /wrong passphrase/);
  const tampered = { ...blob, ct: blob.ct.slice(0, -2) + (blob.ct.endsWith("00") ? "11" : "00") };
  await assert.rejects(decryptVault(tampered, "correct horse battery staple"), /wrong passphrase|corrupted/);
});

test("hex helpers round-trip", () => {
  const b = randomScalar();
  assert.equal(toHex(fromHex(toHex(b))), toHex(b));
  assert.throws(() => fromHex("xyz"), /invalid hex/);
});
