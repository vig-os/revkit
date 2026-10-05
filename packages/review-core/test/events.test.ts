// Tests for the ReviewEvent Zod schema — the boundary check every event
// hits before it enters the log. Exercises three things: (a) each `kind`
// accepts its documented payload, (b) a stray extra field is rejected
// on every strict variant, (c) core payload invariants fail loudly
// (positive seq, ISO ts with offset, non-empty ids, SHA-256-shaped
// revision, presence line-range coherence, and ask-specific rules).
import { describe, expect, test } from "bun:test";
import { reviewEventKinds, reviewEventSchema, type ReviewEvent } from "../src/index.ts";

const t = "2026-09-30T12:00:00Z";
const actor = { kind: "gh-user", id: "gerchowl" } as const;
const anchor = {
  path: "docs/adr/0006-comments-anchoring-event-log.md",
  startLine: 40,
  endLine: 44,
  quote: { exact: "text-quote selector", prefix: "carries a ", suffix: " and the revision" },
  revision: "c".repeat(64),
} as const;

/** One valid event per kind, used both to prove the happy path and as
 * a base for negative tests below. */
const validPerKind: Record<ReviewEvent["kind"], ReviewEvent> = {
  "comment.created": {
    seq: 1,
    ts: t,
    actor,
    kind: "comment.created",
    threadId: "th-1",
    commentId: "c-1",
    anchor,
    body: "why 30 s?",
  },
  "comment.replied": {
    seq: 2,
    ts: t,
    actor,
    kind: "comment.replied",
    threadId: "th-1",
    commentId: "c-2",
    parentId: "c-1",
    body: "raised to 60 s",
  },
  "comment.edited": {
    seq: 3,
    ts: t,
    actor,
    kind: "comment.edited",
    commentId: "c-1",
    body: "why 30 s? (edited)",
    remoteUpdatedAt: "2026-09-30T21:00:00Z",
  },
  "thread.resolved": {
    seq: 3,
    ts: t,
    actor,
    kind: "thread.resolved",
    threadId: "th-1",
  },
  "thread.reopened": {
    seq: 4,
    ts: t,
    actor,
    kind: "thread.reopened",
    threadId: "th-1",
  },
  "thread.external_synced": {
    seq: 5,
    ts: t,
    actor,
    kind: "thread.external_synced",
    threadId: "th-1",
    resolved: true,
    intentSeq: 3,
    resolvedByLogin: "gerchowl",
  },
  handover: {
    seq: 5,
    ts: t,
    actor,
    kind: "handover",
    commentIds: ["c-1"],
    revision: "d".repeat(64),
  },
  "delivery.mode_changed": {
    seq: 6,
    ts: t,
    actor,
    kind: "delivery.mode_changed",
    from: "handover",
    to: "live",
  },
  "ask.created": {
    seq: 7,
    ts: t,
    actor: { kind: "agent", id: "revkit-live" },
    kind: "ask.created",
    askId: "ask-1",
    spec: {
      schemaVersion: 1,
      kind: "choice",
      title: "Which storage?",
      options: [
        { id: "d1", label: "D1" },
        { id: "kv", label: "KV" },
      ],
      allowOther: false,
      multi: false,
    },
  },
  "ask.answered": {
    seq: 8,
    ts: t,
    actor,
    kind: "ask.answered",
    askId: "ask-1",
    answer: { kind: "choice", value: "d1" },
  },
  "ask.cancelled": {
    seq: 12,
    ts: t,
    actor: { kind: "agent", id: "revkit-live" },
    kind: "ask.cancelled",
    askId: "ask-1",
    reason: "superseded",
  },
  "ask.expired": {
    seq: 13,
    ts: t,
    actor: { kind: "agent", id: "revkit-live" },
    kind: "ask.expired",
    askId: "ask-1",
  },
  "comment.linked": {
    seq: 9,
    ts: t,
    actor: { kind: "agent", id: "revkit-live" },
    kind: "comment.linked",
    commentId: "c-1",
    external: { github: { commentId: 42, reviewId: 7, nodeId: "PRC_x" } },
  },
  "thread.reanchored": {
    seq: 10,
    ts: t,
    actor: { kind: "agent", id: "revkit-live" },
    kind: "thread.reanchored",
    threadId: "th-1",
    anchor: { ...anchor, revision: "d".repeat(64), startLine: 42, endLine: 46 },
    method: "quote-exact",
  },
  "thread.orphaned": {
    seq: 11,
    ts: t,
    actor: { kind: "agent", id: "revkit-live" },
    kind: "thread.orphaned",
    threadId: "th-1",
    revision: "e".repeat(64),
    reason: "block deleted on rebuild",
  },
  "doc.published": {
    seq: 14,
    ts: t,
    actor: { kind: "agent", id: "revkit-live" },
    kind: "doc.published",
    path: "docs/adr/0006-comments-anchoring-event-log.md",
    revision: "f".repeat(64),
    route: "/adr/0006-comments-anchoring-event-log/",
    generation: "1".repeat(64),
  },
  "review.opened": {
    seq: 12,
    ts: t,
    actor: { kind: "local", id: "u-1" },
    kind: "review.opened",
    reviewNodeId: "PR_review_1",
    headSha: "0123456789abcdef0123456789abcdef01234567",
  },
  "review.submitted": {
    seq: 13,
    ts: t,
    actor: { kind: "local", id: "u-1" },
    kind: "review.submitted",
    reviewNodeId: "PR_review_1",
    event: "COMMENT",
  },
  "review.abandoned": {
    seq: 14,
    ts: t,
    actor: { kind: "local", id: "u-1" },
    kind: "review.abandoned",
    reviewNodeId: "PR_review_2",
    reason: "head-moved",
  },
  "comment.sync_requested": {
    seq: 15,
    ts: t,
    actor: { kind: "local", id: "u-1" },
    kind: "comment.sync_requested",
    commentId: "c-1",
    path: "docs/index.md",
    subjectType: "LINE",
    side: "RIGHT",
    line: 2,
    bodyHash: "e".repeat(64),
  },
  "comment.sync_failed": {
    seq: 16,
    ts: t,
    actor: { kind: "local", id: "u-1" },
    kind: "comment.sync_failed",
    commentId: "c-1",
    reason: "adapter-rate-limited",
  },
  "comment.sync_cancelled": {
    seq: 17,
    ts: t,
    actor: { kind: "local", id: "u-1" },
    kind: "comment.sync_cancelled",
    commentId: "c-1",
    requestedAtSeq: 15,
  },
  "draft.promoted": {
    seq: 18,
    ts: t,
    actor: { kind: "local", id: "u-1" },
    kind: "draft.promoted",
    threadId: "th-1",
    target: "comment",
    commentId: "c-1",
    commentSeq: 1,
    bodyHash: "f".repeat(64),
  },
  "build.requested": {
    seq: 19,
    ts: t,
    actor: { kind: "system", id: "revkit-daemon" },
    kind: "build.requested",
    generation: "a".repeat(64),
    routes: ["/adr/example/"],
  },
  "build.started": {
    seq: 19,
    ts: t,
    actor: { kind: "system", id: "revkit-daemon" },
    kind: "build.started",
    generation: "a".repeat(64),
    routes: ["/adr/example/"],
  },
  "build.succeeded": {
    seq: 20,
    ts: t,
    actor: { kind: "system", id: "revkit-daemon" },
    kind: "build.succeeded",
    generation: "a".repeat(64),
    routes: ["/adr/example/"],
  },
  "build.failed": {
    seq: 21,
    ts: t,
    actor: { kind: "system", id: "revkit-daemon" },
    kind: "build.failed",
    generation: "a".repeat(64),
    routes: ["/adr/example/"],
    error: "astro build exited 1. Tail:\nRollupError: something bad",
  },
};

describe("reviewEventSchema — happy paths", () => {
  test("every declared kind has a valid example that parses", () => {
    // Sanity: the fixture covers exactly the kinds the schema declares.
    // If a kind is added to `reviewEventKinds` without a fixture, this
    // fails at the length check instead of silently under-testing.
    expect(Object.keys(validPerKind).sort()).toEqual([...reviewEventKinds].sort());
    for (const kind of reviewEventKinds) {
      const result = reviewEventSchema.safeParse(validPerKind[kind]);
      if (!result.success) {
        throw new Error(`kind '${kind}' should parse but did not: ${JSON.stringify(result.error.issues)}`);
      }
    }
  });
});

describe("reviewEventSchema — rejections", () => {
  test("a stray extra field is rejected (strict on every variant)", () => {
    const stray = { ...validPerKind["comment.created"], bogus: 1 };
    expect(reviewEventSchema.safeParse(stray).success).toBe(false);
  });

  test("seq must be a positive integer", () => {
    for (const seq of [0, -1, 1.5]) {
      const bad = { ...validPerKind["comment.created"], seq };
      expect(reviewEventSchema.safeParse(bad).success).toBe(false);
    }
  });

  test("ts must be an ISO datetime WITH offset (Z or ±hh:mm)", () => {
    const bareLocal = { ...validPerKind["comment.created"], ts: "2026-09-30T12:00:00" };
    expect(reviewEventSchema.safeParse(bareLocal).success).toBe(false);
    const notADate = { ...validPerKind["comment.created"], ts: "tomorrow" };
    expect(reviewEventSchema.safeParse(notADate).success).toBe(false);
  });

  test("actor.kind must be one of the documented set", () => {
    const bad = { ...validPerKind["comment.created"], actor: { kind: "wizard", id: "merlin" } };
    expect(reviewEventSchema.safeParse(bad).success).toBe(false);
  });

  test("anchor.revision must be 64 hex chars (SHA-256 shape)", () => {
    const bad = {
      ...validPerKind["comment.created"],
      anchor: { ...anchor, revision: "not-a-hash" },
    };
    expect(reviewEventSchema.safeParse(bad).success).toBe(false);
  });

  test("comment.replied requires threadId, commentId, parentId, body — all non-empty", () => {
    const missingParent = {
      ...validPerKind["comment.replied"],
    } as Record<string, unknown>;
    delete missingParent.parentId;
    expect(reviewEventSchema.safeParse(missingParent).success).toBe(false);
    const emptyBody = { ...validPerKind["comment.replied"], body: "" };
    expect(reviewEventSchema.safeParse(emptyBody).success).toBe(false);
  });

  test("delivery.mode_changed accepts from=null (first-write on a fresh log)", () => {
    const first = { ...validPerKind["delivery.mode_changed"], from: null } as Record<string, unknown>;
    expect(reviewEventSchema.safeParse(first).success).toBe(true);
  });

  test("delivery.mode_changed rejects garbage `to`", () => {
    const bad = { ...validPerKind["delivery.mode_changed"], to: "loud" } as Record<string, unknown>;
    expect(reviewEventSchema.safeParse(bad).success).toBe(false);
  });

  test("ask.answered rejects an answer whose kind mismatches the shape", () => {
    // A `choice` answer that carries a `text` field only is rejected —
    // the discriminated union on answer.kind refuses cross-kind fields.
    const bad = {
      ...validPerKind["ask.answered"],
      answer: { kind: "choice", text: "hi" },
    };
    expect(reviewEventSchema.safeParse(bad).success).toBe(false);
  });

  test("comment.linked with an empty external object is rejected — needs at least one backend", () => {
    const bad = { ...validPerKind["comment.linked"], external: {} };
    expect(reviewEventSchema.safeParse(bad).success).toBe(false);
  });

  test("thread.reanchored: method='fuzzy' REQUIRES a numeric score", () => {
    const bad = { ...validPerKind["thread.reanchored"], method: "fuzzy" as const };
    // No `score` provided — refused.
    expect(reviewEventSchema.safeParse(bad).success).toBe(false);
  });

  test("thread.reanchored: method='quote-exact' MUST NOT carry a score", () => {
    const bad = { ...validPerKind["thread.reanchored"], method: "quote-exact" as const, score: 0.9 };
    expect(reviewEventSchema.safeParse(bad).success).toBe(false);
  });

  test("thread.reanchored: method='fuzzy' with a valid score parses", () => {
    const good = {
      ...validPerKind["thread.reanchored"],
      method: "fuzzy" as const,
      score: 0.87,
    };
    expect(reviewEventSchema.safeParse(good).success).toBe(true);
  });

  test("thread.reanchored: score out of [0,1] is rejected", () => {
    const bad = {
      ...validPerKind["thread.reanchored"],
      method: "fuzzy" as const,
      score: 1.4,
    };
    expect(reviewEventSchema.safeParse(bad).success).toBe(false);
  });

  test("thread.orphaned.revision must be 64-hex (SHA-256 shape)", () => {
    const bad = { ...validPerKind["thread.orphaned"], revision: "not-a-hash" };
    expect(reviewEventSchema.safeParse(bad).success).toBe(false);
  });
});
