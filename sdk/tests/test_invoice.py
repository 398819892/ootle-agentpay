import pytest

from agentpay.errors import InvoiceError
from agentpay.invoice import (
    Invoice, decode_memo, encode_memo, from_challenge, new_invoice_id, to_challenge,
)


def test_memo_roundtrip():
    iid = new_invoice_id()
    memo = encode_memo(iid, "agent-42")
    parsed = decode_memo(memo)
    assert parsed is not None
    assert parsed.invoice_id == iid
    assert parsed.agent_tag == "agent-42"


def test_memo_roundtrip_via_bytes_and_str():
    iid = new_invoice_id()
    memo = encode_memo(iid)
    import json
    assert decode_memo(json.dumps(memo).encode()).invoice_id == iid
    assert decode_memo(json.dumps(memo)).invoice_id == iid


def test_decode_memo_tolerant_of_garbage():
    assert decode_memo(None) is None
    assert decode_memo({"Message": "not-ours"}) is None
    assert decode_memo({"NotMessage": 1}) is None
    assert decode_memo(b"\xff\xfe not json") is None
    assert decode_memo("also not json {") is None


def test_encode_memo_rejects_bad_tag():
    with pytest.raises(InvoiceError):
        encode_memo(new_invoice_id(), "bad tag with spaces!")


def test_invoice_validates_id_and_amount():
    with pytest.raises(InvoiceError):
        Invoice("BAD ID", 1, "coin", "payee", 0.0)
    with pytest.raises(InvoiceError):
        Invoice(new_invoice_id(), 0, "coin", "payee", 0.0)


def test_invoice_expiry():
    inv = Invoice(new_invoice_id(), 10, "coin", "payee", expires_at=100.0)
    assert inv.expired(now=100.0)
    assert not inv.expired(now=99.0)


def test_challenge_roundtrip():
    inv = Invoice(new_invoice_id(), 500, "resource_coin", "otl_payee", 999999.0, "widget")
    ch = to_challenge(inv)
    back = from_challenge(ch)
    assert back == inv


def test_from_challenge_rejects_wrong_scheme():
    with pytest.raises(InvoiceError):
        from_challenge({"scheme": "other"})
