// In-process event bus for `/events` (SSE + WebSocket).
//
// The store is the source of truth (ADR-0006); the bus is a delivery
// mechanism: every `store.append(...)` in the daemon goes through
// `EventBus.publish(event)`, which fans it out to all live subscribers.
// A subscriber that just connected primes itself from `store.since(after)`
// (using `Last-Event-ID` on SSE, `?since=` on WebSocket), which
// covers gap-recovery after a reconnect — the bus never queues.
//
// Subscribers implement one method: `deliver(event) → Promise<void>`.
// Errors on deliver detach the subscriber (a disconnected client).
// One `Set` of subscribers, one broadcast loop; the daemon has one
// human and a handful of tabs, no need for anything cleverer.

import type { ReviewEvent } from "@revkit/review-core";

export interface Subscriber {
  /** Push an event to the subscriber. Rejects (throws) on delivery
   * failure — the bus drops the subscriber and moves on. */
  deliver(event: ReviewEvent): void | Promise<void>;
  /** Called by the bus when the subscriber is being detached (either
   * on a delivery failure or on a graceful `unsubscribe`). Idempotent;
   * the subscriber uses it to close its underlying transport. */
  close(): void;
}

export class EventBus {
  readonly #subscribers = new Set<Subscriber>();

  /** Register a subscriber. Returns a detach function; the daemon
   * calls it on `finally` for a graceful teardown. */
  subscribe(subscriber: Subscriber): () => void {
    this.#subscribers.add(subscriber);
    return () => {
      if (this.#subscribers.delete(subscriber)) {
        try {
          subscriber.close();
        } catch {
          // A subscriber whose close() throws is a bug in the
          // subscriber, not something the bus recovers from —
          // swallow rather than take out the whole daemon.
        }
      }
    };
  }

  /** Fan `event` out to every current subscriber. Delivery is best-
   * effort per subscriber; a failure detaches the subscriber. Callers
   * `await` this so the promise resolves once all subscribers have
   * been offered the event — some transports (SSE) do not backpressure,
   * but a WebSocket send returns immediately either way, so this
   * function does not become a bottleneck. */
  async publish(event: ReviewEvent): Promise<void> {
    const failures: Subscriber[] = [];
    // Snapshot the subscriber set — a subscriber that unsubscribes
    // itself during delivery must not mutate the iterator we walk.
    const snapshot = [...this.#subscribers];
    for (const subscriber of snapshot) {
      try {
        await subscriber.deliver(event);
      } catch {
        failures.push(subscriber);
      }
    }
    for (const subscriber of failures) {
      if (this.#subscribers.delete(subscriber)) {
        try {
          subscriber.close();
        } catch {
          // See comment above.
        }
      }
    }
  }

  /** Number of live subscribers. Exported so tests and shutdown checks
   * can assert liveness without reaching into the internal set. */
  size(): number {
    return this.#subscribers.size;
  }

  /** Detach every subscriber. Called by the daemon on shutdown so
   * clients see their connections close rather than hang. */
  closeAll(): void {
    for (const subscriber of this.#subscribers) {
      try {
        subscriber.close();
      } catch {
        // See comment above.
      }
    }
    this.#subscribers.clear();
  }
}

/** Serialise a `ReviewEvent` to the SSE line-shape:
 *   id: <seq>\n
 *   data: <json>\n\n
 *
 * The `id` field is what `Last-Event-ID` echoes back on reconnect
 * (`event.seq`), so a client can resume at exactly the seq it last
 * saw — no drift, no duplicates. */
export function sseFrame(event: ReviewEvent): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** SSE "keepalive" comment. A comment-line (`:` prefix) is ignored by
 * the client but keeps intermediate proxies from closing an idle
 * connection. The daemon is loopback-only so proxies are unlikely, but
 * a browser will sometimes freeze the tab; a heartbeat gets an
 * immediate reconnect signal on wake. */
export function sseKeepalive(): string {
  return `: keepalive\n\n`;
}
