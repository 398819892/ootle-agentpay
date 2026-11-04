"""
Let a REAL LLM spend within an on-chain budget — over the hosted `/api/v1` HTTP API.

This is the "wrap an HTTP payment tool for an LLM" pattern: the model is given three tools
(`get_budget`, `list_merchants`, `pay_merchant`), decides what to buy, and calls them. The tools
are a thin shim over the owner's hosted AgentPay service (`examples/agentpay_api.py`) — the agent
holds only an **API key**, never the wallet, and every payment is capped/whitelisted **on chain**.
A prompt-injected or runaway model therefore cannot exceed the per-tx cap, the daily cap, or pay a
non-whitelisted merchant: the validator says no and the model sees the reason and adapts.

The scripted `demo_agent.py` (in integrations/agentpay_mcp) drives the SAME idea over MCP with no
API key; this one swaps in a real tool-calling model over HTTP — only the decision-maker changes.

Run it:
    pip install anthropic                         # the only dependency (plus stdlib)
    export ANTHROPIC_API_KEY=sk-ant-...           # your Anthropic key (drives the model)
    export AGENTPAY_URL=http://localhost:8787     # the hosted AgentPay service
    export AGENTPAY_API_KEY=sk_agent_...          # an AGENT key issued by the service owner
    # optional: export ANTHROPIC_MODEL=claude-sonnet-5-5   # defaults below
    python examples/llm_agent.py

Prerequisite: the owner has opened a budget and whitelisted at least one merchant (e.g. "shop"),
and issued you an agent-role key. See examples/README.md and docs/api.md.
"""
from __future__ import annotations

import json
import os
import secrets
import sys

# Reuse the tiny, dependency-free HTTP client that lives next to this file.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agentpay_api import AgentPayApi, AgentPayApiError  # noqa: E402

MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5-5")

# The agent's ENTIRE spending surface — the same shape whether the decider is a human, a script or
# an LLM. There is deliberately no tool to raise a cap or add a merchant: those are owner powers.
TOOLS = [
    {
        "name": "get_budget",
        "description": "Get the remaining budget and the caps the agent must stay within "
                       "(per-transaction cap, daily cap, amount left this window). Amounts are in "
                       "base units (µT; 1,000,000 µT = 1 token).",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "list_merchants",
        "description": "List the merchant names/addresses the agent is allowed to pay (the on-chain "
                       "whitelist). Paying anyone not on this list is rejected by the chain.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "pay_merchant",
        "description": "Pay a whitelisted merchant from the on-chain budget. The payment is "
                       "adjudicated by the validator: if it exceeds a cap or the merchant is not "
                       "whitelisted it is REJECTED and the reason is returned — do not retry a "
                       "rejected or pending payment blindly; read the reason and adapt.",
        "input_schema": {
            "type": "object",
            "properties": {
                "merchant": {"type": "string", "description": "merchant name or component address"},
                "amount": {"type": "string", "description": "amount in base units (µT), e.g. '250'"},
                "memo": {"type": "string", "description": "optional note / invoice reference"},
            },
            "required": ["merchant", "amount"],
        },
    },
]

SYSTEM = (
    "You are a purchasing agent with an on-chain spending budget. You can only pay whitelisted "
    "merchants, and only within hard per-transaction and daily caps enforced by the blockchain — "
    "you cannot override them. Always check get_budget and list_merchants before paying. Amounts "
    "are in base units (µT). If a payment is rejected, read the reason and adjust (smaller amount, "
    "a whitelisted merchant) rather than repeating it. When the task is done, summarise what you "
    "paid and what was refused."
)


def run_tool(api: AgentPayApi, name: str, args: dict) -> dict:
    """Execute one tool call against the hosted API and return a JSON-able result for the model."""
    try:
        if name == "get_budget":
            b = api.budget()
            return {"ok": True, "budget": b} if b else {"ok": False, "error": "no budget open"}
        if name == "list_merchants":
            return {"ok": True, "merchants": api.list_merchants()}
        if name == "pay_merchant":
            # A fresh idempotency key per *decision* — a client retry of the same intent is safe,
            # but a new intent gets a new key. The chain, not this shim, is the spending authority.
            receipt, replayed = api.pay(
                args["merchant"], str(args["amount"]), memo=args.get("memo"),
                idempotency_key=f"llm_{secrets.token_hex(6)}",
            )
            # A rejection is a normal verdict (receipt with status "rejected"), not an exception.
            return {"ok": receipt.get("status") == "accepted", "status": receipt.get("status"),
                    "reason": receipt.get("reason"), "amount": args.get("amount"),
                    "merchant": args["merchant"], "replayed": replayed, "id": receipt.get("id")}
        return {"ok": False, "error": f"unknown tool {name}"}
    except AgentPayApiError as e:
        # Surface setup/auth/rate problems to the model as data, not a crash.
        return {"ok": False, "error": str(e), "rate_limited": e.rate_limited, "frozen": e.frozen}


def main() -> None:
    try:
        import anthropic
    except ImportError:
        raise SystemExit("pip install anthropic (this example needs the Anthropic SDK).")

    base = os.environ.get("AGENTPAY_URL", "http://localhost:8787")
    key = os.environ.get("AGENTPAY_API_KEY")
    if not key:
        raise SystemExit("Set AGENTPAY_API_KEY (an agent key issued by the service owner).")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise SystemExit("Set ANTHROPIC_API_KEY (drives the model).")

    api = AgentPayApi(base, key)
    client = anthropic.Anthropic()

    task = (
        "Buy the data feed from 'shop' for 300 (base units), and a second small top-up of 1500 "
        "from 'shop'. Stay within the budget; if something is refused, tell me why."
    )
    messages: list = [{"role": "user", "content": task}]
    print(f"TASK: {task}\n")

    for _ in range(12):  # cap the loop so a confused model can't spin forever
        resp = client.messages.create(
            model=MODEL, max_tokens=1024, system=SYSTEM, tools=TOOLS, messages=messages,
        )
        # Echo any text the model produced this turn.
        for block in resp.content:
            if block.type == "text" and block.text.strip():
                print("MODEL:", block.text.strip())

        if resp.stop_reason != "tool_use":
            break  # the model is done talking / has finished the task

        messages.append({"role": "assistant", "content": resp.content})
        results = []
        for block in resp.content:
            if block.type == "tool_use":
                out = run_tool(api, block.name, block.input or {})
                verb = {"get_budget": "get_budget", "list_merchants": "list_merchants"}.get(
                    block.name, f"pay_merchant({block.input})")
                print(f"  → {verb} -> {out}")
                results.append({"type": "tool_result", "tool_use_id": block.id,
                                "content": json.dumps(out)})
        messages.append({"role": "user", "content": results})


if __name__ == "__main__":
    main()
