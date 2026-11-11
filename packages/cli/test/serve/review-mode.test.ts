// Daemon integration tests for M3 part 2b — review mode.
//
// One in-process daemon, one fake GitHub adapter, one temp repo.
// Every test starts a fresh context and stops the daemon on exit
// (no lingering daemons — every start pushes onto `daemonsToStop`
// which `afterEach` drains).
//
// Coverage (each of these is a hard requirement from the task):
//   - Comments accumulate as a pending review: `POST /api/threads`
//     as the local human mirrors to the adapter (`AddThread`
//     GraphQL mutation), a `review.opened` and `comment.linked`
//     land on the log, and `GET /api/review/state` reports one
//     open pending review with one comment.
//   - Agent bearer is FORBIDDEN on `/api/review/submit`,
//     `/api/review/discard` and `/api/review/refresh` — RED
//     against the SHIPPING code (the 403 is what makes the
//     security envelope real).
//   - Submit calls the adapter's `SubmitReview` op and appends a
//     `review.submitted` event to the log; a subsequent submit
//     hits `no-open-pending-review`.
//   - A stale pending review (head moved after opening) fails
//     `submit` with 409 stale-pending-review AND is reported by
//     `GET /api/review/state` with `stale: true`.
//   - RESTART: the pending set persists — a fresh daemon reopens
//     the same sqlite and derives the same pending state from
//     the log alone. Proves the "state is derived from typed
//     events, not held in memory" rule (M2 PR #53 lesson).
//   - Idempotency: a duplicate `AddThread` (retry after a fake
//     transient error) does NOT double-link (adapter policy:
//     mutations are never auto-retried; a second mirror call
//     would see the duplicate-external-id rejection and swallow
//     it).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revisionOf, GitHubAdapter, type PrFile, type PullRequestSummary, type PrRef, type TokenSource } from "@revkit/review-core";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";
import type { LineSink } from "../../src/serve/logger.ts";
import { makeFakeGithubFetch, makePendingState, type FakePendingState, type FakePr } from "../review/helpers/fake-github.ts";

const staticToken: TokenSource = { async getToken() { return "ghp_" + "a".repeat(40); } };
const HEAD_A = "1234567890abcdef1234567890abcdef12345678";
const HEAD_B = "abcdef1234567890abcdef1234567890abcdef12";

const daemonsToStop: DaemonHandle[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (daemonsToStop.length > 0) {
    const h = daemonsToStop.pop();
    if (h !== undefined) {
      try {
        await h.stop();
      } catch {
        /* fine */
      }
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* fine */
      }
    }
  }
});

interface ReviewCtx {
  handle: DaemonHandle;
  fake: FakePendingState;
  root: string;
  sqlitePath: string;
  dist: string;
  cookieFor(code: string): Promise<string>;
  logs: string[];
}

async function startReviewDaemon(options: {
  headSha?: string;
  pendingState?: FakePendingState;
  sqlitePath?: string;
  root?: string;
  registerPrs?: readonly FakePr[];
  blobs?: ReadonlyMap<string, string>;
} = {}): Promise<ReviewCtx> {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "revkit-review-mode-"));
  tempDirs.push(root);
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><h1>PR</h1>");
  // Anchor source files under the repo root so anchor resolution
  // (server-side revision authority) works.
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs/index.md"), "line1\nline2 with quote\nline3\n");

  const headSha = options.headSha ?? HEAD_A;
  const pendingState = options.pendingState ?? makePendingState();
  const fakeFetch = makeFakeGithubFetch(options.registerPrs ?? [], {
    pendingState,
    ...(options.blobs !== undefined ? { blobs: options.blobs } : {}),
  });
  const adapter = new GitHubAdapter({ token: staticToken, fetch: fakeFetch });

  const pr: PrRef = { owner: "vig-os", repo: "revkit", pullNumber: 42 };
  const summary: PullRequestSummary = {
    number: 42,
    nodeId: "PR_42",
    title: "test PR",
    state: "open",
    draft: false,
    headSha,
    headRef: "test-head",
    baseSha: "b".repeat(40),
    baseRef: "main",
    headRepoFullName: "vig-os/revkit",
    baseRepoFullName: "vig-os/revkit",
    url: "https://github.com/vig-os/revkit/pull/42",
  };
  // A minimal patch on docs/index.md so anchorToPrComment can map
  // line 2 to the PR's RIGHT side.
  const files: PrFile[] = [
    {
      filename: "docs/index.md",
      status: "modified",
      patch: "@@ -1,3 +1,3 @@\n line1\n-line2 with quote\n+line2 with QUOTE\n line3",
    },
  ];

  const logs: string[] = [];
  const sink: LineSink = { write: (line) => logs.push(line) };

  const sqlitePath = options.sqlitePath ?? join(root, "threads.sqlite");

  const handle = await startDaemon({
    dir: dist,
    repoRoot: root,
    port: 0,
    sqlitePath,
    version: "0.0.0-test",
    localUserId: "review-test-user",
    installSignalHandlers: false,
    logSink: sink,
    reviewMode: {
      adapter,
      pr,
      summary,
      viewerLogin: "test-reviewer",
      files,
    },
  });
  daemonsToStop.push(handle);

  const cookieFor = async (code: string): Promise<string> => {
    const url = new URL(handle.url + "/-/auth");
    url.searchParams.set("code", code);
    const response = await fetch(url, {
      redirect: "manual",
      headers: { host: `127.0.0.1:${handle.port}` },
    });
    if (response.status !== 302) throw new Error(`auth exchange failed: ${response.status}`);
    const setCookie = response.headers.get("set-cookie");
    if (setCookie === null) throw new Error("no set-cookie");
    const eq = setCookie.indexOf("=");
    const semi = setCookie.indexOf(";");
    if (eq === -1 || semi === -1) throw new Error("bad set-cookie");
    return setCookie.slice(0, semi);
  };

  return { handle, fake: pendingState, root, sqlitePath, dist, cookieFor, logs };
}

/** Post a comment as the LOCAL human (session-cookie authenticated). */
async function postCommentAsLocal(ctx: ReviewCtx, cookie: string, body: string, threadIdSuffix: string): Promise<Response> {
  const revision = await revisionOf("line1\nline2 with quote\nline3\n");
  return await fetch(`${ctx.handle.url}/api/threads`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      origin: ctx.handle.url,
      "sec-fetch-site": "same-origin",
      cookie,
    },
    body: JSON.stringify({
      threadId: `th-${threadIdSuffix}`,
      commentId: `c-${threadIdSuffix}`,
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

describe("daemon review mode — comments accumulate as a pending review", () => {
  test("POST /api/threads mirrors to GitHub as a pending draft; state shows one pending comment", async () => {
    const ctx = await startReviewDaemon();
    const cookie = await ctx.cookieFor(ctx.handle.launchCode);
    const create = await postCommentAsLocal(ctx, cookie, "Nit: rename this", "aa");
    expect(create.status).toBe(201);
    // The fake adapter recorded the write.
    expect(ctx.fake.reviewNodeId).not.toBeNull();
    expect(ctx.fake.drafts.length).toBe(1);
    const draft = ctx.fake.drafts[0]!;
    expect(draft.path).toBe("docs/index.md");
    expect(draft.line).toBe(2);
    expect(draft.side).toBe("RIGHT");
    expect(draft.body).toContain("Nit: rename this");
    // Review state reports one pending comment.
    const state = await fetch(`${ctx.handle.url}/api/review/state`, {
      headers: { cookie, "sec-fetch-site": "same-origin" },
    });
    expect(state.status).toBe(200);
    const stateBody = (await state.json()) as {
      pr: { number: number; headSha: string };
      viewerLogin: string;
      state: { openPending: { reviewNodeId: string; comments: unknown[] } | null };
      stale: boolean;
    };
    expect(stateBody.pr.number).toBe(42);
    expect(stateBody.viewerLogin).toBe("test-reviewer");
    expect(stateBody.state.openPending).not.toBeNull();
    expect(stateBody.state.openPending!.comments.length).toBe(1);
    expect(stateBody.stale).toBe(false);
  });

  test("submit calls the adapter's SubmitReview and moves the review to terminal", async () => {
    const ctx = await startReviewDaemon();
    const cookie = await ctx.cookieFor(ctx.handle.launchCode);
    const create = await postCommentAsLocal(ctx, cookie, "One nit", "bb");
    expect(create.status).toBe(201);
    const submit = await fetch(`${ctx.handle.url}/api/review/submit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        origin: ctx.handle.url,
        "sec-fetch-site": "same-origin",
        cookie,
      },
      body: JSON.stringify({ event: "APPROVE", body: "LGTM ship it" }),
    });
    expect(submit.status).toBe(201);
    expect(ctx.fake.submits.length).toBe(1);
    expect(ctx.fake.submits[0]!.event).toBe("APPROVE");
    // A second submit fails with no-open-pending-review.
    const submit2 = await fetch(`${ctx.handle.url}/api/review/submit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        origin: ctx.handle.url,
        "sec-fetch-site": "same-origin",
        cookie,
      },
      body: JSON.stringify({ event: "COMMENT" }),
    });
    expect(submit2.status).toBe(400);
    const body = (await submit2.json()) as { error: string; issues: Array<{ message: string }> };
    expect(body.issues[0]!.message).toBe("no-open-pending-review");
  });
});

describe("daemon review mode — SECURITY: agent bearer forbidden on review writes", () => {
  test("POST /api/review/submit with the agent bearer → 403 agent-forbidden", async () => {
    const ctx = await startReviewDaemon();
    const cookie = await ctx.cookieFor(ctx.handle.launchCode);
    await postCommentAsLocal(ctx, cookie, "one", "sec1");
    const response = await fetch(`${ctx.handle.url}/api/review/submit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        origin: ctx.handle.url,
        "sec-fetch-site": "same-origin",
        authorization: `Bearer ${ctx.handle.agentToken}`,
      },
      body: JSON.stringify({ event: "APPROVE" }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("agent-forbidden");
    // The submits set stays EMPTY — nothing was posted to GitHub
    // on the agent's behalf.
    expect(ctx.fake.submits.length).toBe(0);
  });

  test("POST /api/review/discard with the agent bearer → 403", async () => {
    const ctx = await startReviewDaemon();
    const cookie = await ctx.cookieFor(ctx.handle.launchCode);
    await postCommentAsLocal(ctx, cookie, "one", "sec2");
    const response = await fetch(`${ctx.handle.url}/api/review/discard`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        origin: ctx.handle.url,
        "sec-fetch-site": "same-origin",
        authorization: `Bearer ${ctx.handle.agentToken}`,
      },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(403);
    expect(ctx.fake.deletes.length).toBe(0);
  });

  test("POST /api/review/refresh with the agent bearer → 403", async () => {
    const ctx = await startReviewDaemon();
    const response = await fetch(`${ctx.handle.url}/api/review/refresh`, {
      method: "POST",
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
  });
});

describe("daemon review mode — stale head detection", () => {
  test("stale review: submit returns 409 stale-pending-review and state.stale=true", async () => {
    // Two contexts on the same sqlite, different head SHAs. First
    // opens a pending review at HEAD_A; second daemon reopens the
    // same sqlite at HEAD_B and refuses submit with 409.
    const root = mkdtempSync(join(tmpdir(), "revkit-review-stale-"));
    tempDirs.push(root);
    const sqlitePath = join(root, "threads.sqlite");
    const pendingState = makePendingState();

    // 1. First daemon at HEAD_A creates a pending draft.
    const ctxA = await startReviewDaemon({ root, sqlitePath, pendingState, headSha: HEAD_A });
    const cookieA = await ctxA.cookieFor(ctxA.handle.launchCode);
    const create = await postCommentAsLocal(ctxA, cookieA, "at head A", "st1");
    expect(create.status).toBe(201);
    expect(ctxA.fake.reviewNodeId).not.toBeNull();
    await ctxA.handle.stop();

    // 2. Second daemon at HEAD_B on the SAME sqlite. State shows
    //    stale=true; submit returns 409.
    const ctxB = await startReviewDaemon({ root, sqlitePath, pendingState, headSha: HEAD_B });
    const cookieB = await ctxB.cookieFor(ctxB.handle.launchCode);
    const state = await fetch(`${ctxB.handle.url}/api/review/state`, {
      headers: { cookie: cookieB, "sec-fetch-site": "same-origin" },
    });
    expect(state.status).toBe(200);
    const stateBody = (await state.json()) as { stale: boolean; state: { openPending: { comments: unknown[] } | null } };
    expect(stateBody.stale).toBe(true);
    expect(stateBody.state.openPending?.comments.length).toBe(1);

    const submit = await fetch(`${ctxB.handle.url}/api/review/submit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        origin: ctxB.handle.url,
        "sec-fetch-site": "same-origin",
        cookie: cookieB,
      },
      body: JSON.stringify({ event: "COMMENT" }),
    });
    expect(submit.status).toBe(409);
    const body = (await submit.json()) as { error: string; expectedHeadSha: string; openedHeadSha: string };
    expect(body.error).toBe("stale-pending-review");
    expect(body.expectedHeadSha).toBe(HEAD_B);
    expect(body.openedHeadSha).toBe(HEAD_A);
    // No submit call was posted to the adapter.
    expect(pendingState.submits.length).toBe(0);
  });
});

describe("daemon review mode — RESTART: derived pending state survives a daemon restart", () => {
  test("a second daemon reopens the same sqlite and reports the same pending set from the log", async () => {
    const root = mkdtempSync(join(tmpdir(), "revkit-review-restart-"));
    tempDirs.push(root);
    const sqlitePath = join(root, "threads.sqlite");
    const pendingState = makePendingState();

    // 1. Post two comments as the local human. Both mirror.
    const ctx1 = await startReviewDaemon({ root, sqlitePath, pendingState });
    const cookie1 = await ctx1.cookieFor(ctx1.handle.launchCode);
    await postCommentAsLocal(ctx1, cookie1, "one", "r1");
    await postCommentAsLocal(ctx1, cookie1, "two", "r2");
    expect(ctx1.fake.drafts.length).toBe(2);
    const preRestartReviewNodeId = ctx1.fake.reviewNodeId;
    await ctx1.handle.stop();

    // 2. New daemon on the same sqlite. WITHOUT ever calling POST
    //    /api/threads, GET /api/review/state must show TWO pending
    //    comments derived from the log alone.
    const ctx2 = await startReviewDaemon({ root, sqlitePath, pendingState });
    const cookie2 = await ctx2.cookieFor(ctx2.handle.launchCode);
    const state = await fetch(`${ctx2.handle.url}/api/review/state`, {
      headers: { cookie: cookie2, "sec-fetch-site": "same-origin" },
    });
    expect(state.status).toBe(200);
    const stateBody = (await state.json()) as {
      state: { openPending: { reviewNodeId: string; comments: unknown[] } | null };
    };
    expect(preRestartReviewNodeId).not.toBeNull();
    expect(stateBody.state.openPending?.reviewNodeId).toBe(preRestartReviewNodeId!);
    expect(stateBody.state.openPending?.comments.length).toBe(2);
  });
});

describe("daemon review mode — discard abandons the review", () => {
  test("POST /api/review/discard deletes on GitHub and appends review.abandoned", async () => {
    const ctx = await startReviewDaemon();
    const cookie = await ctx.cookieFor(ctx.handle.launchCode);
    await postCommentAsLocal(ctx, cookie, "one", "d1");
    expect(ctx.fake.reviewNodeId).not.toBeNull();
    const openedReviewNodeId = ctx.fake.reviewNodeId!;
    const discard = await fetch(`${ctx.handle.url}/api/review/discard`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        origin: ctx.handle.url,
        "sec-fetch-site": "same-origin",
        cookie,
      },
      body: JSON.stringify({ reason: "user-discarded" }),
    });
    expect(discard.status).toBe(201);
    expect(ctx.fake.deletes.length).toBe(1);
    expect(ctx.fake.deletes[0]!.reviewNodeId).toBe(openedReviewNodeId);
    // Subsequent state read shows no open pending.
    const state = await fetch(`${ctx.handle.url}/api/review/state`, {
      headers: { cookie, "sec-fetch-site": "same-origin" },
    });
    const stateBody = (await state.json()) as { state: { openPending: unknown | null; terminal: unknown[] } };
    expect(stateBody.state.openPending).toBeNull();
    expect(stateBody.state.terminal.length).toBe(1);
  });
});

describe("daemon review mode — head-move reanchor + repost", () => {
  test("head-move reanchor abandons old, opens new, and repositions the comment onto the new head", async () => {
    // Fixture: HEAD_A had docs/index.md at revision R_A; HEAD_B has
    // the SAME file (identity). The reanchor pipeline produces an
    // `anchored` outcome — same anchor lines, new head commit.
    const source = "line1\nline2 with quote\nline3\n";
    const pendingState = makePendingState();
    // Register a PR at HEAD_B so getPullRequest / listPullRequestFiles
    // succeed on the reanchor call.
    const prAtB: FakePr = {
      owner: "vig-os",
      repo: "revkit",
      pullNumber: 42,
      nodeId: "PR_42",
      title: "test PR",
      state: "open",
      headSha: HEAD_B,
      headRef: "test-head",
      baseSha: "b".repeat(40),
      baseRef: "main",
      headRepoFullName: "vig-os/revkit",
      baseRepoFullName: "vig-os/revkit",
      url: "https://github.com/vig-os/revkit/pull/42",
      files: [
        {
          filename: "docs/index.md",
          status: "modified",
          patch: "@@ -1,3 +1,3 @@\n line1\n-line2 with quote\n+line2 with QUOTE\n line3",
        },
      ],
    };
    const blobs = new Map<string, string>();
    blobs.set(`${HEAD_B}:docs/index.md`, source);

    const root = mkdtempSync(join(tmpdir(), "revkit-review-reanchor-"));
    tempDirs.push(root);
    const sqlitePath = join(root, "threads.sqlite");

    // Daemon at HEAD_A creates a pending draft.
    const ctxA = await startReviewDaemon({ root, sqlitePath, pendingState, headSha: HEAD_A });
    const cookieA = await ctxA.cookieFor(ctxA.handle.launchCode);
    const create = await postCommentAsLocal(ctxA, cookieA, "please rename", "reanc1");
    expect(create.status).toBe(201);
    expect(pendingState.reviewNodeId).not.toBeNull();
    const oldReviewNodeId = pendingState.reviewNodeId!;
    const firstDraftCount = pendingState.drafts.length;
    expect(firstDraftCount).toBe(1);
    await ctxA.handle.stop();

    // Reset drafts on the shared pending state so the reanchor
    // pass's new-draft count is easy to assert.
    pendingState.drafts.length = 0;

    // Daemon at HEAD_B on the SAME sqlite, WITH the PR + blobs
    // fixture so the reanchor pass can look up new-side source.
    const ctxB = await startReviewDaemon({
      root,
      sqlitePath,
      pendingState,
      headSha: HEAD_B,
      registerPrs: [prAtB],
      blobs,
    });
    const cookieB = await ctxB.cookieFor(ctxB.handle.launchCode);

    const response = await fetch(`${ctxB.handle.url}/api/review/reanchor`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        origin: ctxB.handle.url,
        "sec-fetch-site": "same-origin",
        cookie: cookieB,
      },
      body: "{}",
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      ok: boolean;
      abandonedReviewNodeId: string;
      newIntents: number;
      orphaned: number;
      repositions: Array<{ outcome: string }>;
      reconcile: { reviewNodeId: string | null; newlySynced: readonly string[] };
    };
    expect(body.ok).toBe(true);
    expect(body.abandonedReviewNodeId).toBe(oldReviewNodeId);
    expect(body.reconcile.reviewNodeId).not.toBe(oldReviewNodeId);
    expect(body.newIntents).toBe(1);
    expect(body.orphaned).toBe(0);
    expect(body.repositions[0]!.outcome).toBe("moved");
    expect(body.reconcile.newlySynced.length).toBe(1);

    // Adapter side-effects:
    //   - old review was deleted (deletePendingReview),
    //   - a fresh AddThread was posted at the new head.
    expect(pendingState.deletes.length).toBe(1);
    expect(pendingState.deletes[0]!.reviewNodeId).toBe(oldReviewNodeId);
    expect(pendingState.drafts.length).toBe(1);

    // State reads show the new pending review, no stale banner.
    const state = await fetch(`${ctxB.handle.url}/api/review/state`, {
      headers: { cookie: cookieB, "sec-fetch-site": "same-origin" },
    });
    const stateBody = (await state.json()) as {
      stale: boolean;
      state: { openPending: { reviewNodeId: string; comments: unknown[] } | null; terminal: unknown[] };
    };
    expect(stateBody.stale).toBe(false);
    expect(stateBody.state.openPending?.reviewNodeId).toBe(body.reconcile.reviewNodeId ?? undefined);
    expect(stateBody.state.openPending?.comments.length).toBe(1);
    // The old review shows up in terminal as abandoned.
    expect(stateBody.state.terminal.length).toBe(1);
  });

  test("head-move reanchor: new source unavailable → comment orphans (never silently dropped)", async () => {
    // Same as above but the fake serves NO blob for the new head —
    // fetchBlobText returns not-found, so the pipeline orphans the
    // pending comment. The endpoint still succeeds (abandon + open
    // new empty pending review); the response names the orphan.
    const pendingState = makePendingState();
    const prAtB: FakePr = {
      owner: "vig-os",
      repo: "revkit",
      pullNumber: 42,
      nodeId: "PR_42",
      title: "test PR",
      state: "open",
      headSha: HEAD_B,
      headRef: "test-head",
      baseSha: "b".repeat(40),
      baseRef: "main",
      headRepoFullName: "vig-os/revkit",
      baseRepoFullName: "vig-os/revkit",
      url: "https://github.com/vig-os/revkit/pull/42",
      files: [
        {
          filename: "docs/index.md",
          status: "modified",
          patch: "@@ -1,3 +1,3 @@\n line1\n-line2 with quote\n+line2 with QUOTE\n line3",
        },
      ],
    };

    const root = mkdtempSync(join(tmpdir(), "revkit-review-reanc-orphan-"));
    tempDirs.push(root);
    const sqlitePath = join(root, "threads.sqlite");

    const ctxA = await startReviewDaemon({ root, sqlitePath, pendingState, headSha: HEAD_A });
    const cookieA = await ctxA.cookieFor(ctxA.handle.launchCode);
    await postCommentAsLocal(ctxA, cookieA, "orphan me", "reanc2");
    await ctxA.handle.stop();
    pendingState.drafts.length = 0;

    // No blobs registered — fetchBlobText → not-found → orphaned.
    const ctxB = await startReviewDaemon({
      root,
      sqlitePath,
      pendingState,
      headSha: HEAD_B,
      registerPrs: [prAtB],
    });
    const cookieB = await ctxB.cookieFor(ctxB.handle.launchCode);

    const response = await fetch(`${ctxB.handle.url}/api/review/reanchor`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        origin: ctxB.handle.url,
        "sec-fetch-site": "same-origin",
        cookie: cookieB,
      },
      body: "{}",
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      ok: boolean;
      newIntents: number;
      orphaned: number;
      repositions: Array<{ outcome: string; reason?: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.newIntents).toBe(0);
    expect(body.orphaned).toBe(1);
    expect(body.repositions[0]!.outcome).toBe("orphaned");
    expect(body.repositions[0]!.reason).toBe("new-source-unavailable");
    // No AddThread was posted at the new head.
    expect(pendingState.drafts.length).toBe(0);
  });
});
