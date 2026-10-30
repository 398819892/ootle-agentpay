"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_MEMO_BYTES = exports.MEMO_PREFIX = void 0;
exports.newInvoiceId = newInvoiceId;
exports.encodeMemo = encodeMemo;
/**
 * Memo codec — mirrors the parts of `agentpay.invoice` the on-chain path uses.
 *
 * Wire memo (passed to the AgentBudget `pay` call and emitted verbatim in its on-chain `pay`
 * event): {"Message": "ap1|<invoice_id>|<agent_tag>"}
 * This memo is PUBLIC, on-chain plaintext, NOT an encrypted stealth output — the template writes it
 * into the event payload as-is, so never put a secret in it (see docs/security.md: "A memo is public
 * metadata, not a secret."). Ootle Message memos are UTF-8 up to 253 bytes.
 */
const node_crypto_1 = require("node:crypto");
const errors_1 = require("./errors");
exports.MEMO_PREFIX = "ap1";
exports.MAX_MEMO_BYTES = 253;
const ID_RE = /^[a-z0-9]{8,32}$/;
const TAG_RE = /^[A-Za-z0-9_.-]{0,32}$/;
/** 16 lowercase hex chars (8 random bytes), matching Python's `secrets.token_hex(8)`. */
function newInvoiceId() {
    return (0, node_crypto_1.randomBytes)(8).toString("hex");
}
function encodeMemo(invoiceId, agentTag = "") {
    if (!ID_RE.test(invoiceId))
        throw new errors_1.InvoiceError("bad invoice_id");
    if (!TAG_RE.test(agentTag))
        throw new errors_1.InvoiceError("agent_tag must match [A-Za-z0-9_.-]{0,32}");
    const text = `${exports.MEMO_PREFIX}|${invoiceId}|${agentTag}`;
    if (Buffer.byteLength(text, "utf8") > exports.MAX_MEMO_BYTES)
        throw new errors_1.InvoiceError("memo too long");
    return { Message: text };
}
