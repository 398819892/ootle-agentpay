#!/usr/bin/env python3
# Real on-chain verification of the Escrow template on the local swarm.
# Flow: instantiate an escrow (payer=default funds 1000, payee=bob, treasury=fees, 5% fee),
# then release; check bob/fees balances move by +950/+50.
import json, sys, time, urllib.request

URL = "http://127.0.0.1:12010/json_rpc"
TPL = "template_9b230fab92bd2c2e32b82d28162854b9d31a2cb6a950a7920088cb8d54f2ef90"
DEFAULT = "component_9b4056f17545b091ac77a20c4506b7562b59ed3b7a8b0b164e99fb9c6f71511d"
BOB = "component_599dfb26007103e65e729f6ec3290bd2a67088946300cd987c9863d13c891417"
BOB_PK = "de8b4c8e1842616885893da7b8b227f58dc2b840765b2fe5522a43c6b8e5e42d"
FEES = "component_d5b68993d9dd8375f5f54a0db3739418bb322565ce61f8ccce2c86300ff899d3"

def rpc(method, params, token=None):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json"})
    if token:
        req.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())

def token():
    r = rpc("auth.request", {"permissions": ["Admin"], "duration": None, "credentials": "None"})
    return r["result"]["token"]

def balance(tok, name):
    r = rpc("accounts.get_balances", {"account": {"Name": name}, "refresh": True}, tok)
    for b in r["result"]["balances"]:
        if b["token_symbol"] == "tTARI":
            return int(b["balance"])
    return 0

def submit(tok, manifest, dry_run):
    params = {
        "manifest": manifest,
        "variables": {"payer": DEFAULT},
        "max_fee": 50000,
        "dry_run": dry_run,
    }
    return rpc("transactions.submit_manifest", params, tok)

INSTANTIATE = f'''use {TPL} as Escrow;
fn main() {{
    let mut payer = var!["payer"];
    let funds = payer.withdraw(XTR, amount!(1000));
    Escrow::new(
        funds,
        address!("{DEFAULT}"),
        address!("{BOB}"),
        public_key!("{BOB_PK}"),
        None,
        address!("{FEES}"),
        None,
        10u64,
        500u64
    );
}}
'''

KNOWN = {DEFAULT, BOB, FEES, "component_128407a4db61ad65b1cdd8d85cfdc490802b3750e70119f951cf4b63f8dd457c"}

def tx_id_of(res):
    for k in ("transaction_id", "transaction_hash", "hash", "id"):
        if isinstance(res, dict) and k in res:
            return res[k]
    return None

def wait_result(tok, tx_id, tries=40):
    import re
    for _ in range(tries):
        r = rpc("transactions.get_result", {"transaction_id": tx_id}, tok)
        res = r.get("result") or r
        txt = json.dumps(res)
        if '"Accept"' in txt or '"Reject"' in txt or '"finalize"' in txt:
            return res, txt
        time.sleep(1.5)
    return None, ""

def new_component(txt):
    import re
    comps = set(re.findall(r"component_[0-9a-f]{64}", txt))
    extra = [c for c in comps if c not in KNOWN]
    return extra[0] if extra else None

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "dry"
    tok = token()
    print("balances before: bob=%d fees=%d" % (balance(tok, "bob"), balance(tok, "fees")))

    dry = (mode != "go")
    print("=== instantiate (dry_run=%s) ===" % dry)
    r = submit(tok, INSTANTIATE, dry_run=dry)
    if "error" in r:
        print("INSTANTIATE ERROR:", json.dumps(r["error"])[:600]); return
    res = r["result"]
    if dry:
        print("required_fees:", res.get("required_fees"))
        print("would create:", new_component(json.dumps(res)))
        print("(dry run only — re-run with 'go' to submit for real)")
        return

    tx_id = tx_id_of(res)
    print("instantiate tx:", tx_id)
    fin, txt = wait_result(tok, tx_id)
    if fin is None:
        print("instantiate not finalized in time; raw submit:", json.dumps(res)[:400]); return
    if '"Reject"' in txt:
        print("INSTANTIATE REJECTED:", txt[:600]); return
    escrow = new_component(txt)
    print("ESCROW created on-chain:", escrow)
    if not escrow:
        print("no new component found:", txt[:500]); return

    RELEASE = f'''use {TPL} as Escrow;
fn main() {{
    let escrow = global!["escrow"];
    escrow.release(None);
}}
'''
    print("=== release ===")
    r = rpc("transactions.submit_manifest",
            {"manifest": RELEASE, "variables": {"escrow": escrow}, "max_fee": 50000, "dry_run": False}, tok)
    if "error" in r:
        print("RELEASE ERROR:", json.dumps(r["error"])[:600]); return
    rtx = tx_id_of(r["result"])
    print("release tx:", rtx)
    fin, txt = wait_result(tok, rtx)
    if fin is None:
        print("release not finalized in time"); return
    if '"Reject"' in txt:
        print("RELEASE REJECTED:", txt[:600]); return
    print("release accepted on-chain")
    time.sleep(3)
    print("balances after:  bob=%d fees=%d" % (balance(tok, "bob"), balance(tok, "fees")))
    print("expected delta:  bob +950, fees +50 (1000 funds, 5%% fee)")

main()
