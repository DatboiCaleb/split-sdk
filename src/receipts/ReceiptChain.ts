/**
 * ReceiptChain — a SHA-256-linked chain of {@link PaymentReceipt} records for
 * a single invoice, giving tamper-evident proof of the full payment history
 * (each receipt hashes in the previous entry's hash, so altering any past
 * receipt breaks every hash after it). Hashing uses the Web Crypto API
 * (`crypto.subtle.digest`) exclusively — no Node `crypto` module — so this
 * runs unmodified in browsers and browser workers.
 */

import type { ChainVerificationResult, PaymentReceipt, ReceiptChainEntry } from "../types/receipts.js";

/** `prevHash` of the first entry in any chain. */
export const GENESIS_PREV_HASH = "0".repeat(64);

/** Storage abstraction the chain is persisted through — mirrors the SDK's cache-store pattern. */
export interface ReceiptChainStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** In-memory storage — the default, and the fallback outside browser environments. */
export class InMemoryReceiptChainStorage implements ReceiptChainStorage {
  private readonly _map = new Map<string, string>();

  get(key: string): string | null {
    return this._map.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this._map.set(key, value);
  }
}

class WebStorageReceiptChainStorage implements ReceiptChainStorage {
  constructor(private readonly _storage: Storage) {}

  get(key: string): string | null {
    return this._storage.getItem(key);
  }

  set(key: string, value: string): void {
    this._storage.setItem(key, value);
  }
}

/** Storage backed by `window.localStorage`; falls back to in-memory outside browsers. */
export function createLocalStorageReceiptChainStorage(): ReceiptChainStorage {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return new InMemoryReceiptChainStorage();
  }
  return new WebStorageReceiptChainStorage(window.localStorage);
}

/** Storage backed by `window.sessionStorage`; falls back to in-memory outside browsers. */
export function createSessionStorageReceiptChainStorage(): ReceiptChainStorage {
  if (typeof window === "undefined" || typeof window.sessionStorage === "undefined") {
    return new InMemoryReceiptChainStorage();
  }
  return new WebStorageReceiptChainStorage(window.sessionStorage);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return bytesToHex(new Uint8Array(digest));
}

function entryHashInput(receipt: PaymentReceipt, prevHash: string): string {
  return JSON.stringify({ ...receipt, prevHash });
}

/** Storage key for the receipt chain of a given invoice. */
export function receiptChainStorageKey(invoiceId: string): string {
  return `receipt_chain:${invoiceId}`;
}

/**
 * A tamper-evident, SHA-256-linked chain of payment receipts for one
 * invoice. Persisted to a pluggable {@link ReceiptChainStorage} under
 * `receipt_chain:{invoiceId}`.
 */
export class ReceiptChain {
  private _entries: ReceiptChainEntry[] = [];
  private readonly _storage: ReceiptChainStorage;
  private readonly _invoiceId: string;

  constructor(invoiceId: string, storage: ReceiptChainStorage = new InMemoryReceiptChainStorage()) {
    this._invoiceId = invoiceId;
    this._storage = storage;
    this._load();
  }

  /** Append a new receipt, linking it to the current tail entry's hash. */
  async append(receipt: PaymentReceipt): Promise<ReceiptChainEntry> {
    const tail = this._entries[this._entries.length - 1];
    const prevHash = tail ? tail.hash : GENESIS_PREV_HASH;
    const hash = await sha256Hex(entryHashInput(receipt, prevHash));
    const entry: ReceiptChainEntry = { receipt, prevHash, hash };

    this._entries.push(entry);
    this._persist();
    return entry;
  }

  /**
   * Walk the chain, recomputing each entry's hash and checking that its
   * `prevHash` matches the prior entry's hash. An empty chain is valid.
   */
  async verify(): Promise<ChainVerificationResult> {
    if (this._entries.length === 0) {
      return { valid: true, length: 0 };
    }

    let expectedPrevHash = GENESIS_PREV_HASH;
    for (let i = 0; i < this._entries.length; i++) {
      const entry = this._entries[i]!;

      if (entry.prevHash !== expectedPrevHash) {
        return {
          valid: false,
          length: this._entries.length,
          brokenAt: i,
          reason: `entry ${i}: prevHash does not match the previous entry's hash`,
        };
      }

      const recomputedHash = await sha256Hex(entryHashInput(entry.receipt, entry.prevHash));
      if (recomputedHash !== entry.hash) {
        return {
          valid: false,
          length: this._entries.length,
          brokenAt: i,
          reason: `entry ${i}: hash does not match its receipt contents`,
        };
      }

      expectedPrevHash = entry.hash;
    }

    return { valid: true, length: this._entries.length };
  }

  /** All entries currently in the chain, in append order. */
  getEntries(): ReceiptChainEntry[] {
    return [...this._entries];
  }

  /** Number of entries currently in the chain. */
  get length(): number {
    return this._entries.length;
  }

  private _load(): void {
    const raw = this._storage.get(receiptChainStorageKey(this._invoiceId));
    if (raw) {
      this._entries = JSON.parse(raw) as ReceiptChainEntry[];
    }
  }

  private _persist(): void {
    this._storage.set(receiptChainStorageKey(this._invoiceId), JSON.stringify(this._entries));
  }
}
