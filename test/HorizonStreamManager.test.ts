import { describe, it, expect, vi, afterEach } from "vitest";
import {
  HorizonStreamManager,
  InMemoryCursorStore,
  createLocalStorageCursorStore,
  type HorizonCallBuilderLike,
  type HorizonStreamRecord,
  type HorizonStreamSource,
} from "../src/horizon/HorizonStreamManager.js";

afterEach(() => {
  vi.useRealTimers();
});

interface FakeRecord extends HorizonStreamRecord {
  id: string;
}

/**
 * A scriptable stand-in for a Horizon `CallBuilder`. Each call to the
 * `source` factory returns a fresh builder (mirroring real `Server.payments()`
 * usage); `.cursor(token)` records what cursor a (re)connect requested and
 * filters the fixture list to records after that cursor.
 */
class FakeCallBuilder implements HorizonCallBuilderLike<FakeRecord> {
  public requestedCursor: string | null = null;
  private _onmessage: ((value: FakeRecord) => void) | null = null;
  private _onerror: ((event: unknown) => void) | null = null;
  public closed = false;

  constructor(
    private readonly _records: FakeRecord[],
    private readonly _onSubscribed: (builder: FakeCallBuilder) => void,
  ) {}

  cursor(token: string): HorizonCallBuilderLike<FakeRecord> {
    this.requestedCursor = token;
    return this;
  }

  stream(options: {
    onmessage?: (value: FakeRecord) => void;
    onerror?: (event: unknown) => void;
  }): () => void {
    this._onmessage = options.onmessage ?? null;
    this._onerror = options.onerror ?? null;
    this._onSubscribed(this);

    const startIndex = this.requestedCursor
      ? this._records.findIndex((r) => r.paging_token === this.requestedCursor) + 1
      : 0;
    for (const record of this._records.slice(startIndex)) {
      this._onmessage?.(record);
    }

    return () => {
      this.closed = true;
    };
  }

  emit(record: FakeRecord): void {
    this._onmessage?.(record);
  }

  fail(event: unknown = new Error("stream error")): void {
    this._onerror?.(event);
  }
}

function makeRecord(paging_token: string, createdAtMs: number): FakeRecord {
  return { id: paging_token, paging_token, created_at: new Date(createdAtMs).toISOString() };
}

describe("HorizonStreamManager", () => {
  it("delivers events from a fresh (cursor-less) initial connect", () => {
    const builders: FakeCallBuilder[] = [];
    const source: HorizonStreamSource<FakeRecord> = () =>
      new FakeCallBuilder([makeRecord("1", 1_000), makeRecord("2", 2_000)], (b) =>
        builders.push(b),
      );

    const manager = new HorizonStreamManager<FakeRecord>({ source, now: () => 3_000 });
    const received: FakeRecord[] = [];
    manager.start("GACCOUNT", (r) => received.push(r));

    expect(received.map((r) => r.paging_token)).toEqual(["1", "2"]);
    expect(builders[0]!.requestedCursor).toBeNull();
    expect(manager.getCursor()).toBe("2");
  });

  it("reconnects and requests the stream from the last confirmed cursor", () => {
    vi.useFakeTimers();
    const builders: FakeCallBuilder[] = [];
    const allRecords = [makeRecord("1", 1_000), makeRecord("2", 2_000), makeRecord("3", 3_000)];
    const source: HorizonStreamSource<FakeRecord> = () =>
      new FakeCallBuilder(allRecords, (b) => builders.push(b));

    const manager = new HorizonStreamManager<FakeRecord>({
      source,
      now: () => 3_000,
      reconnectDelayMs: 500,
    });
    const received: FakeRecord[] = [];
    const reconnected = vi.fn();
    manager.on("stream:reconnected", reconnected);
    manager.start("GACCOUNT", (r) => received.push(r));

    // Simulate the first record having already arrived, then a disconnect.
    expect(manager.getCursor()).toBe("3"); // fixture delivers all 3 records immediately above
    builders[0]!.fail();

    vi.advanceTimersByTime(500);

    expect(builders).toHaveLength(2);
    expect(builders[1]!.requestedCursor).toBe("3");
    expect(reconnected).toHaveBeenCalledWith({ accountId: "GACCOUNT", cursor: "3" });
  });

  it("does not reconnect-emit on the very first (non-reconnect) connect", () => {
    const source: HorizonStreamSource<FakeRecord> = () => new FakeCallBuilder([], () => {});
    const manager = new HorizonStreamManager<FakeRecord>({ source });
    const reconnected = vi.fn();
    manager.on("stream:reconnected", reconnected);
    manager.start("GACCOUNT", () => {});
    expect(reconnected).not.toHaveBeenCalled();
  });

  it("deduplicates events re-delivered after a reconnect", () => {
    vi.useFakeTimers();
    const builders: FakeCallBuilder[] = [];
    const source: HorizonStreamSource<FakeRecord> = () =>
      new FakeCallBuilder([], (b) => builders.push(b));

    const manager = new HorizonStreamManager<FakeRecord>({ source, now: () => 10_000 });
    const received: FakeRecord[] = [];
    manager.start("GACCOUNT", (r) => received.push(r));

    builders[0]!.emit(makeRecord("1", 9_000));
    expect(received).toHaveLength(1);

    builders[0]!.fail();
    vi.advanceTimersByTime(1_000);

    // Overlapping redelivery of "1" plus a genuinely new "2".
    builders[1]!.emit(makeRecord("1", 9_000));
    builders[1]!.emit(makeRecord("2", 9_500));

    expect(received.map((r) => r.paging_token)).toEqual(["1", "2"]);
  });

  it("discards replayed events older than replayCutoffMs", () => {
    vi.useFakeTimers();
    const builders: FakeCallBuilder[] = [];
    const source: HorizonStreamSource<FakeRecord> = () =>
      new FakeCallBuilder([], (b) => builders.push(b));

    const NOW = 1_000_000;
    const manager = new HorizonStreamManager<FakeRecord>({
      source,
      now: () => NOW,
      replayCutoffMs: 300_000,
    });
    const received: FakeRecord[] = [];
    manager.start("GACCOUNT", (r) => received.push(r));

    builders[0]!.fail();
    vi.advanceTimersByTime(1_000);

    // 10 minutes stale — beyond the 5-minute cutoff.
    builders[1]!.emit(makeRecord("stale", NOW - 600_000));
    // 1 minute stale — within the cutoff.
    builders[1]!.emit(makeRecord("fresh", NOW - 60_000));

    expect(received.map((r) => r.paging_token)).toEqual(["fresh"]);
  });

  it("persists the cursor after every received event and survives a fresh manager instance (page reload)", () => {
    const cursorStore = createLocalStorageCursorStore();
    const source: HorizonStreamSource<FakeRecord> = () =>
      new FakeCallBuilder([makeRecord("1", 1_000), makeRecord("2", 2_000)], () => {});

    const manager = new HorizonStreamManager<FakeRecord>({
      source,
      cursorStore,
      storageNamespace: "test-ns",
      now: () => 3_000,
    });
    manager.start("GACCOUNT", () => {});
    expect(manager.getCursor()).toBe("2");

    // A "page reload": brand new manager instance, same persistent store.
    const reloaded = new HorizonStreamManager<FakeRecord>({
      source: () => new FakeCallBuilder([], () => {}),
      cursorStore,
      storageNamespace: "test-ns",
    });
    reloaded.start("GACCOUNT", () => {});
    expect(reloaded.getCursor()).toBe("2");
  });

  it("getCursor/setCursor allow manual cursor management", () => {
    const source: HorizonStreamSource<FakeRecord> = () => new FakeCallBuilder([], () => {});
    const manager = new HorizonStreamManager<FakeRecord>({ source });
    expect(manager.getCursor()).toBeNull();
    manager.start("GACCOUNT", () => {});
    manager.setCursor("42");
    expect(manager.getCursor()).toBe("42");
  });

  it("stop() closes the underlying stream and cancels pending reconnects", () => {
    vi.useFakeTimers();
    const builders: FakeCallBuilder[] = [];
    const source: HorizonStreamSource<FakeRecord> = () =>
      new FakeCallBuilder([], (b) => builders.push(b));
    const manager = new HorizonStreamManager<FakeRecord>({ source, reconnectDelayMs: 500 });
    manager.start("GACCOUNT", () => {});

    builders[0]!.fail();
    manager.stop();
    expect(builders[0]!.closed).toBe(true);

    vi.advanceTimersByTime(1_000);
    // No second builder should have been created — reconnect was cancelled.
    expect(builders).toHaveLength(1);
  });

  it("InMemoryCursorStore round-trips values", () => {
    const store = new InMemoryCursorStore();
    expect(store.get("k")).toBeNull();
    store.set("k", "v");
    expect(store.get("k")).toBe("v");
  });
});
