"""Verifies our derivation feeds valid scalars into the real ootle-py crypto bridge."""
from ootle import Network, OotleSecretKey

from agentpay.keys import derive_scalar, derive_scalar_pair, session_path


def test_derive_is_deterministic():
    seed = b"owner-master-seed-please-be-long-enough"
    a = derive_scalar_pair(seed, session_path("s1"))
    b = derive_scalar_pair(seed, session_path("s1"))
    assert a == b


def test_derive_differs_per_session():
    seed = b"owner-master-seed-please-be-long-enough"
    a = derive_scalar_pair(seed, session_path("s1"))
    b = derive_scalar_pair(seed, session_path("s2"))
    assert a != b


def test_derive_differs_per_seed():
    a = derive_scalar(b"seed-one-is-long-enough-for-this", "session/x/owner")
    b = derive_scalar(b"seed-two-is-long-enough-for-this", "session/x/owner")
    assert a != b


def test_scalar_produces_valid_ootle_address():
    seed = b"owner-master-seed-please-be-long-enough"
    owner, view = derive_scalar_pair(seed, session_path("s1"))
    key = OotleSecretKey(network=Network.LOCAL_NET, owner_secret=owner, view_secret=view)
    addr = key.to_address()
    assert addr.bech32m.startswith("otl_loc_")
    # re-deriving must reproduce the same address (the whole point of the design)
    owner2, view2 = derive_scalar_pair(seed, session_path("s1"))
    key2 = OotleSecretKey(network=Network.LOCAL_NET, owner_secret=owner2, view_secret=view2)
    assert key2.to_address().bech32m == addr.bech32m


def test_rejects_short_seed():
    import pytest
    with pytest.raises(ValueError):
        derive_scalar(b"short", "session/x/owner")
