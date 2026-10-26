"""AgentPay MCP integration — a real Model Context Protocol server that gives an AI
agent a *hard-limited, on-chain* wallet.

The agent only ever sees three tools (``pay_merchant``, ``get_budget_status``,
``list_merchants``). The spending rules — per-transaction cap, rolling daily cap,
merchant whitelist and the owner's kill switch — are enforced by the Tari Ootle
validator through the ``AgentBudget`` template, not by this code. The agent's client
cannot talk its way past them.

The heavy lifting is delegated to the repo's stdlib-only on-chain SDK
(``agentpay.onchain.OnChainBudget``); this package adds only the framework glue.
"""

__all__ = ["backend"]
