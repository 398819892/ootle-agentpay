// Minimal JSON-RPC client for tari_ootle_walletd 0.47 with scoped permissions.
// Permission shapes verified against the local swarm walletd (see docs/wallet-integration.md):
//   "Admin" | {Transactions:"Read"|"Create"|"Update"|"Delete"} | {SigningRequests:"Create"} | {Substates:"Read"}
//   | {Accounts:["Read", <component_… | null>]} | {Transfer:["Create", ...]} ...
export class WalletdRpc {
  constructor(url, { token = null, permissions = ["Admin"], credentials = "None" } = {}) {
    this.url = url;
    this.token = token;
    this.permissions = permissions;
    this.credentials = credentials;
  }
  async call(method, params = {}) {
    const headers = { "Content-Type": "application/json" };
    if (this.token) headers.Authorization = "Bearer " + this.token;
    const r = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  }
  async connect() {
    if (this.token) return this;
    const r = await this.call("auth.request", {
      permissions: this.permissions,
      duration: 3600,
      credentials: this.credentials,
    });
    this.token = r.token;
    return this;
  }
}
