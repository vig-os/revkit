// Derived asks view — mirrors what `reducer.ts` does for threads, but
// for the four ask-lifecycle events (`ask.created`, `ask.answered`,
// `ask.cancelled`, `ask.expired`). The pattern (ADR-0006 / ADR-0025):
// the event log is the source of truth; a store may cache the
// reduction. `reduceAsks(events)` produces a `Map<askId, AskRecord>`
// that the daemon serves at `/api/asks/*`.
//
// Kept in its own file (rather than folded into `reducer.ts`) so a
// consumer that only needs threads or only needs asks pays a smaller
// bundle. Both files are runtime-neutral (no `node:*` / `bun:*` /
// DOM imports); enforced by `test/src-imports.test.ts`.

import type { ReviewEvent } from "./events.ts";
import type { AskFilter, AskRecord, AskStatus } from "./asks.ts";

/** Reduce an event slice into a Map keyed by askId. Applied in
 * ascending `seq` — the reducer re-sorts so any slice from
 * `since(seq)` produces the same result. Terminal-state events on an
 * ask that has not been created yet in the slice are skipped, so the
 * reducer stays total on any partial slice (`validateNext` already
 * refuses these on the append side, so a well-formed log never
 * carries one). */
export function reduceAsks(events: readonly ReviewEvent[]): Map<string, AskRecord> {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const asks = new Map<string, AskRecord>();
  for (const event of ordered) {
    applyEvent(asks, event);
  }
  return asks;
}

function applyEvent(asks: Map<string, AskRecord>, event: ReviewEvent): void {
  switch (event.kind) {
    case "ask.created": {
      if (asks.has(event.askId)) return;
      const createdAtMs = Date.parse(event.ts);
      asks.set(event.askId, {
        id: event.askId,
        spec: event.spec,
        status: "pending",
        // Field-elision on undefined to match the .strict() schema in
        // asks.ts (`z.object({...}).strict()` accepts a missing key
        // but rejects an explicit `undefined` on round-trip).
        ...(event.url !== undefined ? { url: event.url } : {}),
        createdAt: event.ts,
        createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
        ...(event.expiresAtMs !== undefined ? { expiresAtMs: event.expiresAtMs } : {}),
        createdSeq: event.seq,
      });
      return;
    }
    case "ask.answered": {
      const existing = asks.get(event.askId);
      if (existing === undefined || existing.status !== "pending") return;
      asks.set(event.askId, {
        ...existing,
        status: "answered",
        answer: event.answer,
        answeredAt: event.ts,
      });
      return;
    }
    case "ask.cancelled": {
      const existing = asks.get(event.askId);
      if (existing === undefined || existing.status !== "pending") return;
      asks.set(event.askId, {
        ...existing,
        status: "cancelled",
        ...(event.reason !== undefined ? { cancelReason: event.reason } : {}),
        cancelledAt: event.ts,
      });
      return;
    }
    case "ask.expired": {
      const existing = asks.get(event.askId);
      if (existing === undefined || existing.status !== "pending") return;
      asks.set(event.askId, {
        ...existing,
        status: "expired",
        expiredAt: event.ts,
      });
      return;
    }
    default:
      // Non-ask events do not touch this view.
      return;
  }
}

/** Reduce `events` and return the resulting asks ordered by
 * `createdSeq` ascending and filtered by `filter`. Mirrors
 * `selectThreads` in `store.ts` so a store that carries both concerns
 * has one shape of query for each. */
export function selectAsks(events: readonly ReviewEvent[], filter?: AskFilter): AskRecord[] {
  const derived = reduceAsks(events);
  const list = [...derived.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  return list.filter((ask) => matchesAskFilter(ask, filter));
}

/** Predicate for `AskFilter`. Exported so a caller with its own
 * pre-reduced ask set (a UI cache, an export tool) can apply the
 * same rules. */
export function matchesAskFilter(ask: AskRecord, filter: AskFilter | undefined): boolean {
  if (filter === undefined) return true;
  if (filter.status !== undefined) {
    const allowed: readonly AskStatus[] = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!allowed.includes(ask.status)) return false;
  }
  return true;
}
