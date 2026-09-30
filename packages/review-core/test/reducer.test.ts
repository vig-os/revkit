// Tests for the pure event reducer (ADR-0006). The log is the source of
// truth; the reducer's job is to fold it into the derived Thread view.
// Guarantees exercised here: (a) create → reply → resolve → reopen lands
// on the expected state; (b) the reducer sorts by `seq` before applying,
// so an out-of-order slice yields the same result; (c) events on unknown
// or duplicate threads are skipped without throwing so the reducer stays
// total on any slice `since(seq)` might return.
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

  test("skips a duplicate comment.created for the same thread id", () => {
    const duplicate: ReviewEvent = {
      seq: 5,
      ts: t(4),
      actor: humanActor,
      kind: "comment.created",
      threadId: "th-1",
      commentId: "c-dup",
      anchor,
      body: "duplicate — must be skipped by the reducer",
    };
    const threads = reduce([...log, duplicate]);
    // The original create wins; the duplicate has no effect on comments
    // or timestamps.
    const thread = threads.get("th-1");
    expect(thread?.comments.map((c) => c.id)).toEqual(["c-1", "c-2"]);
    expect(thread?.updatedAt).toBe(t(3));
  });

  test("ignores resolved/reopened for an unknown thread id", () => {
    const stray: ReviewEvent = {
      seq: 6,
      ts: t(5),
      actor: humanActor,
      kind: "thread.resolved",
      threadId: "th-does-not-exist",
    };
    // Passing only the stray event: reducer returns an empty map.
    expect(reduce([stray]).size).toBe(0);
  });
});
