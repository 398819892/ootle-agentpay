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
// Mirrors the wallet SDK "merged fee intent" pattern
// (tari_ootle_wallet_sdk .../apis/stealth_transfer/api.rs::generate_merged_transfer_transaction):
// claim -> put_last_instruction_output_on_workspace -> pay_fee_from_bucket -> create_account_with_bucket,
// all inside the fee-instruction builder so the revealed remainder funds the fee and the
// leftover lands in the newly created account.
//
// Args: <faucet_component> <owner_pubkey_hex> <network_byte> <max_epoch>
// Esmeralda: network_byte = 38; max_epoch = current_epoch + validity (e.g. +3).

use std::str::FromStr;

use tari_ootle_transaction::{args, Epoch, Transaction};
use tari_template_lib_types::crypto::RistrettoPublicKeyBytes;
use tari_template_lib_types::ComponentAddress;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() != 5 {
        eprintln!("usage: esme-fund <faucet_component> <owner_pubkey_hex> <network_byte> <max_epoch>");
        std::process::exit(2);
    }
    let faucet = ComponentAddress::from_str(&a[1]).expect("bad faucet component address");
    let owner_pk = RistrettoPublicKeyBytes::from_hex(&a[2]).expect("bad owner pubkey hex");
    let network: u8 = a[3].parse().expect("bad network byte");
    let max_epoch = Epoch(a[4].parse().expect("bad max_epoch"));

    let tx = Transaction::builder(network, max_epoch)
        .with_fee_instructions_builder(|b| {
            b.call_method(faucet, "claim", args![owner_pk])
                .put_last_instruction_output_on_workspace("claimed")
                .pay_fee_from_bucket("claimed")
                .create_account_with_bucket(owner_pk, "claimed")
        })
        .build_unsigned();

    println!("{}", serde_json::to_string(&tx).expect("serialize unsigned tx"));
}
