// A stand-in for the headless minotari_console_wallet gRPC server — enough to drive the gateway's
// one-sided Transfer offline, with NO real wallet, NO funds, NO chain. It records every Transfer it
// receives so a test can assert that over-quota payments NEVER reached the wallet. Swap this for a real
// `minotari_console_wallet --non-interactive --grpc-address <addr>` to go on-chain (see README).
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROTO = join(HERE, "..", "wallet.proto");

/** Start the mock Wallet gRPC server. Resolves to { port, transfers, stop() }. */
export function startMockWallet({ address = "127.0.0.1:0", balance = 1_000_000_000n, failAddresses = [] } = {}) {
  const def = protoLoader.loadSync(PROTO, { keepCase: true, longs: String, enums: String, defaults: true });
  const pkg = grpc.loadPackageDefinition(def).tari.rpc;
  const server = new grpc.Server();

  const transfers = [];   // every PaymentRecipient the wallet was actually asked to send
  const fail = new Set(failAddresses);
  let nextTxId = 1000n;

  server.addService(pkg.Wallet.service, {
    GetCompleteAddress: (_c, cb) =>
      cb(null, { interactive_address: "mock_interactive", one_sided_address: "mock_one_sided" }),
    GetBalance: (_c, cb) =>
      cb(null, { available_balance: balance.toString(), pending_incoming_balance: "0", pending_outgoing_balance: "0", timelocked_balance: "0" }),
    Transfer: (c, cb) => {
      const r = c.request.recipients?.[0];
      transfers.push(r);
      if (!r || fail.has(r.address)) {
        cb(null, { results: [{ address: r?.address ?? "", transaction_id: "0", is_success: false, failure_message: "mock: send failed" }] });
        return;
      }
      const txId = (nextTxId++).toString();
      cb(null, { results: [{ address: r.address, transaction_id: txId, is_success: true, failure_message: "" }] });
    },
    GetTransactionInfo: (c, cb) => {
      const ids = c.request.transaction_ids ?? [];
      cb(null, { transactions: ids.map((id) => ({ tx_id: String(id), dest_address: "", status: "TRANSACTION_STATUS_MINED_CONFIRMED", amount: "0", fee: "0" })) });
    },
  });

  return new Promise((res, rej) => {
    server.bindAsync(address, grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) return rej(err);
      // (grpc-js >=1.10 starts on bindAsync; server.start() is a deprecated no-op)
      res({ port, transfers, stop: () => new Promise((r) => server.tryShutdown(() => r())) });
    });
  });
}
