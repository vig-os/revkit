// Tests for the unanchored-anchor kind (PR-43 round-5 nit): proper
// state for "imported thread whose source content we couldn't
// fetch", not a sentinel-string revision.
//
// Coverage:
//   - schema accepts a valid unanchored anchor
//   - schema refuses `quote` / `revision` / `startLine` / `endLine`
//   - `isLineAnchor` / `isUnanchoredAnchor` type guards
//   - reducer parks an unanchored-anchor thread in `orphaned` from birth
//   - validator does the same on the state-machine side
//   - a subsequent `thread.orphaned` is refused (already orphaned)
//   - a subsequent `thread.resolved` is refused (not open)

import { describe, expect, test } from "bun:test";
import {
  anyAnchorSchema,
  emptyLogState,
  isLineAnchor,
  isUnanchoredAnchor,
  reduce,
  reviewEventSchema,
  unanchoredAnchorSchema,
  validateNext,
  type AnyAnchor,
  type ReviewEvent,
} from "../src/index.ts";

const UNANCHORED: AnyAnchor = {
  kind: "unanchored",
  path: "docs/x.mdx",
  originalStartLine: 40,
  originalEndLine: 40,
};

describe("unanchoredAnchorSchema", () => {
  test("accepts a valid unanchored anchor", () => {
    const parsed = unanchoredAnchorSchema.parse(UNANCHORED);
    expect(parsed.kind).toBe("unanchored");
    expect(parsed.path).toBe("docs/x.mdx");
    expect(parsed.originalStartLine).toBe(40);
  });

  test("refuses extra fields (`quote`, `revision`, `startLine`, `endLine`)", () => {
    for (const stray of [
      { ...UNANCHORED, quote: { exact: "x", prefix: "", suffix: "" } },
      { ...UNANCHORED, revision: "0".repeat(64) },
      { ...UNANCHORED, startLine: 40 },
      { ...UNANCHORED, endLine: 40 },
    ]) {
      expect(() => unanchoredAnchorSchema.parse(stray)).toThrow();
    }
  });

  test("`originalEndLine` must be >= `originalStartLine` when both set", () => {
    expect(() =>
      unanchoredAnchorSchema.parse({ ...UNANCHORED, originalStartLine: 10, originalEndLine: 5 }),
    ).toThrow();
    // Only start OR only end is fine.
    expect(() =>
      unanchoredAnchorSchema.parse({ kind: "unanchored", path: "a.mdx", originalStartLine: 3 }),
    ).not.toThrow();
    expect(() =>
      unanchoredAnchorSchema.parse({ kind: "unanchored", path: "a.mdx", originalEndLine: 3 }),
    ).not.toThrow();
  });

  test("anyAnchorSchema accepts both variants", () => {
    // Unanchored.
    expect(() => anyAnchorSchema.parse(UNANCHORED)).not.toThrow();
    // Line anchor (no `kind` field).
    expect(() =>
      anyAnchorSchema.parse({
        path: "a.mdx",
        startLine: 1,
        endLine: 1,
        quote: { exact: "hi", prefix: "", suffix: "" },
        revision: "0".repeat(64),
      }),
    ).not.toThrow();
  });
});

describe("type guards", () => {
  test("`isLineAnchor` returns true for anchors without `kind`", () => {
    const line = {
      path: "a.mdx",
      startLine: 1,
      endLine: 1,
      quote: { exact: "hi", prefix: "", suffix: "" },
      revision: "0".repeat(64),
    } as const;
    expect(isLineAnchor(line)).toBe(true);
    expect(isUnanchoredAnchor(line)).toBe(false);
  });

  test("`isUnanchoredAnchor` returns true for kind: 'unanchored'", () => {
    expect(isUnanchoredAnchor(UNANCHORED)).toBe(true);
    expect(isLineAnchor(UNANCHORED)).toBe(false);
  });
});

describe("reducer: unanchored anchor → thread starts orphaned", () => {
  test("comment.created with unanchored anchor puts the thread in `orphaned`", () => {
    const events: readonly ReviewEvent[] = [
      reviewEventSchema.parse({
        seq: 1,
        ts: "2026-09-30T00:00:00.000Z",
        kind: "comment.created",
        actor: { kind: "gh-user", id: "alice" },
        threadId: "T1",
        commentId: "C1",
        anchor: UNANCHORED,
        body: "imported",
        external: { provider: "github", threadId: "PRRT_x", resolved: true, resolvedByLogin: "carol" },
      }),
    ];
    const threads = reduce(events);
    const t = threads.get("T1");
    expect(t?.status).toBe("orphaned");
    expect(t?.anchor).toEqual(UNANCHORED);
  });

  test("validator agrees: comment.created with unanchored anchor sets `orphaned` state", () => {
    const state = emptyLogState();
    const event = reviewEventSchema.parse({
      seq: 1,
      ts: "2026-09-30T00:00:00.000Z",
      kind: "comment.created",
      actor: { kind: "gh-user", id: "alice" },
      threadId: "T1",
      commentId: "C1",
      anchor: UNANCHORED,
      body: "b",
    });
    const result = validateNext(state, event);
    expect(result.ok).toBe(true);
    expect(state.threads.get("T1")?.status).toBe("orphaned");
  });

  test("a subsequent thread.orphaned is refused (already orphaned)", () => {
    const state = emptyLogState();
    const evs = [
      {
        seq: 1,
        ts: "2026-09-30T00:00:00.000Z",
        kind: "comment.created" as const,
        actor: { kind: "gh-user" as const, id: "alice" },
        threadId: "T1",
        commentId: "C1",
        anchor: UNANCHORED,
        body: "b",
      },
      {
        seq: 2,
        ts: "2026-09-30T00:00:01.000Z",
        kind: "thread.orphaned" as const,
        actor: { kind: "gh-user" as const, id: "alice" },
        threadId: "T1",
        revision: "0".repeat(64),
        reason: "redundant",
      },
    ];
    const first = validateNext(state, reviewEventSchema.parse(evs[0]));
    expect(first.ok).toBe(true);
    const second = validateNext(state, reviewEventSchema.parse(evs[1]));
    expect(second.ok).toBe(false);
  });

  test("a subsequent thread.resolved is refused (not open)", () => {
    const state = emptyLogState();
    validateNext(
      state,
      reviewEventSchema.parse({
        seq: 1,
        ts: "2026-09-30T00:00:00.000Z",
        kind: "comment.created",
        actor: { kind: "gh-user", id: "alice" },
        threadId: "T1",
        commentId: "C1",
        anchor: UNANCHORED,
        body: "b",
      }),
    );
    const res = validateNext(
      state,
      reviewEventSchema.parse({
        seq: 2,
        ts: "2026-09-30T00:00:01.000Z",
        kind: "thread.resolved",
        actor: { kind: "gh-user", id: "alice" },
        threadId: "T1",
        resolution: "late",
      }),
    );
    expect(res.ok).toBe(false);
  });
});

describe("thread.orphaned event carries structured external metadata", () => {
  test("external field validates the { provider, threadId, resolved, resolvedByLogin? } shape", () => {
    // Positive case.
    expect(() =>
      reviewEventSchema.parse({
        seq: 1,
        ts: "2026-09-30T00:00:00.000Z",
        kind: "thread.orphaned",
        actor: { kind: "gh-user", id: "alice" },
        threadId: "T1",
        revision: "0".repeat(64),
        external: { provider: "github", threadId: "PRRT_x", resolved: true, resolvedByLogin: "carol" },
      }),
    ).not.toThrow();
    // Refuses a bad provider.
    expect(() =>
      reviewEventSchema.parse({
        seq: 1,
        ts: "2026-09-30T00:00:00.000Z",
        kind: "thread.orphaned",
        actor: { kind: "gh-user", id: "alice" },
        threadId: "T1",
        revision: "0".repeat(64),
        external: { provider: "gitlab", threadId: "PRRT_x", resolved: true },
      }),
    ).toThrow();
  });
});
