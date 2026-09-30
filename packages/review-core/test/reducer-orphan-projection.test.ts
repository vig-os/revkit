// Reducer tests for issue #46 items 3 & 4:
//   - project `external` from `comment.created` onto `Thread.external`
//   - project `orphanReason` from `comment.created` onto
//     `Thread.orphanReason` when the anchor is unanchored (forced-
//     orphan path; matches PR #45's field name)
//   - allow `orphaned → resolved`, and reopen restores the pre-resolve
//     status via `Thread.resumeStatus` (open stays open; orphaned
//     comes back orphaned)
//
// Every test in this file was designed to be RED on the round-5 code
// at be636d61 (before this branch), because:
//   - the reducer did not read `event.external` on `comment.created`
//     (Thread had no `external` field yet)
//   - the reducer did not read `event.orphanReason` on `comment.created`
//     (Thread had no `orphanReason` field yet)
//   - the validator refused `orphaned → resolved` (round-5 only
//     allowed `open → resolved`)

import { describe, expect, test } from "bun:test";
import {
  emptyLogState,
  reduce,
  reviewEventSchema,
  validateNext,
  type AnyAnchor,
  type ReviewEvent,
} from "../src/index.ts";

const LINE_ANCHOR = {
  path: "docs/x.mdx",
  startLine: 3,
  endLine: 3,
  quote: { exact: "target", prefix: "", suffix: "" },
  revision: "0".repeat(64),
} as const;

const UNANCHORED: AnyAnchor = {
  kind: "unanchored",
  path: "docs/x.mdx",
  originalStartLine: 42,
  originalEndLine: 42,
};

function stamp(events: readonly Record<string, unknown>[]): readonly ReviewEvent[] {
  return events.map((ev, i) =>
    reviewEventSchema.parse({
      ...ev,
      seq: i + 1,
      ts: `2026-09-30T00:00:${String(i).padStart(2, "0")}.000Z`,
    }),
  );
}

describe("reducer: item 3 — project `external` onto Thread", () => {
  test("comment.created.external is copied onto Thread.external", () => {
    const events = stamp([
      {
        kind: "comment.created",
        actor: { kind: "gh-user", id: "alice" },
        threadId: "T1",
        commentId: "C1",
        anchor: LINE_ANCHOR,
        body: "hi",
        external: {
          provider: "github",
          threadId: "PRRT_x",
          resolved: false,
        },
      },
    ]);
    const thread = reduce(events).get("T1");
    expect(thread?.external).toEqual({
      provider: "github",
      threadId: "PRRT_x",
      resolved: false,
    });
  });

  test("Thread.external persists across replies", () => {
    const events = stamp([
      {
        kind: "comment.created",
        actor: { kind: "gh-user", id: "alice" },
        threadId: "T1",
        commentId: "C1",
        anchor: LINE_ANCHOR,
        body: "hi",
        external: { provider: "github", threadId: "PRRT_x", resolved: true, resolvedByLogin: "carol" },
      },
      {
        kind: "comment.replied",
        actor: { kind: "gh-user", id: "bob" },
        threadId: "T1",
        commentId: "C2",
        parentId: "C1",
        body: "reply",
      },
    ]);
    const thread = reduce(events).get("T1");
    expect(thread?.external?.resolvedByLogin).toBe("carol");
  });
});

describe("reducer: item 3 — project `orphanReason` from comment.created for forced orphans", () => {
  test("unanchored anchor + orphanReason on comment.created → Thread.orphanReason set", () => {
    const events = stamp([
      {
        kind: "comment.created",
        actor: { kind: "gh-user", id: "alice" },
        threadId: "T1",
        commentId: "C1",
        anchor: UNANCHORED,
        body: "imported",
        orphanReason: "diffhunk-mismatch",
      },
    ]);
    const thread = reduce(events).get("T1");
    expect(thread?.status).toBe("orphaned");
    expect(thread?.orphanReason).toBe("diffhunk-mismatch");
  });

  test("line-anchored comment.created ignores orphanReason (only unanchored uses it)", () => {
    const events = stamp([
      {
        kind: "comment.created",
        actor: { kind: "gh-user", id: "alice" },
        threadId: "T1",
        commentId: "C1",
        anchor: LINE_ANCHOR,
        body: "hi",
        // Meaningless on a line-anchored thread — the thread reaches
        // `orphaned` via a subsequent `thread.orphaned` whose own
        // `reason` field is the correct source.
        orphanReason: "wrong-source",
      },
    ]);
    const thread = reduce(events).get("T1");
    expect(thread?.status).toBe("open");
    expect(thread?.orphanReason).toBeUndefined();
  });
});

describe("reducer: item 4 — orphaned → resolved, and reopen restores previous status", () => {
  test("a human resolves an orphaned thread: status: resolved; resumeStatus: orphaned", () => {
    const events = stamp([
      {
        kind: "comment.created",
        actor: { kind: "gh-user", id: "alice" },
        threadId: "T1",
        commentId: "C1",
        anchor: UNANCHORED,
        body: "imported",
      },
      {
        kind: "thread.resolved",
        actor: { kind: "gh-user", id: "human" },
        threadId: "T1",
        resolution: "not applicable",
      },
    ]);
    const thread = reduce(events).get("T1");
    expect(thread?.status).toBe("resolved");
    expect(thread?.resumeStatus).toBe("orphaned");
  });

  test("reopen from resolved-was-orphaned goes back to orphaned (issue #46 item 4)", () => {
    const events = stamp([
      {
        kind: "comment.created",
        actor: { kind: "gh-user", id: "alice" },
        threadId: "T1",
        commentId: "C1",
        anchor: UNANCHORED,
        body: "imported",
      },
      {
        kind: "thread.resolved",
        actor: { kind: "gh-user", id: "human" },
        threadId: "T1",
        resolution: "not applicable",
      },
      {
        kind: "thread.reopened",
        actor: { kind: "gh-user", id: "human" },
        threadId: "T1",
      },
    ]);
    const thread = reduce(events).get("T1");
    expect(thread?.status).toBe("orphaned");
    expect(thread?.resumeStatus).toBeUndefined();
  });

  test("reopen from resolved-was-open goes back to open (existing behaviour preserved)", () => {
    const events = stamp([
      {
        kind: "comment.created",
        actor: { kind: "gh-user", id: "alice" },
        threadId: "T1",
        commentId: "C1",
        anchor: LINE_ANCHOR,
        body: "hi",
      },
      {
        kind: "thread.resolved",
        actor: { kind: "gh-user", id: "alice" },
        threadId: "T1",
        resolution: "done",
      },
      {
        kind: "thread.reopened",
        actor: { kind: "gh-user", id: "alice" },
        threadId: "T1",
      },
    ]);
    const thread = reduce(events).get("T1");
    expect(thread?.status).toBe("open");
  });

  test("validator agrees: orphaned → resolved is accepted; reopen returns to orphaned", () => {
    const state = emptyLogState();
    const events = stamp([
      {
        kind: "comment.created",
        actor: { kind: "gh-user", id: "alice" },
        threadId: "T1",
        commentId: "C1",
        anchor: UNANCHORED,
        body: "imported",
      },
      {
        kind: "thread.resolved",
        actor: { kind: "gh-user", id: "human" },
        threadId: "T1",
        resolution: "wontfix",
      },
    ]);
    for (const ev of events) validateNext(state, ev);
    expect(state.threads.get("T1")?.status).toBe("resolved");
    expect(state.threads.get("T1")?.resumeStatus).toBe("orphaned");
    const reopen = reviewEventSchema.parse({
      seq: 3,
      ts: "2026-09-30T00:00:02.000Z",
      kind: "thread.reopened",
      actor: { kind: "gh-user", id: "human" },
      threadId: "T1",
    });
    const result = validateNext(state, reopen);
    expect(result.ok).toBe(true);
    expect(state.threads.get("T1")?.status).toBe("orphaned");
    expect(state.threads.get("T1")?.resumeStatus).toBeUndefined();
  });

  test("thread.reanchored on a RESOLVED thread updates resumeStatus to 'open' (PR #47 round-1 nit)", () => {
    // Reviewer's probe: orphaned → resolved → reanchored → reopened
    // should end `open` (the reanchor brought the block back). On
    // 3edec7d8 the reanchor's status logic only fired on
    // `status === "orphaned"`, so a reanchor on a resolved-was-
    // orphaned thread left `resumeStatus = "orphaned"` untouched
    // and the reopen returned to `orphaned` with a fresh anchor
    // and no reason — a nonsense state.
    const NEW_LINE_ANCHOR = {
      path: "docs/x.mdx",
      startLine: 7,
      endLine: 7,
      quote: { exact: "moved target", prefix: "", suffix: "" },
      revision: "1".repeat(64),
    } as const;
    const events = stamp([
      // 1. Import unanchored (starts orphaned).
      {
        kind: "comment.created",
        actor: { kind: "gh-user", id: "alice" },
        threadId: "T1",
        commentId: "C1",
        anchor: UNANCHORED,
        body: "imported",
        orphanReason: "diffhunk-mismatch",
      },
      // 2. Human resolves the orphaned thread.
      {
        kind: "thread.resolved",
        actor: { kind: "gh-user", id: "human" },
        threadId: "T1",
        resolution: "not applicable",
      },
      // 3. Pipeline re-anchors — the block came back. The
      //    resumeStatus should flip to `open`, and the stale
      //    `orphanReason` should be dropped.
      {
        kind: "thread.reanchored",
        actor: { kind: "agent", id: "reanchor" },
        threadId: "T1",
        anchor: NEW_LINE_ANCHOR,
        method: "quote-exact",
      },
      // 4. Reopen — must land on `open`, not `orphaned`.
      {
        kind: "thread.reopened",
        actor: { kind: "gh-user", id: "human" },
        threadId: "T1",
      },
    ]);
    const thread = reduce(events).get("T1");
    expect(thread?.status).toBe("open");
    // Reanchor also drops the orphanReason (the block came back).
    expect(thread?.orphanReason).toBeUndefined();
    // The new anchor from step 3.
    const anchor = thread!.anchor;
    const isUnanchored = "kind" in anchor && anchor.kind === "unanchored";
    expect(isUnanchored).toBe(false);
    if (!isUnanchored) {
      expect((anchor as typeof NEW_LINE_ANCHOR).startLine).toBe(7);
    }
  });

  test("validator agrees: reanchor on resolved-was-orphaned updates resumeStatus to 'open'", () => {
    const state = emptyLogState();
    const NEW_LINE_ANCHOR = {
      path: "docs/x.mdx",
      startLine: 7,
      endLine: 7,
      quote: { exact: "moved target", prefix: "", suffix: "" },
      revision: "1".repeat(64),
    } as const;
    const events = stamp([
      {
        kind: "comment.created",
        actor: { kind: "gh-user", id: "alice" },
        threadId: "T1",
        commentId: "C1",
        anchor: UNANCHORED,
        body: "imported",
      },
      {
        kind: "thread.resolved",
        actor: { kind: "gh-user", id: "human" },
        threadId: "T1",
        resolution: "wontfix",
      },
      {
        kind: "thread.reanchored",
        actor: { kind: "agent", id: "reanchor" },
        threadId: "T1",
        anchor: NEW_LINE_ANCHOR,
        method: "quote-exact",
      },
    ]);
    for (const ev of events) validateNext(state, ev);
    // The thread stays `resolved` — the reanchor respects the
    // human's terminal decision — but its resumeStatus is now `open`.
    expect(state.threads.get("T1")?.status).toBe("resolved");
    expect(state.threads.get("T1")?.resumeStatus).toBe("open");
    // Reopen from `resolved` restores `open`, not `orphaned`.
    const reopen = reviewEventSchema.parse({
      seq: 4,
      ts: "2026-09-30T00:00:03.000Z",
      kind: "thread.reopened",
      actor: { kind: "gh-user", id: "human" },
      threadId: "T1",
    });
    const result = validateNext(state, reopen);
    expect(result.ok).toBe(true);
    expect(state.threads.get("T1")?.status).toBe("open");
  });
});
