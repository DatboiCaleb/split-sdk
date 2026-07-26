import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockRpcClient } from "../src/testing/mockRpcClient.js";
import {
  SubscriptionManager,
  getSubscriptionManager,
  _resetSubscriptionManagerSingletonForTesting,
} from "../src/streaming/SubscriptionManager.js";
import { MemoryStorageAdapter } from "../src/storage/storageAdapter.js";
import type { InvoiceEvent } from "../src/types.js";

function server(opts: { events: unknown[]; latestLedger?: number; sequence?: number }) {
  return new MockRpcClient({
    defaultGetEventsResponse: { events: opts.events as never, latestLedger: opts.latestLedger ?? 105 },
    defaultGetLatestLedgerResponse: {
      id: "mock",
      sequence: opts.sequence ?? 100,
      protocolVersion: 21,
    } as never,
  }) as unknown as ConstructorParameters<typeof SubscriptionManager>[0];
}

const paymentEvent = {
  topic: ["payment", "inv-1"],
  value: { payer: "GABC", amount: "1000" },
  ledger: 100,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("SubscriptionManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetSubscriptionManagerSingletonForTesting();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("connects and delivers typed InvoiceEvent objects to the registered handler", async () => {
    const mockServer = server({ events: [paymentEvent] });
    const storage = new MemoryStorageAdapter();
    const manager = new SubscriptionManager(mockServer, "contract-1", { pollIntervalMs: 100, storage });

    const received: InvoiceEvent[] = [];
    manager.subscribe("inv-1", (event) => received.push(event));

    await vi.advanceTimersByTimeAsync(0);

    expect(received.length).toBe(1);
    expect(received[0].type).toBe("payment");
    expect(manager.activeSubscriptionCount).toBe(1);
  });

  it("reconnects with exponential backoff after a simulated disconnect and replays missed events via the stored cursor", async () => {
    const failingServer = new MockRpcClient({
      defaultGetLatestLedgerResponse: { id: "mock", sequence: 100, protocolVersion: 21 } as never,
    }) as unknown as ConstructorParameters<typeof SubscriptionManager>[0];
    // Force getEvents to fail on the first call.
    let callCount = 0;
    (failingServer as unknown as { getEvents: () => Promise<unknown> }).getEvents = () => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error("network down"));
      return Promise.resolve({ events: [paymentEvent], latestLedger: 105 });
    };

    const storage = new MemoryStorageAdapter();
    const lifecycleEvents: string[] = [];
    const manager = new SubscriptionManager(failingServer, "contract-1", {
      pollIntervalMs: 100,
      initialBackoffMs: 500,
      storage,
      onLifecycleEvent: (e) => lifecycleEvents.push(e.type),
    });

    const received: InvoiceEvent[] = [];
    manager.subscribe("inv-1", (event) => received.push(event));

    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycleEvents).toContain("reconnecting");
    expect(received.length).toBe(0);

    await vi.advanceTimersByTimeAsync(500);
    expect(received.length).toBe(1);

    // Cursor should now be persisted for this invoice.
    const cursorRaw = storage.getItem(`stellar_split:cursor:contract-1:inv-1`);
    expect(cursorRaw).toBeTruthy();
  });

  it("unsubscribe() stops the handler from receiving further events and releases the poll timer", async () => {
    const mockServer = server({ events: [] });
    const storage = new MemoryStorageAdapter();
    const manager = new SubscriptionManager(mockServer, "contract-1", { pollIntervalMs: 100, storage });

    const received: InvoiceEvent[] = [];
    manager.subscribe("inv-1", (event) => received.push(event));
    await vi.advanceTimersByTimeAsync(0);

    manager.unsubscribe("inv-1");
    expect(manager.activeSubscriptionCount).toBe(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(received.length).toBe(0);
  });

  it("persists the cursor to the configured storage backend after each event batch and restores it on re-instantiation", async () => {
    const storage = new MemoryStorageAdapter();
    const first = new SubscriptionManager(server({ events: [paymentEvent] }), "contract-1", {
      pollIntervalMs: 100,
      storage,
    });
    first.subscribe("inv-1", () => {});
    await vi.advanceTimersByTimeAsync(0);
    first.destroy();

    const cursorRaw = storage.getItem("stellar_split:cursor:contract-1:inv-1");
    expect(cursorRaw).toBeTruthy();
    const cursor = JSON.parse(cursorRaw!);
    expect(cursor.lastLedger).toBeGreaterThan(100);

    // A fresh manager instance restores the cursor and starts polling from there.
    const secondServer = server({ events: [] });
    const second = new SubscriptionManager(secondServer, "contract-1", { pollIntervalMs: 100, storage });
    second.subscribe("inv-1", () => {});
    await vi.advanceTimersByTimeAsync(0);

    const getEventsCalls = (secondServer as unknown as { calls: { getEvents: Array<{ startLedger: number }> } }).calls
      .getEvents;
    expect(getEventsCalls[0]?.startLedger).toBe(cursor.lastLedger);
  });

  it("supports concurrent subscriptions to different invoice IDs independently", async () => {
    const mockServer = server({
      events: [paymentEvent, { ...paymentEvent, topic: ["payment", "inv-2"], ledger: 101 }],
    });
    const manager = new SubscriptionManager(mockServer, "contract-1", {
      pollIntervalMs: 100,
      storage: new MemoryStorageAdapter(),
    });

    const inv1Events: InvoiceEvent[] = [];
    const inv2Events: InvoiceEvent[] = [];
    manager.subscribe("inv-1", (e) => inv1Events.push(e));
    manager.subscribe("inv-2", (e) => inv2Events.push(e));

    await vi.advanceTimersByTimeAsync(0);

    expect(inv1Events.length).toBe(1);
    expect(inv2Events.length).toBe(1);
    expect(manager.activeSubscriptionCount).toBe(2);
  });

  it("cleans up all subscriptions and timers on destroy()", async () => {
    const mockServer = server({ events: [] });
    const manager = new SubscriptionManager(mockServer, "contract-1", {
      pollIntervalMs: 100,
      storage: new MemoryStorageAdapter(),
    });

    manager.subscribe("inv-1", () => {});
    manager.subscribe("inv-2", () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.activeSubscriptionCount).toBe(2);

    manager.destroy();
    expect(manager.activeSubscriptionCount).toBe(0);
  });

  it("getSubscriptionManager returns the same singleton for a given contract ID", () => {
    const mockServer = server({ events: [] });
    const a = getSubscriptionManager(mockServer, "contract-1");
    const b = getSubscriptionManager(mockServer, "contract-1");
    expect(a).toBe(b);

    const c = getSubscriptionManager(mockServer, "contract-2");
    expect(c).not.toBe(a);
  });
});
