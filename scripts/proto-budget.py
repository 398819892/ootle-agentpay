#!/usr/bin/env python3
import json, time, urllib.request, re
URL = "http://127.0.0.1:12010/json_rpc"
BUDGET_TPL = "template_758d0c587624cab9634692a9b13424e2da89e7389e0e8e2272c6dc7bdeec5b97"
DEFAULT = "component_9b4056f17545b091ac77a20c4506b7562b59ed3b7a8b0b164e99fb9c6f71511d"
BOB = "component_599dfb26007103e65e729f6ec3290bd2a67088946300cd987c9863d13c891417"

def rpc(m,p,t=None):
    b=json.dumps({"jsonrpc":"2.0","id":1,"method":m,"params":p}).encode()
    r=urllib.request.Request(URL,data=b,headers={"Content-Type":"application/json"})
    if t: r.add_header("Authorization","Bearer "+t)
    return json.loads(urllib.request.urlopen(r,timeout=60).read())
def tok(): return rpc("auth.request",{"permissions":["Admin"],"duration":None,"credentials":"None"})["result"]["token"]
def submit(t,m,v,dry): return rpc("transactions.submit_manifest",{"manifest":m,"variables":v,"max_fee":200000,"dry_run":dry},t)
def wait(t,txid,n=40):
    for _ in range(n):
        res=rpc("transactions.get_result",{"transaction_id":txid},t).get("result")
        if res and ('"Accept"' in json.dumps(res) or '"Reject"' in json.dumps(res)): return res
        time.sleep(1.5)
def txid(r):
    for k in ("transaction_id","hash","id"):
        if isinstance(r,dict) and k in r: return r[k]

INST=f'''use {BUDGET_TPL} as AgentBudget;
fn main() {{
    let mut owner = var!["owner"];
    let funds = owner.withdraw(XTR, amount!(10000));
    let (comp, owner_badge, agent_badge) = AgentBudget::new(funds, amount!(1000), amount!(3000), 10u64, [address!("{BOB}")]);
    owner.deposit(owner_badge);
    owner.deposit(agent_badge);
}}
'''
def pay_manifest(badge, budget, merchant, amt, memo):
    return f'''fn main() {{
    let mut agent = var!["agent"];
    let proof = agent.create_proof_for_resource(address!("{badge}"));
    let mut budget = var!["budget"];
    budget.pay(address!("{merchant}"), amount!({amt}), "{memo}");
    drop_all_proofs!();
}}
'''

def main():
    t=tok()
    print("=== instantiate (real) ===")
    r=submit(t,INST,{"owner":DEFAULT},False)
    if "error" in r: print("ERR",r["error"]); return
    res=wait(t,txid(r["result"]));
    if not res or '"Reject"' in json.dumps(res): print("reject",json.dumps(res)[:300]); return
    txt=json.dumps(res)
    budget=next(c for c in set(re.findall(r"component_[0-9a-f]{64}",txt)) if c not in {DEFAULT,BOB})
    badges=[x for x in set(re.findall(r"resource_[0-9a-f]{64}",txt)) if not x.startswith("resource_0101") and not x.startswith("resource_0000")]
    print("budget:",budget); print("badges:",badges)

    # empirically find the agent badge: the one whose proof lets pay succeed (dry_run)
    agent_badge=None
    for b in badges:
        r=submit(t,pay_manifest(b,budget,BOB,500,"ap1|inv0001|shopper"),{"agent":DEFAULT,"budget":budget},True)
        ok = "error" not in r
        reason = json.dumps(r.get("error") or r.get("result",{})).replace(" ","")
        print(f"  badge {b[:18]} pay dry -> {'OK' if ok else 'ERR'} {('fees='+str(r['result'].get('required_fees'))) if ok else reason[:120]}")
        if ok: agent_badge=b
    print("AGENT BADGE =", agent_badge)
    if agent_badge:
        # confirm memo + pay event present in the dry result
        r=submit(t,pay_manifest(agent_badge,budget,BOB,500,"ap1|inv0001|shopper"),{"agent":DEFAULT,"budget":budget},True)
        s=json.dumps(r["result"])
        print("pay event present:", '"pay"' in s and "ap1|inv0001|shopper" in s)
        # and that an over-cap pay is rejected on-chain
        r2=submit(t,pay_manifest(agent_badge,budget,BOB,5000,"ap1|inv0002|x"),{"agent":DEFAULT,"budget":budget},True)
        print("over-cap pay (5000 > 1000) rejected:", "error" in r2 or '"Reject"' in json.dumps(r2.get("result","")))
        print("  reason:", json.dumps(r2.get("error") or r2.get("result"))[:200])

main()
