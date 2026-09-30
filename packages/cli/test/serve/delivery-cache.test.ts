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
import { openDeliveryAdapter } from "../../src/serve/delivery-modes.ts";

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
});
