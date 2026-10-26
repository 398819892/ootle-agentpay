#!/usr/bin/env python3
"""Fund the esmeralda `dev` account on chain.

Pipeline:
  1. auth to walletd (:5100, auth=none -> Admin token)
  2. settings.get -> current_epoch
  3. run the `esme-fund` Rust helper to build the UnsignedTransaction JSON
     (claim from faucet -> pay fee from claimed bucket -> create/fund account)
  4. transactions.submit_dry_run  (default)  or  transactions.submit  (--submit)

Run inside WSL Ubuntu with the walletd running. See scripts/esme-fund/ for the helper.
"""
import json, subprocess, sys, urllib.request, time

URL = "http://127.0.0.1:5100/json_rpc"
FAUCET = "component_568f84a0cc7ccfe49116ee86d072f02b99e246a4750e680a8cbfcd2b7862f37b"
PUBKEY = "2c049e88b8271733616f429dc51cfc34cc53c04cd6c300fbfb7a8f154f2df06f"
NETWORK = 38  # esmeralda
ESME_FUND = "/root/esme-fund/target/debug/esme-fund"
SEAL_SIGNER = {"Derived": {"index": 0, "key_branch": "account"}}  # dev account owner key

def call(method, params, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(URL, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())

def auth():
    return call("auth.request", {"permissions": ["Admin"], "duration": None, "credentials": "None"})["result"]["token"]

def main():
    submit = "--submit" in sys.argv
    tok = auth()
    cur = None
    for _ in range(10):
        cur = call("settings.get", {}, tok).get("result", {}).get("current_epoch")
        if cur is not None:
            break
        time.sleep(1)
    if cur is None:
        print("could not read current_epoch"); sys.exit(1)
    max_epoch = cur + 3
    print(f"current_epoch={cur} max_epoch={max_epoch}")
    out = subprocess.run([ESME_FUND, FAUCET, PUBKEY, str(NETWORK), str(max_epoch)],
                         capture_output=True, text=True)
    if out.returncode != 0:
        print("esme-fund failed:", out.stderr); sys.exit(1)
    txn = json.loads(out.stdout.strip())

    req = {"transaction": txn, "seal_signer": SEAL_SIGNER, "other_signers": [],
           "signatures": [], "detect_inputs": True, "lock_ids": []}
    method = "transactions.submit" if submit else "transactions.submit_dry_run"
    print(f"=== {method} ===")
    print(json.dumps(call(method, req, tok), indent=2, default=str)[:4000])

if __name__ == "__main__":
    main()
