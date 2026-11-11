import { describe, expect, test } from "bun:test";
import { reduceReviewState, reviewEventSchema, validateNext, emptyLogState, type ReviewEvent } from "../src/index.ts";

const actor = { kind: "local", id: "reviewer" } as const;
const envelope = { ts: "2026-10-08T00:00:00Z", actor };
const created: ReviewEvent = { ...envelope, seq: 1, kind: "comment.created", threadId: "th-1", commentId: "c-1", body: "thread",
  anchor: { path: "docs/index.md", startLine: 1, endLine: 1, quote: { exact: "text", prefix: "", suffix: "" }, revision: "a".repeat(64) } };
const opened: ReviewEvent = { ...envelope, seq: 2, kind: "review.opened", reviewNodeId: "PRR_A", headSha: "b".repeat(40) };
const resolved: ReviewEvent = { ...envelope, actor: { kind: "agent", id: "agent" }, seq: 3, kind: "thread.resolved", threadId: "th-1" };
const promoted: ReviewEvent = { ...envelope, seq: 4, kind: "draft.promoted", threadId: "th-1", target: "resolve", reviewNodeId: "PRR_A" };
const failure: ReviewEvent = { ...envelope, seq: 5, kind: "thread.sync_failed", threadId: "th-1", intentSeq: 4, reason: "promotion-review-not-pending" };

describe("#155 lifecycle refusal events", () => {
  test("typed lifecycle failures parse, reject unknown reasons and require a known thread", () => {
    expect(reviewEventSchema.safeParse(failure).success).toBe(true);
    expect(reviewEventSchema.safeParse({ ...failure, reason: "anything" }).success).toBe(false);
    expect(reviewEventSchema.safeParse({ ...failure, intentSeq: undefined }).success).toBe(false);
    const state = emptyLogState();
    expect(validateNext(state, failure)).toMatchObject({ ok: false, rejection: { kind: "unknown-thread" } });
    expect(validateNext(state, created).ok).toBe(true);
    expect(validateNext(state, failure).ok).toBe(true);
  });

  test("failure projection follows the current intent and clears on completion, fresh promotion or supersession", () => {
    const events = [created, opened, resolved, promoted, failure];
    const expected = [{ threadId: "th-1", target: "resolve", path: "docs/index.md", intentSeq: 4, reason: "promotion-review-not-pending" }] as const;
    expect(reduceReviewState(events).lifecycleFailures).toEqual(expected);
    expect(reduceReviewState([...events, { ...failure, seq: 6, intentSeq: 3 }]).lifecycleFailures).toEqual(expected);
    expect(reduceReviewState([...events, { ...envelope, seq: 6, kind: "thread.external_synced", threadId: "th-1", intentSeq: 4, resolved: true }]).lifecycleFailures).toEqual([]);
    expect(reduceReviewState([...events, { ...promoted, seq: 6 }]).lifecycleFailures).toEqual([]);
    expect(reduceReviewState([...events, { ...envelope, seq: 6, kind: "thread.reopened", threadId: "th-1" }]).lifecycleFailures).toEqual([]);
  });
});


describe("#155 R1 — sync outcome actor restrictions", () => {
  const outcomes: ReviewEvent[] = [failure,
    { ...envelope, seq: 5, kind: "comment.sync_failed", commentId: "c-1", reason: "promotion-review-unbound" },
    { ...envelope, seq: 5, kind: "thread.external_synced", threadId: "th-1", resolved: true, intentSeq: 3 },
  ];
  for (const outcome of outcomes) {
    test(`${outcome.kind} refuses agent outcomes and retains legitimate writers`, () => {
      const state = emptyLogState();
      expect(validateNext(state, created).ok).toBe(true);
      for (const actorKind of ["agent", "system", "gh-user"] as const) {
        if (outcome.kind === "thread.external_synced" && actorKind === "gh-user") continue;
        const actor = { kind: actorKind, id: "untrusted" };
        expect(validateNext(state, { ...outcome, actor })).toMatchObject({ ok: false, rejection: { kind: "invalid-actor", actor } });
      }
      expect(validateNext(state, outcome).ok).toBe(true);
      // The GitHub import path records external observations under gh-user.
      if (outcome.kind === "thread.external_synced") {
        expect(validateNext(state, { ...outcome, actor: { kind: "gh-user", id: "github" } }).ok).toBe(true);
      }
    });
  }
});
