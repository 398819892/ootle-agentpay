#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AgentPay 本地 Web 控制台 —— 浏览器里点按钮,实时看链上限额生效。

启动(在 F:\\oolte 目录下):

    python scripts/console.py

然后浏览器打开 http://127.0.0.1:8700 。

它是一个纯标准库的小后台:把现成的 Python SDK(OnChainBudget)包成几个 JSON 接口,
每个按钮都对着真实的本地链(swarm)提交交易。前提是本地 swarm 的钱包守护进程
JSON-RPC 在 127.0.0.1:12010(auth=none);搭法见 docs/devnet.md。
"""
from __future__ import annotations

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
sys.path.insert(0, os.path.join(_ROOT, "sdk", "src"))

from agentpay.errors import ChainError, PolicyViolation  # noqa: E402
from agentpay.onchain import OnChainBudget, WalletdClient  # noqa: E402

BUDGET_TEMPLATE = os.environ.get(
    "BUDGET_TEMPLATE",
    "template_758d0c587624cab9634692a9b13424e2da89e7389e0e8e2272c6dc7bdeec5b97",
)
PORT = int(os.environ.get("PORT", "8700"))
HTML_PATH = os.path.join(_HERE, "console.html")


class State:
    """服务端内存状态 —— 一个控制台单用户,够用。"""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.client: WalletdClient | None = None
        self.owner = ""
        self.shop = ""
        self.scammer = ""
        self.budget: OnChainBudget | None = None
        self.fund = 0
        self.log: list[dict] = []

    # -- 连接 + 账户 ---------------------------------------------------------
    def connect(self) -> None:
        if self.client:
            return
        c = WalletdClient().connect()
        self.owner = c.account_address("default")
        self.shop = _ensure(c, "shop")
        self.scammer = _ensure(c, "scammer")
        self.client = c

    def add_log(self, action: str, ok: bool, detail: str) -> None:
        self.log.insert(0, {"action": action, "ok": ok, "detail": detail})
        self.log = self.log[:30]

    def _name_of(self, addr: str) -> str:
        if addr == self.shop:
            return "shop"
        if addr == self.scammer:
            return "scammer"
        return addr[:12] + "…"

    def _safe_balance(self, name: str):
        """查余额失败(链一时读不到)返回 None,而不是把整页打成「未连接」。"""
        try:
            return self.client.balance(name)
        except Exception:
            return None

    def scammer_whitelisted(self) -> bool:
        b = self.budget
        return bool(b and self.scammer in (b.whitelist or []))

    # -- 快照给前端 ---------------------------------------------------------
    def snapshot(self) -> dict:
        c = self.client
        s: dict = {
            "connected": c is not None,
            "owner": self.owner,
            "shop": self.shop,
            "scammer": self.scammer,
            "template": BUDGET_TEMPLATE,
            "log": self.log,
            "budget": None,
        }
        if c:
            s["owner_balance"] = self._safe_balance("default")
            s["shop_balance"] = self._safe_balance("shop")
            s["scammer_whitelisted"] = self.scammer_whitelisted()
        b = self.budget
        if b and b.component:
            s["budget"] = {
                "component": b.component,
                "per_tx_cap": b.per_tx_cap,
                "daily_cap": b.daily_cap,
                "spent": b.spent,
                "remaining": max(0, b.daily_cap - b.spent),
                "vault": max(0, self.fund - b.spent),
                "fund": self.fund,
                "revoked": b.revoked,
                "whitelist": [self._name_of(a) for a in b.whitelist],
                "ledger": [{"amount": e.amount, "merchant": e.merchant, "memo": e.memo}
                           for e in b.ledger],
            }
        return s


STATE = State()


def _ensure(client: WalletdClient, name: str) -> str:
    try:
        return client.account_address(name)
    except ChainError:
        addr = client.create_account(name)
        client.fund(name)
        return addr


# --- 各动作 ---------------------------------------------------------------------
def act_open(body: dict) -> dict:
    STATE.connect()
    fund = int(body.get("fund", 10000))
    per_tx = int(body.get("per_tx", 1000))
    daily = int(body.get("daily", 1500))
    b = OnChainBudget(STATE.client, BUDGET_TEMPLATE, STATE.owner).open(
        fund=fund, per_tx_cap=per_tx, daily_cap=daily, epochs_per_window=10,
        whitelist=[STATE.shop],
    )
    STATE.budget = b
    STATE.fund = fund
    STATE.add_log("开预算", True,
                  f"充值 {fund},单笔≤{per_tx},日限额≤{daily},白名单=[shop] → 合约 {b.component[:18]}…")
    return {"ok": True}


def act_pay(body: dict) -> dict:
    b = STATE.budget
    if not b or not b.component:
        return {"ok": False, "reason": "还没开预算"}
    target = body.get("target", "shop")
    amount = int(body.get("amount", 100))
    merchant = STATE.shop if target == "shop" else STATE.scammer
    if target == "shop":
        label = "shop(白名单)"
    else:
        label = "scammer(白名单)" if STATE.scammer_whitelisted() else "scammer(非白名单)"
    memo = f"console|{target}|{amount}"
    # 先 dry-run 问验证节点「这么付会不会被拒」—— 会拒就立刻拿到链上理由(秒回,
    # 不会卡;被拒的交易真提交上链反而不会返回结果、要傻等超时)。不会拒才真的提交。
    reason = b.would_reject(merchant, amount, memo=memo)
    if reason:
        STATE.add_log(f"付款 {amount} → {label}", False, f"链拒绝:{reason}")
        return {"ok": False, "reason": str(reason)}
    try:
        res = STATE.client.run(b._pay_manifest(merchant, amount, memo),
                               {"agent": b.agent_account, "budget": b.component})
    except (ChainError, PolicyViolation) as e:
        reason = e.args[0] if isinstance(e, PolicyViolation) else str(e)
        if isinstance(reason, (list, tuple)):
            reason = reason[0]
        STATE.add_log(f"付款 {amount} → {label}", False, f"链拒绝:{reason}")
        return {"ok": False, "reason": str(reason)}
    for ev in OnChainBudget.pay_events(res):
        b.spent += int(ev.get("amount", amount))
        from agentpay.onchain import LedgerEntry
        b.ledger.append(LedgerEntry(ev.get("merchant", merchant),
                                    int(ev.get("amount", amount)), ev.get("memo", memo), "pay"))
    STATE.add_log(f"付款 {amount} → {label}", True, f"成功,窗口内已花 {b.spent}/{b.daily_cap}")
    return {"ok": True}


def act_revoke(_body: dict) -> dict:
    b = STATE.budget
    if not b or not b.component:
        return {"ok": False, "reason": "还没开预算"}
    b.revoke()
    STATE.add_log("撤销代理", True, "急停已触发,之后任何付款都会被链拒绝")
    return {"ok": True}


def act_withdraw(_body: dict) -> dict:
    b = STATE.budget
    if not b or not b.component:
        return {"ok": False, "reason": "还没开预算"}
    remaining = max(0, STATE.fund - b.spent)
    if remaining:
        b.withdraw(remaining)
    STATE.add_log("提现", True, f"把合约里剩余的 {remaining} 取回所有者账户")
    return {"ok": True}


def act_add_merchant(_body: dict) -> dict:
    b = STATE.budget
    if not b or not b.component:
        return {"ok": False, "reason": "还没开预算"}
    if b.revoked:
        return {"ok": False, "reason": "代理已撤销"}
    if STATE.scammer in (b.whitelist or []):
        return {"ok": False, "reason": "scammer 已在白名单"}
    b.add_merchant(STATE.scammer)   # 链上 add_merchant,需所有者凭证
    STATE.add_log("加白名单", True, "把 scammer 加入白名单,之后给它付款不再被链拒绝")
    return {"ok": True}


def act_reset(_body: dict) -> dict:
    STATE.budget = None
    STATE.fund = 0
    STATE.add_log("新建", True, "清空当前预算,可重新开一个")
    return {"ok": True}


ACTIONS = {
    "open": act_open, "pay": act_pay, "revoke": act_revoke,
    "withdraw": act_withdraw, "reset": act_reset, "add_merchant": act_add_merchant,
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a) -> None:  # 静音默认访问日志
        pass

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path in ("/", "/index.html"):
            try:
                with open(HTML_PATH, "rb") as f:
                    self._send(200, f.read(), "text/html; charset=utf-8")
            except FileNotFoundError:
                self._send(500, b"console.html missing", "text/plain; charset=utf-8")
        elif self.path == "/api/state":
            def snap() -> dict:
                with STATE.lock:
                    try:
                        STATE.connect()      # 懒连接:首次打开页面就连上本地链
                    except Exception as e:
                        return {"connected": False, "log": STATE.log,
                                "reason": f"本地链未就绪:{e}"}
                    return STATE.snapshot()
            self._json(self._guard(snap))
        else:
            self._send(404, b"not found", "text/plain; charset=utf-8")

    def do_POST(self) -> None:
        if not self.path.startswith("/api/"):
            self._send(404, b"not found", "text/plain; charset=utf-8")
            return
        name = self.path[len("/api/"):]
        fn = ACTIONS.get(name)
        if not fn:
            self._send(404, b"unknown action", "text/plain; charset=utf-8")
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        body = json.loads(self.rfile.read(length) or b"{}") if length else {}

        def run() -> dict:
            with STATE.lock:
                out = fn(body)
            out["state"] = STATE.snapshot()
            return out

        self._json(self._guard(run))

    def _guard(self, fn):
        try:
            return fn()
        except Exception as e:  # 把后台错误原样回前端,方便排查
            return {"ok": False, "reason": f"{type(e).__name__}: {e}"}

    def _json(self, obj: dict) -> None:
        self._send(200, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")


def main() -> None:
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"AgentPay 控制台已启动 → http://127.0.0.1:{PORT}")
    print("（Ctrl+C 停止）在浏览器打开上面的地址开始点。")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")


if __name__ == "__main__":
    main()
