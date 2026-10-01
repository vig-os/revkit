// Derived pending-review state (M3 part 2b).
//
// The pending-review view is a pure function of the log:
//   - `review.opened` opens a pending review.
//   - `comment.linked` events with `external.github.pending: true`
//     and `reviewNodeId` are the pending comments.
//   - `review.submitted` / `review.abandoned` close the review, and
//     the pending comments no longer appear in the pending set.
//
// The tests exercise the reducer directly. The "restart test" that
// proves the daemon's pending set is derived-from-log (never held in
// memory) lives in `packages/cli/test/serve/review-mode.test.ts`.

import { describe, expect, test } from "bun:test";
import type { ReviewEvent } from "../src/index.ts";
import { isPendingReviewStale, reduceReviewState } from "../src/index.ts";

const t = "2026-09-30T12:00:00Z";
const localActor = { kind: "local" as const, id: "u-1" };
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const REV_A = "c".repeat(64);
const REV_B = "d".repeat(64);

function commentCreated(seq: number, threadId: string, commentId: string, path: string): ReviewEvent {
  return {
    seq,
    ts: t,
    actor: localActor,
    kind: "comment.created",
    threadId,
    commentId,
    anchor: {
      path,
      startLine: 1,
      endLine: 1,
      quote: { exact: "hi", prefix: "", suffix: "" },
      revision: REV_A,
    },
    body: "hello",
  };
}

function reviewOpened(seq: number, reviewNodeId: string, headSha: string): ReviewEvent {
  return { seq, ts: t, actor: localActor, kind: "review.opened", reviewNodeId, headSha };
}

function commentLinkedPending(seq: number, commentId: string, reviewNodeId: string, ghCommentId: number, ghNodeId?: string): ReviewEvent {
  return {
    seq,
    ts: t,
    actor: localActor,
    kind: "comment.linked",
    commentId,
    external: {
      github: {
        commentId: ghCommentId,
        pending: true,
        reviewNodeId,
        ...(ghNodeId !== undefined ? { nodeId: ghNodeId } : {}),
      },
    },
  };
}

describe("reduceReviewState (M3 part 2b)", () => {
  test("empty log — no open pending review", () => {
    const state = reduceReviewState([]);
    expect(state.openPending).toBeNull();
    expect(state.terminal).toEqual([]);
  });

  test("review.opened alone — pending with zero comments", () => {
    const state = reduceReviewState([reviewOpened(1, "R_1", HEAD_A)]);
    expect(state.openPending).toEqual({ reviewNodeId: "R_1", headSha: HEAD_A, comments: [] });
    expect(state.terminal).toEqual([]);
  });

  test("comment.created + review.opened + comment.linked — one pending comment", () => {
    const state = reduceReviewState([
      commentCreated(1, "th-1", "c-1", "docs/index.md"),
      reviewOpened(2, "R_1", HEAD_A),
      commentLinkedPending(3, "c-1", "R_1", 999, "PRRC_1"),
    ]);
    expect(state.openPending).not.toBeNull();
    expect(state.openPending!.reviewNodeId).toBe("R_1");
    expect(state.openPending!.headSha).toBe(HEAD_A);
    expect(state.openPending!.comments).toEqual([
      {
        commentId: "c-1",
        threadId: "th-1",
        pendingCommentDatabaseId: 999,
        pendingCommentNodeId: "PRRC_1",
        path: "docs/index.md",
      },
    ]);
  });

  test("review.submitted moves the review to `terminal` and empties pending", () => {
    const state = reduceReviewState([
      commentCreated(1, "th-1", "c-1", "docs/index.md"),
      reviewOpened(2, "R_1", HEAD_A),
      commentLinkedPending(3, "c-1", "R_1", 999),
      {
        seq: 4,
        ts: t,
        actor: localActor,
        kind: "review.submitted",
        reviewNodeId: "R_1",
        event: "APPROVE",
        body: "LGTM",
      },
    ]);
    expect(state.openPending).toBeNull();
    expect(state.terminal.length).toBe(1);
    const term = state.terminal[0]!;
    expect(term.outcome).toEqual({ kind: "submitted", event: "APPROVE", body: "LGTM" });
  });

  test("review.abandoned moves the review to `terminal` and empties pending", () => {
    const state = reduceReviewState([
      commentCreated(1, "th-1", "c-1", "docs/index.md"),
      reviewOpened(2, "R_1", HEAD_A),
      commentLinkedPending(3, "c-1", "R_1", 999),
      {
        seq: 4,
        ts: t,
        actor: localActor,
        kind: "review.abandoned",
        reviewNodeId: "R_1",
        reason: "head-moved",
      },
    ]);
    expect(state.openPending).toBeNull();
    expect(state.terminal.length).toBe(1);
    const term = state.terminal[0]!;
    expect(term.outcome).toEqual({ kind: "abandoned", reason: "head-moved" });
  });

  test("after abandon a NEW pending review can open at a new headSha", () => {
    const state = reduceReviewState([
      reviewOpened(1, "R_1", HEAD_A),
      {
        seq: 2,
        ts: t,
        actor: localActor,
        kind: "review.abandoned",
        reviewNodeId: "R_1",
      },
      reviewOpened(3, "R_2", HEAD_B),
    ]);
    expect(state.openPending?.reviewNodeId).toBe("R_2");
    expect(state.openPending?.headSha).toBe(HEAD_B);
    expect(state.terminal.length).toBe(1);
  });

  test("a comment.linked without `pending: true` is NOT in the pending set", () => {
    const state = reduceReviewState([
      commentCreated(1, "th-1", "c-1", "docs/index.md"),
      reviewOpened(2, "R_1", HEAD_A),
      {
        seq: 3,
        ts: t,
        actor: localActor,
        kind: "comment.linked",
        commentId: "c-1",
        external: { github: { commentId: 999 } }, // no pending, no reviewNodeId
      },
    ]);
    expect(state.openPending!.comments).toEqual([]);
  });

  test("a comment.linked whose reviewNodeId is unknown is skipped", () => {
    const state = reduceReviewState([
      commentCreated(1, "th-1", "c-1", "docs/index.md"),
      // No review.opened event.
      commentLinkedPending(2, "c-1", "R_ghost", 999),
    ]);
    expect(state.openPending).toBeNull();
  });

  test("a correlated cancellation is terminal until a newer explicit sync request", () => {
    const requested = {
      seq: 2,
      ts: t,
      actor: localActor,
      kind: "comment.sync_requested" as const,
      commentId: "c-1",
      path: "docs/index.md",
      subjectType: "FILE" as const,
      bodyHash: REV_B,
    };
    const base: ReviewEvent[] = [
      commentCreated(1, "th-1", "c-1", "docs/index.md"),
      requested,
      { seq: 3, ts: t, actor: localActor, kind: "comment.sync_cancelled", commentId: "c-1", requestedAtSeq: 2 },
      { seq: 4, ts: t, actor: localActor, kind: "comment.sync_failed", commentId: "c-1", reason: "late-failure" },
    ];
    const cancelled = reduceReviewState(base);
    expect(cancelled.commentSync.get("c-1")).toEqual({ kind: "cancelled", requestedAtSeq: 2, cancelledAtSeq: 3 });
    expect(cancelled.unsyncedCommentIds).toEqual([]);

    const retried = reduceReviewState([
      ...base,
      { ...requested, seq: 5, bodyHash: REV_A },
    ]);
    expect(retried.commentSync.get("c-1")?.kind).toBe("pending-sync");
    expect(retried.unsyncedCommentIds).toEqual(["c-1"]);
  });

  test("isPendingReviewStale detects a head move", () => {
    expect(isPendingReviewStale(null, HEAD_A)).toBe(false);
    expect(isPendingReviewStale({ reviewNodeId: "R", headSha: HEAD_A, comments: [] }, HEAD_A)).toBe(false);
    expect(isPendingReviewStale({ reviewNodeId: "R", headSha: HEAD_A, comments: [] }, HEAD_B)).toBe(true);
    // Case-insensitive equality.
    expect(
      isPendingReviewStale({ reviewNodeId: "R", headSha: HEAD_A.toUpperCase(), comments: [] }, HEAD_A),
    ).toBe(false);
  });

  test("reduce is idempotent and order-invariant on seq", () => {
    const events: ReviewEvent[] = [
      commentCreated(1, "th-1", "c-1", "docs/index.md"),
      reviewOpened(2, "R_1", HEAD_A),
      commentLinkedPending(3, "c-1", "R_1", 999, "PRRC_1"),
    ];
    const s1 = reduceReviewState(events);
    const s2 = reduceReviewState([...events].reverse());
    expect(s2.openPending?.reviewNodeId).toBe(s1.openPending?.reviewNodeId);
    expect(s2.openPending?.comments.length).toBe(s1.openPending?.comments.length);
  });
});
