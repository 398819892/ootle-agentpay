// self-custody.mjs — browser-side key material for the non-custodial wallet.
//
// Scope (deliberately small, so the security-sensitive surface is auditable):
//   1. KEY GENERATION. The installed ootle-wasm 0.50.1 RNG is broken — generateOotleSecretKey(),
//      generateKeypair() and SecretKeyWallet.randomWithViewKey() all trap ("unreachable"), and the
//      WASM rejects non-canonical secrets ("Invalid canonical scalar byte array"). So we make our own
//      entropy with the platform CSPRNG (crypto.getRandomValues) and reduce it to a canonical sr25519
//      scalar mod the ristretto/ed25519 group order L. This is the ONLY hand-rolled curve arithmetic;
//      it is validated against the WASM's own scalar check (see node/self-custody.test.mjs — 100% of
//      reduced scalars are accepted and round-trip to a stable address).
//   2. MNEMONIC backup/restore. The Tari packages expose NO seed-phrase API and SecretKeyWallet has no
//      secret export, so the two 32-byte secrets (owner + view) ARE the backup. We encode them as a
//      48-word phrase using the audited @scure/bip39 (two standard 24-word BIP39 halves, each with its
//      own checksum) — no custom word/checksum code of our own.
//   3. AT-REST ENCRYPTION. The secret is sealed with WebCrypto AES-256-GCM under a PBKDF2-SHA256 key
//      derived from the user's passphrase, replacing plaintext localStorage.
//
// Deriving the public key / account address from these secrets is NOT done here — it stays in the
// ootle-wasm-backed engine (publicKeyFromSecretKey / SecretKeyWallet). This module imports no WASM and
// is pure, so it can be unit-tested and reasoned about on its own.
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

// ristretto255 / ed25519 scalar group order. A canonical sr25519 secret is an integer in [0, L).
export const GROUP_ORDER = (1n << 252n) + 27742317777372353535851937790883648493n;

export const WORDS_PER_HALF = 24; // 256-bit entropy + 8-bit checksum
export const TOTAL_WORDS = WORDS_PER_HALF * 2; // owner (24) ‖ view (24)

const SCALAR_BYTES = 32;
const te = new TextEncoder();
const td = new TextDecoder();

function requireCrypto() {
  const c = globalThis.crypto;
  if (!c || !c.getRandomValues || !c.subtle) {
    throw new Error("WebCrypto unavailable: this wallet needs crypto.getRandomValues + crypto.subtle");
  }
  return c;
}

// --- hex ---------------------------------------------------------------------------------------
export function toHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
export function fromHex(hex) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) throw new Error("invalid hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

// --- little-endian scalar <-> bigint -----------------------------------------------------------
function leToBig(bytes) {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}
function bigToLe32(n) {
  const b = new Uint8Array(SCALAR_BYTES);
  for (let i = 0; i < SCALAR_BYTES; i++) {
    b[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return b;
}

/**
 * A uniformly-random canonical sr25519 scalar. 64 bytes of CSPRNG output reduced mod L — the standard
 * wide-reduction construction (as used for ed25519 nonces), bias < 2^-250. Returns 32 LE bytes in [0, L).
 */
export function randomScalar() {
  const wide = new Uint8Array(64);
  requireCrypto().getRandomValues(wide);
  return bigToLe32(leToBig(wide) % GROUP_ORDER);
}

/** Fresh key material: an owner secret and an independent view secret, both canonical scalars. */
export function generateKeyMaterial() {
  return { owner: randomScalar(), view: randomScalar() };
}

// --- mnemonic (48 words = owner 24 ‖ view 24, standard BIP39) -----------------------------------
function entropy32(bytes, label) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== SCALAR_BYTES)
    throw new Error(`${label} must be 32 bytes`);
  return bytes;
}

/** { owner, view } -> a 48-word recovery phrase (two 24-word BIP39 halves). */
export function keyMaterialToMnemonic({ owner, view }) {
  const a = entropyToMnemonic(entropy32(owner, "owner"), wordlist);
  const b = entropyToMnemonic(entropy32(view, "view"), wordlist);
  return `${a} ${b}`;
}

/** A 48-word recovery phrase -> { owner, view }. Validates both BIP39 checksums; throws otherwise. */
export function mnemonicToKeyMaterial(phrase) {
  const words = String(phrase).trim().toLowerCase().split(/\s+/);
  if (words.length !== TOTAL_WORDS) throw new Error(`recovery phrase must be ${TOTAL_WORDS} words, got ${words.length}`);
  const ownerWords = words.slice(0, WORDS_PER_HALF).join(" ");
  const viewWords = words.slice(WORDS_PER_HALF).join(" ");
  if (!validateMnemonic(ownerWords, wordlist)) throw new Error("recovery phrase invalid (owner half checksum)");
  if (!validateMnemonic(viewWords, wordlist)) throw new Error("recovery phrase invalid (view half checksum)");
  return { owner: mnemonicToEntropy(ownerWords, wordlist), view: mnemonicToEntropy(viewWords, wordlist) };
}

// --- at-rest encryption (AES-256-GCM + PBKDF2-SHA256) ------------------------------------------
const KDF = "PBKDF2-SHA256";
const PBKDF2_ITERS = 210_000; // OWASP 2023 floor for PBKDF2-HMAC-SHA256
const VAULT_VERSION = 1;

async function deriveAesKey(passphrase, salt, iterations) {
  const c = requireCrypto();
  const base = await c.subtle.importKey("raw", te.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return c.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Seal an arbitrary JSON-able secret (e.g. { owner, view } as hex) under a passphrase.
 * Returns a plain, storable object — no key material in the clear.
 */
export async function encryptVault(secret, passphrase) {
  if (!passphrase) throw new Error("a passphrase is required to encrypt the wallet");
  const c = requireCrypto();
  const salt = c.getRandomValues(new Uint8Array(16));
  const iv = c.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(passphrase, salt, PBKDF2_ITERS);
  const ct = await c.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(JSON.stringify(secret)));
  return { v: VAULT_VERSION, kdf: KDF, iter: PBKDF2_ITERS, salt: toHex(salt), iv: toHex(iv), ct: toHex(new Uint8Array(ct)) };
}

/** Open a vault produced by encryptVault. Throws on a wrong passphrase or tampered ciphertext. */
export async function decryptVault(blob, passphrase) {
  if (!blob || blob.v !== VAULT_VERSION || blob.kdf !== KDF) throw new Error("unrecognized vault format");
  const c = requireCrypto();
  const key = await deriveAesKey(passphrase, fromHex(blob.salt), blob.iter || PBKDF2_ITERS);
  let pt;
  try {
    pt = await c.subtle.decrypt({ name: "AES-GCM", iv: fromHex(blob.iv) }, key, fromHex(blob.ct));
  } catch {
    throw new Error("wrong passphrase or corrupted wallet data");
  }
  return JSON.parse(td.decode(pt));
}

/** Convenience: fresh wallet secret as hex + its 48-word backup phrase, ready to encrypt/show. */
export function newWalletSecret() {
  const km = generateKeyMaterial();
  return { owner: toHex(km.owner), view: toHex(km.view), mnemonic: keyMaterialToMnemonic(km) };
}
