# AgentPay dashboard (`web/`)

A polished, hosted web console for **AgentPay** — the on-chain, validator-enforced spending
budget for AI agents on **Tari Ootle**. An owner opens a budget, funds it, sets the rules
(per-transaction cap, rolling daily cap, merchant whitelist, kill switch), and watches an agent
spend **only within those rules** — because the rules live in the budget's on-chain component and
are enforced by the validators, not by this app.

## Architecture (security first)

```
 browser (SPA)  ──HTTP/JSON──▶  this backend (Node)  ──JSON-RPC──▶  walletd  ──▶  Tari Ootle
   public/*                      server/server.js                   (holds keys, signs & pays fee)
```

- **The browser never talks to `walletd`.** It only calls this backend's small JSON API. walletd
  holds the keys; the backend drives the chain through the committed
  [`clients/ts`](../clients/ts) client (its compiled `dist/`), which submits **transaction
  manifests** — there is no client-side signing anywhere.
- The caps, whitelist and kill switch are **enforced on chain**. The dashboard's "Check on chain"
  button runs a validator **dry-run** and shows the chain's *own* reject reason, so you can see the
  limits are real, not UI theater.
- **Zero runtime dependencies, no build step.** The backend uses only Node's built-in `http`/`fs`,
  and the frontend is hand-authored HTML/CSS/JS. `node server/server.js` just runs — there is no
  `npm install` for this app. (It depends only on the already-built `clients/ts/dist`.)

## Requirements

- **Node 18+** (for the global `fetch` the TS client uses).
- A reachable Tari Ootle **wallet daemon**. Defaults target the **local swarm**
  (`http://127.0.0.1:12010/json_rpc`, auth = none) and the localnet AgentBudget template.
- The committed `clients/ts/dist` (already built in the repo). If it's missing, build it once:
  `(cd clients/ts && npm install && npm run build)`.

## Run (one command)

```bash
./run.sh
```

Then open **http://localhost:8787**.

> **Windows + WSL:** on this machine the Tari swarm and Node live in WSL, so run it from WSL:
>
> ```bash
> wsl bash /mnt/f/oolte/web/run.sh
> ```
>
> The server binds `0.0.0.0`, so the Windows browser reaches it at `http://localhost:8787` via
> WSL2's localhost forwarding. (Unlike `clients/ts`, this app installs nothing, so the known
> "`npm install` corrupts `node_modules` over `/mnt`" problem never arises here.)

You can also run the server module directly: `node server/server.js`.

## Configuration

All optional; defaults target the local swarm.

| Env var | Meaning | Default |
|---|---|---|
| `PORT` | HTTP port for the dashboard | `8787` |
| `HOST` | bind address | `0.0.0.0` |
| `AGENTPAY_WALLETD_URL` | wallet daemon JSON-RPC URL | `http://127.0.0.1:12010/json_rpc` |
| `AGENTPAY_BUDGET_TEMPLATE` | AgentBudget template address | localnet `template_758d0c58…` |
| `AGENTPAY_OWNER_ACCOUNT` | funded owner account name | `default` |
| `DASHBOARD_PASSWORD` | sign-in password — **setting it enables auth** | *(unset → open dev mode)* |
| `SESSION_SECRET` | signs session cookies (`openssl rand -hex 32`) | *(ephemeral per process)* |
| `COOKIE_SECURE` | force the `Secure` cookie flag behind HTTPS | *(inferred from `X-Forwarded-Proto`)* |

Point it at **esmeralda** by setting `AGENTPAY_WALLETD_URL=http://127.0.0.1:5100/json_rpc`,
`AGENTPAY_BUDGET_TEMPLATE=template_299d49bc…` and `AGENTPAY_OWNER_ACCOUNT=dev` (see
[`../docs/esmeralda.md`](../docs/esmeralda.md)).

## Authentication

The backend is a **hosted wallet** (it signs through walletd), so a public instance must be behind
a login:

- Auth is **enabled whenever `DASHBOARD_PASSWORD` is set**, and it gates **every** `/api/*` route —
  unauthenticated requests get `401` and the SPA shows a sign-in screen.
- Sessions are a signed, `HttpOnly` cookie (`Secure` behind HTTPS), with a per-IP login throttle
  (8 failures → 10-minute lock) and a **Sign out** control.
- With `DASHBOARD_PASSWORD` **unset**, the app runs in **open local-dev mode** against the swarm —
  the original local experience, unchanged. **Never expose an instance without the password.**

Local quick check:

```bash
DASHBOARD_PASSWORD=secret SESSION_SECRET=$(openssl rand -hex 32) node server/server.js
# /api/state without a session → 401; sign in at http://localhost:8787 to use it
```

## Deploying

To put this on the internet (HTTPS, pointed at esmeralda, with walletd kept private), see
**[DEPLOYMENT.md](DEPLOYMENT.md)**. In short: build the image from the repo root
(`docker build -f web/Dockerfile -t agentpay-dashboard .`), run it behind a TLS reverse proxy
(Caddy/nginx) with `DASHBOARD_PASSWORD` + `SESSION_SECRET` set, and run `walletd` **privately**
(localhost / a private network — never a public port). A [`docker-compose.yml`](docker-compose.yml)
and [`.env.example`](.env.example) are included; esmeralda env values are in the deploy guide.

## What you can do

- **Overview** — budget status (Active / Revoked), the on-chain component address (truncated +
  copy), this-window-spend and treasury meters, per-tx / daily caps, whitelist chips, recent
  activity. The daily cap is shown **in human terms**: how much is left in the current spending
  window and roughly how long until it resets (see below).
- **Create budget** — fund the vault and set per-tx cap, daily cap, daily window and whitelist,
  with inline validation. Named merchants are created on the local devnet on first use.
- **Payments** — the agent pays a merchant; the ledger is rebuilt from the chain's `pay` events.
  **Check on chain** dry-runs the payment and surfaces the validator's real reject reason
  (e.g. *"Amount exceeds the per-transaction cap"*, *"Merchant is not whitelisted"*,
  *"Amount exceeds the daily cap"*, *"Agent has been revoked"*).
- **Governance** — add a merchant to the on-chain whitelist, withdraw from the treasury
  (confirm dialog), and the **kill switch** to revoke the agent (double-confirm: an explicit
  acknowledgement is required before the button enables).

### The "daily cap" is a rolling epoch window (shown honestly)

The on-chain daily cap is **not** a calendar day. The `AgentBudget` template enforces it over a
**rolling window of `epochsPerWindow` chain epochs** (an Ootle epoch is **≈30 min**), and the
window resets **lazily** — the spent counter is only zeroed on the next payment after the window
has elapsed. Ootle has no wall-clock, so this is unavoidable at the chain layer; the dashboard
translates it for the user instead of hiding it:

- The overview meter reads **"This window's spend — X / cap"** and a line underneath shows
  **"X left this window · resets ≈Y (N epochs)"**. Once the window has elapsed it reads
  *"Window elapsed — the next payment starts a fresh ≈N-epoch window."*
- An explainer under the caps (and a tooltip on the Daily-cap badge) spells out that *"Daily" is a
  rolling window of N chain epochs (~30 min each), not a calendar day, reset lazily on the next
  payment*. All wall-clock figures use **≈** because epoch length is approximate.

These numbers are read **live from chain** (the budget component substate + the current epoch) via
the `clients/ts` helper `OnChainBudget.readWindow()` / `windowStatus()` — no chain logic is added.
If the chain read ever fails, the card falls back to the stored figures and still renders.

### Scope note

The three governance actions above are exactly what the current on-chain `AgentBudget` template
and the `clients/ts` client expose (`add_merchant`, `withdraw`, `revoke`). Removing a merchant and
editing the caps after creation aren't in the template yet, so this dashboard deliberately does
**not** fake them — it only drives operations the chain actually supports. (The source in
`templates/`, `sdk/` and `clients/ts/` is left untouched; this app only imports the TS client.)

## UX

Light / dark / system themes (persisted), full loading / empty / error states, toasts, pending
feedback on every on-chain action (they take a moment to finalize), truncated addresses with
copy buttons, confirm dialogs for destructive actions, keyboard-navigable modals, and a
responsive layout that collapses to a top bar on phones.

## Project layout

```
web/
├─ server/server.js     # zero-dep Node backend: auth + static files + /api, drives the chain via clients/ts/dist
├─ server/state.json    # runtime state (git-ignored): the open budget + known merchants
├─ public/
│  ├─ index.html
│  ├─ styles.css        # the design system (tokens, light/dark, components, login)
│  ├─ app.js            # the SPA (auth/login, state, views, API client, toasts, modals)
│  └─ favicon.svg
├─ run.sh               # one-command launcher (local dev)
├─ Dockerfile           # production image (build from the repo root)
├─ docker-compose.yml   # dashboard + private walletd topology
├─ .env.example         # secrets template (copy to web/.env)
├─ DEPLOYMENT.md        # deploy guide: auth, HTTPS, esmeralda, walletd, security checklist
└─ README.md
```

The backend keeps the open budget in `server/state.json` so a browser reload (or a server
restart) keeps the same budget. **Reset demo** detaches the dashboard from the current budget so
you can open a fresh one; the on-chain component itself is not deleted.
