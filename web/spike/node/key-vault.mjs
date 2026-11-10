// key-vault.mjs — encrypt the custodial dev key at rest (P0, 2026-11-10 review).
//
// The wallet server needs the plaintext owner/view secret in memory to sign, but it must not sit in
// plaintext on disk (it was readable via the old /api/dev-key and ships in backups / could be copied).
// So the key file is AES-256-GCM encrypted with a key derived (scrypt) from a passphrase that lives
// OUTSIDE the repo dir (a 0600 file referenced by WALLET_KEY_PASSPHRASE_FILE, or WALLET_KEY_PASSPHRASE).
// GCM authenticates the ciphertext, so a wrong passphrase or any tampering fails closed on decrypt.
//
// loadKeyFile() is backward-compatible: if no .spike-key.enc.json exists it falls back to the plaintext
// .spike-key.json (with a warning), so deploying this code changes nothing until the file is migrated.
import fs from "node:fs";
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const KDF = { N: 1 << 14, r: 8, p: 1 };           // scrypt ~16MB — plenty for a one-shot boot decrypt
const scryptKey = (passphrase, salt, p = KDF) =>
  scryptSync(Buffer.from(String(passphrase), "utf8"), salt, 32, { N: p.N, r: p.r, p: p.p, maxmem: 128 * 1024 * 1024 });

export function encrypt(obj, passphrase) {
  if (!passphrase) throw new Error("passphrase required");
  const salt = randomBytes(16), iv = randomBytes(12);
  const dk = scryptKey(passphrase, salt);
  const c = createCipheriv("aes-256-gcm", dk, iv);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), "utf8")), c.final()]);
  return {
    v: 1, cipher: "aes-256-gcm", kdf: "scrypt", N: KDF.N, r: KDF.r, p: KDF.p,
    salt: salt.toString("base64"), iv: iv.toString("base64"),
    tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64"),
  };
}

export function decrypt(enc, passphrase) {
  if (!passphrase) throw new Error("passphrase required");
  if (!enc || enc.v !== 1 || enc.cipher !== "aes-256-gcm" || enc.kdf !== "scrypt") throw new Error("unrecognized key-vault format");
  const dk = scryptKey(passphrase, Buffer.from(enc.salt, "base64"), { N: enc.N, r: enc.r, p: enc.p });
  const d = createDecipheriv("aes-256-gcm", dk, Buffer.from(enc.iv, "base64"));
  d.setAuthTag(Buffer.from(enc.tag, "base64"));
  const pt = Buffer.concat([d.update(Buffer.from(enc.ct, "base64")), d.final()]); // throws on wrong passphrase / tamper
  return JSON.parse(pt.toString("utf8"));
}

// Resolve the passphrase: a literal in WALLET_KEY_PASSPHRASE, else the contents of WALLET_KEY_PASSPHRASE_FILE.
export function passphraseFromEnv(env = process.env) {
  if (env.WALLET_KEY_PASSPHRASE) return env.WALLET_KEY_PASSPHRASE;
  const f = env.WALLET_KEY_PASSPHRASE_FILE;
  if (f && fs.existsSync(f)) return fs.readFileSync(f, "utf8").replace(/\r?\n$/, "");
  return null;
}

// baseUrl is a module's import.meta.url (the key files live one level up, beside the repo's node/ dir).
// Returns the parsed key object. Prefers the encrypted file; falls back to plaintext for dev continuity.
export function loadKeyFile(baseUrl, env = process.env) {
  const enc = new URL("../.spike-key.enc.json", baseUrl);
  const plain = new URL("../.spike-key.json", baseUrl);
  if (fs.existsSync(enc)) {
    const pass = passphraseFromEnv(env);
    if (!pass) throw new Error("encrypted key present (.spike-key.enc.json) but WALLET_KEY_PASSPHRASE[_FILE] is not set");
    const obj = decrypt(JSON.parse(fs.readFileSync(enc, "utf8")), pass);
    console.error("key-vault: loaded ENCRYPTED key at rest (.spike-key.enc.json)");
    return obj;
  }
  if (fs.existsSync(plain)) {
    console.warn("WARNING: the custodial key is UNENCRYPTED at rest (.spike-key.json). Migrate with node/encrypt-key.mjs and set WALLET_KEY_PASSPHRASE_FILE.");
    return JSON.parse(fs.readFileSync(plain, "utf8"));
  }
  throw new Error(`need a funded dev key at ${plain.pathname} (plaintext) or ${enc.pathname} (encrypted)`);
}
