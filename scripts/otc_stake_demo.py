#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# OtcBoard 仲裁人「质押 + 罚没」链上演示(真实本地链,manifest 提交)。
#
# 剧情:
#   1) owner 建板,设定仲裁人必须质押 500 才能裁决(set_arbiter_stake)
#   2) 卖方挂单、买方接单、开争议
#   3) 仲裁人未质押就想裁决 -> 链当场拒绝(dry-run 显示理由)
#   4) 仲裁人质押 500 -> 再裁决成功,买方收到裁定金额
#   5) owner 认定仲裁人作恶,slash 掉它的质押 -> 质押进国库(treasury)
#
# 单签 devnet 简化:owner/seller/arbiter 都由已充值的 default 账户扮演(模板按公钥判定身份,
# 角色隔离的正确性由 otc_board 的 cargo 测试用不同账户覆盖)。buyer / treasury 是独立账户。
#
# 用法(在 F:\oolte 下,swarm 在跑):
#   python scripts/otc_stake_demo.py <新发布的 OtcBoard 模板地址>
#   # 或设环境变量 OTC_TEMPLATE
import json, time, re, urllib.request, sys, os

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

URL = "http://127.0.0.1:12010/json_rpc"
BOARD_TPL = (sys.argv[1] if len(sys.argv) > 1 else None) or os.environ.get("OTC_TEMPLATE")
DEFAULT = "component_9b4056f17545b091ac77a20c4506b7562b59ed3b7a8b0b164e99fb9c6f71511d"
DEFAULT_PK = "1c3571c3fce0049bd330934f54b9a4403dcabca38afa17b9c5005495a118762a"

if not BOARD_TPL:
    print("用法: python scripts/otc_stake_demo.py <OtcBoard 模板地址>  (或设 OTC_TEMPLATE)")
    sys.exit(2)


def rpc(m, p, t=None):
    b = json.dumps({"jsonrpc": "2.0", "id": 1, "method": m, "params": p}).encode()
    r = urllib.request.Request(URL, data=b, headers={"Content-Type": "application/json"})
    if t:
        r.add_header("Authorization", "Bearer " + t)
    return json.loads(urllib.request.urlopen(r, timeout=120).read())


def tok():
    return rpc("auth.request", {"permissions": ["Admin"], "duration": None, "credentials": "None"})["result"]["token"]


def submit(t, m, v, dry, fee=300000):
    return rpc("transactions.submit_manifest",
               {"manifest": m, "variables": v, "max_fee": fee, "dry_run": dry}, t)


def wait(t, txid, n=60):
    for _ in range(n):
        res = rpc("transactions.get_result", {"transaction_id": txid}, t).get("result")
        if res and ("Accept" in json.dumps(res) or "Reject" in json.dumps(res)):
            return res
        time.sleep(1.5)


def run(t, m, v, fee=300000):
    r = submit(t, m, v, False, fee)
    if "error" in r:
        raise RuntimeError(r["error"]["message"])
    res = wait(t, r["result"].get("transaction_id"))
    if not res or "Reject" in json.dumps(res):
        raise RuntimeError("rejected: " + json.dumps(res)[:300])
    return res


def reject_reason(blob):
    m = re.search(r"Template error: ([^\"\\]+)", blob) or re.search(r'"RejectReason":"([^"]+)"', blob)
    return m.group(1) if m else blob[:160]


def acct(t, name):
    for a in rpc("accounts.list", {"offset": 0, "limit": 50}, t)["result"]["accounts"]:
        if a["account"]["name"] == name:
            return a["account"]["component_address"]
    rpc("accounts.create", {"account_name": name, "custom_access_rules": None, "max_fee": None, "is_default": False, "key_id": None}, t)
    rpc("accounts.create_free_test_coins", {"account": {"Name": name}, "amount": 1000000, "max_fee": 50000, "key_id": None}, t)
    return [a["account"]["component_address"] for a in rpc("accounts.list", {"offset": 0, "limit": 50}, t)["result"]["accounts"] if a["account"]["name"] == name][0]


def bal(t, name):
    for b in rpc("accounts.get_balances", {"account": {"Name": name}, "refresh": True}, t)["result"].get("balances", []):
        if b["token_symbol"] == "tTARI":
            return int(b["balance"])
    return 0


def new_comp(blob, known):
    return next(c for c in set(re.findall(r"component_[0-9a-f]{64}", blob)) if c not in known)


def new_resource(blob):
    cands = [r for r in set(re.findall(r"resource_[0-9a-f]{64}", blob))
             if not r.startswith("resource_0101") and not r.startswith("resource_0000")]
    return cands[0]


def sha(s):
    import hashlib
    return hashlib.sha256(s.encode()).hexdigest()


def main():
    t = tok()
    treasury = acct(t, "otc_stk_treasury")
    buyer = acct(t, "otc_stk_buyer")
    print(f"模板 = {BOARD_TPL[:28]}…")
    print(f"owner/seller/arbiter = default ; treasury = {treasury[:18]}… ; buyer = {buyer[:18]}…")

    print("\n【1】owner 建板(bond≥50, max 5000, 手续费 5%, 仲裁人=default)")
    NEW = (f'use {BOARD_TPL} as OtcBoard;\n'
           'fn main() { let mut o=var!["o"]; '
           f'let (c,ob)=OtcBoard::new(address!("{treasury}"), amount!(50), amount!(5000), 500u64, [public_key!("{DEFAULT_PK}")], []); '
           'o.deposit(ob); }')
    res = run(t, NEW, {"o": DEFAULT})
    board = new_comp(json.dumps(res), {DEFAULT, treasury, buyer})
    owner_badge = new_resource(json.dumps(res))
    print(f"  board = {board}")
    print(f"  owner_badge = {owner_badge[:28]}…")

    print("\n【2】owner 设定:仲裁人必须质押 500 才能裁决(set_arbiter_stake)")
    SET = ('fn main() { let mut o=var!["o"]; '
           f'let p=o.create_proof_for_resource(address!("{owner_badge}")); '
           'let mut b=var!["b"]; b.set_arbiter_stake(amount!(500)); drop_all_proofs!(); }')
    run(t, SET, {"o": DEFAULT, "b": board})
    print("  已设 arbiter_stake = 500")

    print("\n【3】仲裁人先质押 500(新规则:take 时必须已有足额【空闲】质押,否则买方无法接单)")
    STAKE = ('fn main() { let mut a=var!["a"]; let s=a.withdraw(XTR, amount!(500)); '
             'let mut b=var!["b"]; b.stake_arbiter(s); }')
    run(t, STAKE, {"a": DEFAULT, "b": board})
    print("  已质押 500")

    print("\n【4】卖方挂单 1000 + 保证金 100,买方接单(质押被锁定到该单),开争议")
    LIST = ('fn main() { let mut s=var!["s"]; '
            'let asset=s.withdraw(XTR, amount!(1000)); let bond=s.withdraw(XTR, amount!(100)); '
            'let mut b=var!["b"]; '
            f'b.list(asset, bond, address!("{DEFAULT}"), hex_bytes!("{sha("stake demo")}"), public_key!("{DEFAULT_PK}"), 20u64); }}')
    run(t, LIST, {"s": DEFAULT, "b": board})
    run(t, f'fn main() {{ let mut b=var!["b"]; b.take(0u64, address!("{buyer}"), public_key!("{DEFAULT_PK}"), public_key!("{DEFAULT_PK}")); }}', {"b": board})
    run(t, 'fn main() { let mut b=var!["b"]; b.open_dispute(0u64); }', {"b": board})
    print("  listing 0:已挂单→已接单→争议中")

    print("\n【5】仲裁人想在争议中取回质押逃避罚没 → 链应当拒绝(质押已锁定到活跃挂单)")
    UNSTAKE = ('fn main() { let mut b=var!["b"]; let s=b.unstake_arbiter(); '
               f'let mut a=var!["a"]; a.deposit(s); }}')
    dr = submit(t, UNSTAKE, {"a": DEFAULT, "b": board}, True)
    blob = json.dumps(dr)
    if "error" in dr:
        print(f"  ✓ 被拒:{dr['error']['message'][:120]}")
    elif "Reject" in blob:
        print(f"  ✓ 被拒(链上理由):{reject_reason(blob)}")
    else:
        print("  ✗ 意外:争议中竟能取回质押(检查模板逻辑)")

    print("\n【6】仲裁人正常裁决 → 成功")
    RESOLVE = 'fn main() { let mut b=var!["b"]; b.resolve(0u64, amount!(600)); }'
    bb = bal(t, "otc_stk_buyer")
    run(t, RESOLVE, {"b": board})
    print(f"  ✓ 裁决成功;买方到账 {bal(t,'otc_stk_buyer')-bb}(600 的 95% = 570)")

    print("\n【7】owner 认定仲裁人作恶 → slash 掉其质押(slash_arbiter)")
    tb = bal(t, "otc_stk_treasury")
    SLASH = ('fn main() { let mut o=var!["o"]; '
             f'let p=o.create_proof_for_resource(address!("{owner_badge}")); '
             f'let mut b=var!["b"]; b.slash_arbiter(public_key!("{DEFAULT_PK}")); drop_all_proofs!(); }}')
    run(t, SLASH, {"o": DEFAULT, "b": board})
    print(f"  ✓ 罚没完成;国库(treasury)增加 {bal(t,'otc_stk_treasury')-tb}(= 被没收的 500 质押)")

    print("\n全部在真实本地链上发生并核对。质押是仲裁人的「skin in the game」,作恶会被罚没。")


if __name__ == "__main__":
    main()
