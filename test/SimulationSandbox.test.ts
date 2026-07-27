import { describe, it, expect } from "vitest";
import {
  Keypair,
  StrKey,
  SorobanDataBuilder,
  nativeToScVal,
  rpc as SorobanRpc,
} from "@stellar/stellar-sdk";
import { StellarSplitClient } from "../src/client.js";
import { MockRpcClient } from "../src/testing/mockRpcClient.js";
import { SimulationSandbox } from "../src/sandbox/SimulationSandbox.js";

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

function testClient(rpcClient: MockRpcClient): StellarSplitClient {
  return new StellarSplitClient({
    rpcUrl: "http://localhost:8000",
    networkPassphrase: NETWORK_PASSPHRASE,
    contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    rpcClient,
  });
}

/** Build a SimulateTransactionSuccessResponse-shaped mock response that returns `retval`. */
function simSuccess(
  retval: ReturnType<typeof nativeToScVal>,
  resources: { cpuInsns: number; readBytes: number; writeBytes: number } = {
    cpuInsns: 5_000_000,
    readBytes: 1024,
    writeBytes: 2048,
  },
) {
  const transactionData = new SorobanDataBuilder().setResources(
    resources.cpuInsns,
    resources.readBytes,
    resources.writeBytes,
  );
  return {
    id: "mock",
    latestLedger: 100,
    events: [],
    transactionData,
    minResourceFee: "100",
    result: { auth: [], retval },
  } as unknown as SorobanRpc.Api.SimulateTransactionSuccessResponse;
}

describe("SimulationSandbox", () => {
  it("createInvoice -> pay does not call sendTransaction and accumulates state", async () => {
    const rpcClient = new MockRpcClient();
    rpcClient.setDefaultSimulateResponse(simSuccess(nativeToScVal(1, { type: "u64" })));
    const client = testClient(rpcClient);
    const sandbox = SimulationSandbox.fork(client);

    const creator = Keypair.random().publicKey();
    const payer = Keypair.random().publicKey();
    const token = Keypair.random().publicKey();

    const createResult = await sandbox.createInvoice({
      creator,
      recipients: [{ address: Keypair.random().publicKey(), amount: 10_000_000n }],
      token,
      deadline: Math.floor(Date.now() / 1000) + 86_400,
    });

    expect(createResult.success).toBe(true);
    expect(createResult.value?.invoiceId).toBe("1");
    expect(createResult.cost.cpuInsns).toBe(5_000_000);
    expect(createResult.cost.memBytes).toBe(1024 + 2048);

    const payResult = await sandbox.pay({
      payer,
      invoiceId: "1",
      amount: 5_000_000n,
    });

    expect(payResult.success).toBe(true);
    expect(rpcClient.calls.send).toHaveLength(0);
  });

  it("never invokes the real sendTransaction RPC method", async () => {
    const rpcClient = new MockRpcClient();
    rpcClient.setDefaultSimulateResponse(simSuccess(nativeToScVal(2, { type: "u64" })));
    const client = testClient(rpcClient);
    const sandbox = SimulationSandbox.fork(client);

    await sandbox.createInvoice({
      creator: Keypair.random().publicKey(),
      recipients: [{ address: Keypair.random().publicKey(), amount: 1_000_000n }],
      token: Keypair.random().publicKey(),
      deadline: Math.floor(Date.now() / 1000) + 86_400,
    });

    expect(rpcClient.calls.send).toHaveLength(0);
    expect(rpcClient.calls.getTransaction).toHaveLength(0);
    expect(rpcClient.calls.simulate.length).toBeGreaterThan(0);
  });

  it("the real (non-sandboxed) client is unaffected after a sandboxed call", async () => {
    const rpcClient = new MockRpcClient();
    rpcClient.setDefaultSimulateResponse(simSuccess(nativeToScVal(3, { type: "u64" })));
    const client = testClient(rpcClient);
    const sandbox = SimulationSandbox.fork(client);

    await sandbox.createInvoice({
      creator: Keypair.random().publicKey(),
      recipients: [{ address: Keypair.random().publicKey(), amount: 1_000_000n }],
      token: Keypair.random().publicKey(),
      deadline: Math.floor(Date.now() / 1000) + 86_400,
    });

    // The instance-level shadow of `_submitTx` must be removed once the
    // sandboxed call completes, restoring normal (network-bound) behavior.
    expect(
      Object.prototype.hasOwnProperty.call(client, "_submitTx"),
    ).toBe(false);
  });

  it("a payment simulated after createInvoice sees the invoice from the earlier step", async () => {
    const rpcClient = new MockRpcClient();
    rpcClient.setDefaultSimulateResponse(simSuccess(nativeToScVal(7, { type: "u64" })));
    const client = testClient(rpcClient);
    const sandbox = new SimulationSandbox();
    const sandboxed = sandbox.attach(client);

    const created = await sandboxed.createInvoice({
      creator: Keypair.random().publicKey(),
      recipients: [{ address: Keypair.random().publicKey(), amount: 1_000_000n }],
      token: Keypair.random().publicKey(),
      deadline: Math.floor(Date.now() / 1000) + 86_400,
    });
    const invoiceId = created.value!.invoiceId;

    await sandboxed.pay({
      payer: Keypair.random().publicKey(),
      invoiceId,
      amount: 500_000n,
    });

    const state = sandbox.getInvoiceState(invoiceId);
    expect(state).toBeDefined();
    expect(state?.payments).toHaveLength(1);
  });

  it("reports success: false and does not throw when simulation fails", async () => {
    const rpcClient = new MockRpcClient();
    rpcClient.setDefaultSimulateResponse({
      id: "mock",
      latestLedger: 100,
      events: [],
      error: "HostError: contract call failed",
    } as unknown as SorobanRpc.Api.SimulateTransactionErrorResponse);
    const client = testClient(rpcClient);
    const sandbox = SimulationSandbox.fork(client);

    const result = await sandbox.createInvoice({
      creator: Keypair.random().publicKey(),
      recipients: [{ address: Keypair.random().publicKey(), amount: 1_000_000n }],
      token: Keypair.random().publicKey(),
      deadline: Math.floor(Date.now() / 1000) + 86_400,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  describe("reset / snapshot / restore", () => {
    it("reset() clears accumulated local state", async () => {
      const rpcClient = new MockRpcClient();
      rpcClient.setDefaultSimulateResponse(simSuccess(nativeToScVal(9, { type: "u64" })));
      const client = testClient(rpcClient);
      const sandbox = new SimulationSandbox();
      const sandboxed = sandbox.attach(client);

      await sandboxed.createInvoice({
        creator: Keypair.random().publicKey(),
        recipients: [{ address: Keypair.random().publicKey(), amount: 1_000_000n }],
        token: Keypair.random().publicKey(),
        deadline: Math.floor(Date.now() / 1000) + 86_400,
      });

      expect(sandbox.snapshot().callLog).toHaveLength(1);
      sandbox.reset();
      expect(sandbox.snapshot().callLog).toHaveLength(0);
      expect(sandbox.snapshot().invoices).toEqual({});
    });

    it("restore() reproduces the exact ledger diff from a snapshot", async () => {
      const rpcClient = new MockRpcClient();
      rpcClient.setDefaultSimulateResponse(simSuccess(nativeToScVal(11, { type: "u64" })));
      const client = testClient(rpcClient);
      const sandbox = new SimulationSandbox();
      const sandboxed = sandbox.attach(client);

      const created = await sandboxed.createInvoice({
        creator: Keypair.random().publicKey(),
        recipients: [{ address: Keypair.random().publicKey(), amount: 1_000_000n }],
        token: Keypair.random().publicKey(),
        deadline: Math.floor(Date.now() / 1000) + 86_400,
      });
      await sandboxed.pay({
        payer: Keypair.random().publicKey(),
        invoiceId: created.value!.invoiceId,
        amount: 250_000n,
      });

      const originalSnapshot = sandbox.snapshot();
      const restored = SimulationSandbox.restore(originalSnapshot);

      expect(restored.snapshot()).toEqual(originalSnapshot);
      expect(restored.getInvoiceState(created.value!.invoiceId)?.payments).toHaveLength(1);
    });

    it("an empty sandbox snapshot round-trips through restore()", () => {
      const sandbox = new SimulationSandbox();
      const snapshot = sandbox.snapshot();
      const restored = SimulationSandbox.restore(snapshot);
      expect(restored.snapshot()).toEqual({ invoices: {}, callLog: [] });
    });
  });
});
