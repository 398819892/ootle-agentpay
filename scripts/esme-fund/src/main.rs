// Build an UnsignedTransaction that claims from the Caravel esmeralda faucet,
// pays the fee from the claimed bucket, and creates/funds an account on chain.
// Prints the transaction as JSON (the `{"V1": {...}}` shape walletd's
// `transactions.submit` / `transactions.submit_dry_run` expect in its `transaction` field).
//
// WHY THIS EXISTS: the account to fund has 0 balance and is not yet on chain, so it
// cannot pay the transaction fee the normal way. The fee must come from the coins the
// faucet hands out in the same transaction. The walletd manifest DSL (submit_manifest)
// cannot express `PayFeeFromBucket`, so we build the raw UnsignedTransaction instead and
// submit it via `transactions.submit`.
//
// Instruction sequence (all in the fee-instruction list, mirroring the wallet SDK's merged
// fee intent with a revealed recipient — see docs/esmeralda.md):
//   claim(pubkey) → PutLastInstructionOutputOnWorkspace("claimed")
//   → TakeFromBucket("claimed", fee, "fee_bucket") → PayFeeFromBucket("fee_bucket")
//   → CreateAccount(owner_pk, bucket = "claimed")
// `PayFeeFromBucket` consumes its WHOLE bucket (any overpayment goes to the validators), so
// the fee is first split into its own small bucket and the remainder funds the new account.
// Paying the fee straight from "claimed" empties it and `CreateAccount` then fails with
// "unknown or out of scope bucket" (the previous revision of this file did exactly that).
//
// Args: <faucet_component> <owner_pubkey_hex> <network_byte> <max_epoch> [fee_microtari]
// Esmeralda: network_byte = 38; max_epoch = current_epoch + validity (e.g. +3); the dry run
// reports `required_fees` (~600 µT); default fee 20_000 µT leaves ample headroom.

use std::str::FromStr;

use tari_ootle_transaction::{args, Epoch, Transaction};
use tari_template_lib_types::crypto::RistrettoPublicKeyBytes;
use tari_template_lib_types::{Amount, ComponentAddress};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() != 5 && a.len() != 6 {
        eprintln!("usage: esme-fund <faucet_component> <owner_pubkey_hex> <network_byte> <max_epoch> [fee_microtari]");
        std::process::exit(2);
    }
    let faucet = ComponentAddress::from_str(&a[1]).expect("bad faucet component address");
    let owner_pk = RistrettoPublicKeyBytes::from_hex(&a[2]).expect("bad owner pubkey hex");
    let network: u8 = a[3].parse().expect("bad network byte");
    let max_epoch = Epoch(a[4].parse().expect("bad max_epoch"));
    let fee: u128 = a.get(5).map(|s| s.parse().expect("bad fee")).unwrap_or(20_000);

    let tx = Transaction::builder(network, max_epoch)
        .with_fee_instructions_builder(|b| {
            b.call_method(faucet, "claim", args![owner_pk])
                .put_last_instruction_output_on_workspace("claimed")
                .take_from_bucket("claimed", Amount::new(fee), "fee_bucket")
                .pay_fee_from_bucket("fee_bucket")
                .create_account_with_bucket(owner_pk, "claimed")
        })
        .build_unsigned();

    println!("{}", serde_json::to_string(&tx).expect("serialize unsigned tx"));
}
