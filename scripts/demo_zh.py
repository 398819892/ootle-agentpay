#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一键中文讲解演示 —— 看懂这个 DApp 到底在干什么。

它对着**真实的本地链**(local swarm)一步步演示 "AI 代理支付钱包(AgentPay 链上版)":
所有者充值并发凭证给代理,代理只能在链上规则内花钱 —— 单笔上限、每日上限、
商户白名单、随时撤销。每一步都暂停,并说明"这一步证明了什么"。

用法(在 F:\\oolte 目录下):

    python scripts/demo_zh.py          # 一步步演示,每步回车继续
    python scripts/demo_zh.py --auto   # 不暂停,一口气跑完
    python scripts/demo_zh.py --otc    # 改演示 P2P 场外托管(OTC)流程

前提:本地 swarm 的钱包守护进程 JSON-RPC 在 127.0.0.1:12010 (auth=none)。
搭法见 docs/devnet.md。本脚本只用 Python 标准库,会自动找到仓库里的 SDK。
"""
from __future__ import annotations

import os
import sys

# Windows 控制台默认 GBK,会把中文/符号输出搞崩或乱码 —— 强制走 UTF-8。
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

# --- 自动把仓库里的 SDK 加进来,这样不用手动设 PYTHONPATH ----------------------
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)                       # F:\oolte
sys.path.insert(0, os.path.join(_ROOT, "sdk", "src"))

AUTO = "--auto" in sys.argv or not sys.stdout.isatty()
OTC = "--otc" in sys.argv

# 已发布到本地链的模板地址(发布一次就常驻链上)
BUDGET_TEMPLATE = os.environ.get(
    "BUDGET_TEMPLATE",
    "template_758d0c587624cab9634692a9b13424e2da89e7389e0e8e2272c6dc7bdeec5b97",
)


# --- 小工具:彩色/分隔/暂停 ----------------------------------------------------
def c(code: str, s: str) -> str:
    return s if os.environ.get("NO_COLOR") else f"\033[{code}m{s}\033[0m"


BOLD = lambda s: c("1", s)
GREEN = lambda s: c("32", s)
RED = lambda s: c("31", s)
CYAN = lambda s: c("36", s)
DIM = lambda s: c("2", s)
YELLOW = lambda s: c("33", s)

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


def pause() -> None:
    if AUTO:
        return
    try:
        input(DIM("     (按回车继续…)"))
    except EOFError:
        pass


# ================================ AgentPay 演示 ================================
def demo_agentpay() -> None:
    from agentpay.errors import ChainError
    from agentpay.invoice import new_invoice_id
    from agentpay.onchain import OnChainBudget, WalletdClient

    print(BOLD("\n╔══════════════════════════════════════════════════════════╗"))
    print(BOLD("║   AgentPay 链上版 —— 给 AI 代理的「带护栏」支付钱包      ║"))
    print(BOLD("╚══════════════════════════════════════════════════════════╝"))
    print("剧情:你(所有者)给一个 AI 代理一张会话凭证,让它替你付钱,")
    print("但花钱的规矩由" + BOLD("链上验证节点强制执行") + ",代理再怎么耍也突破不了。")
    pause()

    c0 = WalletdClient().connect()
    step("连接本地链,准备三个角色")
    owner = c0.account_address("default")
    shop = _ensure(c0, "shop")       # 白名单内的商户
    scammer = _ensure(c0, "scammer") # 不在白名单
    say("所有者(你)", owner[:30] + "…")
    say("商户 shop(白名单内)", shop[:30] + "…")
    say("骗子 scammer(不在白名单)", scammer[:30] + "…")
    why("这些都是本地链上的真实账户,余额是真的链上余额。")
    pause()

    step("所有者开一个预算:充值 10000,单笔上限 1000,每日上限 1500,只许付给 shop")
    budget = OnChainBudget(c0, BUDGET_TEMPLATE, owner).open(
        fund=10_000, per_tx_cap=1_000, daily_cap=1_500, epochs_per_window=10, whitelist=[shop],
    )
    say("预算合约已上链", budget.component[:30] + "…")
    say("规则", "单笔≤1000 · 日限额≤1500 · 白名单=[shop] · 可随时撤销")
    why("这几条规则现在写进了链上合约。接下来每笔付款都要过验证节点这一关。")
    shop_before = c0.balance("shop")
    pause()

    step("代理给 shop 付一笔正常的钱(700),带发票号")
    inv = new_invoice_id()
    res = budget.pay_invoice(merchant=shop, invoice_id=inv, amount=700, agent_tag="shopper")
    ev = OnChainBudget.pay_events(res)[0]
    say(GREEN("✓ 成功"), f"付了 {ev['amount']},发票号随 memo 一起上链:{ev['memo']}")
    say("窗口内已花", f"{ev['spent_in_window']} / 1500")
    why("700 ≤ 单笔上限,且 shop 在白名单,所以链接受了。")
    pause()

    step("代理想耍花招 —— 链当场拒绝(是验证节点在拒,不是前端装样子)")
    r1 = budget.would_reject(shop, 1500)
    say(RED("✗ 超单笔上限"), f"付 1500(>1000)→ 链拒绝:{BOLD(r1)}")
    r2 = budget.would_reject(scammer, 100)
    say(RED("✗ 非白名单商户"), f"付给 scammer 100 → 链拒绝:{BOLD(r2)}")
    why("这两笔是问链「如果这么付会怎样」,链直接给出拒绝理由。代理无法绕过。")
    pause()

    step("再正常付一笔 700 —— 累计 1400,逼近每日上限")
    budget.pay(shop, 700, memo="ap1|second|shopper")
    say(GREEN("✓ 成功"), f"又付 700,窗口内累计已花 {budget.spent} / 1500")
    r3 = budget.would_reject(shop, 700)
    say(RED("✗ 超每日上限"), f"再付 700(1400+700>1500)→ 链拒绝:{BOLD(r3)}")
    why("单笔没超,但会突破当日累计额度,链照样拦 —— 日限额也是链上强制的。")
    pause()

    step("所有者按下急停:撤销代理")
    budget.revoke()
    r4 = budget.would_reject(shop, 100)
    say(RED("✗ 已撤销"), f"撤销后再付任意金额 → 链拒绝:{BOLD(r4)}")
    why("一次撤销,代理的凭证就彻底失效。这是你的 kill switch。")
    pause()

    step("所有者把没花完的钱取回来,收尾核对")
    remaining = 10_000 - budget.spent
    budget.withdraw(remaining)
    got = c0.balance("shop") - shop_before
    say(GREEN("✓ 取回"), f"{remaining}(10000 充值 − {budget.spent} 已花)")
    say("shop 实际到账", f"{BOLD(str(got))}(应为 1400 = 两笔 700)")
    why("链上余额对得上:代理只花出了规则允许的部分,一分都没多。")

    print(BOLD(GREEN("\n✓ 演示完毕。")) + "你刚看到的每一条「拒绝」都来自链上验证节点,")
    print("  不是客户端自觉 —— 这就是「AgentPay 链上版」的核心卖点。")
    print(DIM("  想看 P2P 场外托管流程:python scripts/demo_zh.py --otc"))


def _ensure(client, name: str) -> str:
    from agentpay.errors import ChainError
    try:
        return client.account_address(name)
    except ChainError:
        addr = client.create_account(name)
        client.fund(name)
        return addr


# ================================== OTC 演示 ==================================
def demo_otc() -> None:
    import otc_demo  # 复用现成的链上 OTC 演示脚本(同目录)
    print(BOLD("\n╔══════════════════════════════════════════════════════════╗"))
    print(BOLD("║   隐私 P2P 场外托管(OTC)—— 挂单→接单→确认 / 争议→仲裁 ║"))
    print(BOLD("╚══════════════════════════════════════════════════════════╝"))
    print("卖方把资产锁进托管 → 买方接单并链下付款 → 放币(扣手续费)/ 超时退回 /")
    print("争议时由仲裁人按比例分配。下面是对真实本地链的完整走一遍。")
    pause()
    otc_demo.main()
    print(BOLD(GREEN("\n✓ OTC 演示完毕。")) + "买方到账、平台手续费、争议分配都在链上发生并核对过。")


def main() -> None:
    try:
        if OTC:
            demo_otc()
        else:
            demo_agentpay()
    except Exception as e:
        print(RED("\n[出错] ") + str(e))
        print(YELLOW("请确认本地 swarm 在跑、钱包守护进程 JSON-RPC 在 127.0.0.1:12010。"))
        print(YELLOW("搭建/恢复见 docs/devnet.md。"))
        sys.exit(1)


if __name__ == "__main__":
    main()
