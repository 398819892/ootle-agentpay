# Deploying the AgentPay dashboard

A practical guide to putting the dashboard on the public internet, pointed at the **esmeralda**
testnet, **safely**. Read the security model first — it drives every other choice here.

---

## 1. Security model (read this)

The dashboard is a **hosted wallet**: the backend signs transactions through a Tari Ootle **wallet
daemon** (`walletd`) that **holds private keys**. That makes two things non-negotiable:

1. **The dashboard must require a login.** Anyone who can reach an un-authenticated instance can
   operate the wallet. Auth is enabled whenever `DASHBOARD_PASSWORD` is set, and it gates **every**
   `/api/*` route (unauthenticated requests get `401`). **Never deploy without it.**
2. **`walletd` must be private.** Its JSON-RPC port must bind to localhost / a private network and
   **never** be published to the internet. Only the dashboard backend — on the same host or a
   private network — should be able to reach it.
3. **The custody boundary is hardened, but this is a custodial service.** Every chain signature goes
   through one restricted, audited authorizer; high-risk actions (withdraw, revoke, whitelist edits,
   badge mint/revoke, freeze) require a **step-up confirmation independent of the login session**
   (`AGENTPAY_ADMIN_PASSWORD`); there is a global **kill switch (freeze)**, an append-only **audit
   log**, and fund-movement rate limits. Read **[`../docs/custody.md`](../docs/custody.md)** for the
   target architecture and what is still missing (separate signer, HSM/KMS, multisig) — this is
   **testnet hardening, not production-grade custody.**

### Topology

```
                         TLS (Let's Encrypt)
   Internet  ───────────────▶  Reverse proxy  ───────▶  Dashboard  ───localhost/private───▶  walletd
  (users)        :443          (Caddy/nginx)    :8787   (this app)        :5100 (NOT public)   (keys)
                                                                                                 │
                                                                                                 ▼
                                                                                    esmeralda validators
```

- Only the **reverse proxy** is exposed publicly (port 443).
- The **dashboard** listens on `127.0.0.1:8787` (or a private network), reached only via the proxy.
- **`walletd`** has **no public port at all**.

---

## 2. Configuration

All via environment variables.

| Variable | Required | Meaning |
|---|---|---|
| `DASHBOARD_PASSWORD` | **yes (prod)** | Password users type to sign in. Long & random. Enables auth. |
| `SESSION_SECRET` | **yes (prod)** | Signs session cookies. `openssl rand -hex 32`. Keep stable across restarts/replicas. |
| `AGENTPAY_ADMIN_PASSWORD` | recommended | Step-up secret for high-risk actions. Keep **different** from `DASHBOARD_PASSWORD`; falls back to it if unset. |
| `AGENTPAY_AUDIT_FILE` | recommended | Append-only audit log path (mount a volume; ship off-box in prod). Default `web/server/audit.log`. |
| `COOKIE_SECURE` | recommended | `true` behind HTTPS (forces the `Secure` cookie flag). Otherwise inferred from `X-Forwarded-Proto`. |
| `TRUSTED_PROXY` | **behind a proxy** | How to read the real client IP for the throttles. Default ignores `X-Forwarded-For` (uses the socket peer, so a forged XFF can't dodge the lockout). Set `true` (single hop) or a proxy IP list. See [`../docs/security.md`](../docs/security.md). |
| `ALLOWED_ORIGINS` | no | Extra browser-facing origins for the CSRF origin check (the request Host is always allowed). Only for split-origin proxy setups. |
| `AGENTPAY_WALLETD_URL` | yes | walletd JSON-RPC URL, e.g. `http://walletd:5100/json_rpc`. |
| `AGENTPAY_BUDGET_TEMPLATE` | yes | esmeralda AgentBudget template (below). |
| `AGENTPAY_OWNER_ACCOUNT` | yes | Funded owner account name (`dev` on esmeralda). |
| `AGENTPAY_STATE_FILE` | no | Path to the runtime state file (mount a volume for persistence). |
| `PORT` / `HOST` | no | Default `8787` / `0.0.0.0`. |
| `SESSION_TTL_HOURS` | no | Session lifetime (default 12). |
| `LOGIN_MAX_FAILS` / `LOGIN_LOCK_MINUTES` | no | Login throttle (default 8 fails → 10 min lock, per IP). |

### esmeralda testnet values

From [`../docs/esmeralda.md`](../docs/esmeralda.md):

```
AGENTPAY_WALLETD_URL=http://walletd:5100/json_rpc     # walletd runs privately; see §4
AGENTPAY_BUDGET_TEMPLATE=template_299d49bcace827cb86a8cdd9e6b1880783ae40a8a29ab28ba94b6b3ded6123a8
AGENTPAY_OWNER_ACCOUNT=dev
```

> **Local development is unchanged.** With `DASHBOARD_PASSWORD` **unset** the app runs in open dev
> mode against the local swarm (`http://127.0.0.1:12010/json_rpc`), exactly as before. Auth turns
> on only when you set the password — which you must for anything reachable off your machine.

---

## 3. Build the image

The dashboard is zero-dependency (no `npm install`, no bundler). Build from the **repo root** so
the pre-built `clients/ts/dist` is in the build context:

```bash
docker build -f web/Dockerfile -t agentpay-dashboard .
```

Prepare secrets:

```bash
cp web/.env.example web/.env
# edit web/.env:  DASHBOARD_PASSWORD, SESSION_SECRET (openssl rand -hex 32), WALLETD_KEYRING_PASSWORD
```

---

## 4. `walletd` — the honest part

`walletd` is **not** a normal container workload. It needs:

- the **`tari_ootle_walletd`** binary (esmeralda release — in this repo at
  [`../node-binaries/bins/tari_ootle_walletd`](../node-binaries/bins));
- an **esmeralda network config** — normally `~/.tari/ootle/esmeralda/config/config.toml`. On
  esmeralda you must set `indexer_trust = "trust"` under `[ootle_wallet_daemon]` (the public
  indexers can't serve the validator-set proof inside walletd's hard-coded 30 s timeout). This is a
  dev-only relaxation; transactions still execute on real esmeralda validators.
- a **persistent keyring**, unlocked with a passphrase (`TARI_WALLET_DAEMON_KEYRING_PASSPHRASE` /
  the daemon's keyring password) supplied via env — **never baked into the image or logged**;
- a **funded `dev` account** already on chain (see `docs/esmeralda.md`; the repo's `dev` account is
  `component_bfb548cf…`, funded).

**Two ways to run it, both keeping it private:**

### 4a. walletd as a compose sidecar

The provided [`docker-compose.yml`](docker-compose.yml) includes a `walletd` service **with no
published ports** — it is reachable only from the `dashboard` container over the private compose
network. Supply the binary and config via mounts:

```bash
mkdir -p web/walletd
cp node-binaries/bins/tari_ootle_walletd web/walletd/      # the esmeralda binary
# put your esmeralda config/keyring where the compose `walletd-data` volume expects it
```

> The exact `command:`/flags in `docker-compose.yml` are a **template** — confirm them against your
> binary (`tari_ootle_walletd --help`) and your config layout. The daemon must listen on
> `0.0.0.0:5100` *inside* the container (private network only), not be published to the host.

### 4b. walletd on the host (often simpler)

Run `walletd` directly on the host (e.g. under `systemd` or in WSL on a dev box), bound to
`127.0.0.1:5100`, and delete the `walletd` service from the compose file. Point the dashboard at it:

```yaml
    environment:
      AGENTPAY_WALLETD_URL: "http://host.docker.internal:5100/json_rpc"
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

Either way: **`walletd`'s port is bound to localhost / the private network and is never exposed to
the internet.**

---

## 5. Option A — single VPS with docker-compose + Caddy (recommended)

A small VPS (1 vCPU / 1–2 GB) is the simplest place to run **both** the dashboard and `walletd`
privately, with automatic HTTPS from [Caddy](https://caddyserver.com/).

1. **Provision** a VPS, point a DNS `A` record (e.g. `agentpay.example.com`) at it, install Docker +
   the compose plugin.
2. **Clone the repo**, set up `web/.env` and `walletd` as in §3–§4.
3. **Start the app** (dashboard on `127.0.0.1:8787`, walletd private):

   ```bash
   docker compose -f web/docker-compose.yml up -d
   ```
4. **Add Caddy for TLS.** Install Caddy on the host and use this `Caddyfile`:

   ```
   agentpay.example.com {
       encode gzip
       reverse_proxy 127.0.0.1:8787
   }
   ```

   Caddy obtains and renews a Let's Encrypt certificate automatically and sets `X-Forwarded-Proto:
   https`, so the dashboard issues `Secure` cookies. (nginx + certbot works equally well — just
   proxy `:443` → `127.0.0.1:8787` and forward `X-Forwarded-Proto`.)
5. **Verify** (see §7).

The dashboard container only binds `127.0.0.1:8787`, so even on the VPS it is not directly
reachable from the internet — only through Caddy on 443.

## 6. Option B — managed PaaS (Render / Railway) for the dashboard

Platforms like Render or Railway give you HTTPS and deploys for free, **but they can't easily run
`walletd`** (it needs the Tari binary, esmeralda config and a persistent keyring — not a standard
web runtime). So the realistic split is:

- **Dashboard** → PaaS web service, from `web/Dockerfile` (Render reads a Dockerfile directly;
  Railway via Nixpacks/Docker). Set the env vars from §2, including `COOKIE_SECURE=true`.
- **`walletd`** → a **separate private host** (a small VPS or your dev box) running walletd bound to
  localhost.

The hard requirement stands: **walletd must not be public**. Since the PaaS dashboard and the
walletd host are different machines, connect them over a **private channel** — a WireGuard tunnel or
an SSH tunnel between the dashboard host and the walletd host — and set
`AGENTPAY_WALLETD_URL` to the tunnel's private address. Do **not** expose walletd's `5100` on a
public IP "just to make it reach", even with the dashboard password in place: that port is the keys.

Render example (`render.yaml`-style):

```yaml
services:
  - type: web
    name: agentpay-dashboard
    runtime: docker
    dockerfilePath: web/Dockerfile
    dockerContext: .
    envVars:
      - key: DASHBOARD_PASSWORD        # set as a secret in the dashboard
        sync: false
      - key: SESSION_SECRET
        sync: false
      - key: COOKIE_SECURE
        value: "true"
      - key: AGENTPAY_WALLETD_URL      # the private tunnel address to your walletd host
        sync: false
      - key: AGENTPAY_BUDGET_TEMPLATE
        value: template_299d49bcace827cb86a8cdd9e6b1880783ae40a8a29ab28ba94b6b3ded6123a8
      - key: AGENTPAY_OWNER_ACCOUNT
        value: dev
```

If you can't run walletd privately-reachable from the PaaS, use **Option A** instead — one VPS
keeps everything on one private network and is less fiddly.

---

## 7. Verify the deployment

```bash
# Auth is on and you are not signed in:
curl -s https://agentpay.example.com/api/session        # {"authRequired":true,"authed":false}

# Protected routes are closed without a session:
curl -s -o /dev/null -w '%{http_code}\n' https://agentpay.example.com/api/state   # 401

# Sign in, keep the cookie, and a protected route opens:
curl -s -c cookies.txt -X POST https://agentpay.example.com/api/login \
  -H 'content-type: application/json' -d '{"password":"<your DASHBOARD_PASSWORD>"}'
curl -s -b cookies.txt -o /dev/null -w '%{http_code}\n' \
  -X POST https://agentpay.example.com/api/connect        # 200
```

Then open the site in a browser: you should see the login screen, and after signing in the
dashboard should connect to esmeralda and let you open a budget, pay, and see the validator's reject
reasons.

---

## 8. Security checklist

- [ ] `DASHBOARD_PASSWORD` is set (long, random) — the server logs `auth ON` on boot.
- [ ] `SESSION_SECRET` is set (stable) — `openssl rand -hex 32`, kept in secrets, never committed.
- [ ] `AGENTPAY_ADMIN_PASSWORD` is set and **different** from `DASHBOARD_PASSWORD` (the boot log notes
      it if unset) — high-risk actions log `step-up ON`.
- [ ] The audit log (`AGENTPAY_AUDIT_FILE`) is on a mounted volume and (prod) shipped off-box to an
      append-only sink; a dedicated owner/treasury account is used, not the wallet `default`.
- [ ] HTTPS everywhere; `COOKIE_SECURE=true` (or a proxy that sets `X-Forwarded-Proto: https`).
- [ ] Behind a proxy, `TRUSTED_PROXY` is set so the per-IP login/operation throttles see the real
      client IP (otherwise a forged `X-Forwarded-For` is ignored and everyone shares the proxy's IP).
      CSRF + security headers verified: `node web/server/security.test.js` (22 checks).
- [ ] `walletd`'s port (`5100`) is bound to localhost / a private network and has **no** public
      mapping (`docker compose ps` shows no host port for it; `ss -tlnp` on the host shows it on
      `127.0.0.1`/the private iface only).
- [ ] The walletd keyring passphrase comes from the environment; it is not in the image, the compose
      file, or any log. `web/.env` is git-ignored.
- [ ] On esmeralda, `indexer_trust = "trust"` is a deliberate, dev-only setting you accept.
- [ ] Only the funded `dev` account's keys are on the walletd host; it holds no more than the test
      funds you're willing to expose.
- [ ] Reverse proxy only forwards `:443` → the dashboard; nothing forwards to `walletd`.
- [ ] (Optional) rate-limit / basic-auth at the proxy too, and restrict by IP if the audience is known.

> **Scope reminder.** This is a testnet demo operating a hosted wallet. Keep only test funds on the
> walletd host, rotate `DASHBOARD_PASSWORD`/`SESSION_SECRET` if shared, and treat the walletd host as
> the sensitive component it is.
