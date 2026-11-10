// One-shot migration: encrypt the plaintext ../.spike-key.json into ../.spike-key.enc.json using the
// passphrase from WALLET_KEY_PASSPHRASE[_FILE]. Does NOT delete the plaintext — the operator does that
// (after keeping a backup OUTSIDE the repo dir) once the server is confirmed to boot from the encrypted
// file. Prints only non-secret info.
//
//   WALLET_KEY_PASSPHRASE_FILE=/root/.config/agentpay/wallet-key.pass node node/encrypt-key.mjs
import fs from "node:fs";
import { encrypt, passphraseFromEnv } from "./key-vault.mjs";

const pass = passphraseFromEnv();
if (!pass) { console.error("set WALLET_KEY_PASSPHRASE or WALLET_KEY_PASSPHRASE_FILE first"); process.exit(1); }

const plain = new URL("../.spike-key.json", import.meta.url);
const out = new URL("../.spike-key.enc.json", import.meta.url);
if (!fs.existsSync(plain)) { console.error(`no plaintext key at ${plain.pathname}`); process.exit(1); }

const obj = JSON.parse(fs.readFileSync(plain, "utf8"));
if (!obj.account) { console.error("plaintext key has no .account — refusing"); process.exit(1); }

const enc = encrypt(obj, pass);
fs.writeFileSync(out, JSON.stringify(enc));
try { fs.chmodSync(out, 0o600); } catch { /* best effort */ }
console.error(`wrote ${out.pathname} (account=${obj.account.slice(0, 18)}…). Verify the server boots from it, then remove the plaintext (keep a backup outside the repo).`);
