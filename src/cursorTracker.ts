/**
 * Cursor tracker for persisting Horizon paging tokens.
 *
 * Provides an in-memory and pluggable storage-backed cursor store so that
 * the horizon paginator can resume from the last-seen position across
 * restarts or page walks.
 */

import type { CursorStore } from "./types.js";

/**
 * In-memory cursor store suitable for session-scoped pagination.
 * Cursors are lost when the process exits.
 */
export class InMemoryCursorStore implements CursorStore {
  private store = new Map<string, string>();

  async save(key: string, cursor: string): Promise<void> {
    this.store.set(key, cursor);
  }

  async load(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  /** Remove all saved cursors. */
  clear(): void {
    this.store.clear();
  }
}

/** Singleton in-memory store shared across the module. */
let defaultStore: CursorStore = new InMemoryCursorStore();

/**
 * Override the default cursor store.
 * Useful for plugging in localStorage, IndexedDB, or a remote store.
 */
export function setDefaultCursorStore(store: CursorStore): void {
  defaultStore = store;
}

/**
 * Get the current default cursor store.
 */
export function getDefaultCursorStore(): CursorStore {
  return defaultStore;
}

/**
 * Build a namespaced cursor key from a base name and namespace.
 */
export function buildCursorKey(namespace: string, name: string): string {
  return `${namespace}:${name}`;
}
