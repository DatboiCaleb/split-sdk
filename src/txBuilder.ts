import {
  Contract,
  rpc as SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  xdr,
  Account,
  Transaction,
  Asset,
  Operation,
} from "@stellar/stellar-sdk";
import type { StellarSplitClientConfig } from "./client.js";
import { signTransaction } from "./wallet.js";
import { SimulationFailedError, TransactionFailedError, TransactionNotConfirmedError } from "./errors.js";

/** Builder for composing multi-operation StellarSplit transactions. */
export class StellarSplitTxBuilder {
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly config: StellarSplitClientConfig;
  private readonly sourceAddress: string;
  private readonly operations: xdr.Operation[] = [];

  constructor(config: StellarSplitClientConfig, sourceAddress: string) {
    this.config = config;
    this.sourceAddress = sourceAddress;
    const rpcUrl = Array.isArray(config.rpcUrl) ? config.rpcUrl[0]! : config.rpcUrl;
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
    this.contract = new Contract(config.contractId);
  }

  addPay(invoiceId: string, amount: bigint | number | string): this {
    const op = this.contract.call(
      "pay",
      nativeToScVal(this.sourceAddress, { type: "address" }),
      nativeToScVal(BigInt(invoiceId), { type: "u64" }),
      nativeToScVal(BigInt(amount), { type: "i128" })
    );
    this.operations.push(op);
    return this;
  }

  addRolloverInvoice(
    invoiceId: string,
    newDeadline: number,
    caller: string
  ): this {
    const op = this.contract.call(
      "rollover_invoice",
      nativeToScVal(BigInt(invoiceId), { type: "u64" }),
      nativeToScVal(BigInt(newDeadline), { type: "u64" }),
      nativeToScVal(caller, { type: "address" })
    );
    this.operations.push(op);
    return this;
  }

  addRelease(invoiceId: string): this {
    const op = this.contract.call(
      "release_invoice",
      nativeToScVal(BigInt(invoiceId), { type: "u64" })
    );
    this.operations.push(op);
    return this;
  }

  addRefund(invoiceId: string): this {
    const op = this.contract.call(
      "refund_invoice",
      nativeToScVal(BigInt(invoiceId), { type: "u64" })
    );
    this.operations.push(op);
    return this;
  }

  /**
   * Add a PathPaymentStrictSend operation for cross-asset DEX-routed payments.
   */
  addPathPaymentStrictSend(
    sendAsset: Asset,
    sendAmount: string,
    destination: string,
    destAsset: Asset,
    destMin: string,
    path: Asset[],
  ): this {
    const op = Operation.pathPaymentStrictSend({
      sendAsset,
      sendAmount,
      destination,
      destAsset,
      destMin,
      path,
    });
    this.operations.push(op);
    return this;
  }

  /**
   * Add a PathPaymentStrictReceive operation for cross-asset DEX-routed payments.
   */
  addPathPaymentStrictReceive(
    sendAsset: Asset,
    sendMax: string,
    destination: string,
    destAsset: Asset,
    destAmount: string,
    path: Asset[],
  ): this {
    const op = Operation.pathPaymentStrictReceive({
      sendAsset,
      sendMax,
      destination,
      destAsset,
      destAmount,
      path,
    });
    this.operations.push(op);
    return this;
  }

  /**
   * Build an unsigned Transaction using a fallback source account (sequence 0).
   * Use {@link buildWithSequence} when a {@link SequenceCache} is available to
   * avoid extra Horizon round-trips.
   */
  build(): Transaction {
    return this.buildWithSequence("0");
  }

  /**
   * Build an unsigned Transaction using the provided sequence number string.
   * Integrates with {@link SequenceCache} — callers should pass the value
   * returned by `SequenceCache.getSequence()` converted to a string.
   */
  buildWithSequence(sequence: string): Transaction {
    const sourceAccount = ({
      accountId: () => this.sourceAddress,
      sequenceNumber: () => sequence,
      incrementSequenceNumber: () => {},
    } as unknown) as Account;

    const tb = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    });

    for (const op of this.operations) {
      tb.addOperation(op);
    }

    tb.setTimeout(30);
    return tb.build();
  }

  /**
   * Sign and submit the composed transaction. Returns transaction hash when confirmed.
   * Always fetches the current account sequence from the RPC.
   */
  async submit(): Promise<{ txHash: string }> {
    return this._submitInternal();
  }

  /**
   * Sign and submit using a pre-fetched sequence number (from {@link SequenceCache}).
   * When `sequence` is provided as a bigint, the Horizon `loadAccount` call is skipped,
   * saving a round-trip. The sequence number is converted to a string for the
   * TransactionBuilder.
   *
   * @param sequence - Optional pre-fetched sequence number as a bigint. When omitted,
   *                   falls back to `server.getAccount()`.
   */
  async submitWithSequence(sequence?: bigint): Promise<{ txHash: string }> {
    return this._submitInternal(sequence);
  }

  /**
   * Internal submission shared by {@link submit} and {@link submitWithSequence}.
   */
  private async _submitInternal(sequence?: bigint): Promise<{ txHash: string }> {
    let account: Account;

    if (sequence !== undefined) {
      // Build account object from cached sequence, skipping the RPC call
      account = ({
        accountId: () => this.sourceAddress,
        sequenceNumber: () => sequence.toString(),
        incrementSequenceNumber: () => {},
      } as unknown) as Account;
    } else {
      // Fallback: fetch from RPC
      const fetched = await this.server.getAccount(this.sourceAddress);
      account = new Account(fetched.accountId(), fetched.sequenceNumber());
    }

    const tb = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    });

    for (const op of this.operations) tb.addOperation(op);
    tb.setTimeout(30);
    const tx = tb.build();

    const simResult = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new SimulationFailedError(`Simulation failed: ${simResult.error}`, "submit", simResult.error);
    }

    const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();

    const signedXdr = await (this.config.adapter
      ? this.config.adapter.signTransaction(preparedTx.toXDR(), this.config.networkPassphrase)
      : signTransaction(preparedTx.toXDR(), this.config.networkPassphrase));

    const sendResult = await this.server.sendTransaction(
      TransactionBuilder.fromXDR(signedXdr, this.config.networkPassphrase)
    );

    if (sendResult.status === "ERROR") {
      throw new TransactionFailedError(
        `Transaction failed: ${JSON.stringify(sendResult.errorResult)}`
      );
    }

    const txHash = sendResult.hash;
    let getResult = await this.server.getTransaction(txHash);
    let attempts = 0;
    while (
      getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND &&
      attempts < 20
    ) {
      await new Promise((r) => setTimeout(r, 1500));
      getResult = await this.server.getTransaction(txHash);
      attempts++;
    }

    if (getResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      throw new TransactionNotConfirmedError(String(getResult.status));
    }

    return { txHash };
  }
}
