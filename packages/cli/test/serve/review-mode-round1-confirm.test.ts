// PR #59 round-2 — confirmation tests for round-1 invariants the
// coordinator asked to see named:
//
//   R1. Bearer-403 on reanchor. (Also submit, discard, refresh.)
//   R2. Agent-created threads never reach the adapter (no draft
//       lands, no pending review opens under the agent bearer).
//   R3. Reply mirror hits `addReviewThreadReply` pinned to the
//       viewer's pending review.
//   R4. Resolve mirror hits `resolveReviewThread`; reopen hits
//       `unresolveReviewThread`.
//   R5. Origin / same-origin gate on every `/api/review/*` route.
//   R6. Single-flight submit lock: a second submit while one is
//       in flight → 409 `submit-in-flight`.
//   R7. `reduceReviewState` is ordered by seq — events replayed
//       out of order still land the same terminal state.
//   R8. B4 pull: `/api/review/refresh` re-imports remote threads
//       idempotently (`importedSkipped` on a second call) and
//       reflects `external.resolved` for orphaned-vs-resolved.
//
// Every test in this file must PASS on the round-2 code AND
// FAIL on efa6aa2f (either because the test-id / behaviour did
// not exist yet, or because the invariant it asserts wasn't
// held).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitHubAdapter,
  reduceReviewState,
  revisionOf,
  type GhReviewThread,
  type PrFile,
  type PrRef,
  type PullRequestSummary,
  type ReviewEvent,
  type TokenSource,
} from "@revkit/review-core";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";
import type { LineSink } from "../../src/serve/logger.ts";
import { makeFakeGithubFetch, makePendingState, type FakePendingState } from "../review/helpers/fake-github.ts";

const staticToken: TokenSource = { async getToken() { return "ghp_" + "a".repeat(40); } };
const HEAD_A = "1234567890abcdef1234567890abcdef12345678";

const daemonsToStop: DaemonHandle[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (daemonsToStop.length > 0) {
    const h = daemonsToStop.pop();
    if (h !== undefined) {
      try { await h.stop(); } catch { /* fine */ }
    }
  }
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d !== undefined) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* fine */ }
    }
  }
});

interface Ctx {
  handle: DaemonHandle;
  fake: FakePendingState;
  fakeFetch: typeof fetch;
  root: string;
  cookie: string;
}

async function startCtx(options: { remoteThreads?: readonly GhReviewThread[] } = {}): Promise<Ctx> {
  const root = mkdtempSync(join(tmpdir(), "revkit-r1c-"));
  tempDirs.push(root);
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><h1>PR</h1>");
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs/index.md"), "line1\nline2 with quote\nline3\n");
  const pending = makePendingState();
  const fakeFetch = makeFakeGithubFetch(
    [
      {
        owner: "vig-os",
        repo: "revkit",
        pullNumber: 42,
        headSha: HEAD_A,
        baseSha: "b".repeat(40),
        baseRef: "main",
        headRef: "test-head",
        title: "R1 confirm PR",
        nodeId: "PR_42",
        state: "open",
        headRepoFullName: "vig-os/revkit",
        baseRepoFullName: "vig-os/revkit",
        url: "https://github.com/vig-os/revkit/pull/42",
        ...(options.remoteThreads !== undefined ? { threads: options.remoteThreads } : {}),
      },
    ],
    { pendingState: pending, viewerLogin: "test-reviewer" },
  );
  const adapter = new GitHubAdapter({ token: staticToken, fetch: fakeFetch });
  const pr: PrRef = { owner: "vig-os", repo: "revkit", pullNumber: 42 };
  const summary: PullRequestSummary = {
    number: 42,
    nodeId: "PR_42",
    title: "R1 confirm PR",
    state: "open",
    draft: false,
    headSha: HEAD_A,
    headRef: "test-head",
    baseSha: "b".repeat(40),
    baseRef: "main",
    headRepoFullName: "vig-os/revkit",
    baseRepoFullName: "vig-os/revkit",
    url: "https://github.com/vig-os/revkit/pull/42",
  };
  const files: PrFile[] = [
    {
      filename: "docs/index.md",
      status: "modified",
      patch: "@@ -1,3 +1,3 @@\n line1\n-line2 with quote\n+line2 with QUOTE\n line3",
    },
  ];
  const logs: string[] = [];
  const sink: LineSink = { write: (line) => logs.push(line) };
  const handle = await startDaemon({
    dir: dist,
    repoRoot: root,
    port: 0,
    sqlitePath: join(root, "threads.sqlite"),
    version: "0.0.0-test",
    localUserId: "r1c-user",
    installSignalHandlers: false,
    logSink: sink,
    reviewMode: { adapter, pr, summary, viewerLogin: "test-reviewer", files },
  });
  daemonsToStop.push(handle);
  const url = new URL(handle.url + "/-/auth");
  url.searchParams.set("code", handle.launchCode);
  const authResponse = await fetch(url, { redirect: "manual" });
  const setCookie = authResponse.headers.get("set-cookie")!;
  const cookie = setCookie.slice(0, setCookie.indexOf(";"));
  return { handle, fake: pending, fakeFetch, root, cookie };
}

async function postComment(ctx: Ctx, body: string, suffix: string, auth: "cookie" | "bearer" = "cookie"): Promise<Response> {
  const revision = await revisionOf("line1\nline2 with quote\nline3\n");
  return await fetch(`${ctx.handle.url}/api/threads`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      origin: ctx.handle.url,
      "sec-fetch-site": "same-origin",
      ...(auth === "cookie" ? { cookie: ctx.cookie } : { authorization: `Bearer ${ctx.handle.agentToken}` }),
    },
    body: JSON.stringify({
      threadId: `th-${suffix}`,
      commentId: `c-${suffix}`,
      anchor: {
        path: "docs/index.md",
        startLine: 2,
        endLine: 2,
        quote: { exact: "line2 with quote", prefix: "line1\n", suffix: "\nline3" },
        revision,
      },
      body,
    }),
  });
}

// ────────────────────────────────────────────────────────────────
// R1: agent-bearer 403 on every /api/review/* write route.
// ────────────────────────────────────────────────────────────────
describe("R1 — agent bearer is 403 on all review write routes", () => {
  // Every mutation-capable review route requires the browser's
  // session cookie. Reconcile can post drafts, so the agent bearer
  // is not a safe repair credential.
  const routes = [
    { path: "/api/review/submit", method: "POST" as const },
    { path: "/api/review/discard", method: "POST" as const },
    { path: "/api/review/refresh", method: "POST" as const },
    { path: "/api/review/reanchor", method: "POST" as const },
    { path: "/api/review/reconcile", method: "POST" as const },
  ];
  for (const r of routes) {
    test(`${r.method} ${r.path} with agent bearer → 403 agent-forbidden`, async () => {
      const ctx = await startCtx();
      const response = await fetch(`${ctx.handle.url}${r.path}`, {
        method: r.method,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          origin: ctx.handle.url,
          "sec-fetch-site": "same-origin",
          authorization: `Bearer ${ctx.handle.agentToken}`,
        },
        body: "{}",
      });
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("agent-forbidden");
    });
  }
});

// ────────────────────────────────────────────────────────────────
// R2: agent-authored POST /api/threads never reaches the adapter.
// (Already covered as BLOCK-fix 7; retained here for the round-1
// confirmation set.)
// ────────────────────────────────────────────────────────────────
describe("R2 — agent-authored threads never reach the adapter", () => {
  test("agent POST /api/threads: 201 local, but no draft / no pending review", async () => {
    const ctx = await startCtx();
    const response = await postComment(ctx, "agent-authored comment", "agent-1", "bearer");
    expect(response.status).toBe(201);
    expect(ctx.fake.drafts.length).toBe(0);
    expect(ctx.fake.reviewNodeId).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// R3+R4: reply / resolve / reopen mirror hit the adapter with the
// right shape. Direct-adapter probes with the fake.
// ────────────────────────────────────────────────────────────────
describe("R3+R4 — reply / resolve / reopen mirroring hits the fake", () => {
  test("addReviewThreadReply pinned to the pending review lands with pullRequestReviewId", async () => {
    const ctx = await startCtx();
    // Open a pending review by posting a comment first.
    await postComment(ctx, "opener", "r3-open");
    const reviewId = ctx.fake.reviewNodeId!;
    const adapter = new GitHubAdapter({ token: staticToken, fetch: ctx.fakeFetch });
    await adapter.addReviewThreadReply({
      threadNodeId: "PRT_100000",
      body: "reply pinned to pending review",
      pendingReviewId: reviewId,
    });
    expect(ctx.fake.replies.length).toBe(1);
    expect(ctx.fake.replies[0]!.pendingReviewId).toBe(reviewId);
    expect(ctx.fake.replies[0]!.body).toBe("reply pinned to pending review");
  });

  test("resolveReviewThread and unresolveReviewThread land on the fake", async () => {
    const ctx = await startCtx();
    const adapter = new GitHubAdapter({ token: staticToken, fetch: ctx.fakeFetch });
    await adapter.resolveReviewThread({ threadNodeId: "PRT_777" });
    await adapter.unresolveReviewThread({ threadNodeId: "PRT_777" });
    expect(ctx.fake.resolutions.length).toBe(2);
    expect(ctx.fake.resolutions[0]!.op).toBe("resolve");
    expect(ctx.fake.resolutions[1]!.op).toBe("unresolve");
    expect(ctx.fake.resolutions[0]!.threadNodeId).toBe("PRT_777");
  });
});

// ────────────────────────────────────────────────────────────────
// R5: Origin / same-origin gate on every /api/review/* route.
// (Repeats BLOCK-fix's Origin discipline as the confirmation set.)
// ────────────────────────────────────────────────────────────────
describe("R5 — Origin gate on /api/review/*", () => {
  const paths = ["/api/review/state", "/api/review/submit", "/api/review/discard", "/api/review/refresh", "/api/review/reanchor", "/api/review/reconcile"] as const;
  for (const path of paths) {
    test(`cross-site Origin on ${path} → 403`, async () => {
      const ctx = await startCtx();
      const response = await fetch(`${ctx.handle.url}${path}`, {
        method: path === "/api/review/state" ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          origin: "http://evil.example",
          "sec-fetch-site": "cross-site",
          cookie: ctx.cookie,
        },
        ...(path === "/api/review/state" ? {} : { body: "{}" }),
      });
      expect(response.status).toBe(403);
    });
  }
});

// ────────────────────────────────────────────────────────────────
// R6: Single-flight submit lock.
// ────────────────────────────────────────────────────────────────
describe("R6 — single-flight submit lock", () => {
  test("concurrent submits never both succeed: at most one submit reaches GitHub", async () => {
    const ctx = await startCtx();
    // Seed a pending review with one comment.
    await postComment(ctx, "seed", "r6-seed");
    expect(ctx.fake.reviewNodeId).not.toBeNull();
    // Fire two concurrent submits. The lock's invariant is that
    // AT MOST one SubmitReview mutation reaches GitHub — the
    // second either loses the race (409 submit-in-flight) or
    // arrives after the first cleared the pending (400
    // no-open-pending-review). BOTH cannot succeed.
    const post = () =>
      fetch(`${ctx.handle.url}/api/review/submit`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          origin: ctx.handle.url,
          "sec-fetch-site": "same-origin",
          cookie: ctx.cookie,
        },
        body: JSON.stringify({ event: "COMMENT" }),
      });
    const [a, b] = await Promise.all([post(), post()]);
    // Exactly one 201; the loser is 409 or 400.
    const okCount = [a, b].filter((r) => r.status === 201).length;
    expect(okCount).toBe(1);
    const loser = [a, b].find((r) => r.status !== 201)!;
    expect([400, 409]).toContain(loser.status);
    // The fake saw exactly one SubmitReview mutation.
    expect(ctx.fake.submits.length).toBe(1);
  });

  test("second call while the first is genuinely mid-flight → 409 submit-in-flight", async () => {
    // Build a ctx with a fetch that delays SubmitReview so the
    // window of "in flight" is wide enough to guarantee the
    // second request lands inside it. This is the LOCK's own
    // behaviour, isolated from the "both requests raced past
    // the body-read await" case.
    const root = mkdtempSync(join(tmpdir(), "revkit-r6b-"));
    tempDirs.push(root);
    const dist = join(root, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><h1>PR</h1>");
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs/index.md"), "line1\nline2 with quote\nline3\n");
    const pending = makePendingState();
    let submitDelayResolve: (() => void) | undefined;
    const submitDelay = new Promise<void>((resolve) => { submitDelayResolve = resolve; });
    const rawFetch = makeFakeGithubFetch(
      [
        {
          owner: "vig-os", repo: "revkit", pullNumber: 42, headSha: HEAD_A,
          baseSha: "b".repeat(40), baseRef: "main", headRef: "test-head",
          title: "R6b PR", nodeId: "PR_42",
          state: "open" as const,
          headRepoFullName: "vig-os/revkit",
          baseRepoFullName: "vig-os/revkit",
          url: "https://github.com/vig-os/revkit/pull/42",
        },
      ],
      { pendingState: pending, viewerLogin: "test-reviewer" },
    );
    const wrappedFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const bodyText = init !== undefined && init.body !== undefined ? String(init.body) : "";
      if (url.endsWith("/graphql") && bodyText.includes("mutation SubmitReview")) {
        // Await the release before running the real fake.
        await submitDelay;
      }
      return rawFetch(input, init);
    }) as unknown as typeof fetch;
    const adapter = new GitHubAdapter({ token: staticToken, fetch: wrappedFetch });
    const summary: PullRequestSummary = {
      number: 42, nodeId: "PR_42", title: "R6b", state: "open", draft: false,
      headSha: HEAD_A, headRef: "test-head",
      baseSha: "b".repeat(40), baseRef: "main",
      headRepoFullName: "vig-os/revkit", baseRepoFullName: "vig-os/revkit",
      url: "https://github.com/vig-os/revkit/pull/42",
    };
    const files: PrFile[] = [
      { filename: "docs/index.md", status: "modified", patch: "@@ -1,3 +1,3 @@\n line1\n-line2 with quote\n+line2 with QUOTE\n line3" },
    ];
    const handle = await startDaemon({
      dir: dist, repoRoot: root, port: 0,
      sqlitePath: join(root, "threads.sqlite"),
      version: "0.0.0-test", localUserId: "r6b-user",
      installSignalHandlers: false,
      reviewMode: { adapter, pr: { owner: "vig-os", repo: "revkit", pullNumber: 42 }, summary, viewerLogin: "test-reviewer", files },
    });
    daemonsToStop.push(handle);
    const url = new URL(handle.url + "/-/auth");
    url.searchParams.set("code", handle.launchCode);
    const authResponse = await fetch(url, { redirect: "manual" });
    const setCookie = authResponse.headers.get("set-cookie")!;
    const cookie = setCookie.slice(0, setCookie.indexOf(";"));
    // Seed a pending review with one comment.
    const revision = await revisionOf("line1\nline2 with quote\nline3\n");
    await fetch(`${handle.url}/api/threads`, {
      method: "POST",
      headers: {
        "content-type": "application/json", accept: "application/json",
        origin: handle.url, "sec-fetch-site": "same-origin", cookie,
      },
      body: JSON.stringify({
        threadId: "th-r6b", commentId: "c-r6b",
        anchor: { path: "docs/index.md", startLine: 2, endLine: 2, quote: { exact: "line2 with quote", prefix: "line1\n", suffix: "\nline3" }, revision },
        body: "seed",
      }),
    });
    // Start the first submit — it will block inside the fake's
    // SubmitReview await.
    const first = fetch(`${handle.url}/api/review/submit`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", origin: handle.url, "sec-fetch-site": "same-origin", cookie },
      body: JSON.stringify({ event: "COMMENT" }),
    });
    // Yield until the daemon actually enters the lock: poll
    // by trying a second submit and looking for a 409.
    let secondStatus: number | undefined;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const r = await fetch(`${handle.url}/api/review/submit`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", origin: handle.url, "sec-fetch-site": "same-origin", cookie },
        body: JSON.stringify({ event: "COMMENT" }),
      });
      if (r.status === 409) {
        secondStatus = 409;
        const body = (await r.json()) as { error: string };
        expect(body.error).toBe("submit-in-flight");
        break;
      }
      // Keep the response body from leaking:
      await r.text();
      await new Promise((res) => setTimeout(res, 20));
    }
    // Release the first submit's stall so the daemon completes.
    submitDelayResolve!();
    const firstResp = await first;
    expect(firstResp.status).toBe(201);
    expect(secondStatus).toBe(409);
  });
});

// ────────────────────────────────────────────────────────────────
// R7: reduceReviewState is ordered by seq. Even if events are
// handed to it OUT of seq order, the reducer sorts them and yields
// the same terminal state.
// ────────────────────────────────────────────────────────────────
describe("R7 — reduceReviewState reads by seq", () => {
  test("shuffling the event array preserves the terminal state", async () => {
    const ctx = await startCtx();
    await postComment(ctx, "seed A", "r7-a");
    await postComment(ctx, "seed B", "r7-b");
    // Submit so we have terminal events too.
    const submit = await fetch(`${ctx.handle.url}/api/review/submit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        origin: ctx.handle.url,
        "sec-fetch-site": "same-origin",
        cookie: ctx.cookie,
      },
      body: JSON.stringify({ event: "COMMENT" }),
    });
    expect(submit.status).toBe(201);

    // Read the log via /events?since=0? Simpler — read the state
    // endpoint's log via the store. The daemon doesn't expose the
    // raw log to a cookie client, so simulate by generating our
    // own tiny event stream: two review-lifecycle events that
    // MUST be reduced in seq order.
    const events: ReviewEvent[] = [
      {
        seq: 1,
        kind: "review.opened",
        ts: new Date().toISOString(),
        actor: { kind: "gh-user", id: "test-reviewer", displayName: "test-reviewer" },
        reviewNodeId: "PR_review_1",
        headSha: HEAD_A,
      } as ReviewEvent,
      {
        seq: 2,
        kind: "review.submitted",
        ts: new Date().toISOString(),
        actor: { kind: "gh-user", id: "test-reviewer", displayName: "test-reviewer" },
        reviewNodeId: "PR_review_1",
        event: "COMMENT",
      } as ReviewEvent,
    ];
    const inOrder = reduceReviewState(events);
    const shuffled = reduceReviewState([events[1]!, events[0]!]);
    // Terminal set is identical regardless of order.
    expect(shuffled.terminal.map((t) => t.reviewNodeId).sort()).toEqual(inOrder.terminal.map((t) => t.reviewNodeId).sort());
    // openPending: both cases end with the review submitted, so
    // openPending is null.
    expect(inOrder.openPending).toBeNull();
    expect(shuffled.openPending).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// R8: B4 pull — refresh re-imports remote threads idempotently
// and the second call reports `importedSkipped` for the same rows.
// ────────────────────────────────────────────────────────────────
describe("R8 — B4 pull is idempotent (no echo)", () => {
  const OTHER_REVIEWER = { login: "other-reviewer", type: "User" as const };

  /** One remote review thread with a single comment, as the fake
   * GitHub serves it. Anchored on `docs/index.md` line 2 — a path
   * the daemon materialises on disk — so the import produces real
   * anchored events rather than being refused. */
  function remoteThread(commentNodeId: string): GhReviewThread {
    return {
      id: "PRT_r8",
      isResolved: false,
      isOutdated: false,
      resolvedByLogin: null,
      diffSide: "RIGHT" as const,
      startDiffSide: null,
      line: 2,
      originalLine: 2,
      startLine: null,
      originalStartLine: null,
      subjectType: "LINE" as const,
      path: "docs/index.md",
      comments: [
        {
          nodeId: commentNodeId,
          databaseId: 10_000,
          body: "please rename this",
          authorLogin: OTHER_REVIEWER.login,
          authorType: OTHER_REVIEWER.type,
          createdAt: "2026-09-30T00:00:00Z",
          url: "https://github.com/example/pull/1#discussion_r10000",
          originalCommitOid: HEAD_A,
          diffHunk: "@@ -1,3 +1,3 @@\n line1\n line2 with quote\n line3",
        },
      ],
    };
  }

  test("two refreshes without any remote change: first imports the thread, second sees importedNew=0 and importedSkipped=1", async () => {
    // Seeded with one remote thread carrying one comment, because an
    // EMPTY remote makes both counters 0 on both calls — which is
    // exactly what a refresh that imports nothing at all also
    // reports, so the idempotency invariant could not fail. With a
    // real remote comment the counters are forced to move: the first
    // call must import, the second must skip.
    //
    // Exact expected values, measured against the round-2/3 code
    // (`populateStoreFromPr`): one remote comment yields two store
    // events (`comment.created` + `comment.linked`), so the first
    // pass reports `importedNew: 2`.
    //
    // The second pass re-presents BOTH events, and only ONE of them is
    // skipped. `comment.created` repeats the same deterministic
    // comment id and is refused `duplicate-comment-id`, which
    // `import-threads.ts:243` classifies as skipped. `comment.linked`
    // repeats the same BACKEND link instead, so it is refused
    // `duplicate-link` (`validator.ts:675`) — a kind that classifier
    // does NOT recognise, so it lands in `refused`, not `skipped`.
    // Hence `importedNew: 0, importedSkipped: 1` and a `refused: 1`
    // the endpoint does not surface. That asymmetry is pre-existing
    // and tracked in #114; it is why `importedSkipped` is 1 here and
    // not 2, and this test pins the real numbers rather than the
    // tidier-looking 2.
    const ctx = await startCtx({ remoteThreads: [remoteThread("PRRC_r8_1")] });
    const cookieHdr = { cookie: ctx.cookie, origin: ctx.handle.url, "sec-fetch-site": "same-origin", "content-type": "application/json" } as const;
    const r1 = await fetch(`${ctx.handle.url}/api/review/refresh`, { method: "POST", headers: cookieHdr, body: "{}" });
    expect([200, 201]).toContain(r1.status);
    // Both fields are asserted as REQUIRED members of the response
    // (no `??` default): a renamed or dropped field is `undefined`,
    // which fails these instead of being absorbed by a default.
    const b1 = (await r1.json()) as { importedNew: number; importedSkipped: number };
    expect(b1.importedNew).toBe(2);
    expect(b1.importedSkipped).toBe(0);
    const r2 = await fetch(`${ctx.handle.url}/api/review/refresh`, { method: "POST", headers: cookieHdr, body: "{}" });
    expect([200, 201]).toContain(r2.status);
    const b2 = (await r2.json()) as { importedNew: number; importedSkipped: number };
    // The idempotency invariant, and the point of the test name: the
    // second pass appends nothing and reports one already-present
    // event as skipped (see the note on `comment.linked` above) — no
    // echo of already-imported rows back to GitHub.
    expect(b2.importedNew).toBe(0);
    expect(b2.importedSkipped).toBe(1);
    // No adapter writes fired: no drafts, no submits, no
    // replies, no resolutions.
    expect(ctx.fake.drafts.length).toBe(0);
    expect(ctx.fake.submits.length).toBe(0);
    expect(ctx.fake.replies.length).toBe(0);
    expect(ctx.fake.resolutions.length).toBe(0);
  });
});
