// Delivery adapter cache — incremental fold parity (round-3).
//
// The cache is a materialised view of the pure functions in
// `@revkit/review-core`. This test asserts:
//   1. `rebuildFromLog(events)` matches an event-by-event
//      `ingest(event)` sequence — the two paths are equivalent.
//   2. The cache answers `snapshot`, `pendingCommentIds`,
//      `deliveredCommentIds`, `currentMode` and
//      `shouldFanOutToAgent` from memory (no `store.since` needed).

import { describe, expect, test } from "bun:test";
import type { ReviewEvent } from "@revkit/review-core";
import {
  currentDeliveryMode,
  deliveredCommentIds,
  pendingCommentIds,
} from "@revkit/review-core";
import { IngestGapError, openDeliveryAdapter } from "../../src/serve/delivery-modes.ts";

const T = "2026-09-30T00:00:00.000Z";
type Actor = { readonly kind: "local" | "agent"; readonly id: string };
const localActor: Actor = { kind: "local", id: "u1" };

function commentCreated(seq: number, id: string, actor: Actor = localActor): ReviewEvent {
  return {
    seq, ts: T, actor, kind: "comment.created",
    threadId: "t-" + id, commentId: id,
    anchor: {
      path: "docs/a.md", startLine: 1, endLine: 1,
      quote: { exact: "hi", prefix: "", suffix: "" },
      revision: "a".repeat(64),
    },
    body: "body-" + id,
  } as ReviewEvent;
}
function modeChanged(seq: number, from: "handover" | "live" | "quiet" | null, to: "handover" | "live" | "quiet"): ReviewEvent {
  return { seq, ts: T, actor: localActor, kind: "delivery.mode_changed", from, to } as ReviewEvent;
}
function handover(seq: number, ids: readonly string[], trigger: "live" | "agent-now" | "handover" | "mode-change-flush"): ReviewEvent {
  return {
    seq, ts: T, actor: localActor, kind: "handover",
    commentIds: [...ids], revision: "b".repeat(64), trigger,
  } as ReviewEvent;
}

describe("delivery cache", () => {
  test("rebuildFromLog matches an event-by-event ingest", () => {
    const events: ReviewEvent[] = [
      modeChanged(1, null, "live"),
      commentCreated(2, "c1"),
      handover(3, ["c1"], "live"),
      modeChanged(4, "live", "handover"),
      commentCreated(5, "c2"),
      commentCreated(6, "c3"),
      handover(7, ["c2"], "handover"),
    ];
    const rebuilt = openDeliveryAdapter();
    rebuilt.rebuildFromLog(events);
    const incremental = openDeliveryAdapter();
    for (const event of events) incremental.ingest(event);
    expect(incremental.currentMode()).toBe(rebuilt.currentMode());
    expect([...incremental.pendingCommentIds()].sort()).toEqual([...rebuilt.pendingCommentIds()].sort());
    expect([...incremental.deliveredCommentIds()].sort()).toEqual([...rebuilt.deliveredCommentIds()].sort());
  });

  test("cache answers match the pure review-core derivation", () => {
    const events: ReviewEvent[] = [
      commentCreated(1, "a"),
      commentCreated(2, "b"),
      modeChanged(3, "handover", "live"),
      commentCreated(4, "c"),
      handover(5, ["c"], "live"),
      modeChanged(6, "live", "quiet"),
      commentCreated(7, "d"),
      modeChanged(8, "quiet", "handover"),
      commentCreated(9, "e"),
      handover(10, ["a", "b", "e"], "handover"),
    ];
    const adapter = openDeliveryAdapter();
    adapter.rebuildFromLog(events);
    // Compare against the pure derivation.
    expect(adapter.currentMode()).toBe(currentDeliveryMode(events));
    expect([...adapter.pendingCommentIds()].sort()).toEqual([...pendingCommentIds(events)].sort());
    expect([...adapter.deliveredCommentIds()].sort()).toEqual([...deliveredCommentIds(events)].sort());
  });

  test("shouldFanOutToAgent reads the cache (no full-log arg needed)", () => {
    const adapter = openDeliveryAdapter();
    adapter.ingest(modeChanged(1, null, "handover"));
    // A batched comment — not yet delivered → not for agent.
    const c1 = commentCreated(2, "c1");
    adapter.ingest(c1);
    expect(adapter.shouldFanOutToAgent(c1)).toBe(false);
    // A subsequent handover event covers it.
    const h = handover(3, ["c1"], "handover");
    adapter.ingest(h);
    // The comment is now delivered — the SAME event re-checked
    // resolves to fan-out. Daemon publishes each event once, but
    // the pure check stays consistent with the log state.
    expect(adapter.shouldFanOutToAgent(c1)).toBe(true);
    // The handover event itself fans out.
    expect(adapter.shouldFanOutToAgent(h)).toBe(true);
    // A handover(trigger=live) is bookkeeping — does NOT fan out.
    const bookkeeping = handover(4, ["c2"], "live");
    expect(adapter.shouldFanOutToAgent(bookkeeping)).toBe(false);
  });

  test("reconcileIdleTimer arms only when pending is non-empty AND mode=handover", () => {
    let armed = 0;
    const timers: (() => void)[] = [];
    const adapter = openDeliveryAdapter({
      idleFlushMs: 100,
      setTimer: (fn) => {
        armed++;
        timers.push(fn);
        return { unref: () => {} };
      },
      clearTimer: () => {},
    });
    // Empty log → no timer.
    adapter.reconcileIdleTimer(() => {});
    expect(armed).toBe(0);
    // handover mode, one pending → armed.
    adapter.ingest(commentCreated(1, "c1"));
    adapter.reconcileIdleTimer(() => {});
    expect(armed).toBe(1);
    // Flush the pending set → no more pending → no re-arm.
    adapter.ingest(handover(2, ["c1"], "handover"));
    adapter.reconcileIdleTimer(() => {});
    expect(armed).toBe(1);
  });

  test("ROUND 4: ingest is idempotent on duplicates AND throws on gaps", () => {
    const adapter = openDeliveryAdapter();
    const e1 = commentCreated(1, "c1");
    const e2 = commentCreated(2, "c2");
    const e3 = commentCreated(3, "c3");
    adapter.ingest(e1);
    adapter.ingest(e2);
    // Duplicate — silent no-op, cache unchanged.
    adapter.ingest(e2);
    expect([...adapter.pendingCommentIds()].sort()).toEqual(["c1", "c2"]);
    // Skipping seq=3 and feeding seq=4 is a gap → throws.
    const e4 = commentCreated(4, "c4");
    expect(() => adapter.ingest(e4)).toThrow(IngestGapError);
    // Recovery: rebuildFromLog with the full slice.
    adapter.rebuildFromLog([e1, e2, e3, e4]);
    expect([...adapter.pendingCommentIds()].sort()).toEqual(["c1", "c2", "c3", "c4"]);
  });
});

describe("PROPERTY: adapter cache vs. pure review-core derivation", () => {
  // Round-4: run the same seeded sequences from the property test in
  // review-core through the ADAPTER — with SHUFFLED and DUPLICATED
  // ingest — and assert the adapter state matches the pure derivation.
  //
  // On 6ff43589 (before the round-4 fix), `ingest` was seq-agnostic:
  // a `comment.created` ingested BEFORE its preceding
  // `delivery.mode_changed` recorded the wrong arrival mode. Feeding
  // a shuffled sequence produced a divergent pending / delivered set
  // and this test would fail red.
  //
  // On the round-4 fix, `ingest` throws `IngestGapError` on out-of-
  // order events. The test's `feed` helper catches that and recovers
  // via `rebuildFromLog(events[0..i+1])`. The final state matches
  // the pure derivation over the ORIGINAL (in-order) sequence.

  const seed = 0xC0FFEE + 0xD00D;
  const runs = 300;

  test("300 seeded runs, seq-order and shuffled and duplicated all converge on the pure derivation", async () => {
    const { pendingCommentIds: purePending, deliveredCommentIds: pureDelivered } = await import(
      "@revkit/review-core"
    );
    for (let run = 0; run < runs; run++) {
      const rng = mulberry32(seed + run);
      const events = generateSequence(rng, 25);
      const expectedPending = purePending(events);
      const expectedDelivered = pureDelivered(events);
      // 1. In-order feed matches the pure derivation.
      {
        const adapter = openDeliveryAdapter();
        for (const event of events) adapter.ingest(event);
        expect([...adapter.pendingCommentIds()].sort()).toEqual([...expectedPending].sort());
        expect([...adapter.deliveredCommentIds()].sort()).toEqual([...expectedDelivered].sort());
      }
      // 2. Shuffled feed — the property that fails RED on round 3.
      //
      //    Round-3 head (6ff43589): `ingest` was seq-agnostic — no
      //    gap detection. Feeding shuffled events silently folded
      //    them in the wrong order, producing a wrong
      //    `arrivalMode` on comments whose preceding
      //    `delivery.mode_changed` hadn't been seen yet. The buggy
      //    fold gave the WRONG pending / delivered sets AND raised
      //    NO error, so a caller had no way to detect the drift.
      //    We assert that AT LEAST ONE gap detection fires when
      //    the shuffle actually swaps two consecutive seqs — a
      //    detection round 3 did not provide.
      //
      //    Round 4: `ingest` throws `IngestGapError` on any
      //    out-of-order event, so the caller learns immediately
      //    that it must recover via `rebuildFromLog`.
      {
        const adapter = openDeliveryAdapter();
        const shuffled = shuffle([...events], mulberry32(seed + run + 1));
        // Skip runs where the shuffle happened to leave events in
        // seq order — nothing to detect.
        const isInOrder = shuffled.every((e, i) => i === 0 || e.seq > shuffled[i - 1]!.seq);
        let gapErrorsSeen = 0;
        for (const event of shuffled) {
          try {
            adapter.ingest(event);
          } catch (error) {
            if (error instanceof IngestGapError) gapErrorsSeen++;
            else throw error;
          }
        }
        if (!isInOrder && events.length > 1) {
          // Round-3 head: 0 gap errors even on a non-sorted shuffle.
          // Round-4:      at least one gap detected → RED-then-GREEN.
          expect(gapErrorsSeen).toBeGreaterThan(0);
        }
        // Recovery via `rebuildFromLog(fullLog)` — order-invariant
        // (rebuildFromLog sorts by seq) — converges on the pure
        // derivation.
        adapter.rebuildFromLog(events);
        expect([...adapter.pendingCommentIds()].sort()).toEqual([...expectedPending].sort());
        expect([...adapter.deliveredCommentIds()].sort()).toEqual([...expectedDelivered].sort());
      }
      // 3. Duplicated feed — every event repeated twice; duplicates
      //    are silent no-ops; final state matches the pure derivation.
      {
        const adapter = openDeliveryAdapter();
        for (const event of events) {
          adapter.ingest(event);
          // A duplicate at the same seq is idempotent.
          adapter.ingest(event);
        }
        expect([...adapter.pendingCommentIds()].sort()).toEqual([...expectedPending].sort());
        expect([...adapter.deliveredCommentIds()].sort()).toEqual([...expectedDelivered].sort());
      }
    }
  });
});

/** Fisher–Yates shuffle with a seeded PRNG. Modifies `arr` in place
 * AND returns it. */
function shuffle<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

/** Deterministic PRNG (Mulberry32) — mirrors the review-core
 * property test so a failing run reproduces on either side. */
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

/** Same generator as `packages/review-core/test/delivery.test.ts`.
 * Kept in sync via review — a divergence would silently give the
 * two suites different inputs. */
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
      const id = nextId();
      const isAgent = rng() < 0.4;
      events.push(commentCreated(++seq, id, isAgent ? { kind: "agent", id: "agent" } : localActor));
      if (!isAgent && mode === "handover") pendingIds.add(id);
      if (!isAgent && mode === "handover" && rng() < 0.2) {
        const drain = [...pendingIds];
        pendingIds.clear();
        events.push(handover(++seq, drain, "agent-now"));
      } else if (!isAgent && mode === "live") {
        events.push(handover(++seq, [id], "live"));
      }
    } else if (roll < 0.75) {
      const next = modes[Math.floor(rng() * modes.length)]!;
      if (next !== mode) {
        if (mode === "handover" && next === "live" && pendingIds.size > 0) {
          const drain = [...pendingIds];
          pendingIds.clear();
          events.push(handover(++seq, drain, "mode-change-flush"));
        }
        events.push(modeChanged(++seq, mode, next));
        mode = next;
      }
    } else if (roll < 0.9) {
      if (pendingIds.size > 0) {
        const drain = [...pendingIds];
        pendingIds.clear();
        events.push(handover(++seq, drain, "handover"));
      }
    }
  }
  return events;
}
