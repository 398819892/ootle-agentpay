"""The package's supported surface vs. its experimental modules (review item #8).

`agentpay.__all__` must expose the on-chain path and the chain-agnostic helpers, but NOT the phase-1
`BudgetManager` / `AgentWallet` model (client-side policy only, never run on a live chain) nor
`OotlePyChain` (unverified, has NotImplementedError stubs). Those stay importable from their own
modules for the offline demo, so `import *` consumers never pick them up by accident.
"""
import agentpay


def test_experimental_names_are_not_exported():
    for name in ("BudgetManager", "AgentWallet", "OpenResult", "PaymentProof", "SweepResult"):
        assert name not in agentpay.__all__, name
        assert name in agentpay.EXPERIMENTAL
    assert "OotlePyChain" in agentpay.EXPERIMENTAL
    assert "OotlePyChain" not in agentpay.__all__


def test_supported_onchain_surface_is_exported():
    for name in ("OnChainBudget", "WalletdClient", "LedgerEntry", "new_invoice_id"):
        assert name in agentpay.__all__, name
        assert getattr(agentpay, name) is not None


def test_experimental_names_remain_importable_for_the_offline_demo():
    from agentpay.budget import AgentWallet, BudgetManager  # noqa: F401
    assert agentpay.BudgetManager is BudgetManager  # explicit attribute access still works


def test_star_import_skips_experimental():
    ns: dict = {}
    exec("from agentpay import *", ns)  # noqa: S102 - the point of the test
    assert "OnChainBudget" in ns
    assert "BudgetManager" not in ns and "AgentWallet" not in ns
