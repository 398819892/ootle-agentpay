// sc-chain.mjs — the self-custody wallet's on-chain layer, run IN THE BROWSER.
//
// A fresh browser key has no on-chain account until it is funded (the account is created in the funding
// tx). On localnet the built-in faucet does both in one transaction, signed here by the user's own key
// and submitted straight to the indexer (CORS-open) — no backend custody. Balance is read the same way
// the backend does (sum the account's XTR vaults), but from the browser.
//
// Reuses the proven engine: chain.js (connect / maxEpoch / signSealSubmit) and the Flow-A faucet recipe
// from src/main.js. Signing still needs a live indexer (resolveTransaction stamps the signer + input
// versions) — the known L2 gate, satisfied by the running localnet.
import {
  TransactionBuilder, Network, amountLiteral, toHexStr,
  XTR_FAUCET_COMPONENT_ADDRESS, XTR_FAUCET_VAULT_ADDRESS, XTR_FAUCET_CLAIM_RESOURCE_ADDRESS,
} from "@tari-project/ootle";
import { publicKeyFromSecretKey } from "@tari-project/ootle-wasm";
import { decodeSubstateValue } from "@tari-project/ootle-wasm-bor";
import { findNewComponent, transferTx, XTR } from "./agentpay-tx.js";
import { connectIndexer, accountVaults, maxEpoch, signSealSubmit } from "./chain.js";

const XTR_HEX = XTR.replace(/^resource_/, "");

/** Owner public key (hex) for createAccount, derived from the owner secret bytes. */
export function ownerPublicHex(ownerSecretBytes) {
  return toHexStr(publicKeyFromSecretKey(ownerSecretBytes));
}

export function connect(indexerUrl) {
  return connectIndexer(indexerUrl, Network.LocalNet);
}

/**
 * Create + fund the account via the localnet faucet in one browser-signed tx (Flow A's recipe).
 * Returns { txId, account } where account is the new component address.
 */
export async function fundViaFaucet(provider, wallet, ownerPubHex) {
  const unsigned = new TransactionBuilder(Network.LocalNet, await maxEpoch(provider))
    .withFeeInstructionsBuilder((b) =>
      b
        .createAccount(ownerPubHex)
        .saveVar("account")
        .callMethod({ componentAddress: XTR_FAUCET_COMPONENT_ADDRESS, methodName: "take" }, [{ Workspace: "account" }])
        .callMethod({ fromWorkspace: "account", methodName: "pay_fee" }, [amountLiteral(20_000n)]),
    )
    .withInputs([
      { substate_id: XTR_FAUCET_COMPONENT_ADDRESS, version: null },
      { substate_id: XTR_FAUCET_VAULT_ADDRESS, version: null },
      { substate_id: XTR_FAUCET_CLAIM_RESOURCE_ADDRESS, version: null },
    ])
    .buildUnsignedTransaction();
  const { txId, receipt } = await signSealSubmit(provider, [wallet], unsigned);
  return { txId, account: findNewComponent(receipt) };
}

/**
 * Send `amount` (XTR base units) from `fromAccount` to `toAccount`, signed in the browser by the
 * user's own key — the owner spending their real balance (transferTx's owner→recipient recipe, NOT
 * the AgentBudget). Both accounts' current vaults are declared as inputs (the bare indexer can't
 * auto-detect them); a brand-new recipient may have no vault yet, so a lookup failure there is fine —
 * the deposit creates the vault. Returns { txId }.
 */
export async function sendXtr(provider, wallet, fromAccount, toAccount, amount) {
  const ownerVaults = await accountVaults(provider, fromAccount);
  let recipientVaults = [];
  try { recipientVaults = await accountVaults(provider, toAccount); } catch { /* fresh recipient: no vault yet */ }
  const unsigned = transferTx({
    network: Network.LocalNet,
    maxEpoch: await maxEpoch(provider),
    owner: fromAccount,
    ownerVaults,
    recipient: toAccount,
    recipientVaults,
    amount: BigInt(amount),
    maxFee: 200_000,
  });
  const { txId } = await signSealSubmit(provider, [wallet], unsigned);
  return { txId };
}

// --- balance: sum the account's XTR-bearing vaults (same logic as the backend's ownerBalance) --------
async function vaultXtr(provider, vaultId) {
  let c = (await provider.getSubstate(vaultId))?.state?.up?.substate;
  if (typeof c === "string") c = JSON.parse(decodeSubstateValue(c));
  const s = JSON.stringify(c);
  if (!s.includes(XTR_HEX)) return null; // a badge/NFT vault, or another resource
  const m = s.match(/"revealed_amount":"?(\d+)"?/) || s.match(/"amount":"?(\d+)"?/);
  return m ? BigInt(m[1]) : null;
}

/** Total XTR balance (as a BigInt) held by `account`, read from the indexer. */
export async function balanceOf(provider, account) {
  const ids = await accountVaults(provider, account);
  let total = 0n;
  for (const v of ids) {
    const a = await vaultXtr(provider, v);
    if (a != null) total += a;
  }
  return total;
}
