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
  inputs: readonly Awaited<ReturnType<typeof GitHubAdapter.mapThreadsToEvents>>["events"][number][],
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
    const { events, orphanedThreadIds, snapshots } = await GitHubAdapter.mapThreadsToEvents({
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
    const { events, orphanedThreadIds, snapshots } = await GitHubAdapter.mapThreadsToEvents({
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
    const { events, orphanedThreadIds } = await GitHubAdapter.mapThreadsToEvents({
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
    const { events } = await GitHubAdapter.mapThreadsToEvents({
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
    const { events, orphanedThreadIds } = await GitHubAdapter.mapThreadsToEvents({
      threads: [t],
      threadIdOf: () => "T-un",
      commentIdOf: (_t, c) => `C${c.databaseId}`,
      headRevisionOf: () => HEAD_REV,
      headSourceOf: () => HEAD_SOURCE,
      resolveSnapshot: () => ({ kind: "unavailable", reason: "not-found" }),
    });
    expect(orphanedThreadIds).toEqual(["T-un"]);
    const orphan = events.find((e) => e.kind === "thread.orphaned");
    if (orphan?.kind !== "thread.orphaned") throw new Error("kind");
    expect(orphan.reason).toBe("not-found");
    // BLOCKER (PR-43 round-4): the anchor MUST NOT carry the head
    // revision when the snapshot is unavailable — a head revision
    // pins the thread at head lines that don't actually contain
    // its content. We use a deterministic non-file revision
    // (hash of the comment body under a namespace tag) instead.
    const created = events[0]!;
    if (created.kind !== "comment.created") throw new Error("kind");
    expect(created.anchor.revision).not.toBe(HEAD_REV);
    expect(created.anchor.commit).toBeUndefined();
  });
});

describe("mapThreadsToEvents — Blocker (PR-43 round-4): resolved+unavailable NEVER pins at head", () => {
  test("RES_OUT_UNAV: resolved+outdated+unavailable emits thread.orphaned (not resolved) and no head-relative anchor", async () => {
    if (HEAD_REV === "") HEAD_REV = await revisionOf(HEAD_SOURCE);
    const t = thread({
      line: null,
      startLine: null,
      originalLine: 40,
      isOutdated: true,
      isResolved: true,
      resolvedByLogin: "carol",
    });
    const { events, orphanedThreadIds } = await GitHubAdapter.mapThreadsToEvents({
      threads: [t],
      threadIdOf: () => "RES_OUT_UNAV",
      commentIdOf: (_t, c) => `C${c.databaseId}`,
      headRevisionOf: () => HEAD_REV,
      headSourceOf: () => HEAD_SOURCE,
      // Content unavailable (deleted / binary / truncated / not-found).
      resolveSnapshot: () => ({ kind: "unavailable", reason: "not-found" }),
    });
    // The terminal transition is thread.orphaned, not
    // thread.resolved — resolved-on-GitHub is preserved in the
    // reason string but the anchor is not authoritative.
    expect(orphanedThreadIds).toEqual(["RES_OUT_UNAV"]);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("thread.orphaned");
    expect(kinds).not.toContain("thread.resolved");
    const orphan = events.find((e) => e.kind === "thread.orphaned")!;
    if (orphan.kind !== "thread.orphaned") throw new Error("kind");
    expect(orphan.reason).toContain("not-found");
    expect(orphan.reason).toContain("was-resolved-on-github");
    // Anchor: no head revision, no `commit` (nothing to pin to).
    const created = events[0]!;
    if (created.kind !== "comment.created") throw new Error("kind");
    expect(created.anchor.revision).not.toBe(HEAD_REV);
    expect(created.anchor.commit).toBeUndefined();
  });

  test("RES_LEFT_UNAV: resolved+LEFT+unavailable also emits thread.orphaned, not resolved", async () => {
    if (HEAD_REV === "") HEAD_REV = await revisionOf(HEAD_SOURCE);
    const t = thread({
      diffSide: "LEFT",
      line: 7,
      originalLine: 7,
      isResolved: true,
      resolvedByLogin: "carol",
    });
    const { events, orphanedThreadIds } = await GitHubAdapter.mapThreadsToEvents({
      threads: [t],
      threadIdOf: () => "RES_LEFT_UNAV",
      commentIdOf: (_t, c) => `C${c.databaseId}`,
      headRevisionOf: () => HEAD_REV,
      headSourceOf: () => HEAD_SOURCE,
      resolveSnapshot: () => ({ kind: "unavailable", reason: "not-found" }),
    });
    expect(orphanedThreadIds).toEqual(["RES_LEFT_UNAV"]);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("thread.orphaned");
    expect(kinds).not.toContain("thread.resolved");
    const created = events[0]!;
    if (created.kind !== "comment.created") throw new Error("kind");
    expect(created.anchor.revision).not.toBe(HEAD_REV);
    expect(created.anchor.commit).toBeUndefined();
  });

  test("LEFTRES via importThreads: LEFT+resolved fetches parent-of-originalCommit blob (never head; never originalCommit alone)", async () => {
    // Fake fetch: only allow `<oid>^:<path>` expressions to
    // succeed. If importThreads tries `<oid>:<path>` for a LEFT
    // thread, this returns null and the thread becomes
    // unavailable — the assertion below would fail.
    const captured: string[] = [];
    const parentBlobText = "line 1\nline 2\nleft-side target\nline 4\n";
    let parentRev = "";
    const baseFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = JSON.parse((init as { body: string }).body) as {
        query: string;
        variables: { expression?: string };
      };
      if (/query FetchBlobText/.test(body.query)) {
        const expr = body.variables.expression ?? "";
        captured.push(expr);
        if (expr.includes("^:")) {
          return new Response(
            JSON.stringify({
              data: {
                repository: {
                  object: {
                    __typename: "Blob",
                    text: parentBlobText,
                    isBinary: false,
                    isTruncated: false,
                  },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        // NOT parent-of-originalCommit → refuse (return null).
        return new Response(
          JSON.stringify({ data: { repository: { object: null } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    };
    (baseFetch as { preconnect?: (url: string) => void }).preconnect = () => {};

    const adapter = new GitHubAdapter({
      token: { async getToken() { return "test-token-value-long-enough-01234567"; } },
      fetch: baseFetch as unknown as typeof fetch,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 },
    });
    parentRev = await revisionOf(parentBlobText);
    if (HEAD_REV === "") HEAD_REV = await revisionOf(HEAD_SOURCE);
    const t = thread({
      diffSide: "LEFT",
      startDiffSide: null,
      line: 3,
      startLine: null,
      originalLine: 3,
      originalStartLine: null,
      isResolved: true,
      resolvedByLogin: "carol",
      comments: [
        {
          databaseId: 1,
          nodeId: "n1",
          body: "left comment",
          authorLogin: "alice",
          authorType: "User",
          createdAt: "t1",
          url: "u1",
          originalCommitOid: "9".repeat(40),
        },
      ],
    });
    const { events } = await adapter.importThreads({
      pr: { owner: "o", repo: "r", pullNumber: 1 },
      threads: [t],
      threadIdOf: () => "LEFTRES",
      commentIdOf: (_t, c) => `C${c.databaseId}`,
      headRevisionOf: () => HEAD_REV,
    });
    // Exactly the parent expression was queried.
    expect(captured).toEqual([`${"9".repeat(40)}^:docs/x.mdx`]);
    // Anchor uses the parent blob's revision, NOT head, and NOT
    // originalCommit's own revision.
    const created = events[0]!;
    if (created.kind !== "comment.created") throw new Error("kind");
    expect(created.anchor.revision).toBe(parentRev);
    expect(created.anchor.revision).not.toBe(HEAD_REV);
    // For a resolved thread with a KNOWN own-commit anchor, the
    // pipeline emits thread.resolved (not orphaned).
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("thread.resolved");
    expect(kinds).not.toContain("thread.orphaned");
    // No event carries head revision.
    for (const e of events) {
      if (e.kind === "comment.created") {
        expect(e.anchor.revision).not.toBe(HEAD_REV);
      }
    }
  });

  test("importThreads: LEFT rename uses oldPathOf(current) → previousFilename", async () => {
    const captured: string[] = [];
    const parentBlobText = "old file contents\nline 2\n";
    const baseFetch = async (_input: string | URL | Request, init: RequestInit = {}) => {
      const body = JSON.parse((init as { body: string }).body) as {
        query: string;
        variables: { expression?: string };
      };
      if (/query FetchBlobText/.test(body.query)) {
        captured.push(body.variables.expression ?? "");
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                object: {
                  __typename: "Blob",
                  text: parentBlobText,
                  isBinary: false,
                  isTruncated: false,
                },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    };
    (baseFetch as { preconnect?: (url: string) => void }).preconnect = () => {};
    const adapter = new GitHubAdapter({
      token: { async getToken() { return "test-token-value-long-enough-01234567"; } },
      fetch: baseFetch as unknown as typeof fetch,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 },
    });
    const t = thread({
      path: "docs/new-name.mdx",
      diffSide: "LEFT",
      line: 1,
      originalLine: 1,
      comments: [
        {
          databaseId: 1,
          nodeId: "n1",
          body: "left",
          authorLogin: "alice",
          authorType: "User",
          createdAt: "t1",
          url: "u1",
          originalCommitOid: "5".repeat(40),
        },
      ],
    });
    await adapter.importThreads({
      pr: { owner: "o", repo: "r", pullNumber: 1 },
      threads: [t],
      threadIdOf: () => "LEFT_RENAME",
      commentIdOf: (_t, c) => `C${c.databaseId}`,
      headRevisionOf: () => "0".repeat(64),
      oldPathOf: (p) => (p === "docs/new-name.mdx" ? "docs/old-name.mdx" : undefined),
    });
    expect(captured).toEqual([`${"5".repeat(40)}^:docs/old-name.mdx`]);
  });
});

describe("mapThreadsToEvents — mutant killers (own-commit revision, side isolation)", () => {
  test("own-commit revision equals revisionOf(content) exactly", async () => {
    const content = "some own-commit content\nline 2\nline 3\n";
    const rev = await revisionOf(content);
    const t = thread({ line: null, originalLine: 2, isOutdated: true });
    const { events, snapshots } = await GitHubAdapter.mapThreadsToEvents({
      threads: [t],
      threadIdOf: () => "T",
      commentIdOf: (_t, c) => `C${c.databaseId}`,
      headRevisionOf: () => "0".repeat(64),
      resolveSnapshot: () => ({ kind: "own-commit", content, oid: "9".repeat(40), revision: rev }),
    });
    const created = events[0]!;
    if (created.kind !== "comment.created") throw new Error("kind");
    // If a mutation replaces `snapshot.revision` with a different
    // value, this fails.
    expect(created.anchor.revision).toBe(rev);
    // Snapshot map keyed by that revision.
    expect(snapshots.get(rev)).toBe(content);
  });

  test("importThreads: RIGHT-side outdated uses originalCommitOid, LEFT uses originalCommitOid^", async () => {
    // Two threads: one RIGHT-outdated, one LEFT. The recorder
    // captures the exact expressions sent, so a bug that used the
    // wrong side's oid would fail the equality check.
    const rightSource = "R content\n";
    const leftSource = "L content\n";
    const captured: string[] = [];
    const baseFetch = async (_input: string | URL | Request, init: RequestInit = {}) => {
      const body = JSON.parse((init as { body: string }).body) as {
        query: string;
        variables: { expression?: string };
      };
      if (/query FetchBlobText/.test(body.query)) {
        const expr = body.variables.expression ?? "";
        captured.push(expr);
        const text = expr.includes("^:") ? leftSource : rightSource;
        return new Response(
          JSON.stringify({
            data: { repository: { object: { __typename: "Blob", text, isBinary: false, isTruncated: false } } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    };
    (baseFetch as { preconnect?: (url: string) => void }).preconnect = () => {};
    const adapter = new GitHubAdapter({
      token: { async getToken() { return "test-token-value-long-enough-01234567"; } },
      fetch: baseFetch as unknown as typeof fetch,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 },
    });
    const outdatedRight = thread({
      id: "T-R",
      isOutdated: true,
      line: null,
      originalLine: 1,
      comments: [
        {
          databaseId: 1, nodeId: "nR", body: "r", authorLogin: "a", authorType: "User",
          createdAt: "t", url: "u", originalCommitOid: "a".repeat(40),
        },
      ],
    });
    const leftThread = thread({
      id: "T-L",
      diffSide: "LEFT",
      line: 1,
      originalLine: 1,
      comments: [
        {
          databaseId: 2, nodeId: "nL", body: "l", authorLogin: "a", authorType: "User",
          createdAt: "t", url: "u", originalCommitOid: "b".repeat(40),
        },
      ],
    });
    await adapter.importThreads({
      pr: { owner: "o", repo: "r", pullNumber: 1 },
      threads: [outdatedRight, leftThread],
      threadIdOf: (t) => t.id,
      commentIdOf: (_t, c) => `C${c.databaseId}`,
      headRevisionOf: () => "0".repeat(64),
    });
    // Order-preserving: RIGHT uses <oid>:path, LEFT uses <oid>^:path.
    expect(captured.sort()).toEqual([
      `${"a".repeat(40)}:docs/x.mdx`,
      `${"b".repeat(40)}^:docs/x.mdx`,
    ]);
  });

  test("fetchBlobText: binary and truncated map to their own reasons (not not-found)", async () => {
    const adapter = new GitHubAdapter({
      token: { async getToken() { return "test-token-value-long-enough-01234567"; } },
      fetch: ((async () => new Response("", { status: 500 })) as unknown as typeof fetch),
      retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 },
    });
    // Replace `graphql` with a canned function per case.
    const cases = [
      { resp: { data: { repository: { object: { __typename: "Blob", isBinary: true } } } }, expected: "binary" as const },
      { resp: { data: { repository: { object: { __typename: "Blob", isTruncated: true, text: "ignored" } } } }, expected: "truncated" as const },
      { resp: { data: { repository: { object: null } } }, expected: "not-found" as const },
      { resp: { data: { repository: { object: { __typename: "Tree" } } } }, expected: "not-a-blob" as const },
    ];
    for (const c of cases) {
      // Stub the retry-wrapped GraphQL method for this test.
      (adapter as unknown as { graphqlWithRetry: unknown }).graphqlWithRetry = async () => c.resp;
      const r = await adapter.fetchBlobText({ owner: "o", repo: "r", expression: "abc:path" });
      expect(r.kind).toBe(c.expected);
    }
  });
});

describe("mapThreadsToEvents — multi-comment threads", () => {
  test("first author is used for comment.created, replies use their own authors, parentId chain OK", async () => {
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
    const { events } = await GitHubAdapter.mapThreadsToEvents({
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
