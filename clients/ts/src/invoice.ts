/**
 * Encrypted-memo codec — mirrors the parts of `agentpay.invoice` the on-chain path uses.
 *
 * Wire memo (goes in an Ootle stealth output, encrypted to the merchant only):
 *     {"Message": "ap1|<invoice_id>|<agent_tag>"}
 * Ootle memos: Message is UTF-8 up to 253 bytes.
 */
import { randomBytes } from "node:crypto";

import { InvoiceError } from "./errors";

export const MEMO_PREFIX = "ap1";
export const MAX_MEMO_BYTES = 253;
const ID_RE = /^[a-z0-9]{8,32}$/;
const TAG_RE = /^[A-Za-z0-9_.-]{0,32}$/;

/** 16 lowercase hex chars (8 random bytes), matching Python's `secrets.token_hex(8)`. */
export function newInvoiceId(): string {
  return randomBytes(8).toString("hex");
}

export function encodeMemo(invoiceId: string, agentTag = ""): { Message: string } {
  if (!ID_RE.test(invoiceId)) throw new InvoiceError("bad invoice_id");
  if (!TAG_RE.test(agentTag)) throw new InvoiceError("agent_tag must match [A-Za-z0-9_.-]{0,32}");
  const text = `${MEMO_PREFIX}|${invoiceId}|${agentTag}`;
  if (Buffer.byteLength(text, "utf8") > MAX_MEMO_BYTES) throw new InvoiceError("memo too long");
  return { Message: text };
}
