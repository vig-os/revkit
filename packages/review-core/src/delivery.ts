// Delivery-mode derivation (ADR-0007 amendment, M2 item 6 review
// round 2).
//
// Delivery state is FULLY DERIVED from the event log. There is no
// in-memory state that a restart could disagree with. Given a
// slice of events in seq order, the two pure functions here answer:
//
//   `currentDeliveryMode(events)` → the mode after the last
//     `delivery.mode_changed`. Defaults to `"handover"` (ADR-0007
//     "Default delivery mode is `handover`").
//
//   `pendingCommentIds(events)` → the set of human-authored
//     comment ids that are STILL WAITING to be delivered to the
//     agent.
//
// Rules for `pendingCommentIds`:
//
//   1. Only `comment.created` / `comment.replied` from a
//      non-agent actor are candidates.
//   2. A candidate is pending iff its ARRIVAL MODE (the mode at
//      its own `seq`) is `handover`. Live-mode arrivals are
//      already delivered by the fan-out path; quiet-mode arrivals
//      are never delivered (the agent pulls, per §5.3).
//   3. A candidate is no longer pending once ANY subsequent
//      `handover` event lists its commentId — regardless of the
//      trigger. The four triggers cover the singleton live push,
//      the marker's bypass under `agent-now`, the reviewer's
//      explicit flush, and a handover→live transition's flush.
//   4. Cover BY IDS, not by seq. A comment appended between the
//      moment the daemon decides to flush and the moment the
//      `handover` event lands stays pending if its id is not on
//      the event.
//
// The "delivered to agent" complement is:
//
//   `deliveredCommentIds(events)` = every human comment id that
//     arrived under `live` OR is listed in a `handover` event.
//     Quiet-mode arrivals are neither pending nor delivered —
//     they are pull-only.
//
// The hook + the catch-up summary use `deliveredCommentIds ∩ open
// threads with a human last commenter` to decide what to surface.
// Handover drafts NEVER leak into the hook (they are the
// reviewer's private WIP, like a GitHub pending review) — that
// promise is enforced BY CONSTRUCTION here, not case-by-case at
// each caller.
//
// Runtime-neutral: no `node:*` / `bun:*` imports.

import type { DeliveryMode, ReviewEvent } from "./events.ts";

/** The default mode a fresh daemon starts in — matches ADR-0007
 * Acceptance ("Default delivery mode is `handover`"). Exported so
 * tests can assert on the exact constant. */
export const DEFAULT_DELIVERY_MODE: DeliveryMode = "handover";

/** Walk the event log in seq order and return the mode after the
 * last `delivery.mode_changed`. Fresh log → the default. */
export function currentDeliveryMode(events: readonly ReviewEvent[]): DeliveryMode {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  let mode: DeliveryMode = DEFAULT_DELIVERY_MODE;
  for (const event of sorted) {
    if (event.kind === "delivery.mode_changed") mode = event.to;
  }
  return mode;
}

/** Walk the log in seq order and return the arrival mode at each
 * `seq`. A comment's arrival mode is the mode at the time its own
 * event was appended. The returned map is keyed by seq. Kept
 * internal — callers use `pendingCommentIds` / `deliveredCommentIds`
 * which take this into account. */
function arrivalModeBySeq(events: readonly ReviewEvent[]): Map<number, DeliveryMode> {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const map = new Map<number, DeliveryMode>();
  let mode: DeliveryMode = DEFAULT_DELIVERY_MODE;
  for (const event of sorted) {
    // A mode_changed event's OWN arrival mode is the OLD mode
    // (the transition applies AFTER the event). Every other kind
    // arrives under the current mode.
    map.set(event.seq, mode);
    if (event.kind === "delivery.mode_changed") mode = event.to;
  }
  return map;
}

/** Return the set of every commentId listed in any `handover`
 * event on the log. Pure over ids — a comment created between a
 * flush's decision and its `handover` append stays out of this set
 * until a subsequent event covers it. */
function coveredCommentIds(events: readonly ReviewEvent[]): Set<string> {
  const covered = new Set<string>();
  for (const event of events) {
    if (event.kind !== "handover") continue;
    for (const id of event.commentIds) covered.add(id);
  }
  return covered;
}

/** Pending comments — the derived answer that replaces the
 * in-memory batch. A comment id is pending iff its arrival mode
 * was `handover` AND no `handover` event lists it. Comments with
 * `@agent now` in their body OR arriving under `live` / `quiet`
 * are never pending. */
export function pendingCommentIds(events: readonly ReviewEvent[]): Set<string> {
  const arrival = arrivalModeBySeq(events);
  const covered = coveredCommentIds(events);
  const pending = new Set<string>();
  for (const event of events) {
    if (event.kind !== "comment.created" && event.kind !== "comment.replied") continue;
    if (event.actor.kind === "agent") continue;
    const mode = arrival.get(event.seq) ?? DEFAULT_DELIVERY_MODE;
    if (mode !== "handover") continue;
    if (covered.has(event.commentId)) continue;
    pending.add(event.commentId);
  }
  return pending;
}

/** Delivered comments — the complement pending: comments the
 * agent has (or is about to) see. Used by the hook + catch-up
 * summary to filter to "delivered AND still open AND human last
 * commenter". A quiet-mode comment is in NEITHER set (pull-only). */
export function deliveredCommentIds(events: readonly ReviewEvent[]): Set<string> {
  const arrival = arrivalModeBySeq(events);
  const covered = coveredCommentIds(events);
  const delivered = new Set<string>();
  for (const event of events) {
    if (event.kind !== "comment.created" && event.kind !== "comment.replied") continue;
    if (event.actor.kind === "agent") continue;
    const mode = arrival.get(event.seq) ?? DEFAULT_DELIVERY_MODE;
    if (mode === "live") delivered.add(event.commentId);
    else if (covered.has(event.commentId)) delivered.add(event.commentId);
  }
  return delivered;
}

/** True when THIS comment is pending under the log. Convenience
 * wrapper for the daemon's per-event fan-out gate. */
export function isPending(events: readonly ReviewEvent[], commentId: string): boolean {
  return pendingCommentIds(events).has(commentId);
}
