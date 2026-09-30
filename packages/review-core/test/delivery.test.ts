// Unit tests for the derived-delivery module (ADR-0007 amendment).
//
// Cover: currentDeliveryMode + pendingCommentIds + deliveredCommentIds
// on the log alone. The invariants:
//
//   1. A live-arrival comment is delivered, never pending.
//   2. A handover-arrival comment is pending until a handover event
//      lists its id — regardless of trigger.
//   3. A quiet-arrival comment is in NEITHER set.
//   4. Handover→quiet does NOT flush automatically (the caller
//      decides; this module just describes state).
//   5. Restart invariant: the pending set on the same log is
//      identical to before, and no commentId is delivered twice or
//      never after a full round-trip.

import { describe, expect, test } from "bun:test";
import type { ReviewEvent } from "../src/events.ts";
import {
  DEFAULT_DELIVERY_MODE,
  currentDeliveryMode,
  deliveredCommentIds,
  pendingCommentIds,
} from "../src/delivery.ts";

const T = "2026-09-30T00:00:00.000Z";
type Actor = { readonly kind: "local" | "agent"; readonly id: string };
const localActor: Actor = { kind: "local", id: "u1" };
const agentActor: Actor = { kind: "agent", id: "agent" };

function commentCreated(seq: number, id: string, actor: Actor = localActor): ReviewEvent {
  return {
    seq,
    ts: T,
    actor,
    kind: "comment.created",
    threadId: "t-" + id,
    commentId: id,
    anchor: {
      path: "docs/a.md",
      startLine: 1,
      endLine: 1,
      quote: { exact: "hi", prefix: "", suffix: "" },
      revision: "a".repeat(64),
    },
    body: "body-" + id,
  } as ReviewEvent;
}

function modeChanged(seq: number, from: "handover" | "live" | "quiet" | null, to: "handover" | "live" | "quiet"): ReviewEvent {
  return { seq, ts: T, actor: localActor, kind: "delivery.mode_changed", from, to } as ReviewEvent;
}

function handover(
  seq: number,
  ids: readonly string[],
  trigger: "live" | "agent-now" | "handover" | "mode-change-flush",
): ReviewEvent {
  return {
    seq,
    ts: T,
    actor: localActor,
    kind: "handover",
    commentIds: [...ids],
    revision: "b".repeat(64),
    trigger,
  } as ReviewEvent;
}

describe("delivery derivation", () => {
  test("DEFAULT_DELIVERY_MODE is `handover`", () => {
    expect(DEFAULT_DELIVERY_MODE).toBe("handover");
    expect(currentDeliveryMode([])).toBe("handover");
  });

  test("currentDeliveryMode returns the last mode_changed's `to`", () => {
    const log: ReviewEvent[] = [
      modeChanged(1, null, "live"),
      modeChanged(2, "live", "quiet"),
    ];
    expect(currentDeliveryMode(log)).toBe("quiet");
  });

  test("handover-arrival is pending until a handover event covers it", () => {
    const log: ReviewEvent[] = [
      // Default handover mode; comment lands.
      commentCreated(1, "c1"),
    ];
    expect(pendingCommentIds(log)).toEqual(new Set(["c1"]));
    expect(deliveredCommentIds(log)).toEqual(new Set());
    // A handover event covers it (trigger irrelevant per the rules).
    const log2 = [...log, handover(2, ["c1"], "handover")];
    expect(pendingCommentIds(log2)).toEqual(new Set());
    expect(deliveredCommentIds(log2)).toEqual(new Set(["c1"]));
  });

  test("live-arrival is delivered, never pending", () => {
    const log: ReviewEvent[] = [
      modeChanged(1, null, "live"),
      commentCreated(2, "c1"),
    ];
    expect(pendingCommentIds(log)).toEqual(new Set());
    expect(deliveredCommentIds(log)).toEqual(new Set(["c1"]));
  });

  test("quiet-arrival is neither pending nor delivered", () => {
    const log: ReviewEvent[] = [
      modeChanged(1, null, "quiet"),
      commentCreated(2, "c1"),
    ];
    expect(pendingCommentIds(log)).toEqual(new Set());
    expect(deliveredCommentIds(log)).toEqual(new Set());
  });

  test("agent-authored comments are never pending", () => {
    const log: ReviewEvent[] = [commentCreated(1, "c1", agentActor)];
    expect(pendingCommentIds(log)).toEqual(new Set());
  });

  test("BLOCKER 1: rehydrate is arrival-mode aware — live arrivals are NEVER re-batched", () => {
    // Old bug: `rehydrate` treated every human comment as pending
    // under handover, regardless of arrival mode. A live-arrived
    // comment would appear pending after a restart, so the next
    // flush would re-deliver it.
    const log: ReviewEvent[] = [
      modeChanged(1, null, "live"),
      commentCreated(2, "c-live"),
      // ...a bookkeeping handover with trigger=live covers c-live.
      handover(3, ["c-live"], "live"),
      // Now the reviewer flips to handover and one more comment
      // arrives — this ONE is pending.
      modeChanged(4, "live", "handover"),
      commentCreated(5, "c-batched"),
    ];
    expect(pendingCommentIds(log)).toEqual(new Set(["c-batched"]));
    expect(deliveredCommentIds(log)).toEqual(new Set(["c-live"]));
  });

  test("BLOCKER 4: handover→quiet does NOT auto-flush; only →live does", () => {
    // The module describes state; the daemon decides when to
    // append a flush. But the invariant is: after a mode change
    // with NO handover event in between, the pending set is
    // exactly the handover-arrivals so far.
    const log: ReviewEvent[] = [
      commentCreated(1, "c1"), // handover arrival
      commentCreated(2, "c2"), // handover arrival
      modeChanged(3, "handover", "quiet"), // NO flush appended
    ];
    // Both still pending (the caller did NOT flush).
    expect(pendingCommentIds(log)).toEqual(new Set(["c1", "c2"]));
  });

  test("cover BY IDS: a handover event only covers its listed ids", () => {
    const log: ReviewEvent[] = [
      commentCreated(1, "c1"),
      commentCreated(2, "c2"),
      // The flush event covers ONLY c1. c2 was appended after the
      // pending snapshot at flush time — it stays pending.
      handover(3, ["c1"], "handover"),
    ];
    expect(pendingCommentIds(log)).toEqual(new Set(["c2"]));
  });

  test("agent-now handover covers the marker AND the prior batch", () => {
    const log: ReviewEvent[] = [
      commentCreated(1, "c1"), // batched
      commentCreated(2, "c2"), // batched
      commentCreated(3, "c-now"), // marker
      handover(4, ["c1", "c2", "c-now"], "agent-now"),
    ];
    expect(pendingCommentIds(log)).toEqual(new Set());
    expect(deliveredCommentIds(log)).toEqual(new Set(["c1", "c2", "c-now"]));
  });

  test("PROPERTY (restart): pending on the derived log is identical after any prefix→full slice", () => {
    // Random-ish sequence mixing modes, comments, handovers,
    // agent-now flushes. The core invariant: the derivation over
    // the FULL log agrees with the derivation restricted to a
    // prefix on the events in the prefix. If a comment id ever
    // moves out of pending, it never comes back.
    const events: ReviewEvent[] = [];
    let seq = 0;
    // Turn 1: handover default. Three comments batched.
    events.push(commentCreated(++seq, "a"));
    events.push(commentCreated(++seq, "b"));
    events.push(commentCreated(++seq, "c"));
    // Flush two.
    events.push(handover(++seq, ["a", "b"], "handover"));
    // Turn 2: flip to live. One live comment (covered by bookkeeping).
    events.push(modeChanged(++seq, "handover", "live"));
    events.push(commentCreated(++seq, "d"));
    events.push(handover(++seq, ["d"], "live"));
    // Turn 3: flip to quiet. One quiet comment (never delivered).
    events.push(modeChanged(++seq, "live", "quiet"));
    events.push(commentCreated(++seq, "e"));
    // Turn 4: back to handover. Two more batched.
    events.push(modeChanged(++seq, "quiet", "handover"));
    events.push(commentCreated(++seq, "f"));
    events.push(commentCreated(++seq, "g"));
    // Turn 5: @agent now flushes.
    events.push(commentCreated(++seq, "h-now"));
    events.push(handover(++seq, ["c", "f", "g", "h-now"], "agent-now"));

    // Full derivation:
    const fullPending = pendingCommentIds(events);
    const fullDelivered = deliveredCommentIds(events);
    expect(fullPending).toEqual(new Set());
    // e is quiet (never delivered); every other human comment is delivered.
    expect(fullDelivered).toEqual(new Set(["a", "b", "c", "d", "f", "g", "h-now"]));

    // Restart property: over ANY prefix, pending is the derived
    // set at that point, AND once a comment leaves pending it
    // never returns.
    let previousPending = new Set<string>();
    let previouslyDelivered = new Set<string>();
    for (let i = 1; i <= events.length; i++) {
      const slice = events.slice(0, i);
      const p = pendingCommentIds(slice);
      const d = deliveredCommentIds(slice);
      // Monotone: once delivered, forever delivered.
      for (const id of previouslyDelivered) expect(d.has(id)).toBe(true);
      // A comment that left pending never re-enters (this is the
      // "no double-delivery" guard).
      for (const id of previousPending) if (!p.has(id)) {
        // Must be delivered OR quiet-arrival (never appears again).
        // We check: it does not reappear in a later `pending`.
        for (let j = i; j <= events.length; j++) {
          const later = pendingCommentIds(events.slice(0, j));
          expect(later.has(id)).toBe(false);
        }
      }
      previousPending = p;
      previouslyDelivered = d;
    }
  });
});
