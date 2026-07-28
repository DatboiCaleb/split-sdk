/**
 * SSE / stream cursor position tracker.
 *
 * Persists the last-processed paging token for each named stream so
 * long-running SDK processes can resume from the last processed ledger
 * after restarts without duplicating events.
 */

import type { InvoiceSnapshot } from "./snapshot.js";

/** In-memory cursor store. Production uses should inject a persistent backend. */
const cursorMap = new Map<string, string>();

/** Optional persistent store that survives process restarts. */
let persistentStore: CursorPersistence | null = null;

// ---------------------------------------------------------------------------
// Persistence adapter
// ---------------------------------------------------------------------------

/**
 * Backend for persisting cursor positions across restarts.
 * Implementations may write to localStorage, IndexedDB, a file, etc.
 */
export interface CursorPersistence {
  /** Read a cursor value by key. Returns undefined when not found. */
  get(key: string): string | undefined;
  /** Write a cursor value by key. */
  set(key: string, value: string): void;
  /** Remove a cursor by key. */
  delete(key: string): void;
}

/**
 * Inject a persistent cursor store. Call once at app startup to enable
 * cursor survival across process restarts.
 *
 * @example
 * ```ts
 * import { configureCursorStore } from "@stellar-split/sdk";
 *
 * // localStorage (browser)
 * configureCursorStore({
 *   get: (k) => localStorage.getItem(`cursor:${k}`) ?? undefined,
 *   set: (k, v) => localStorage.setItem(`cursor:${k}`, v),
 *   delete: (k) => localStorage.removeItem(`cursor:${k}`),
 * });
 * ```
 */
export function configureCursorStore(store: CursorPersistence): void {
  persistentStore = store;
}

/**
 * Reset the cursor tracker (useful for testing).
 */
export function _resetCursorTrackerForTesting(): void {
  cursorMap.clear();
  persistentStore = null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retrieve the last persisted paging token for `streamId`.
 * Returns `undefined` when no cursor has been saved.
 *
 * @param streamId - Unique identifier for the event stream (e.g. invoice ID or a named stream key).
 */
export function getCursor(streamId: string): string | undefined {
  // Check persistent store first
  if (persistentStore) {
    const persisted = persistentStore.get(streamId);
    if (persisted !== undefined) {
      cursorMap.set(streamId, persisted);
      return persisted;
    }
  }
  return cursorMap.get(streamId);
}

/**
 * Persist the latest paging token for `streamId`.
 *
 * @param streamId - Unique identifier for the event stream.
 * @param token    - The latest processed paging token (ledger sequence or cursor).
 */
export function setCursor(streamId: string, token: string): void {
  cursorMap.set(streamId, token);
  if (persistentStore) {
    persistentStore.set(streamId, token);
  }
}

/**
 * Remove a stored cursor position for `streamId`.
 *
 * @param streamId - Unique identifier for the event stream.
 */
export function removeCursor(streamId: string): void {
  cursorMap.delete(streamId);
  if (persistentStore) {
    persistentStore.delete(streamId);
  }
}

/**
 * Persist the cursor from a snapshot — convenience helper that stores
 * the ledger sequence recorded in an invoice snapshot as the cursor
 * for the stream identified by `streamId`.
 */
export function setCursorFromSnapshot(
  streamId: string,
  snapshot: InvoiceSnapshot,
): void {
  // We use the capturedAt timestamp as a pseudo-cursor; real usage
  // would pass the ledger sequence from the subscription context.
  setCursor(streamId, String(snapshot.capturedAt));
}
