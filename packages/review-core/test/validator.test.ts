// Focused tests for `validateNext` — the single source of truth for the
// log's transition rules, called by both `store.append` and
// `parseArchive`. The store and archive tests exercise it end-to-end
// through their respective boundaries; this file pins the small
// contract directly so a regression that only trips on one path (say,
// import) still fails a targeted test.
import { describe, expect, test } from "bun:test";
import {
  cloneLogState,
  emptyLogState,
  validateNext,
  type ReviewEvent,
} from "../src/index.ts";

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

  test("refuses a reanchor whose anchor.path differs from the thread's file (cross-file-reanchor)", () => {
    const state = emptyLogState();
    validateNext(state, created("th-1", "c-1", 1));
    const crossFile: ReviewEvent = {
      seq: 2,
      ts: t,
      actor,
      kind: "thread.reanchored",
      threadId: "th-1",
      anchor: {
        ...anchor,
        path: "docs/other-file.md",
        revision: "b".repeat(64),
        startLine: 3,
        endLine: 3,
      },
      method: "quote-exact",
    };
    const result = validateNext(state, crossFile);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.kind).toBe("cross-file-reanchor");
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

describe("validateNext — doc.published (M2 item 9)", () => {
  test("doc.published is accepted (no thread state affected)", () => {
    const state = emptyLogState();
    // Publish alongside a comment already on the same path — validates
    // that the publish event does NOT rewrite the existing thread's
    // status (that transition belongs to the re-anchor pipeline, which
    // emits its own events).
    validateNext(state, created("th-1", "c-1", 1));
    const preThread = state.threads.get("th-1");
    const preStatus = preThread?.status;
    const result = validateNext(state, {
      seq: 2,
      ts: t,
      actor: { kind: "agent", id: "revkit-live" },
      kind: "doc.published",
      path: anchor.path,
      revision: "d".repeat(64),
      route: "/adr/0006-comments-anchoring-event-log/",
      generation: "e".repeat(64),
    });
    expect(result.ok).toBe(true);
    expect(state.threads.get("th-1")?.status).toBe(preStatus);
  });

  test("doc.published without a route is accepted (data side files carry no route)", () => {
    const state = emptyLogState();
    const result = validateNext(state, {
      seq: 1,
      ts: t,
      actor: { kind: "agent", id: "revkit-live" },
      kind: "doc.published",
      path: "plots/curve/data.json",
      revision: "d".repeat(64),
      generation: "e".repeat(64),
    });
    expect(result.ok).toBe(true);
  });
});

// Issue #35: `import` validates its archive against a shadow `cloneLogState`
// and commits only on success, so a rejected event in a multi-event archive
// must not leak into the caller's state. That guarantee rests on the clone
// owning its mutable fields rather than sharing them. This pins one of the two:
// `thread.commentIds`, which the dry-run reaches via `comment.replied` — the
// shared-reference variant survives every other test in this repo.
//
// The second is `commentLinks[commentId]` (validator.ts adds a backend to it).
// It is currently unobservable rather than safe: `comment.linked` only ever
// carries "github", and any pre-existing set already contains it, so the add is
// always a no-op. It is not pinned here — worth covering when a second backend
// exists, since one would make the latent sharing observable.
describe("cloneLogState — deep copy", () => {
  test("does not share a thread's comment-id set with the source", () => {
    const source = emptyLogState();
    validateNext(source, created("th-1", "c-1", 1));

    const shadow = cloneLogState(source);
    const reply: ReviewEvent = {
      seq: 2,
      ts: t,
      actor,
      kind: "comment.replied",
      threadId: "th-1",
      commentId: "c-2",
      parentId: "c-1",
      body: "ok",
    };
    expect(validateNext(shadow, reply).ok).toBe(true);

    // The shadow took the reply...
    expect([...(shadow.threads.get("th-1")?.commentIds ?? [])]).toEqual(["c-1", "c-2"]);
    // ...and the source did not. This last assertion is what a shared Set fails.
    expect([...(source.threads.get("th-1")?.commentIds ?? [])]).toEqual(["c-1"]);
  });
});
