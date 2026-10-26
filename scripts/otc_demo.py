#!/usr/bin/env python3
# On-chain demo of the OtcBoard OTC flow against the live swarm.
# Roles seller/arbiter/owner are played by the funded `default` account (single signer, devnet
# simplicity); buyer and treasury are distinct accounts that receive the asset / the fee. The
# role-separation correctness is covered by otc_board's cargo tests (distinct accounts).
import json, time, hashlib, re, urllib.request, sys
URL="http://127.0.0.1:12010/json_rpc"
BOARD_TPL="template_8bfa294dc89b6fdccccb123becaee056d0c250f9c1613d06b7c8571d10cb0ff1"
DEFAULT="component_9b4056f17545b091ac77a20c4506b7562b59ed3b7a8b0b164e99fb9c6f71511d"
DEFAULT_PK="1c3571c3fce0049bd330934f54b9a4403dcabca38afa17b9c5005495a118762a"

def rpc(m,p,t=None):
    b=json.dumps({"jsonrpc":"2.0","id":1,"method":m,"params":p}).encode()
    r=urllib.request.Request(URL,data=b,headers={"Content-Type":"application/json"})
    if t: r.add_header("Authorization","Bearer "+t)
    return json.loads(urllib.request.urlopen(r,timeout=120).read())
def tok(): return rpc("auth.request",{"permissions":["Admin"],"duration":None,"credentials":"None"})["result"]["token"]
def submit(t,m,v,dry,fee=300000): return rpc("transactions.submit_manifest",{"manifest":m,"variables":v,"max_fee":fee,"dry_run":dry},t)
def wait(t,txid,n=60):
    for _ in range(n):
        res=rpc("transactions.get_result",{"transaction_id":txid},t).get("result")
        if res and ("Accept" in json.dumps(res) or "Reject" in json.dumps(res)): return res
        time.sleep(1.5)
def run(t,m,v,fee=300000):
    r=submit(t,m,v,False,fee)
    if "error" in r: raise RuntimeError(r["error"]["message"])
    res=wait(t,r["result"].get("transaction_id"))
    if not res or "Reject" in json.dumps(res): raise RuntimeError("rejected: "+json.dumps(res)[:300])
    return res
def acct(t,name):
    for a in rpc("accounts.list",{"offset":0,"limit":50},t)["result"]["accounts"]:
        if a["account"]["name"]==name: return a["account"]["component_address"]
    rpc("accounts.create",{"account_name":name,"custom_access_rules":None,"max_fee":None,"is_default":False,"key_id":None},t)
    rpc("accounts.create_free_test_coins",{"account":{"Name":name},"amount":1000000,"max_fee":50000,"key_id":None},t)
    return [a["account"]["component_address"] for a in rpc("accounts.list",{"offset":0,"limit":50},t)["result"]["accounts"] if a["account"]["name"]==name][0]
def bal(t,name):
    for b in rpc("accounts.get_balances",{"account":{"Name":name},"refresh":True},t)["result"].get("balances",[]):
        if b["token_symbol"]=="tTARI": return int(b["balance"])
    return 0
def terms_hex(s): return hashlib.sha256(s.encode()).hexdigest()
def new_comp(blob,known): return next(c for c in set(re.findall(r"component_[0-9a-f]{64}",blob)) if c not in known)

def main():
    t=tok()
    treasury=acct(t,"otc_treasury"); buyer=acct(t,"otc_buyer")
    print(f"board owner/seller/arbiter = default; treasury={treasury[:20]}… buyer={buyer[:20]}…")

    print("\n== Owner creates the board (bond>=50, max 5000, 5% fee, arbiter=default) ==")
    NEW=f'''use {BOARD_TPL} as OtcBoard;
fn main() {{ let mut o=var!["o"]; let (c,ob)=OtcBoard::new(address!("{treasury}"), amount!(50), amount!(5000), 500u64, [public_key!("{DEFAULT_PK}")]); o.deposit(ob); }}'''
    res=run(t,NEW,{"o":DEFAULT})
    board=new_comp(json.dumps(res),{DEFAULT,treasury,buyer})
    print(f"  board = {board}")

    print("\n== Seller lists 1000 (asset) + 100 (bond), arbiter=default ==")
    LIST=f'''fn main() {{
  let mut s=var!["s"];
  let asset=s.withdraw(XTR, amount!(1000));
  let bond=s.withdraw(XTR, amount!(100));
  let mut b=var!["b"];
  b.list(asset, bond, address!("{DEFAULT}"), hex_bytes!("{terms_hex("widget terms v1")}"), public_key!("{DEFAULT_PK}"), 20u64);
}}'''
    r=submit(t,LIST,{"s":DEFAULT,"b":board},True)
    if "error" in r: print("  LIST dry error:",json.dumps(r["error"])[:300]); return
    run(t,LIST,{"s":DEFAULT,"b":board})
    print("  listed (id 0)")

    print("\n== Buyer takes listing 0 ==")
    TAKE=f'''fn main() {{ let mut b=var!["b"]; b.take(0u64, address!("{buyer}"), public_key!("{DEFAULT_PK}"), None); }}'''
    run(t,TAKE,{"b":board})
    print("  taken")

    bb=bal(t,"otc_buyer"); tb=bal(t,"otc_treasury")
    print("\n== Seller confirms (buyer paid off-chain) -> asset to buyer minus fee ==")
    CONF=f'''fn main() {{ let mut b=var!["b"]; b.confirm(0u64, None); }}'''
    res=run(t,CONF,{"b":board})
    evs=[p for p in (ev.get("payload") for ev in _events(res)) if isinstance(p,dict) and "to_buyer" in p]
    print("  confirm events:",evs[:2])
    print(f"  buyer received: {bal(t,'otc_buyer')-bb} (expected 950)  treasury fee: {bal(t,'otc_treasury')-tb} (expected 50)")

    # ---- dispute path: second listing, buyer disputes, arbiter splits ----
    print("\n== Second listing (id 1): seller lists 1000 + 100 bond ==")
    run(t,LIST,{"s":DEFAULT,"b":board})   # same LIST manifest -> id 1
    print("\n== Buyer takes listing 1 ==")
    TAKE1=f'''fn main() {{ let mut b=var!["b"]; b.take(1u64, address!("{buyer}"), public_key!("{DEFAULT_PK}"), None); }}'''
    run(t,TAKE1,{"b":board})
    print("\n== A party opens a dispute (seller=default here) ==")
    run(t,f'''fn main() {{ let mut b=var!["b"]; b.open_dispute(1u64); }}''',{"b":board})

    bb=bal(t,"otc_buyer"); tb=bal(t,"otc_treasury"); sb=bal(t,"default")
    print("\n== Arbiter resolves: award 600 of 1000 to the buyer (5% fee on that) ==")
    res=run(t,f'''fn main() {{ let mut b=var!["b"]; b.resolve(1u64, amount!(600)); }}''',{"b":board})
    print(f"  buyer received: {bal(t,'otc_buyer')-bb} (expected 570 = 600 - 5% fee)")
    print(f"  treasury fee:   {bal(t,'otc_treasury')-tb} (expected 30)")
    print(f"  seller net (incl. 400 + 100 bond back): {bal(t,'default')-sb} (expected ~500 minus tx fees)")

def _events(res):
    def w(o):
        if isinstance(o,dict):
            if "payload" in o and ("topic" in o or "substate_id" in o): yield o
            for v in o.values(): yield from w(v)
        elif isinstance(o,list):
            for v in o: yield from w(v)
    yield from w(res)

if __name__ == "__main__":
    main()
