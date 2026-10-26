export declare const MEMO_PREFIX = "ap1";
export declare const MAX_MEMO_BYTES = 253;
/** 16 lowercase hex chars (8 random bytes), matching Python's `secrets.token_hex(8)`. */
export declare function newInvoiceId(): string;
export declare function encodeMemo(invoiceId: string, agentTag?: string): {
    Message: string;
};
