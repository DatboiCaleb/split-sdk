/**
 * Types for the streaming subscription system (SubscriptionManager).
 */

export type { InvoiceEvent } from "../types.js";
import type { StorageAdapter, StorageKind } from "../storage/storageAdapter.js";

/** A persisted position in an invoice's event stream, used to replay events missed during a disconnect. */
export interface EventCursor {
  invoiceId: string;
  /** First ledger sequence not yet processed. */
  lastLedger: number;
  /** ID of the last event delivered to handlers, if any. */
  lastEventId: string | null;
  /** When this cursor was last persisted (ms since epoch). */
  updatedAt: number;
}

/** Lifecycle events emitted by SubscriptionManager for observability. */
export type SubscriptionManagerLifecycleEvent =
  | { type: "connected"; invoiceId: string }
  | { type: "disconnected"; invoiceId: string; error: Error }
  | { type: "reconnecting"; invoiceId: string; attempt: number; delayMs: number }
  | { type: "cursor_persisted"; invoiceId: string; cursor: EventCursor };

/** Options accepted by SubscriptionManager and its per-invoice subscribe() calls. */
export interface SubscriptionOptions {
  /** Poll interval when using the getEvents-based bridge, in ms. Default: 3000. */
  pollIntervalMs?: number;
  /** Initial reconnect backoff, in ms. Default: 1000. */
  initialBackoffMs?: number;
  /** Maximum reconnect backoff, in ms. Default: 30000. */
  maxBackoffMs?: number;
  /** Backoff multiplier applied on each consecutive failure. Default: 2. */
  backoffMultiplier?: number;
  /** Max consecutive reconnect attempts before giving up. Default: Infinity (never gives up). */
  maxRetries?: number;
  /** Custom storage backend for the event cursor. Overrides `storageKind`. */
  storage?: StorageAdapter;
  /** Which built-in storage backend to use for the event cursor. Default: "localStorage". */
  storageKind?: StorageKind;
  /** Called on connect/disconnect/reconnect/cursor-persist for observability. */
  onLifecycleEvent?: (event: SubscriptionManagerLifecycleEvent) => void;
}
