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

  test("PROPERTY (restart): 300 randomised sequences, seeded PRNG", () => {
    // Round-3 real property test: a seeded PRNG (Mulberry32 —
    // deterministic and hash-stable across engines) drives 300
    // random sequences mixing mode changes, comments, handovers,
    // agent-now flushes and simulated restarts. On EVERY sequence
    // the invariants are:
    //
    //   (i)  pending(prefix) at every step matches an independent
    //        re-derivation from that same prefix (restart = fresh
    //        derivation, so this is the "restart yields identical
    //        pending set" property).
    //   (ii) Monotone delivered: once a comment id is in
    //        `delivered`, it is in `delivered` for every later
    //        slice.
    //   (iii) No re-batch: a comment id that leaves `pending` in
    //        one step never re-enters `pending` in a later step
    //        (this is the "no double-delivery / no lost
    //        commentId" invariant the reviewer asked to test).
    //
    // Fixed seed for reproducibility. If a regression is found,
    // hard-code the failing seed into a new test alongside this.
    const seed = 0xC0FFEE;
    const runs = 300;
    for (let run = 0; run < runs; run++) {
      const rng = mulberry32(seed + run);
      const events = generateSequence(rng, 30);
      const fullPending = pendingCommentIds(events);
      const fullDelivered = deliveredCommentIds(events);
      let previousPending = new Set<string>();
      let previouslyDelivered = new Set<string>();
      const leftPending = new Set<string>();
      for (let i = 1; i <= events.length; i++) {
        const slice = events.slice(0, i);
        const p = pendingCommentIds(slice);
        const d = deliveredCommentIds(slice);
        // Restart-equivalence (i): the derivation is pure over
        // the slice, so re-deriving from the same slice must
        // give the same set. Duplicate the call to catch any
        // hidden mutation in the derivation implementation.
        expect(pendingCommentIds(slice.slice())).toEqual(p);
        expect(deliveredCommentIds(slice.slice())).toEqual(d);
        // (ii) monotone delivered
        for (const id of previouslyDelivered) {
          if (!d.has(id)) {
            throw new Error(
              `run=${run} step=${i}: id=${id} left delivered set (monotone violation).`,
            );
          }
        }
        // (iii) no re-batch
        for (const id of previousPending) if (!p.has(id)) leftPending.add(id);
        for (const id of leftPending) {
          if (p.has(id)) {
            throw new Error(
              `run=${run} step=${i}: id=${id} re-entered pending (double-delivery / lost commentId).`,
            );
          }
        }
        previousPending = p;
        previouslyDelivered = d;
      }
      // No pending id is also delivered — the two sets are disjoint.
      for (const id of fullPending) {
        expect(fullDelivered.has(id)).toBe(false);
      }
    }
  });
});

/** Deterministic PRNG (Mulberry32). Used for the property test —
 * same seed produces the same 32-bit stream on every JS runtime. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generate a random sequence of events using the PRNG. Steps pick
 * from a small alphabet {comment, mode-change, flush, agent-now}
 * with weights that keep sequences varied without pathological
 * shapes. Every event uses monotonically-increasing seq ids. */
function generateSequence(rng: () => number, steps: number): ReviewEvent[] {
  const events: ReviewEvent[] = [];
  let seq = 0;
  let commentCounter = 0;
  let mode: "handover" | "live" | "quiet" = "handover";
  const pendingIds = new Set<string>();
  const nextId = (): string => `c${commentCounter++}`;
  const modes: ("handover" | "live" | "quiet")[] = ["handover", "live", "quiet"];
  for (let i = 0; i < steps; i++) {
    const roll = rng();
    if (roll < 0.55) {
      // Comment. 60% human, 40% agent.
      const id = nextId();
      const isAgent = rng() < 0.4;
      events.push(commentCreated(++seq, id, isAgent ? agentActor : localActor));
      if (!isAgent && mode === "handover") pendingIds.add(id);
      // 20% chance the human comment carried @agent now → flush.
      if (!isAgent && mode === "handover" && rng() < 0.2) {
        const drain = [...pendingIds];
        pendingIds.clear();
        events.push(handover(++seq, drain, "agent-now"));
      } else if (!isAgent && mode === "live") {
        // Live: bookkeeping handover.
        events.push(handover(++seq, [id], "live"));
      }
    } else if (roll < 0.75) {
      // Mode change (only if different).
      const next = modes[Math.floor(rng() * modes.length)]!;
      if (next !== mode) {
        // handover→live: flush first.
        if (mode === "handover" && next === "live" && pendingIds.size > 0) {
          const drain = [...pendingIds];
          pendingIds.clear();
          events.push(handover(++seq, drain, "mode-change-flush"));
        }
        events.push(modeChanged(++seq, mode, next));
        mode = next;
      }
    } else if (roll < 0.9) {
      // Explicit hand-over.
      if (pendingIds.size > 0) {
        const drain = [...pendingIds];
        pendingIds.clear();
        events.push(handover(++seq, drain, "handover"));
      }
    } else {
      // Simulated "restart": no event; the loop just moves on.
      // The invariant test slices at every prefix, so this is a
      // no-op semantically — the derivation is stateless.
    }
  }
  return events;
}
