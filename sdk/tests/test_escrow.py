import pytest

from agentpay.errors import VerificationFailed
from agentpay.escrow import commitment_of, decode_delivery_memo, encode_delivery_memo, new_preimage, verify_delivery
from agentpay.invoice import Invoice, new_invoice_id
from agentpay.models import ReceivedOutput


def test_commitment_roundtrip_and_verify():
    k = new_preimage()
    inv = Invoice(new_invoice_id(), 100, "coin", "payee", 9e18)
    memo = encode_delivery_memo(inv.invoice_id, commitment_of(k))
    out = ReceivedOutput(commitment=b"\x00" * 32, value=100, memo=memo)
    verify_delivery(out, inv, k)   # must not raise


def test_verify_delivery_rejects_wrong_preimage():
    k, wrong = new_preimage(), new_preimage()
    inv = Invoice(new_invoice_id(), 100, "coin", "payee", 9e18)
    memo = encode_delivery_memo(inv.invoice_id, commitment_of(k))
    out = ReceivedOutput(commitment=b"\x00" * 32, value=100, memo=memo)
    with pytest.raises(VerificationFailed):
        verify_delivery(out, inv, wrong)


def test_decode_delivery_memo_tolerant():
    assert decode_delivery_memo(None) is None
    assert decode_delivery_memo({"Message": "unrelated"}) is None
