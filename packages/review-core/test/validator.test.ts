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
