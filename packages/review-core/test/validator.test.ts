// Focused tests for `validateNext` — the single source of truth for the
// log's transition rules, called by both `store.append` and
// `parseArchive`. The store and archive tests exercise it end-to-end
// through their respective boundaries; this file pins the small
// contract directly so a regression that only trips on one path (say,
// import) still fails a targeted test.
import { describe, expect, test } from "bun:test";
import { emptyLogState, validateNext, type ReviewEvent } from "../src/index.ts";

const anchor = {
  path: "docs/adr/0006-comments-anchoring-event-log.md",
  startLine: 1,
  endLine: 1,
  quote: { exact: "x", prefix: "", suffix: "" },
  revision: "0".repeat(64),
} as const;

const actor = { kind: "gh-user", id: "gerchowl" } as const;
const t = "2026-09-30T12:00:00Z";

function created(threadId: string, commentId: string, seq: number): ReviewEvent {
  return { seq, ts: t, actor, kind: "comment.created", threadId, commentId, anchor, body: "hi" };
}

describe("validateNext — happy path", () => {
  test("mutates state on success and returns ok=true", () => {
    const state = emptyLogState();
    const result = validateNext(state, created("th-1", "c-1", 1));
    expect(result.ok).toBe(true);
    expect(state.threads.has("th-1")).toBe(true);
    expect(state.commentIndex.get("c-1")).toBe("th-1");
  });
});

describe("validateNext — leaves state untouched on rejection", () => {
  test("a rejected event does not partially mutate state (rollback-free by construction)", () => {
    const state = emptyLogState();
    validateNext(state, created("th-1", "c-1", 1));
    // Same threadId → duplicate-thread. commentId also collides.
    const before = {
      threads: [...state.threads.keys()],
      comments: [...state.commentIndex.keys()],
    };
    const result = validateNext(state, created("th-1", "c-1", 2));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.kind).toBe("duplicate-thread");
    // State unchanged.
    expect([...state.threads.keys()]).toEqual(before.threads);
    expect([...state.commentIndex.keys()]).toEqual(before.comments);
  });
});

// ---------- thread.reanchored / thread.orphaned rules ----------

function reanchored(threadId: string, seq: number): ReviewEvent {
  return {
    seq,
    ts: t,
    actor,
    kind: "thread.reanchored",
    threadId,
    anchor: { ...anchor, revision: "b".repeat(64), startLine: 42, endLine: 46 },
    method: "quote-exact",
  };
}

function orphaned(threadId: string, seq: number): ReviewEvent {
  return {
    seq,
    ts: t,
    actor,
    kind: "thread.orphaned",
    threadId,
    revision: "c".repeat(64),
  };
}

describe("validateNext — thread.reanchored", () => {
  test("un-orphans a previously orphaned thread (status returns to open)", () => {
    const state = emptyLogState();
    expect(validateNext(state, created("th-1", "c-1", 1)).ok).toBe(true);
    expect(validateNext(state, orphaned("th-1", 2)).ok).toBe(true);
    expect(state.threads.get("th-1")?.status).toBe("orphaned");
    expect(validateNext(state, reanchored("th-1", 3)).ok).toBe(true);
    expect(state.threads.get("th-1")?.status).toBe("open");
  });

  test("rejects a reanchor for an unknown thread (unknown-thread)", () => {
    const state = emptyLogState();
    const result = validateNext(state, reanchored("th-nowhere", 1));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.kind).toBe("unknown-thread");
  });
});

describe("validateNext — thread.orphaned", () => {
  test("moves an open thread to orphaned", () => {
    const state = emptyLogState();
    validateNext(state, created("th-1", "c-1", 1));
    const result = validateNext(state, orphaned("th-1", 2));
    expect(result.ok).toBe(true);
    expect(state.threads.get("th-1")?.status).toBe("orphaned");
  });

  test("rejects a second orphan on the same thread (already-orphaned)", () => {
    const state = emptyLogState();
    validateNext(state, created("th-1", "c-1", 1));
    validateNext(state, orphaned("th-1", 2));
    const result = validateNext(state, orphaned("th-1", 3));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.kind).toBe("already-orphaned");
  });

  test("rejects an orphan on a RESOLVED thread (not-open)", () => {
    const state = emptyLogState();
    validateNext(state, created("th-1", "c-1", 1));
    validateNext(state, {
      seq: 2,
      ts: t,
      actor,
      kind: "thread.resolved",
      threadId: "th-1",
    });
    const result = validateNext(state, orphaned("th-1", 3));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.kind).toBe("not-open");
  });

  test("rejects an orphan for an unknown thread (unknown-thread)", () => {
    const state = emptyLogState();
    const result = validateNext(state, orphaned("th-nowhere", 1));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.kind).toBe("unknown-thread");
  });
});
