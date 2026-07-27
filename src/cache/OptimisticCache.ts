/**
 * OptimisticCache — applies a predicted outcome to a cached value
 * immediately upon submission, then commits or rolls back once the
 * settled transaction result is known, so UIs built on the SDK don't have
 * to re-fetch (and flicker) after every mutation.
 *
 * Keyed by invoiceId, with an internal (invoiceId, version) composite so
 * concurrent optimistic mutations to the same invoice queue up instead of
 * clobbering one another: rolling back mutation N leaves mutations N+1..M
 * (and the base cache) untouched.
 */

import { SimpleCache } from "../cache.js";

export type CommitFn = () => void;
export type RollbackFn = () => void;

export interface OptimisticEntry<T> {
  key: string;
  invoiceId: string;
  version: number;
  predictedValue: T;
  rollbackValue: T;
}

export interface RollbackEvent<T> {
  key: string;
  invoiceId: string;
  version: number;
  /** The value now visible for `invoiceId` after this rollback (either an
   * older still-pending prediction, or the committed base value). */
  restoredValue: T;
}

const DEFAULT_BASE_TTL_MS = 60_000;

export class OptimisticCache<T = unknown> {
  private readonly base: SimpleCache<T>;
  /** Per-invoice FIFO queue of pending (uncommitted, unrolled-back) predictions. */
  private readonly pending = new Map<string, OptimisticEntry<T>[]>();
  private readonly rollbackHandlers = new Set<(event: RollbackEvent<T>) => void>();
  private readonly versionCounters = new Map<string, number>();

  constructor(base?: SimpleCache<T>) {
    this.base = base ?? new SimpleCache<T>({ enabled: true, ttlMs: DEFAULT_BASE_TTL_MS });
  }

  /**
   * Read the current UI-facing value for an invoice: the most recently
   * applied still-pending optimistic prediction if one exists, otherwise
   * the committed base value.
   */
  get(invoiceId: string): T | undefined {
    const queue = this.pending.get(invoiceId);
    if (queue && queue.length > 0) {
      return queue[queue.length - 1]!.predictedValue;
    }
    return this.base.get(invoiceId);
  }

  /** Number of optimistic mutations across all invoices awaiting commit/rollback. */
  get pendingCount(): number {
    let total = 0;
    for (const queue of this.pending.values()) total += queue.length;
    return total;
  }

  /** Register a listener invoked whenever a rollback() restores a prior value. */
  onRollback(handler: (event: RollbackEvent<T>) => void): () => void {
    this.rollbackHandlers.add(handler);
    return () => this.rollbackHandlers.delete(handler);
  }

  /**
   * Apply a predicted value for `invoiceId` immediately. Returns a
   * `{ commit, rollback }` pair: `commit()` writes the prediction into the
   * base cache, `rollback()` restores whatever was visible before this
   * prediction (an earlier still-pending prediction, or the base value).
   * Both are idempotent no-ops after the first call.
   */
  applyOptimistic(
    invoiceId: string,
    predictedValue: T,
    rollbackValue: T,
  ): { commit: CommitFn; rollback: RollbackFn; key: string } {
    const version = (this.versionCounters.get(invoiceId) ?? 0) + 1;
    this.versionCounters.set(invoiceId, version);
    const key = `${invoiceId}@${version}`;

    const entry: OptimisticEntry<T> = { key, invoiceId, version, predictedValue, rollbackValue };
    const queue = this.pending.get(invoiceId) ?? [];
    queue.push(entry);
    this.pending.set(invoiceId, queue);

    let settled = false;

    const commit: CommitFn = () => {
      if (settled) return;
      settled = true;
      this.base.set(invoiceId, entry.predictedValue);
      this._removeEntry(entry);
    };

    const rollback: RollbackFn = () => {
      if (settled) return;
      settled = true;
      this._removeEntry(entry);

      const remaining = this.pending.get(invoiceId);
      const stillPending = remaining && remaining.length > 0;
      const restoredValue = stillPending ? remaining![remaining!.length - 1]!.predictedValue : entry.rollbackValue;
      if (!stillPending) {
        this.base.set(invoiceId, entry.rollbackValue);
      }

      const event: RollbackEvent<T> = { key, invoiceId, version, restoredValue };
      for (const handler of this.rollbackHandlers) {
        try {
          handler(event);
        } catch {
          // Isolate listener failures from cache bookkeeping.
        }
      }
    };

    return { commit, rollback, key };
  }

  private _removeEntry(entry: OptimisticEntry<T>): void {
    const queue = this.pending.get(entry.invoiceId);
    if (!queue) return;
    const idx = queue.indexOf(entry);
    if (idx >= 0) queue.splice(idx, 1);
    if (queue.length === 0) this.pending.delete(entry.invoiceId);
  }
}
