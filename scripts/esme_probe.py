#!/usr/bin/env python3
import json, urllib.request
URL="http://127.0.0.1:5100/json_rpc"
FAUCET="component_568f84a0cc7ccfe49116ee86d072f02b99e246a4750e680a8cbfcd2b7862f37b"
def rpc(m,p,t=None):
    b=json.dumps({"jsonrpc":"2.0","id":1,"method":m,"params":p}).encode()
    r=urllib.request.Request(URL,data=b,headers={"Content-Type":"application/json"})
    if t: r.add_header("Authorization","Bearer "+t)
    try: return json.loads(urllib.request.urlopen(r,timeout=60).read())
    except Exception as e: return {"transport_error":str(e)}

a=rpc("auth.request",{"permissions":["Admin"],"duration":None,"credentials":"None"})
print("auth.request:", json.dumps(a)[:220])
tok=a.get("result",{}).get("token")
if not tok:
    print("NO TOKEN -> esmeralda walletd (auth none) does not accept credentials None")
else:
    accts=rpc("accounts.list",{"offset":0,"limit":10},tok)
    dev=accts["result"]["accounts"][0]["account"]
    pk=dev["owner_public_key"]; comp=dev["component_address"]
    print("dev pubkey:", pk, " balance-account:", comp[:24])
    man='fn main() { let f=var!["f"]; let b=f.claim(public_key!("'+pk+'")); let mut a=var!["a"]; a.deposit(b); }'
    r=rpc("transactions.submit_manifest",{"manifest":man,"variables":{"f":FAUCET,"a":comp},"max_fee":100000,"dry_run":True},tok)
    print("claim dry_run:", json.dumps(r.get("error") or r.get("result"))[:600])
