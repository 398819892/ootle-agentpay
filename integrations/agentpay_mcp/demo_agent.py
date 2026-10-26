#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真实 MCP 集成演示 —— 一个 AI 代理通过 MCP 工具花钱,越限被链上验证节点当场拦住。

这不是又一个脚本:支付能力被包成一个**真正的 MCP server**(agentpay_mcp.server),
本脚本则作为一个**真正的 MCP client**,用 stdio 启动那个 server、握手、列工具、调工具。
代理的"决策循环"是脚本化的(不需要付费 LLM key),但它拿到的每一个结果都来自真实的
MCP 协议往返,而每一笔付款的成败都由**链上验证节点**裁决 —— 拒绝理由原样回灌给代理,
让它"看见"自己被限制。

剧情(对着本地 swarm 真链跑):
  owner 开预算 → 代理正常付款(成功)→ 代理越单笔上限 / 付非白名单(链拒绝)→
  代理撞每日上限(链拒绝)→ owner 按下急停(revoke)→ 代理再付被拦 → owner 取回余额核对。

用法(在 F:\\oolte 目录下,用装了 mcp 的 venv 的 python):
    integrations/agentpay_mcp/.venv/Scripts/python integrations/agentpay_mcp/demo_agent.py
    ... --auto     # 不暂停,一口气跑完

前提:本地 swarm 的钱包守护进程 JSON-RPC 在 127.0.0.1:12010 (auth=none),
且 AgentBudget 模板已发布(见 backend.DEFAULT_TEMPLATE)。搭法见 docs/devnet.md。
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)  # so `import agentpay_mcp` works when run as a file

from agentpay_mcp import backend  # noqa: E402

from mcp import ClientSession, StdioServerParameters  # noqa: E402
from mcp.client.stdio import stdio_client  # noqa: E402

AUTO = "--auto" in sys.argv or not sys.stdout.isatty()


# --- 小工具:彩色 / 分隔 / 暂停(与 scripts/demo_zh.py 同风格)----------------------
def _c(code: str, s: str) -> str:
    return s if os.environ.get("NO_COLOR") else f"\033[{code}m{s}\033[0m"


BOLD = lambda s: _c("1", s)
GREEN = lambda s: _c("32", s)
RED = lambda s: _c("31", s)
CYAN = lambda s: _c("36", s)
DIM = lambda s: _c("2", s)
YELLOW = lambda s: _c("33", s)

_step = 0


def step(title: str) -> None:
    global _step
    _step += 1
    print()
    print(BOLD(CYAN(f"━━━ 第 {_step} 步 ━━━ {title}")))


def say(label: str, text: str) -> None:
    print(f"  {label} {text}")


def why(text: str) -> None:
    print(DIM(f"     ↳ 说明:{text}"))


def agent_thinks(text: str) -> None:
    print(YELLOW(f"  🤖 代理(通过 MCP 工具观察后判断):") + text)


def pause() -> None:
    if AUTO:
        return
    try:
        input(DIM("     (按回车继续…)"))
    except EOFError:
        pass


def _unwrap(result) -> object:
    """Pull the Python value back out of an MCP CallToolResult (FastMCP serializes the
    tool's return value as JSON text in the first content block)."""
    if getattr(result, "structuredContent", None) is not None:
        sc = result.structuredContent
        if isinstance(sc, dict) and set(sc.keys()) == {"result"}:
            return sc["result"]
        return sc
    for block in result.content:
        text = getattr(block, "text", None)
        if text is not None:
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                return text
    return None


async def run_demo() -> None:
    print(BOLD("\n╔══════════════════════════════════════════════════════════════╗"))
    print(BOLD("║  AgentPay × MCP —— 给 AI 代理一个「带硬限额的链上钱包」        ║"))
    print(BOLD("╚══════════════════════════════════════════════════════════════╝"))
    print("支付能力包成一个真正的 MCP server;本脚本作为真正的 MCP client 调用它。")
    print("代理花钱的规矩由" + BOLD("链上验证节点强制执行") + ",代理再怎么决策也突破不了。")
    pause()

    # ===== owner 侧:直接用 SDK 开预算(持有 owner badge,代理拿不到)=====
    step("owner 连接链,准备角色,并开一个链上预算")
    client = backend.connect()
    # owner 账户名可用 AGENTPAY_OWNER_ACCOUNT 覆盖(本地 swarm 默认 "default";esmeralda 上是 "dev")。
    owner = client.account_address(os.environ.get("AGENTPAY_OWNER_ACCOUNT", "default"))
    shop = backend.ensure_account(client, "shop")        # 白名单内
    scammer = backend.ensure_account(client, "scammer")  # 不在白名单
    say("owner(你)", owner[:34] + "…")
    say("商户 shop(白名单内)", shop[:34] + "…")
    say("骗子 scammer(不在白名单)", scammer[:34] + "…")

    PER_TX, DAILY, FUND = 1_000, 1_500, 10_000
    budget = backend.open_budget(
        client, owner, fund=FUND, per_tx_cap=PER_TX, daily_cap=DAILY, whitelist=[shop],
    )
    say("预算合约已上链", budget.component[:34] + "…")
    say("规则(写进链上合约)", f"单笔≤{PER_TX} · 日限额≤{DAILY} · 白名单=[shop] · 可随时撤销")
    why("owner 持有 owner badge(能撤销/取款);接下来代理只拿到 agent badge,只能在规则内付款。")
    shop_before = client.balance("shop")
    pause()

    # ===== 启动真正的 MCP server 子进程,代理只通过 MCP 工具接触预算 =====
    step("以 stdio 启动 agentpay MCP server,代理作为 MCP client 连上去")
    server_env = dict(os.environ)
    server_env.update({
        "AGENTPAY_WALLETD_URL": backend.WALLETD_URL,
        "AGENTPAY_BUDGET_TEMPLATE": budget.budget_template,
        "AGENTPAY_COMPONENT": budget.component,
        "AGENTPAY_AGENT_BADGE": budget.agent_badge,
        "AGENTPAY_AGENT_ACCOUNT": owner,   # devnet:owner 账户兼任 agent 身份(持 agent badge)
        "AGENTPAY_PER_TX_CAP": str(PER_TX),
        "AGENTPAY_DAILY_CAP": str(DAILY),
        "AGENTPAY_WHITELIST": shop,
    })
    params = StdioServerParameters(
        command=sys.executable, args=["-m", "agentpay_mcp.server"],
        env=server_env, cwd=_HERE,
    )

    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            say("MCP 握手完成,server 暴露的工具", ", ".join(t.name for t in tools.tools))
            why("代理的全部能力就这三样 pay_merchant / get_budget_status / list_merchants —— 没有「提额」或「撤销自己」的工具。")
            pause()

            async def call(name: str, **args):
                return _unwrap(await session.call_tool(name, args))

            # ---- 代理先搞清楚自己能干什么 ----
            step("代理开工前,先查预算状态和可付商户(真·MCP 工具调用)")
            status = await call("get_budget_status")
            merchants = (await call("list_merchants")).get("merchants", [])
            say("get_budget_status →", json.dumps(status, ensure_ascii=False))
            say("list_merchants →", json.dumps(merchants, ensure_ascii=False))
            agent_thinks(f"我有 {status['remaining_in_window']} 的额度,单笔不能超 {status['per_tx_cap']},只能付给白名单里的 {len(merchants)} 家商户。")
            pause()

            # ---- 正常付款:成功 ----
            step("代理决定给 shop 付一笔正常的钱(700)")
            r = await call("pay_merchant", merchant=shop, amount=700, memo="ap-mcp|order-001|shopper")
            say(GREEN("✓ pay_merchant →"), json.dumps(r, ensure_ascii=False))
            agent_thinks("付款成功,链上确认。继续。")
            why("700 ≤ 单笔上限且 shop 在白名单,验证节点接受。")
            pause()

            # ---- 越单笔上限:链拒绝 ----
            step("代理想一次付 1500(超单笔上限)—— 链当场拒绝")
            r = await call("pay_merchant", merchant=shop, amount=1500, memo="ap-mcp|bulk|shopper")
            say(RED("✗ pay_merchant →"), json.dumps(r, ensure_ascii=False))
            agent_thinks(f"被拒了,理由是『{r.get('reason')}』。这是链上规则,我改不了 —— 那我把金额压到上限内。")
            why("拒绝理由由验证节点给出,原样通过 MCP 回灌给代理,代理据此调整决策。")
            pause()

            # ---- 付非白名单商户:链拒绝 ----
            step("代理想付给 scammer(不在白名单)—— 链当场拒绝")
            r = await call("pay_merchant", merchant=scammer, amount=100, memo="ap-mcp|sketchy")
            say(RED("✗ pay_merchant →"), json.dumps(r, ensure_ascii=False))
            agent_thinks(f"又被拒:『{r.get('reason')}』。scammer 不在白名单,付不出去。放弃这家。")
            pause()

            # ---- 再正常付一笔,逼近每日上限 ----
            step("代理再给 shop 付 700(累计 1400,逼近每日上限 1500)")
            r = await call("pay_merchant", merchant=shop, amount=700, memo="ap-mcp|order-002|shopper")
            say(GREEN("✓ pay_merchant →"), json.dumps(r, ensure_ascii=False))
            status = await call("get_budget_status")
            agent_thinks(f"目前窗口内已花 {status['spent_in_window']},还剩 {status['remaining_in_window']}。")
            pause()

            # ---- 撞每日上限:链拒绝 ----
            step("代理还想再付 700(1400+700>1500)—— 撞每日上限,链拒绝")
            r = await call("pay_merchant", merchant=shop, amount=700, memo="ap-mcp|order-003|shopper")
            say(RED("✗ pay_merchant →"), json.dumps(r, ensure_ascii=False))
            agent_thinks(f"被拒:『{r.get('reason')}』。单笔没超,但会突破当日累计额度。日限额也是链上强制的 —— 我只能等窗口刷新。")
            pause()

            # ===== owner 侧:按下急停 =====
            step("owner 按下急停:撤销代理(owner 直接用 owner badge 调链,代理无感)")
            budget.revoke()
            say(BOLD("owner.revoke()"), "已上链")
            why("revoke 是 owner 的权力,不在代理的 MCP 工具里。代理下一次付款才会撞上。")
            pause()

            step("代理撤销后再试付 100 —— 链拒绝")
            r = await call("pay_merchant", merchant=shop, amount=100, memo="ap-mcp|after-revoke")
            say(RED("✗ pay_merchant →"), json.dumps(r, ensure_ascii=False))
            status = await call("get_budget_status")
            agent_thinks(f"付款被拒:『{r.get('reason')}』;get_budget_status 显示 revoked={status['revoked']}。我的钱包被 owner 关停了,收工。")
            pause()

    # ===== owner 收尾核对 =====
    # 代理的花费发生在 server 那边的 OnChainBudget 实例里,owner 侧的 budget 对象并不知情,
    # 所以用链上确认过的 spent_in_window(通过 get_budget_status 读到的)来算该取回多少。
    agent_spent = status["spent_in_window"]
    step("owner 取回没花完的余额,收尾核对链上余额")
    remaining = FUND - agent_spent
    budget.withdraw(remaining)
    got = client.balance("shop") - shop_before
    say(GREEN("✓ owner 取回"), f"{remaining}(充值 {FUND} − 代理已花 {agent_spent})")
    say("shop 实际到账", f"{BOLD(str(got))}(应为 1400 = 两笔 700)")
    why("链上余额对得上:代理只花出了规则允许的部分,一分都没多。")

    print(BOLD(GREEN("\n✓ 演示完毕。")) + "代理通过真实 MCP 工具花钱,")
    print("  每一条「拒绝」都来自链上验证节点并原样回灌给代理 —— 这就是「给 AI 代理的链上强制预算钱包」。")


def main() -> None:
    try:
        asyncio.run(run_demo())
    except Exception as e:
        print(RED("\n[出错] ") + repr(e))
        print(YELLOW("请确认:(1) 本地 swarm 在跑、walletd 在 127.0.0.1:12010;"))
        print(YELLOW("(2) 已在 integrations/agentpay_mcp/.venv 里装好 mcp(见该目录 README)。"))
        sys.exit(1)


if __name__ == "__main__":
    main()
