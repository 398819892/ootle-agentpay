// Browser spike: both flows, no backend. See README.md.
import {
  TransactionBuilder,
  XTR_FAUCET_COMPONENT_ADDRESS,
  XTR_FAUCET_VAULT_ADDRESS,
  XTR_FAUCET_CLAIM_RESOURCE_ADDRESS,
  amountLiteral,
  toHexStr,
  fromHexStr,
} from "@tari-project/ootle";
import { generateOotleSecretKey, ootlePublicKeyFromSecretKey } from "@tari-project/ootle-wasm";
import { SecretKeyWallet } from "@tari-project/ootle-secret-key-wallet";
import { openBudgetTx, payTx, findNewComponent, templateEvents, parseBudgetSubstate } from "./agentpay-tx.js";
import { connectIndexer, accountVaults, maxEpoch, dryRun, signSealSubmit, LOCALNET } from "./chain.js";
import { WalletdRpc } from "./walletd-rpc.js";
import { WalletdSigningRequestSigner } from "./walletd-signer.js";

const $ = (id) => document.getElementById(id);
const cfg = () => ({ indexer: $("cfg-indexer").value.trim(), template: $("cfg-template").value.trim(), merchant: $("cfg-merchant").value.trim() });
$("indexer-url").textContent = cfg().indexer;
$("template-short").textContent = cfg().template.slice(0, 18) + "…";

function logger(id) {
  const el = $(id);
  return (msg, cls = "") => {
    const line = document.createElement("div");
    if (cls) line.className = cls;
    line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  };
}
const enable = (ids, on = true) => ids.forEach((i) => ($(i).disabled = !on));
const short = (s) => (s ? s.slice(0, 14) + "…" + s.slice(-6) : "");
const provider = async () => connectIndexer(cfg().indexer, LOCALNET.network);
const reason = (res) => JSON.stringify(res?.Reject ?? res?.AcceptFeeRejectRest?.[1] ?? res);

// Shared "open then pay" driver: `signer` is any ootle.ts Signer, `account` the signer's account.
async function openBudget(log, signer, account) {
  const p = await provider();
  const c = cfg();
  const tx = openBudgetTx({
    network: LOCALNET.network, maxEpoch: await maxEpoch(p), template: c.template, owner: account,
    ownerVaults: await accountVaults(p, account), fund: 50_000, perTxCap: 1_000, dailyCap: 1_500, epochsPerWindow: 10,
    whitelist: [c.merchant], maxFee: 200_000,
  });
  log(`open: ${tx.instructions.length} instructions, ${tx.inputs.length} inputs → sign…`);
  const { txId, receipt } = await signSealSubmit(p, [signer], tx);
  const budget = findNewComponent(receipt, [account, c.merchant]);
  const state = parseBudgetSubstate(await p.getSubstate(budget));
  log(`open COMMITTED tx ${short(txId)} → budget ${budget}`, "ok");
  log(`  ownerBadge ${short(state.ownerBadge)}  agentBadge ${short(state.agentBadge)}  caps ${state.perTxCap}/${state.dailyCap}`);
  p.stopWatcher?.();
  return { budget, state };
}
async function pay(log, signer, account, budget, state, amount, realSubmit = true) {
  const p = await provider();
  const c = cfg();
  const tx = payTx({
    network: LOCALNET.network, maxEpoch: await maxEpoch(p), agent: account, agentVaults: await accountVaults(p, account),
    budget, budgetVault: state.vault, agentBadge: state.agentBadge, session: "default", merchant: c.merchant,
    merchantVaults: await accountVaults(p, c.merchant), amount, memo: `browser spike pay ${amount}`, maxFee: 200_000,
  });
  log(`pay ${amount}: proof by non-fungible id "default" → sign…`);
  if (!realSubmit) {
    const dr = await dryRun(p, [signer], tx, c.indexer);
    const res = dr.result?.finalize?.result;
    log(`dry-run → ${res?.Accept ? "ACCEPT" : "REJECT " + reason(res)}`, res?.Accept ? "ok" : "bad");
    return;
  }
  try {
    const { txId, receipt } = await signSealSubmit(p, [signer], tx);
    const evs = templateEvents(receipt, c.template).filter((e) => e.topic.startsWith("AgentBudget."));
    log(`pay COMMITTED tx ${short(txId)}`, "ok");
    for (const e of evs) log(`  event ${e.topic} ${JSON.stringify(e.payload)}`);
    const after = parseBudgetSubstate(await p.getSubstate(budget));
    log(`  spent_in_window ${state.spentInWindow} → ${after.spentInWindow}`);
    state.spentInWindow = after.spentInWindow;
  } catch (e) {
    log(`pay ${e.outcome ?? "failed"}: ${e.reason ?? e.message}`, "bad");
  } finally {
    p.stopWatcher?.();
  }
}

// ---------------- A: key in the browser ------------------------------------------------------------
const alog = logger("a-log");
const A = { key: null, wallet: null, budget: null, state: null };
const KEY = "agentpay-spike-key";
function loadKey() {
  try { A.key = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { A.key = null; }
  if (!A.key) return;
  A.wallet = SecretKeyWallet.fromSecretKey(fromHexStr(A.key.owner), LOCALNET.network, fromHexStr(A.key.view));
  $("a-key").textContent = `pk ${A.key.ownerPublic}${A.key.account ? `\naccount ${A.key.account}` : " (not funded yet)"}`;
  enable(["a-fund"], !A.key.account);
  enable(["a-open"], !!A.key.account);
}
$("a-gen").onclick = () => {
  const sk = generateOotleSecretKey();
  const pk = ootlePublicKeyFromSecretKey(sk.owner_key, sk.view_key);
  A.key = { owner: toHexStr(sk.owner_key), view: toHexStr(sk.view_key), ownerPublic: toHexStr(pk.owner_key), account: null };
  try { localStorage.setItem(KEY, JSON.stringify(A.key)); } catch {}
  loadKey();
  alog("generated a fresh sr25519 key; the secret never leaves this browser");
};
$("a-fund").onclick = async () => {
  enable(["a-fund"], false);
  try {
    const p = await provider();
    const tx = new TransactionBuilder(LOCALNET.network, await maxEpoch(p))
      .withFeeInstructionsBuilder((b) => b
        .createAccount(A.key.ownerPublic).saveVar("account")
        .callMethod({ componentAddress: XTR_FAUCET_COMPONENT_ADDRESS, methodName: "take" }, [{ Workspace: "account" }])
        .callMethod({ fromWorkspace: "account", methodName: "pay_fee" }, [amountLiteral(20_000n)]))
      .withInputs([
        { substate_id: XTR_FAUCET_COMPONENT_ADDRESS, version: null },
        { substate_id: XTR_FAUCET_VAULT_ADDRESS, version: null },
        { substate_id: XTR_FAUCET_CLAIM_RESOURCE_ADDRESS, version: null },
      ]).buildUnsignedTransaction();
    const { txId, receipt } = await signSealSubmit(p, [A.wallet], tx);
    A.key.account = findNewComponent(receipt);
    try { localStorage.setItem(KEY, JSON.stringify(A.key)); } catch {}
    alog(`faucet COMMITTED tx ${short(txId)} → account ${A.key.account}`, "ok");
    p.stopWatcher?.();
    loadKey();
  } catch (e) { alog(`faucet failed: ${e.message}`, "bad"); enable(["a-fund"]); }
};
$("a-open").onclick = async () => {
  enable(["a-open"], false);
  try { Object.assign(A, await openBudget(alog, A.wallet, A.key.account)); enable(["a-pay", "a-over"]); }
  catch (e) { alog(`open failed: ${e.reason ?? e.message}`, "bad"); enable(["a-open"]); }
};
$("a-pay").onclick = () => pay(alog, A.wallet, A.key.account, A.budget, A.state, 700);
$("a-over").onclick = () => pay(alog, A.wallet, A.key.account, A.budget, A.state, 5_000, false);
loadKey();

// ---------------- B: key stays in the user's walletd -------------------------------------------------
const blog = logger("b-log");
const B = { dapp: null, acct: null, signer: null, budget: null, state: null };
$("b-connect").onclick = async () => {
  try {
    const url = $("b-url").value.trim();
    // The dApp's token: queue + read signing requests, read the account list. Nothing else.
    B.dapp = await new WalletdRpc(url, { permissions: [{ SigningRequests: "Create" }, { SigningRequests: "Read" }, { Accounts: ["Read", null] }] }).connect();
    const r = await B.dapp.call("accounts.get_default", {});
    B.acct = r.account;
    $("b-acct").textContent = `${B.acct.name}  ${B.acct.component_address}\nkey ${JSON.stringify(B.acct.owner_key_id)}  pk ${B.acct.owner_public_key}`;
    B.signer = new WalletdSigningRequestSigner(B.dapp, {
      keyId: B.acct.owner_key_id,
      publicKey: B.acct.owner_public_key,
      onRequest: (id) => {
        $("b-pending").innerHTML = `⏳ signing request <b>#${id}</b> is waiting for the wallet owner. Approve it in the wallet UI, or `;
        const btn = document.createElement("button");
        btn.textContent = `simulate the wallet's Approve click (#${id})`;
        btn.onclick = async () => {
          // This stands in for the wallet's own UI: an OWNER session (Admin) approves. The dApp token above cannot.
          const ownerSession = await new WalletdRpc(url, { permissions: ["Admin"] }).connect();
          const res = await ownerSession.call("signing_requests.approve", { request_id: id });
          blog(`[wallet] request #${id} → ${res.status}`);
          $("b-pending").textContent = "";
        };
        $("b-pending").appendChild(btn);
        blog(`signing request #${id} queued on walletd (status Pending)`);
      },
    });
    blog(`connected; dApp token scope = SigningRequests:Create/Read + Accounts:Read`, "ok");
    enable(["b-open"]);
  } catch (e) { blog(`connect failed: ${e.message}`, "bad"); }
};
$("b-open").onclick = async () => {
  enable(["b-open"], false);
  try { Object.assign(B, await openBudget(blog, B.signer, B.acct.component_address)); enable(["b-pay", "b-over"]); }
  catch (e) { blog(`open failed: ${e.reason ?? e.message}`, "bad"); enable(["b-open"]); }
};
$("b-pay").onclick = () => pay(blog, B.signer, B.acct.component_address, B.budget, B.state, 700);
$("b-over").onclick = () => pay(blog, B.signer, B.acct.component_address, B.budget, B.state, 5_000, true); // walletd never co-signs dry runs
