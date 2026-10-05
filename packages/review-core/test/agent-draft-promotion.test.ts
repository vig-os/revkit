// The promotion intent `draft.promoted` (issue #70, option B).
//
// An agent-authored reply / resolve / reopen stays a LOCAL draft until a
// reviewer explicitly promotes it into the pending GitHub review. Three
// layers are asserted here, because each one is a separate promise.
//
//   1. the WIRE SHAPE — a comment promotion names its comment; a
//      resolve or reopen promotion must not.
//   2. the TRUST RULE — only a local actor may record a promotion, and
//      only of an AGENT-authored draft. An agent bearer can author a
//      draft but can never, by any path, record that it was promoted.
//   3. the DERIVED VIEW — the reduced state's draft list names the
//      unpromoted drafts, and a promotion removes the entry.

import { describe, expect, test } from "bun:test";
import {
  emptyLogState,
  reduceReviewState,
  reviewEventSchema,
  validateNext,
  type LogState,
  type ReviewEvent,
} from "../src/index.ts";

const t = "2026-10-05T12:00:00Z";
const localActor = { kind: "local" as const, id: "u-1" };
const agentActor = { kind: "agent" as const, id: "revkit-claude" };
const HEAD_A = "a".repeat(40);
const REV_A = "c".repeat(64);

const COMMENT_ANCHOR = {
  path: "docs/index.md",
  startLine: 1,
  endLine: 1,
  quote: { exact: "hi", prefix: "", suffix: "" },
  revision: REV_A,
} as const;

function commentCreated(
  seq: number,
  threadId: string,
  commentId: string,
  actor: ReviewEvent["actor"],
  body: string,
): ReviewEvent {
  return { seq, ts: t, actor, kind: "comment.created", threadId, commentId, anchor: COMMENT_ANCHOR, body };
}

const agentComment = (seq: number, threadId: string, commentId: string): ReviewEvent =>
  commentCreated(seq, threadId, commentId, agentActor, "agent draft");

const localComment = (seq: number, threadId: string, commentId: string): ReviewEvent =>
  commentCreated(seq, threadId, commentId, localActor, "reviewer comment");

type DraftPromoted = Extract<ReviewEvent, { kind: "draft.promoted" }>;

function promoted(
  seq: number,
  event: Omit<DraftPromoted, "seq" | "ts" | "actor" | "kind">,
  actorOverride?: ReviewEvent["actor"],
): ReviewEvent {
  return { seq, ts: t, actor: actorOverride ?? localActor, kind: "draft.promoted", ...event };
}

function withValidated(events: readonly ReviewEvent[]): LogState {
  const state = emptyLogState();
  for (const event of events) {
    const result = validateNext(state, event);
    if (!result.ok) throw new Error(`unexpected reject for ${event.kind}: ${result.rejection.kind}`);
  }
  return state;
}

describe("draft.promoted — wire shape", () => {
  test("a comment promotion carries a commentId; a resolve promotion must not", () => {
    const base = { seq: 2, ts: t, actor: localActor, kind: "draft.promoted", threadId: "th-1" } as const;
    expect(reviewEventSchema.safeParse({ ...base, target: "comment", commentId: "c-1" }).success).toBe(true);
    expect(reviewEventSchema.safeParse({ ...base, target: "resolve" }).success).toBe(true);
    expect(reviewEventSchema.safeParse({ ...base, target: "resolve", commentId: "c-1" }).success).toBe(false);
    expect(reviewEventSchema.safeParse({ ...base, target: "comment" }).success).toBe(false);
  });
});

describe("draft.promoted — the trust rule lives in the log, not only in the route", () => {
  test("an agent actor cannot record a promotion (invalid-actor)", () => {
    const state = withValidated([agentComment(1, "th-1", "c-1")]);
    const result = validateNext(state, promoted(2, { threadId: "th-1", target: "comment", commentId: "c-1" }, agentActor));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.kind).toBe("invalid-actor");
  });

  test("a reviewer's own comment is not a draft to promote (not-an-agent-draft)", () => {
    const state = withValidated([localComment(1, "th-1", "c-1")]);
    const result = validateNext(state, promoted(2, { threadId: "th-1", target: "comment", commentId: "c-1" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.kind).toBe("not-an-agent-draft");
  });

  test("an unknown thread is refused (unknown-thread)", () => {
    const state = emptyLogState();
    const result = validateNext(state, promoted(1, { threadId: "th-ghost", target: "resolve" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.kind).toBe("unknown-thread");
  });

  test("a comment promotion must name a comment in THAT thread (unknown-comment)", () => {
    const state = withValidated([agentComment(1, "th-1", "c-1"), agentComment(2, "th-2", "c-2")]);
    const result = validateNext(state, promoted(3, { threadId: "th-1", target: "comment", commentId: "c-2" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.kind).toBe("unknown-comment");
  });

  test("a reviewer promoting an agent draft is accepted", () => {
    const state = withValidated([
      agentComment(1, "th-1", "c-1"),
      promoted(2, { threadId: "th-1", target: "comment", commentId: "c-1" }),
    ]);
    expect(state.threads.has("th-1")).toBe(true);
  });
});

describe("reduceReviewState — agentDrafts", () => {
  test("an agent reply is an unpromoted draft; the reviewer comment beside it is not", () => {
    const state = reduceReviewState([
      localComment(1, "th-1", "c-local"),
      { ...agentComment(2, "th-2", "c-agent") },
      {
        seq: 3,
        ts: t,
        actor: agentActor,
        kind: "comment.replied",
        threadId: "th-2",
        commentId: "c-reply",
        parentId: "c-agent",
        body: "agent reply",
      },
    ]);
    expect(state.agentDrafts).toEqual([
      { threadId: "th-2", target: "comment", commentId: "c-agent", path: "docs/index.md" },
      { threadId: "th-2", target: "comment", commentId: "c-reply", path: "docs/index.md" },
    ]);
  });

  test("promoting a draft removes it from agentDrafts; a re-authored draft of the same thread reappears", () => {
    const state = reduceReviewState([
      agentComment(1, "th-1", "c-1"),
      promoted(2, { threadId: "th-1", target: "comment", commentId: "c-1" }),
      {
        seq: 3,
        ts: t,
        actor: agentActor,
        kind: "comment.replied",
        threadId: "th-1",
        commentId: "c-2",
        parentId: "c-1",
        body: "second agent draft",
      },
    ]);
    expect(state.agentDrafts).toEqual([
      { threadId: "th-1", target: "comment", commentId: "c-2", path: "docs/index.md" },
    ]);
  });

  test("an agent resolve / reopen is a draft; a reviewer's own resolve never is", () => {
    const resolved = reduceReviewState([
      localComment(1, "th-1", "c-1"),
      { seq: 2, ts: t, actor: agentActor, kind: "thread.resolved", threadId: "th-1" },
    ]);
    expect(resolved.agentDrafts).toEqual([{ threadId: "th-1", target: "resolve", path: "docs/index.md" }]);

    const reopened = reduceReviewState([
      localComment(1, "th-1", "c-1"),
      { seq: 2, ts: t, actor: localActor, kind: "thread.resolved", threadId: "th-1" },
      { seq: 3, ts: t, actor: agentActor, kind: "thread.reopened", threadId: "th-1" },
    ]);
    expect(reopened.agentDrafts).toEqual([{ threadId: "th-1", target: "reopen", path: "docs/index.md" }]);

    const reviewerResolve = reduceReviewState([
      localComment(1, "th-1", "c-1"),
      { seq: 2, ts: t, actor: localActor, kind: "thread.resolved", threadId: "th-1" },
    ]);
    expect(reviewerResolve.agentDrafts).toEqual([]);
  });

  test("promoting the resolve clears it; a later agent resolve on the same thread is a fresh draft", () => {
    const state = reduceReviewState([
      localComment(1, "th-1", "c-1"),
      { seq: 2, ts: t, actor: agentActor, kind: "thread.resolved", threadId: "th-1" },
      promoted(3, { threadId: "th-1", target: "resolve" }),
      { seq: 4, ts: t, actor: localActor, kind: "thread.reopened", threadId: "th-1" },
      { seq: 5, ts: t, actor: agentActor, kind: "thread.resolved", threadId: "th-1" },
    ]);
    expect(state.agentDrafts).toEqual([{ threadId: "th-1", target: "resolve", path: "docs/index.md" }]);
  });

  test("an agent comment draft and an agent resolve on the same thread are independent drafts", () => {
    const state = reduceReviewState([
      agentComment(1, "th-1", "c-1"),
      { seq: 2, ts: t, actor: agentActor, kind: "thread.resolved", threadId: "th-1" },
      promoted(3, { threadId: "th-1", target: "resolve" }),
    ]);
    expect(state.agentDrafts).toEqual([
      { threadId: "th-1", target: "comment", commentId: "c-1", path: "docs/index.md" },
    ]);
  });
});
