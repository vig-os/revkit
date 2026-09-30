// Tests for the pure event reducer (ADR-0006). The log is the source of
// truth; the reducer's job is to fold it into the derived Thread view.
// Guarantees exercised here: (a) create → reply → resolve → reopen lands
// on the expected state; (b) the reducer sorts by `seq` before applying,
// so an out-of-order slice yields the same result; (c) events on unknown
// or duplicate threads are skipped without throwing so the reducer stays
// total on any slice `since(seq)` might return; (d) `comment.linked`
// merges an external ref onto the referenced comment.
import { describe, expect, test } from "bun:test";
import { reduce, type ReviewEvent } from "../src/index.ts";

const anchor = {
  path: "docs/adr/0006-comments-anchoring-event-log.md",
  startLine: 40,
  endLine: 44,
  quote: { exact: "text-quote selector", prefix: "carries a ", suffix: " and the revision" },
  revision: "a".repeat(64),
} as const;

const humanActor = { kind: "gh-user", id: "gerchowl", displayName: "Lars G" } as const;
const agentActor = { kind: "agent", id: "revkit-live", displayName: "revkit-live" } as const;

// Build a canonical create → reply → resolve → reopen log with predictable
// timestamps so the assertions can name expected `createdAt` / `updatedAt`
// values instead of comparing them to themselves (which would be a
// tautology). The `ts` values are strictly ascending; the store guarantees
// this in practice, and the reducer inherits the property here.
const t = (n: number): string => `2026-09-30T12:00:0${n}Z`;
const log: readonly ReviewEvent[] = [
  {
    seq: 1,
    ts: t(0),
    actor: humanActor,
    kind: "comment.created",
    threadId: "th-1",
    commentId: "c-1",
    anchor,
    body: "why 30 s?",
  },
  {
    seq: 2,
    ts: t(1),
    actor: agentActor,
    kind: "comment.replied",
    threadId: "th-1",
    commentId: "c-2",
    parentId: "c-1",
    body: "raised to 60 s, see L42",
  },
  {
    seq: 3,
    ts: t(2),
    actor: humanActor,
    kind: "thread.resolved",
    threadId: "th-1",
    resolution: "ok, thanks",
  },
  {
    seq: 4,
    ts: t(3),
    actor: humanActor,
    kind: "thread.reopened",
    threadId: "th-1",
    reason: "one follow-up",
  },
];

describe("reduce — create → reply → resolve → reopen", () => {
  test("folds the canonical log into one open thread with two comments and updated timestamps", () => {
    const threads = reduce(log);
    expect(threads.size).toBe(1);
    const thread = threads.get("th-1");
    expect(thread).toBeDefined();
    if (!thread) return;
    expect(thread.status).toBe("open");
    expect(thread.createdAt).toBe(t(0));
    expect(thread.updatedAt).toBe(t(3));
    expect(thread.createdSeq).toBe(1);
    expect(thread.comments.map((c) => c.id)).toEqual(["c-1", "c-2"]);
    expect(thread.comments[1]?.parentId).toBe("c-1");
    expect(thread.comments[1]?.author.kind).toBe("agent");
    expect(thread.anchor).toEqual(anchor);
  });

  test("resolves to `resolved` when the log stops at thread.resolved", () => {
    const threads = reduce(log.slice(0, 3));
    expect(threads.get("th-1")?.status).toBe("resolved");
    expect(threads.get("th-1")?.updatedAt).toBe(t(2));
  });

  test("issue #60: thread.resolved projects resolvedBy + resolvedAt onto the derived thread", () => {
    const threads = reduce(log.slice(0, 3));
    const thread = threads.get("th-1");
    expect(thread?.resolvedBy).toEqual(humanActor);
    expect(thread?.resolvedAt).toBe(t(2));
  });

  test("issue #60: thread.reopened drops resolvedBy + resolvedAt", () => {
    const threads = reduce(log);
    const thread = threads.get("th-1");
    expect(thread?.status).toBe("open");
    expect(thread?.resolvedBy).toBeUndefined();
    expect(thread?.resolvedAt).toBeUndefined();
  });
});

describe("reduce — ordering", () => {
  test("sorts by seq before applying, so a shuffled slice yields the same output", () => {
    const shuffled = [log[3]!, log[0]!, log[2]!, log[1]!];
    const ordered = reduce(log);
    const outOfOrder = reduce(shuffled);
    // Compare by structural equality of the map contents.
    expect([...outOfOrder.entries()]).toEqual([...ordered.entries()]);
  });
});

describe("reduce — total on byzantine slices", () => {
  test("ignores a reply for a thread that is not present in the slice", () => {
    const orphanReply = log.slice(1); // starts at the reply, no create
    const threads = reduce(orphanReply);
    expect(threads.size).toBe(0);
  });

  test("ignores resolved/reopened for an unknown thread id", () => {
    const stray: ReviewEvent = {
      seq: 6,
      ts: t(5),
      actor: humanActor,
      kind: "thread.resolved",
      threadId: "th-does-not-exist",
    };
    expect(reduce([stray]).size).toBe(0);
  });
});

describe("reduce — thread.reanchored", () => {
  test("updates the anchor and stamps updatedAt, leaves an open thread open", () => {
    const newAnchor = {
      ...anchor,
      startLine: 42,
      endLine: 46,
      revision: "b".repeat(64),
    };
    const reanchored: ReviewEvent = {
      seq: 5,
      ts: t(4),
      actor: agentActor,
      kind: "thread.reanchored",
      threadId: "th-1",
      anchor: newAnchor,
      method: "quote-exact",
    };
    const threads = reduce([...log.slice(0, 2), reanchored]);
    const thread = threads.get("th-1");
    expect(thread).toBeDefined();
    if (!thread) return;
    expect(thread.status).toBe("open");
    expect(thread.anchor).toEqual(newAnchor);
    expect(thread.updatedAt).toBe(t(4));
  });

  test("un-orphans a previously-orphaned thread (status → open, new anchor)", () => {
    const orphan: ReviewEvent = {
      seq: 5,
      ts: t(4),
      actor: agentActor,
      kind: "thread.orphaned",
      threadId: "th-1",
      revision: "c".repeat(64),
      reason: "block deleted on prior rebuild",
    };
    const rediscovered: ReviewEvent = {
      seq: 6,
      ts: t(5),
      actor: agentActor,
      kind: "thread.reanchored",
      threadId: "th-1",
      anchor: { ...anchor, startLine: 44, endLine: 48, revision: "d".repeat(64) },
      method: "fuzzy",
      score: 0.87,
    };
    // Use the open-thread log slice (create + reply), then orphan, then re-anchor.
    const threads = reduce([...log.slice(0, 2), orphan, rediscovered]);
    const thread = threads.get("th-1");
    expect(thread?.status).toBe("open");
    // Narrow: the reanchored anchor is a LINE anchor.
    if (!thread || !("startLine" in thread.anchor)) throw new Error("expected line anchor");
    expect(thread.anchor.startLine).toBe(44);
  });
});

describe("reduce — thread.orphaned", () => {
  test("open thread → orphaned; updatedAt stamped", () => {
    const orphan: ReviewEvent = {
      seq: 3,
      ts: t(2),
      actor: agentActor,
      kind: "thread.orphaned",
      threadId: "th-1",
      revision: "e".repeat(64),
      reason: "block deleted",
    };
    const threads = reduce([log[0]!, orphan]);
    expect(threads.get("th-1")?.status).toBe("orphaned");
    expect(threads.get("th-1")?.updatedAt).toBe(t(2));
  });

  test("carries the pipeline's `reason` onto Thread.orphanReason (PR #45 round-2 nit)", () => {
    // The rail must render the pipeline's own explanation, not a
    // synthesised sentence. The reducer plumbs `reason` from the
    // event onto the derived Thread view so a rail refetch sees
    // it verbatim.
    const orphan: ReviewEvent = {
      seq: 3,
      ts: t(2),
      actor: agentActor,
      kind: "thread.orphaned",
      threadId: "th-1",
      revision: "e".repeat(64),
      reason: "block deleted; no move detected.",
    };
    const threads = reduce([log[0]!, orphan]);
    const thread = threads.get("th-1");
    expect(thread?.status).toBe("orphaned");
    expect(thread?.orphanReason).toBe("block deleted; no move detected.");
  });

  test("re-anchor un-orphans and CLEARS the stale orphanReason (mutation guard)", () => {
    const orphan: ReviewEvent = {
      seq: 3,
      ts: t(2),
      actor: agentActor,
      kind: "thread.orphaned",
      threadId: "th-1",
      revision: "e".repeat(64),
      reason: "block deleted; no move detected.",
    };
    const rediscovered: ReviewEvent = {
      seq: 4,
      ts: t(3),
      actor: agentActor,
      kind: "thread.reanchored",
      threadId: "th-1",
      anchor: { ...anchor, startLine: 44, endLine: 48, revision: "d".repeat(64) },
      method: "fuzzy",
      score: 0.87,
    };
    const threads = reduce([log[0]!, orphan, rediscovered]);
    const thread = threads.get("th-1");
    expect(thread?.status).toBe("open");
    // Reason must NOT linger after un-orphan — the block came back.
    expect(thread?.orphanReason).toBeUndefined();
  });

  test("resolved thread that emits orphaned (byzantine slice): status stays resolved (defensive)", () => {
    // The append-side validator refuses this transition, so a well-
    // formed log never carries it — the reducer's guard is the safety
    // net for a partial slice.
    const orphan: ReviewEvent = {
      seq: 4,
      ts: t(3),
      actor: agentActor,
      kind: "thread.orphaned",
      threadId: "th-1",
      revision: "f".repeat(64),
    };
    const threads = reduce([...log.slice(0, 3), orphan]); // includes thread.resolved
    expect(threads.get("th-1")?.status).toBe("resolved");
  });
});

describe("reduce — comment.linked", () => {
  test("merges an external github ref onto the referenced comment", () => {
    const linked: ReviewEvent = {
      seq: 5,
      ts: t(4),
      actor: agentActor,
      kind: "comment.linked",
      commentId: "c-1",
      external: { github: { commentId: 987654, nodeId: "PRC_kwDOA" } },
    };
    const threads = reduce([...log, linked]);
    const thread = threads.get("th-1");
    expect(thread?.comments[0]?.external?.github?.commentId).toBe(987654);
    expect(thread?.comments[0]?.external?.github?.nodeId).toBe("PRC_kwDOA");
    // Second comment is untouched.
    expect(thread?.comments[1]?.external).toBeUndefined();
  });
});
