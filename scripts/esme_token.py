#!/usr/bin/env python3
import json, urllib.request
b = json.dumps({"jsonrpc":"2.0","id":1,"method":"auth.request",
                "params":{"permissions":["Admin"],"duration":None,"credentials":"None"}}).encode()
r = urllib.request.Request("http://127.0.0.1:5100/json_rpc", data=b, headers={"Content-Type":"application/json"})
print(json.loads(urllib.request.urlopen(r).read())["result"]["token"])
