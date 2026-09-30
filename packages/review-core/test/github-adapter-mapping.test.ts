// GitHub adapter thread-import tests (M3 part 1, ADR-0025).
//
// PR-43 round-3 (Blocker 2): every imported thread's anchor lives
// in the coordinates of the commit its comment was made against.
// Live RIGHT threads → head revision + head-side quote. Outdated
// or LEFT threads → own-commit revision + own-commit quote. If
// the content is unavailable, a placeholder anchor is used AND a
// `thread.orphaned` follows.
//
// These tests also cover the rate-limit helpers (`shouldRetry` /
// `retryAfterMs`) — pure functions whose exact-value tests are
// meaningful, not tautological.

import { describe, expect, test } from "bun:test";
import {
  buildQuoteFromLines,
  GitHubAdapter,
  reduce,
  reviewEventSchema,
  retryAfterMs,
  revisionOf,
  shouldRetry,
  type GhReviewThread,
  type ReviewEvent,
  type ThreadSnapshot,
} from "../src/index.ts";

/** Stamp events with monotonic seq/ts so the reducer accepts them. */
function stampEvents(
  inputs: readonly ReturnType<typeof GitHubAdapter.mapThreadsToEvents>["events"][number][],
): readonly ReviewEvent[] {
  return inputs.map(
    (ev, i) =>
      ({
        ...ev,
        seq: i + 1,
        ts: `2026-09-30T00:00:${String(i).padStart(2, "0")}.000Z`,
      }) as ReviewEvent,
  );
}

/** Realistic head-side source for `docs/x.mdx` used in tests. */
const HEAD_SOURCE = "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\n";
let HEAD_REV = "";
/** Original-commit source — same file, different content — so the
 * imported anchor's revision must differ from head. */
const ORIGINAL_SOURCE = "orig 1\norig 2\norig 3 target\norig 4\norig 5\n";
let ORIGINAL_REV = "";

// Precompute revisions once at module load.
(async () => {
  HEAD_REV = await revisionOf(HEAD_SOURCE);
  ORIGINAL_REV = await revisionOf(ORIGINAL_SOURCE);
})();

/** Build a synthetic thread. Callers override selected fields. */
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
        originalCommitOid: "1".repeat(40),
      },
    ],
    ...overrides,
  };
}

describe("mapThreadsToEvents — live RIGHT threads", () => {
  test("live RIGHT thread uses head revision, head-side quote, and does NOT emit thread.orphaned", async () => {
    // Ensure REV precomputed.
    if (HEAD_REV === "") HEAD_REV = await revisionOf(HEAD_SOURCE);
    const { events, orphanedThreadIds, snapshots } = GitHubAdapter.mapThreadsToEvents({
      threads: [thread()],
      threadIdOf: (t) => `t-${t.id}`,
      commentIdOf: (_t, c) => `c-${c.databaseId}`,
      headRevisionOf: () => HEAD_REV,
      headSourceOf: () => HEAD_SOURCE,
      headCommitOid: "9".repeat(40),
      resolveSnapshot: () => ({ kind: "live" }),
    });
    expect(orphanedThreadIds).toEqual([]);
    expect(events.map((e) => e.kind)).toEqual(["comment.created", "comment.linked"]);
    const created = events[0]!;
    if (created.kind !== "comment.created") throw new Error("kind");
    // The anchor is validated by the schema.
    const stamped = reviewEventSchema.parse({
      seq: 1,
      ts: "2026-09-30T00:00:00.000Z",
      ...created,
    });
    if (stamped.kind !== "comment.created") throw new Error("kind");
    expect(stamped.anchor.revision).toBe(HEAD_REV);
    expect(stamped.anchor.commit).toBe("9".repeat(40));
    // The quote is cut from HEAD content at the requested lines.
    const expected = buildQuoteFromLines(HEAD_SOURCE, 5, 5);
    expect(stamped.anchor.quote.exact).toBe(expected.exact);
    // Head source appears in snapshots.
    expect(snapshots.get(HEAD_REV)).toBe(HEAD_SOURCE);
  });
});

describe("mapThreadsToEvents — outdated / LEFT threads use own-commit anchor", () => {
  test("outdated RIGHT thread anchors at the original-commit revision, NOT head", async () => {
    if (ORIGINAL_REV === "") ORIGINAL_REV = await revisionOf(ORIGINAL_SOURCE);
    if (HEAD_REV === "") HEAD_REV = await revisionOf(HEAD_SOURCE);
    const t = thread({
      line: null,
      startLine: null,
      originalLine: 3,
      isOutdated: true,
    });
    const { events, orphanedThreadIds, snapshots } = GitHubAdapter.mapThreadsToEvents({
      threads: [t],
      threadIdOf: () => "T-outdated",
      commentIdOf: (_t, c) => `C${c.databaseId}`,
      headRevisionOf: () => HEAD_REV,
      resolveSnapshot: () => ({
        kind: "own-commit",
        content: ORIGINAL_SOURCE,
        revision: ORIGINAL_REV,
        oid: "1".repeat(40),
      }),
    });
    expect(orphanedThreadIds).toEqual(["T-outdated"]);
    // Sequence includes thread.orphaned.
    expect(events.map((e) => e.kind)).toEqual([
      "comment.created",
      "comment.linked",
      "thread.orphaned",
    ]);
    const created = events[0]!;
    if (created.kind !== "comment.created") throw new Error("kind");
    // CRITICAL: the anchor revision is the original commit's — NOT
    // head. This is exactly what Blocker 2 was about.
    expect(created.anchor.revision).toBe(ORIGINAL_REV);
    expect(created.anchor.revision).not.toBe(HEAD_REV);
    expect(created.anchor.commit).toBe("1".repeat(40));
    // The quote came from ORIGINAL content.
    const expected = buildQuoteFromLines(ORIGINAL_SOURCE, 3, 3);
    expect(created.anchor.quote.exact).toBe(expected.exact);
    // Snapshot map contains the original content at its revision.
    expect(snapshots.get(ORIGINAL_REV)).toBe(ORIGINAL_SOURCE);
    // Reduce: the thread is orphaned.
    const reduced = reduce(stampEvents(events)).get("T-outdated");
    expect(reduced?.status).toBe("orphaned");
    // Body preserved.
    expect(reduced?.comments[0]!.body).toBe("first!");
  });

  test("LEFT-side thread anchors at the provided base-commit content and orphans", async () => {
    if (ORIGINAL_REV === "") ORIGINAL_REV = await revisionOf(ORIGINAL_SOURCE);
    if (HEAD_REV === "") HEAD_REV = await revisionOf(HEAD_SOURCE);
    const t = thread({ diffSide: "LEFT", originalLine: 2 });
    const { events, orphanedThreadIds } = GitHubAdapter.mapThreadsToEvents({
      threads: [t],
      threadIdOf: () => "T-left",
      commentIdOf: (_t, c) => `C${c.databaseId}`,
      headRevisionOf: () => HEAD_REV,
      resolveSnapshot: () => ({
        kind: "own-commit",
        content: ORIGINAL_SOURCE,
        revision: ORIGINAL_REV,
        oid: "2".repeat(40),
      }),
    });
    expect(orphanedThreadIds).toEqual(["T-left"]);
    const created = events[0]!;
    if (created.kind !== "comment.created") throw new Error("kind");
    expect(created.anchor.revision).toBe(ORIGINAL_REV);
    expect(created.anchor.commit).toBe("2".repeat(40));
    // Reduce → orphaned.
    const reduced = reduce(stampEvents(events)).get("T-left");
    expect(reduced?.status).toBe("orphaned");
  });

  test("resolved+outdated thread anchors at own commit and marks resolved (not orphan)", async () => {
    if (ORIGINAL_REV === "") ORIGINAL_REV = await revisionOf(ORIGINAL_SOURCE);
    if (HEAD_REV === "") HEAD_REV = await revisionOf(HEAD_SOURCE);
    const t = thread({
      line: null,
      originalLine: 2,
      isResolved: true,
      isOutdated: true,
      resolvedByLogin: "carol",
    });
    const { events } = GitHubAdapter.mapThreadsToEvents({
      threads: [t],
      threadIdOf: () => "T-both",
      commentIdOf: (_t, c) => `C${c.databaseId}`,
      headRevisionOf: () => HEAD_REV,
      resolveSnapshot: () => ({
        kind: "own-commit",
        content: ORIGINAL_SOURCE,
        revision: ORIGINAL_REV,
        oid: "3".repeat(40),
      }),
    });
    // Anchor uses own-commit revision.
    const created = events[0]!;
    if (created.kind !== "comment.created") throw new Error("kind");
    expect(created.anchor.revision).toBe(ORIGINAL_REV);
    // Resolved event present; no orphan event.
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("thread.resolved");
    expect(kinds).not.toContain("thread.orphaned");
    // Actor is resolvedByLogin.
    const resolved = events.find((e) => e.kind === "thread.resolved")!;
    if (resolved.kind !== "thread.resolved") throw new Error("kind");
    expect(resolved.actor.id).toBe("carol");
    // Reduce → resolved, at own-commit anchor.
    const reduced = reduce(stampEvents(events)).get("T-both");
    expect(reduced?.status).toBe("resolved");
    expect(reduced?.anchor.revision).toBe(ORIGINAL_REV);
  });
});

describe("mapThreadsToEvents — snapshot unavailable", () => {
  test("unavailable snapshot uses head-revision placeholder + orphans with reason", async () => {
    if (HEAD_REV === "") HEAD_REV = await revisionOf(HEAD_SOURCE);
    const t = thread({ isOutdated: true, line: null, originalLine: 3 });
    const { events, orphanedThreadIds } = GitHubAdapter.mapThreadsToEvents({
      threads: [t],
      threadIdOf: () => "T-un",
      commentIdOf: (_t, c) => `C${c.databaseId}`,
      headRevisionOf: () => HEAD_REV,
      headSourceOf: () => HEAD_SOURCE,
      resolveSnapshot: () => ({ kind: "unavailable", reason: "deleted" }),
    });
    expect(orphanedThreadIds).toEqual(["T-un"]);
    const orphan = events.find((e) => e.kind === "thread.orphaned");
    if (orphan?.kind !== "thread.orphaned") throw new Error("kind");
    expect(orphan.reason).toBe("deleted");
    // Anchor still schema-valid (uses head revision as placeholder).
    const created = events[0]!;
    if (created.kind !== "comment.created") throw new Error("kind");
    expect(created.anchor.revision).toBe(HEAD_REV);
  });
});

describe("mapThreadsToEvents — multi-comment threads", () => {
  test("first author is used for comment.created, replies use their own authors, parentId chain OK", () => {
    const t = thread({
      comments: [
        {
          databaseId: 1, nodeId: "n1", body: "first", authorLogin: "opener",
          authorType: "User", createdAt: "t1", url: "u1", originalCommitOid: "1".repeat(40),
        },
        {
          databaseId: 2, nodeId: "n2", body: "reply", authorLogin: "replier",
          authorType: "User", createdAt: "t2", url: "u2", originalCommitOid: "1".repeat(40),
        },
      ],
    });
    const { events } = GitHubAdapter.mapThreadsToEvents({
      threads: [t],
      threadIdOf: () => "T-multi",
      commentIdOf: (_t, c) => `C${c.databaseId}`,
      headRevisionOf: () => "0".repeat(64),
      resolveSnapshot: () => ({ kind: "live" }),
      quoteFor: () => ({ exact: "x", prefix: "", suffix: "" }),
    });
    const created = events.find((e) => e.kind === "comment.created");
    expect(created?.actor.id).toBe("opener");
    const replied = events.find((e) => e.kind === "comment.replied");
    if (replied?.kind !== "comment.replied") throw new Error("kind");
    expect(replied.actor.id).toBe("replier");
    expect(replied.parentId).toBe("C1");
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
  test("parses HTTP-date form of Retry-After", () => {
    const now = () => Date.parse("2026-09-30T00:00:00.000Z");
    const headers = new Headers({ "retry-after": "Wed, 30 Sep 2026 00:00:30 GMT" });
    // 30 seconds ahead of "now".
    expect(retryAfterMs(headers, 0, now)).toBe(30_000);
  });
  test("HTTP-date already in the past returns 0", () => {
    const now = () => Date.parse("2026-09-30T00:01:00.000Z");
    const headers = new Headers({ "retry-after": "Wed, 30 Sep 2026 00:00:30 GMT" });
    expect(retryAfterMs(headers, 999, now)).toBe(0);
  });
  test("ignores a non-numeric non-date Retry-After", () => {
    expect(retryAfterMs(new Headers({ "retry-after": "later" }), 111)).toBe(111);
  });
});
