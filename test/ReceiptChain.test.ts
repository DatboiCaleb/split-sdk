import { describe, it, expect } from "vitest";
import {
  ReceiptChain,
  GENESIS_PREV_HASH,
  InMemoryReceiptChainStorage,
  createLocalStorageReceiptChainStorage,
  receiptChainStorageKey,
  type ReceiptChainStorage,
} from "../src/receipts/ReceiptChain.js";
import type { PaymentReceipt, ReceiptChainEntry } from "../src/types/receipts.js";

function makeReceipt(overrides: Partial<PaymentReceipt> = {}): PaymentReceipt {
  return {
    invoiceId: "inv-1",
    paymentId: "pay-1",
    amount: "10000000",
    recipientId: "GRECIPIENT",
    txHash: "deadbeef",
    ledger: 100,
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

describe("ReceiptChain", () => {
  it("append() uses '0'.repeat(64) as the genesis entry's prevHash", async () => {
    const chain = new ReceiptChain("inv-1");
    const entry = await chain.append(makeReceipt());
    expect(entry.prevHash).toBe(GENESIS_PREV_HASH);
    expect(entry.prevHash).toHaveLength(64);
  });

  it("append() links each new entry to the previous entry's hash", async () => {
    const chain = new ReceiptChain("inv-1");
    const first = await chain.append(makeReceipt({ paymentId: "pay-1" }));
    const second = await chain.append(makeReceipt({ paymentId: "pay-2" }));
    expect(second.prevHash).toBe(first.hash);
  });

  it("append() produces a hash that changes deterministically when any field changes", async () => {
    const chainA = new ReceiptChain("inv-1");
    const entryA = await chainA.append(makeReceipt({ amount: "1000000" }));

    const chainB = new ReceiptChain("inv-2");
    const entryB = await chainB.append(makeReceipt({ amount: "2000000" }));

    expect(entryA.hash).not.toBe(entryB.hash);

    // Same input twice (fresh chains, same genesis prevHash) -> same hash.
    const chainC = new ReceiptChain("inv-3");
    const entryC = await chainC.append(makeReceipt({ amount: "1000000" }));
    expect(entryC.hash).toBe(entryA.hash);
  });

  it("verify() returns { valid: true, length } for an unmodified chain", async () => {
    const chain = new ReceiptChain("inv-1");
    await chain.append(makeReceipt({ paymentId: "pay-1" }));
    await chain.append(makeReceipt({ paymentId: "pay-2" }));
    await chain.append(makeReceipt({ paymentId: "pay-3" }));

    await expect(chain.verify()).resolves.toEqual({ valid: true, length: 3 });
  });

  it("verify() returns { valid: true, length: 0 } for an empty chain", async () => {
    const chain = new ReceiptChain("inv-empty");
    await expect(chain.verify()).resolves.toEqual({ valid: true, length: 0 });
  });

  it("verify() returns valid: false with brokenAt/reason when an entry's receipt is tampered", async () => {
    const storage = new InMemoryReceiptChainStorage();
    const chain = new ReceiptChain("inv-1", storage);
    await chain.append(makeReceipt({ paymentId: "pay-1" }));
    await chain.append(makeReceipt({ paymentId: "pay-2" }));

    const entries = JSON.parse(
      storage.get(receiptChainStorageKey("inv-1"))!,
    ) as ReceiptChainEntry[];
    entries[1]!.receipt.amount = "999999999";
    storage.set(receiptChainStorageKey("inv-1"), JSON.stringify(entries));

    const tamperedChain = new ReceiptChain("inv-1", storage);
    const result = await tamperedChain.verify();

    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
    expect(result.reason).toBeDefined();
  });

  it("verify() detects a tampered prevHash link even if the receipt itself is untouched", async () => {
    const storage = new InMemoryReceiptChainStorage();
    const chain = new ReceiptChain("inv-1", storage);
    await chain.append(makeReceipt({ paymentId: "pay-1" }));
    await chain.append(makeReceipt({ paymentId: "pay-2" }));

    const entries = JSON.parse(
      storage.get(receiptChainStorageKey("inv-1"))!,
    ) as ReceiptChainEntry[];
    entries[1]!.prevHash = "f".repeat(64);
    storage.set(receiptChainStorageKey("inv-1"), JSON.stringify(entries));

    const tamperedChain = new ReceiptChain("inv-1", storage);
    const result = await tamperedChain.verify();

    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
  });

  it("chain entries survive round-trip serialization without hash drift", async () => {
    const storage = new InMemoryReceiptChainStorage();
    const chain = new ReceiptChain("inv-1", storage);
    const original = await chain.append(makeReceipt());

    const reloaded = new ReceiptChain("inv-1", storage);
    const entries = reloaded.getEntries();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(original);
    await expect(reloaded.verify()).resolves.toEqual({ valid: true, length: 1 });
  });

  it("persists to the storage backend under receipt_chain:{invoiceId}", async () => {
    const storage = new InMemoryReceiptChainStorage();
    const chain = new ReceiptChain("inv-42", storage);
    await chain.append(makeReceipt({ invoiceId: "inv-42" }));

    expect(storage.get("receipt_chain:inv-42")).not.toBeNull();
    expect(receiptChainStorageKey("inv-42")).toBe("receipt_chain:inv-42");
  });

  it("createLocalStorageReceiptChainStorage persists across a fresh ReceiptChain instance (page reload)", async () => {
    const storage: ReceiptChainStorage = createLocalStorageReceiptChainStorage();
    const chain = new ReceiptChain("inv-reload", storage);
    await chain.append(makeReceipt({ invoiceId: "inv-reload" }));

    const reloaded = new ReceiptChain("inv-reload", createLocalStorageReceiptChainStorage());
    expect(reloaded.length).toBe(1);
    await expect(reloaded.verify()).resolves.toMatchObject({ valid: true });
  });

  it("getEntries() returns a defensive copy", async () => {
    const chain = new ReceiptChain("inv-1");
    await chain.append(makeReceipt());
    const entries = chain.getEntries();
    entries.pop();
    expect(chain.length).toBe(1);
  });
});
