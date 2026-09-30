// GitHub adapter mapping tests (M3 part 1, ADR-0025).
//
// - Thread → review-core events: assert each thread turns into the
//   right sequence of `comment.created` / `comment.replied` /
//   `comment.linked` / `thread.resolved` events, with external ids
//   and a valid Anchor.
// - Rate-limit helpers: `shouldRetry` and `retryAfterMs` decide the
//   backoff plumbing. Both are pure functions so exact-value tests
//   are meaningful (not tautological — they compute delta and cap
//   which a caller then hands to `setTimeout`).

import { describe, expect, test } from "bun:test";
import {
  GitHubAdapter,
  InMemoryThreadStore,
  reduce,
  reviewEventSchema,
  retryAfterMs,
  shouldRetry,
  type GhReviewThread,
  type ReviewEvent,
} from "../src/index.ts";

const REV = "0".repeat(64); // a valid sha-256 hex, LF-normalised

/** Stamp events with monotonic seq/ts so the reducer accepts them.
 * The reducer doesn't validate — the validator does — but the
 * discriminated-union type requires both fields, and the reducer
 * sorts by seq. */
function stampEvents(inputs: readonly ReturnType<typeof GitHubAdapter.mapThreadsToEvents>["events"][number][]): readonly ReviewEvent[] {
  return inputs.map((ev, i) => ({ ...ev, seq: i + 1, ts: `2026-09-30T00:00:0${i}.000Z` } as ReviewEvent));
}

/** Build a synthetic thread — covers the shapes the fixtures don't
 * (multiple comments, unresolved, RIGHT-side with a live line). */
function thread(overrides: Partial<GhReviewThread> = {}): GhReviewThread {
  return {
    id: "PRRT_x",
    path: "docs/x.mdx",
    isResolved: false,
    isOutdated: false,
    line: 5,
    startLine: null,
    originalLine: 5,
    originalStartLine: null,
    diffSide: "RIGHT",
    startDiffSide: null,
    subjectType: "LINE",
    resolvedByLogin: null,
    comments: [
      {
        databaseId: 1,
        nodeId: "PRRC_1",
        body: "first!",
        authorLogin: "alice",
        authorType: "User",
        createdAt: "2026-09-30T00:00:00Z",
        url: "https://github.com/vig-os/revkit/pull/8#discussion_r1",
      },
    ],
    ...overrides,
  };
}

describe("mapThreadsToEvents", () => {
  const makeQuote = () => ({ exact: "quoted content", prefix: "", suffix: "" });

  test("live RIGHT-side thread yields comment.created + comment.linked", () => {
    const { events, orphanedThreadIds } = GitHubAdapter.mapThreadsToEvents({
      threads: [thread()],
      threadIdOf: (t) => `t-${t.id}`,
      commentIdOf: (_t, c) => `c-${c.databaseId}`,
      revisionOf: () => REV,
      commitId: "0".repeat(40),
      quoteFor: makeQuote,
    });
    expect(orphanedThreadIds).toEqual([]);
    expect(events.length).toBe(2);
    expect(events[0]!.kind).toBe("comment.created");
    expect(events[1]!.kind).toBe("comment.linked");
    // The anchor is well-formed and validates through the wire schema.
    // Build a stamped event with a fake seq/ts to run the discriminated
    // union check.
    const stamped: ReviewEvent = reviewEventSchema.parse({
      seq: 1,
      ts: "2026-09-30T00:00:00.000Z",
      ...events[0]!,
    });
    if (stamped.kind !== "comment.created") throw new Error("kind");
    expect(stamped.anchor.path).toBe("docs/x.mdx");
    expect(stamped.anchor.startLine).toBe(5);
    expect(stamped.anchor.endLine).toBe(5);
    expect(stamped.anchor.commit).toBe("0".repeat(40));
    expect(stamped.actor.kind).toBe("gh-user");
    expect(stamped.actor.id).toBe("alice");
  });

  test("multi-comment thread yields created + linked + replied + linked, with parentId", () => {
    const t = thread({
      comments: [
        {
          databaseId: 1, nodeId: "n1", body: "first", authorLogin: "alice",
          authorType: "User", createdAt: "2026-09-30T00:00:00Z", url: "u1",
        },
        {
          databaseId: 2, nodeId: "n2", body: "reply", authorLogin: "bob",
          authorType: "User", createdAt: "2026-09-30T01:00:00Z", url: "u2",
        },
        {
          databaseId: 3, nodeId: "n3", body: "third", authorLogin: "alice",
          authorType: "User", createdAt: "2026-09-30T02:00:00Z", url: "u3",
        },
      ],
    });
    const { events } = GitHubAdapter.mapThreadsToEvents({
      threads: [t],
      threadIdOf: () => "T1",
      commentIdOf: (_t, c) => `C${c.databaseId}`,
      revisionOf: () => REV,
      quoteFor: makeQuote,
    });
    expect(events.map((e) => e.kind)).toEqual([
      "comment.created",
      "comment.linked",
      "comment.replied",
      "comment.linked",
      "comment.replied",
      "comment.linked",
    ]);
    // parentId chain
    const replies = events.filter((e) => e.kind === "comment.replied");
    expect(replies[0]!.kind === "comment.replied" && replies[0]!.parentId).toBe("C1");
    expect(replies[1]!.kind === "comment.replied" && replies[1]!.parentId).toBe("C2");
  });

  test("outdated thread emits thread.orphaned AND reduces to status=orphaned", () => {
    // BLOCKER 2 (PR-43): outdated threads must emit `thread.orphaned`
    // themselves, not only report via a side channel. Any consumer
    // reducing the events must see the correct end state.
    const t = thread({
      line: null,
      startLine: null,
      originalLine: 42,
      isOutdated: true,
    });
    const { events, orphanedThreadIds } = GitHubAdapter.mapThreadsToEvents({
      threads: [t],
      threadIdOf: () => "T-outdated",
      commentIdOf: (_t, c) => `C${c.databaseId}`,
      revisionOf: () => REV,
      quoteFor: makeQuote,
    });
    expect(orphanedThreadIds).toEqual(["T-outdated"]);
    // The event stream contains thread.orphaned at the end.
    expect(events.map((e) => e.kind)).toEqual([
      "comment.created",
      "comment.linked",
      "thread.orphaned",
    ]);
    // Anchor uses originalLine as a placeholder.
    const created = events[0]!;
    if (created.kind !== "comment.created") throw new Error("kind");
    expect(created.anchor.startLine).toBe(42);
    expect(created.anchor.endLine).toBe(42);
    // Reduce the events through the real reducer — status should be
    // "orphaned" and the comment body should be preserved.
    const stamped = stampEvents(events);
    const threads = reduce(stamped);
    const reduced = threads.get("T-outdated");
    expect(reduced).toBeDefined();
    expect(reduced!.status).toBe("orphaned");
    expect(reduced!.comments.length).toBe(1);
    expect(reduced!.comments[0]!.body).toBe("first!");
  });

  test("LEFT-side thread emits thread.orphaned and reduces to orphaned", () => {
    const { events, orphanedThreadIds } = GitHubAdapter.mapThreadsToEvents({
      threads: [thread({ diffSide: "LEFT" })],
      threadIdOf: () => "T-left",
      commentIdOf: (_t, c) => `C${c.databaseId}`,
      revisionOf: () => REV,
      quoteFor: makeQuote,
    });
    expect(orphanedThreadIds).toEqual(["T-left"]);
    expect(events[events.length - 1]!.kind).toBe("thread.orphaned");
    const reduced = reduce(stampEvents(events)).get("T-left");
    expect(reduced?.status).toBe("orphaned");
  });

  test("FILE-subject thread emits thread.orphaned (file-level, unmappable line)", () => {
    const { events } = GitHubAdapter.mapThreadsToEvents({
      threads: [thread({ subjectType: "FILE", line: null })],
      threadIdOf: () => "T-file",
      commentIdOf: (_t, c) => `C${c.databaseId}`,
      revisionOf: () => REV,
      quoteFor: makeQuote,
    });
    expect(events[events.length - 1]!.kind).toBe("thread.orphaned");
    const reduced = reduce(stampEvents(events)).get("T-file");
    expect(reduced?.status).toBe("orphaned");
  });

  test("resolved+outdated thread emits ONLY thread.resolved (human wins over orphan)", () => {
    // The validator refuses both terminal transitions from `open`,
    // so we choose one. Resolution is a human decision; orphan is
    // a machine classification — human wins.
    const t = thread({
      line: null,
      originalLine: 20,
      isResolved: true,
      isOutdated: true,
      resolvedByLogin: "carol",
    });
    const { events } = GitHubAdapter.mapThreadsToEvents({
      threads: [t],
      threadIdOf: () => "T-both",
      commentIdOf: (_t, c) => `C${c.databaseId}`,
      revisionOf: () => REV,
      quoteFor: makeQuote,
    });
    const terminalKinds = events.filter((e) => e.kind === "thread.resolved" || e.kind === "thread.orphaned");
    expect(terminalKinds.length).toBe(1);
    expect(terminalKinds[0]!.kind).toBe("thread.resolved");
    // The actor of the resolution is `resolvedByLogin`, not the
    // last commenter.
    const resolved = terminalKinds[0]!;
    if (resolved.kind !== "thread.resolved") throw new Error("kind");
    expect(resolved.actor.id).toBe("carol");
    // Reduce: status=resolved.
    const reduced = reduce(stampEvents(events)).get("T-both");
    expect(reduced?.status).toBe("resolved");
  });

  test("resolved thread with no resolvedByLogin falls back to the last commenter as actor", () => {
    const t = thread({
      isResolved: true,
      resolvedByLogin: null,
      comments: [
        {
          databaseId: 1, nodeId: "n1", body: "first", authorLogin: "alice",
          authorType: "User", createdAt: "t1", url: "u1",
        },
        {
          databaseId: 2, nodeId: "n2", body: "second", authorLogin: "bob",
          authorType: "User", createdAt: "t2", url: "u2",
        },
      ],
    });
    const { events } = GitHubAdapter.mapThreadsToEvents({
      threads: [t],
      threadIdOf: () => "T-r",
      commentIdOf: (_t, c) => `C${c.databaseId}`,
      revisionOf: () => REV,
      quoteFor: makeQuote,
    });
    const resolved = events.find((e) => e.kind === "thread.resolved")!;
    if (resolved.kind !== "thread.resolved") throw new Error("kind");
    expect(resolved.actor.id).toBe("bob");
  });

  test("skips a thread whose file has no revision (adapter can't build an anchor)", () => {
    const { events, orphanedThreadIds } = GitHubAdapter.mapThreadsToEvents({
      threads: [thread({ path: "unknown.mdx" })],
      threadIdOf: () => "T-x",
      commentIdOf: (_t, c) => `C${c.databaseId}`,
      revisionOf: (p) => (p === "unknown.mdx" ? undefined : REV),
      quoteFor: makeQuote,
    });
    expect(events).toEqual([]);
    expect(orphanedThreadIds).toEqual([]);
  });

  test("first comment's author is the actor of comment.created (not a downstream author)", () => {
    // Mutation guard: if the mapper accidentally used the LAST
    // comment's author for the created event (a copy-paste that
    // would silently mis-attribute the thread's opening comment),
    // this test goes red.
    const t = thread({
      comments: [
        {
          databaseId: 1, nodeId: "n1", body: "first", authorLogin: "opener",
          authorType: "User", createdAt: "t1", url: "u1",
        },
        {
          databaseId: 2, nodeId: "n2", body: "reply", authorLogin: "replier",
          authorType: "User", createdAt: "t2", url: "u2",
        },
      ],
    });
    const { events } = GitHubAdapter.mapThreadsToEvents({
      threads: [t],
      threadIdOf: () => "T-actor",
      commentIdOf: (_t, c) => `C${c.databaseId}`,
      revisionOf: () => REV,
      quoteFor: makeQuote,
    });
    const created = events.find((e) => e.kind === "comment.created");
    expect(created?.actor.id).toBe("opener");
    const replied = events.find((e) => e.kind === "comment.replied");
    expect(replied?.actor.id).toBe("replier");
  });

  test("bot login turns into a gh-user actor with the [bot] suffix preserved", () => {
    const t = thread({
      comments: [
        {
          databaseId: 9, nodeId: "n9", body: "bot says", authorLogin: "dependabot[bot]",
          authorType: "Bot", createdAt: "2026-09-30T00:00:00Z", url: "u9",
        },
      ],
    });
    const { events } = GitHubAdapter.mapThreadsToEvents({
      threads: [t],
      threadIdOf: () => "T-bot",
      commentIdOf: (_t, c) => `C${c.databaseId}`,
      revisionOf: () => REV,
      quoteFor: makeQuote,
    });
    const created = events[0]!;
    if (created.kind !== "comment.created") throw new Error("kind");
    expect(created.actor.id).toBe("dependabot[bot]");
  });
});

describe("shouldRetry", () => {
  test("429 always retries", () => {
    expect(shouldRetry(429, new Headers(), "body")).toBe(true);
  });

  test("403 with x-ratelimit-remaining: 0 retries", () => {
    expect(shouldRetry(403, new Headers({ "x-ratelimit-remaining": "0" }), "rate limit")).toBe(true);
  });

  test("403 with Retry-After retries", () => {
    expect(shouldRetry(403, new Headers({ "retry-after": "10" }), "wait")).toBe(true);
  });

  test("403 with 'secondary rate limit' body retries", () => {
    expect(
      shouldRetry(403, new Headers(), "You have exceeded a secondary rate limit for this endpoint"),
    ).toBe(true);
  });

  test("plain 403 (permission) does not retry", () => {
    expect(shouldRetry(403, new Headers(), "Resource not accessible by integration")).toBe(false);
  });

  test("404/422 do not retry", () => {
    expect(shouldRetry(404, new Headers(), "not found")).toBe(false);
    expect(shouldRetry(422, new Headers(), "validation")).toBe(false);
  });
});

describe("retryAfterMs", () => {
  test("prefers Retry-After (seconds) over x-ratelimit-reset (epoch)", () => {
    const now = () => 1_700_000_000_000;
    const headers = new Headers({ "retry-after": "5", "x-ratelimit-reset": "1700003600" });
    expect(retryAfterMs(headers, 999, now)).toBe(5000);
  });

  test("falls back to x-ratelimit-reset when Retry-After is absent", () => {
    const now = () => 1_700_000_000_000;
    const headers = new Headers({ "x-ratelimit-reset": "1700000060" });
    expect(retryAfterMs(headers, 0, now)).toBe(60_000);
  });

  test("uses the default when neither header is set", () => {
    expect(retryAfterMs(new Headers(), 1234)).toBe(1234);
  });

  test("ignores a negative reset delta and uses the default", () => {
    const now = () => 1_700_000_100_000;
    const headers = new Headers({ "x-ratelimit-reset": "1700000060" });
    expect(retryAfterMs(headers, 42, now)).toBe(42);
  });

  test("ignores a non-numeric Retry-After", () => {
    expect(retryAfterMs(new Headers({ "retry-after": "later" }), 111)).toBe(111);
  });
});
