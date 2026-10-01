// M3 part 2b round-4 — coordinator's BLOCK-fix tests.
//
// Every test in this file must:
//   - PASS on the round-4 code (this branch).
//   - FAIL on 91477deb (round-3) — the RED evidence that each fix
//     actually changed behaviour.
//
// The coordinator's round-4 BLOCK list:
//
//   B1. Deleted-on-github recovery. On round-3 the reconciler
//       marked the review abandoned but the synced drafts stayed
//       synced against the terminal review — the next human
//       comment opened a fresh review with only that comment, so
//       previous drafts were silently lost. Round-4: the reducer
//       reverts every synced-under-that-review back to
//       `pending-sync` on abandon(reason=deleted-on-github). The
//       rail's banner + Re-post flow lands the stranded drafts on
//       a fresh review.
//
//   B2. Own replies must not come back as duplicates on refresh.
//       Round-4 walks the log for existing `comment.linked`
//       events, builds a nodeId → localCommentId map, and threads
//       that through the import factory. When the fake mirrors
//       live GitHub by returning viewer drafts in reviewThreads,
//       the dedupe path treats them as already-linked.
//
//   B3. VIEWER_REVIEWS_QUERY's first:50 window. Round-4 adds
//       `getReviewById(reviewNodeId)` — a single-node lookup with
//       no pagination — and the reconciler prefers it. A reviewer
//       with 50+ reviews on the PR gets the correct submitted /
//       missing signal instead of a false deleted-on-github.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitHubAdapter,
  revisionOf,
  type PrFile,
  type PrRef,
  type PullRequestSummary,
  type TokenSource,
  type GhReviewThread,
} from "@revkit/review-core";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";
import type { LineSink } from "../../src/serve/logger.ts";
import { populateStoreFromPr } from "../../src/review/import-threads.ts";
import { makeReviewModeHandle, reanchorPendingReviewAtNewHead } from "../../src/serve/review-mode.ts";
import { makeFakeGithubFetch, makePendingState, type FakePendingState } from "../review/helpers/fake-github.ts";

const staticToken: TokenSource = { async getToken() { return "ghp_" + "a".repeat(40); } };
const HEAD_A = "1234567890abcdef1234567890abcdef12345678";
const HEAD_B = "abcdef1234567890abcdef1234567890abcdef12";

const daemonsToStop: DaemonHandle[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (daemonsToStop.length > 0) {
    const h = daemonsToStop.pop();
    if (h !== undefined) { try { await h.stop(); } catch { /* fine */ } }
  }
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d !== undefined) { try { rmSync(d, { recursive: true, force: true }); } catch { /* fine */ } }
  }
});

interface Ctx {
  handle: DaemonHandle;
  fake: FakePendingState;
  fakeFetch: typeof fetch;
  root: string;
  cookie: string;
}

async function startCtx(overrides?: {
  includePendingInReviewThreads?: boolean;
  threads?: readonly GhReviewThread[];
  failBeforeOnce?: string;
  loseResponseOnce?: string;
  rejectOperation?: string;
  delayAfterAcceptOnce?: {
    operation: string;
    onAccepted: () => void;
    wait: Promise<void>;
  };
}): Promise<Ctx> {
  const root = mkdtempSync(join(tmpdir(), "revkit-r4b-"));
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
        owner: "vig-os", repo: "revkit", pullNumber: 42, headSha: HEAD_A,
        baseSha: "b".repeat(40), baseRef: "main", headRef: "test-head",
        title: "R4b PR", nodeId: "PR_42",
        state: "open" as const,
        headRepoFullName: "vig-os/revkit",
        baseRepoFullName: "vig-os/revkit",
        url: "https://github.com/vig-os/revkit/pull/42",
        ...(overrides?.threads !== undefined ? { threads: overrides.threads } : {}),
      },
    ],
    { pendingState: pending, viewerLogin: "test-reviewer", ...overrides },
  );
  let injected = false;
  const wrappedFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (overrides?.rejectOperation !== undefined && body.includes(overrides.rejectOperation)) {
      throw new Error(`forbidden-operation:${overrides.rejectOperation}`);
    }
    const operation = overrides?.failBeforeOnce ?? overrides?.loseResponseOnce;
    if (!injected && operation !== undefined && body.includes(`mutation ${operation}`)) {
      injected = true;
      if (overrides?.failBeforeOnce !== undefined) throw new Error("injected-before-accept");
      await fakeFetch(input, init);
      throw new Error("injected-response-lost");
    }
    if (!injected && overrides?.delayAfterAcceptOnce !== undefined && body.includes(`mutation ${overrides.delayAfterAcceptOnce.operation}`)) {
      injected = true;
      const response = await fakeFetch(input, init);
      overrides.delayAfterAcceptOnce.onAccepted();
      await overrides.delayAfterAcceptOnce.wait;
      return response;
    }
    return await fakeFetch(input, init);
  }) as typeof fetch;
  const adapter = new GitHubAdapter({ token: staticToken, fetch: wrappedFetch });
  const pr: PrRef = { owner: "vig-os", repo: "revkit", pullNumber: 42 };
  const summary: PullRequestSummary = {
    number: 42, nodeId: "PR_42", title: "R4b", state: "open", draft: false,
    headSha: HEAD_A, headRef: "test-head",
    baseSha: "b".repeat(40), baseRef: "main",
    headRepoFullName: "vig-os/revkit", baseRepoFullName: "vig-os/revkit",
    url: "https://github.com/vig-os/revkit/pull/42",
  };
  const files: PrFile[] = [
    { filename: "docs/index.md", status: "modified", patch: "@@ -1,3 +1,3 @@\n line1\n-line2 with quote\n+line2 with QUOTE\n line3" },
  ];
  const logs: string[] = [];
  const sink: LineSink = { write: (line) => logs.push(line) };
  const handle = await startDaemon({
    dir: dist, repoRoot: root, port: 0,
    sqlitePath: join(root, "threads.sqlite"),
    version: "0.0.0-test", localUserId: "r4b-user",
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
  return { handle, fake: pending, fakeFetch: wrappedFetch, root, cookie };
}

async function postComment(ctx: Ctx, body: string, suffix: string): Promise<Response> {
  const revision = await revisionOf("line1\nline2 with quote\nline3\n");
  return await fetch(`${ctx.handle.url}/api/threads`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      origin: ctx.handle.url,
      "sec-fetch-site": "same-origin",
      cookie: ctx.cookie,
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

async function readState(ctx: Ctx): Promise<{
  state: {
    openPending: { reviewNodeId: string; comments: unknown[] } | null;
    terminal: Array<{ reviewNodeId: string; outcome: { kind: string; reason?: string } }>;
    unsyncedCommentIds?: readonly string[];
    commentSync?: Array<{ commentId: string; state: { kind: string; reason?: string } }>;
  };
}> {
  const r = await fetch(`${ctx.handle.url}/api/review/state`, {
    headers: { cookie: ctx.cookie, "sec-fetch-site": "same-origin" },
  });
  return (await r.json()) as {
    state: {
      openPending: { reviewNodeId: string; comments: unknown[] } | null;
      terminal: Array<{ reviewNodeId: string; outcome: { kind: string; reason?: string } }>;
      unsyncedCommentIds?: readonly string[];
      commentSync?: Array<{ commentId: string; state: { kind: string; reason?: string } }>;
    };
  };
}

function importedThread(id: string): GhReviewThread {
  return {
    id,
    path: "docs/index.md",
    isResolved: false,
    isOutdated: false,
    line: 2,
    startLine: null,
    originalLine: 2,
    originalStartLine: null,
    diffSide: "RIGHT",
    startDiffSide: null,
    subjectType: "LINE",
    resolvedByLogin: null,
    comments: [{
      nodeId: `${id}_comment`,
      databaseId: 700,
      body: "remote opener",
      authorLogin: "other-reviewer",
      authorType: "User",
      createdAt: "2026-10-01T00:00:00Z",
      url: "https://github.com/example/pull/42#discussion_r700",
      originalCommitOid: HEAD_A,
      diffHunk: "@@ -1,3 +1,3 @@\n line1\n line2 with quote\n line3",
    }],
  };
}

async function refreshAndReadImportedThread(ctx: Ctx): Promise<{ id: string; parentId: string }> {
  const refresh = await fetch(`${ctx.handle.url}/api/review/refresh`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ctx.handle.url,
      "sec-fetch-site": "same-origin",
      cookie: ctx.cookie,
    },
    body: "{}",
  });
  expect([200, 201]).toContain(refresh.status);
  const list = await fetch(`${ctx.handle.url}/api/threads`, {
    headers: { cookie: ctx.cookie, "sec-fetch-site": "same-origin" },
  });
  const body = (await list.json()) as { threads: Array<{ id: string; comments: Array<{ id: string }> }> };
  const thread = body.threads.find((candidate) => candidate.comments[0]?.id !== undefined);
  if (thread?.comments[0] === undefined) throw new Error("expected imported thread");
  return { id: thread.id, parentId: thread.comments[0].id };
}

async function restartCtx(ctx: Ctx): Promise<Ctx> {
  await ctx.handle.stop();
  const adapter = new GitHubAdapter({ token: staticToken, fetch: ctx.fakeFetch });
  const handle = await startDaemon({
    dir: join(ctx.root, "dist"),
    repoRoot: ctx.root,
    port: 0,
    sqlitePath: join(ctx.root, "threads.sqlite"),
    version: "0.0.0-test",
    localUserId: "r4b-user",
    installSignalHandlers: false,
    reviewMode: {
      adapter,
      pr: { owner: "vig-os", repo: "revkit", pullNumber: 42 },
      summary: {
        number: 42, nodeId: "PR_42", title: "R4b", state: "open", draft: false,
        headSha: HEAD_A, headRef: "test-head", baseSha: "b".repeat(40), baseRef: "main",
        headRepoFullName: "vig-os/revkit", baseRepoFullName: "vig-os/revkit",
        url: "https://github.com/vig-os/revkit/pull/42",
      },
      viewerLogin: "test-reviewer",
      files: [{ filename: "docs/index.md", status: "modified", patch: "@@ -1,3 +1,3 @@\n line1\n-line2 with quote\n+line2 with QUOTE\n line3" }],
    },
  });
  daemonsToStop.push(handle);
  const authUrl = new URL(handle.url + "/-/auth");
  authUrl.searchParams.set("code", handle.launchCode);
  const authResponse = await fetch(authUrl, { redirect: "manual" });
  const setCookie = authResponse.headers.get("set-cookie")!;
  return { ...ctx, handle, cookie: setCookie.slice(0, setCookie.indexOf(";")) };
}

// ────────────────────────────────────────────────────────────────
// B1 — deleted-on-github recovery flow.
// ────────────────────────────────────────────────────────────────
describe("B1 — deleted-on-github recovery: strands revert to pending-sync + Re-post lands them", () => {
  test("reconcile after remote delete: synced drafts revert to pending-sync AND the deleted-on-github terminal is visible", async () => {
    const ctx = await startCtx();
    // Two synced comments on a pending review.
    await postComment(ctx, "draft a", "b1-a");
    await postComment(ctx, "draft b", "b1-b");
    const reviewNodeId = ctx.fake.reviewNodeId!;
    expect(reviewNodeId).not.toBeNull();
    // Remote delete via adapter (crash-injection path).
    const adapter = new GitHubAdapter({ token: staticToken, fetch: ctx.fakeFetch });
    await adapter.deletePendingReview({ reviewId: reviewNodeId });
    expect(ctx.fake.reviewNodeId).toBeNull();
    // Reconcile — heals the log by appending review.abandoned
    // (deleted-on-github). The REDUCER round-4 fix reverts the two
    // synced drafts back to pending-sync.
    const reconcile = await fetch(`${ctx.handle.url}/api/review/reconcile`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        origin: ctx.handle.url,
        "sec-fetch-site": "same-origin",
        cookie: ctx.cookie,
      },
      body: "{}",
    });
    expect(reconcile.status).toBe(201);
    const body = (await reconcile.json()) as { deletedRemotely?: boolean };
    expect(body.deletedRemotely).toBe(true);
    // /api/review/state now:
    //   - openPending: null (log's abandon happened)
    //   - unsyncedCommentIds: 2 (both stranded)
    //   - terminal[]: contains the deleted-on-github abandon
    const state = await readState(ctx);
    expect(state.state.openPending).toBeNull();
    expect(state.state.unsyncedCommentIds?.length).toBe(2);
    const pending = (state.state.commentSync ?? []).filter((c) => c.state.kind === "pending-sync");
    expect(pending.length).toBe(2);
    const hasDeletedOnGithub = state.state.terminal.some(
      (t) => t.outcome.kind === "abandoned" && t.outcome.reason === "deleted-on-github",
    );
    expect(hasDeletedOnGithub).toBe(true);
  });

  test("Re-post after remote delete: a second reconcile opens a fresh pending and lands both stranded drafts", async () => {
    let ctx = await startCtx();
    await postComment(ctx, "draft a", "b1-r-a");
    await postComment(ctx, "draft b", "b1-r-b");
    const firstReviewId = ctx.fake.reviewNodeId!;
    const adapter = new GitHubAdapter({ token: staticToken, fetch: ctx.fakeFetch });
    await adapter.deletePendingReview({ reviewId: firstReviewId });
    // First reconcile: heals + reverts.
    await fetch(`${ctx.handle.url}/api/review/reconcile`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        origin: ctx.handle.url,
        "sec-fetch-site": "same-origin",
        cookie: ctx.cookie,
      },
      body: "{}",
    });
    ctx = await restartCtx(ctx);
    await Bun.sleep(50);
    // Boot reconciliation is read-only: recovery remains visible
    // and no drafts are re-posted without a fresh human click.
    expect(ctx.fake.reviewNodeId).toBeNull();
    expect(ctx.fake.drafts).toHaveLength(0);
    // Second reconcile = the rail's Re-post button. It should open a
    // fresh pending review under LOCAL and re-post both drafts.
    const repost = await fetch(`${ctx.handle.url}/api/review/reconcile`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        origin: ctx.handle.url,
        "sec-fetch-site": "same-origin",
        cookie: ctx.cookie,
      },
      body: "{}",
    });
    expect(repost.status).toBe(201);
    // A fresh pending review with both drafts.
    expect(ctx.fake.reviewNodeId).not.toBeNull();
    expect(ctx.fake.reviewNodeId).not.toBe(firstReviewId);
    expect(ctx.fake.drafts.length).toBe(2);
    // State: openPending has both comments, no pending-sync
    // strands remain.
    const state = await readState(ctx);
    expect(state.state.openPending).not.toBeNull();
    expect(state.state.openPending!.comments.length).toBe(2);
    const stillStranded = (state.state.commentSync ?? []).filter((c) => c.state.kind === "pending-sync");
    expect(stillStranded.length).toBe(0);
  });

  test("Decline durably cancels the intent across reconcile, restart and later submit", async () => {
    let ctx = await startCtx();
    await postComment(ctx, "draft a", "b1-d-a");
    const reviewId = ctx.fake.reviewNodeId!;
    const adapter = new GitHubAdapter({ token: staticToken, fetch: ctx.fakeFetch });
    await adapter.deletePendingReview({ reviewId });
    await fetch(`${ctx.handle.url}/api/review/reconcile`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        origin: ctx.handle.url,
        "sec-fetch-site": "same-origin",
        cookie: ctx.cookie,
      },
      body: "{}",
    });
    // Confirm we're in the deleted-on-github state.
    let state = await readState(ctx);
    const pendingCount = (state.state.commentSync ?? []).filter((c) => c.state.kind === "pending-sync").length;
    expect(pendingCount).toBe(1);
    // Decline.
    const decline = await fetch(`${ctx.handle.url}/api/review/decline-repost`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        origin: ctx.handle.url,
        "sec-fetch-site": "same-origin",
        cookie: ctx.cookie,
      },
      body: "{}",
    });
    expect(decline.status).toBe(201);
    const decBody = (await decline.json()) as { declined: number };
    expect(decBody.declined).toBe(1);
    state = await readState(ctx);
    expect(state.state.unsyncedCommentIds).toEqual([]);
    expect(state.state.commentSync?.find((entry) => entry.commentId === "c-b1-d-a")?.state.kind).toBe("cancelled");

    ctx = await restartCtx(ctx);
    await Bun.sleep(50);
    expect((await readState(ctx)).state.unsyncedCommentIds).toEqual([]);
    expect(ctx.fake.reviewNodeId).toBeNull();
    expect(ctx.fake.drafts).toHaveLength(0);

    const reconcile = await fetch(`${ctx.handle.url}/api/review/reconcile`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ctx.handle.url, "sec-fetch-site": "same-origin", cookie: ctx.cookie },
      body: "{}",
    });
    expect(reconcile.status).toBe(201);
    expect(ctx.fake.reviewNodeId).toBeNull();
    expect(ctx.fake.drafts).toHaveLength(0);

    await postComment(ctx, "new intentional draft", "after-decline");
    expect(ctx.fake.drafts.map((draft) => draft.body)).toEqual(["new intentional draft"]);
    const submit = await fetch(`${ctx.handle.url}/api/review/submit`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ctx.handle.url, "sec-fetch-site": "same-origin", cookie: ctx.cookie },
      body: JSON.stringify({ event: "COMMENT" }),
    });
    expect(submit.status).toBe(201);
    expect(ctx.fake.submits).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────
// B2 — own replies don't come back as duplicates on refresh.
// ────────────────────────────────────────────────────────────────
describe("B2 — dedupe on GitHub node id: locally-authored replies do not re-import as duplicates", () => {
  test("import that mirrors live GitHub (viewer drafts in reviewThreads): local reply's nodeId dedupes", async () => {
    // Post a local comment → mirror opens a review + draft on the
    // fake. Then a refresh — the fake includes viewer PENDING
    // drafts in reviewThreads. Without round-4's dedupe, that
    // draft would import as a second local comment.
    const ctx = await startCtx({ includePendingInReviewThreads: true });
    await postComment(ctx, "my local draft", "b2-local");
    // Refresh the store via the daemon's own refresh endpoint —
    // this is what the rail hits on the refresh button.
    const refresh = await fetch(`${ctx.handle.url}/api/review/refresh`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        origin: ctx.handle.url,
        "sec-fetch-site": "same-origin",
        cookie: ctx.cookie,
      },
      body: "{}",
    });
    expect([200, 201]).toContain(refresh.status);
    const state = await readState(ctx);
    // The pending review contains EXACTLY ONE comment (the
    // local one). Round-3 would have imported the viewer's draft
    // as a second thread with a derived id; round-4 dedupes.
    expect(state.state.openPending).not.toBeNull();
    expect(state.state.openPending!.comments.length).toBe(1);

    await ctx.handle.stop();
    const { SqliteThreadStore } = await import("../../src/serve/sqlite-store.ts");
    const store = SqliteThreadStore.open({ filename: join(ctx.root, "threads.sqlite") });
    const threads = await store.threads();
    expect(threads).toHaveLength(1);
    expect(threads[0]?.comments).toHaveLength(1);
    expect(threads[0]?.comments[0]?.id).toBe("c-b2-local");
    store.close();
  });

  test("an actual local reply keeps its local id after the same GitHub node is imported twice", async () => {
    const ctx = await startCtx({ threads: [importedThread("PRT_own_reply")] });
    const imported = await refreshAndReadImportedThread(ctx);
    const localReplyId = "reply-own-refresh";
    const reply = await fetch(`${ctx.handle.url}/api/threads/${encodeURIComponent(imported.id)}/replies`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ctx.handle.url, "sec-fetch-site": "same-origin", cookie: ctx.cookie },
      body: JSON.stringify({ commentId: localReplyId, parentId: imported.parentId, body: "actual local reply" }),
    });
    expect(reply.status).toBe(201);
    expect(ctx.fake.replies).toHaveLength(1);

    for (let i = 0; i < 2; i++) {
      const refresh = await fetch(`${ctx.handle.url}/api/review/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ctx.handle.url, "sec-fetch-site": "same-origin", cookie: ctx.cookie },
        body: "{}",
      });
      expect([200, 201]).toContain(refresh.status);
    }

    await ctx.handle.stop();
    const { SqliteThreadStore } = await import("../../src/serve/sqlite-store.ts");
    const store = SqliteThreadStore.open({ filename: join(ctx.root, "threads.sqlite") });
    const thread = await store.thread(imported.id);
    expect(thread?.comments.map((comment) => comment.id)).toEqual([imported.parentId, localReplyId]);
    expect(thread?.comments.filter((comment) => comment.body === "actual local reply")).toHaveLength(1);
    store.close();
  });
});

// ────────────────────────────────────────────────────────────────
// B3 — getReviewById avoids the 50-review pagination window.
// ────────────────────────────────────────────────────────────────
describe("B3 — reconciler uses getReviewById; 50+ reviews on the PR do not trip a false deleted-on-github", () => {
  test("crashed submit is healed via node(id:) — never a fresh review even when the PR has many reviews", async () => {
    const ctx = await startCtx({ rejectOperation: "ViewerReviews" });
    await postComment(ctx, "seed", "b3-many");
    const reviewNodeId = ctx.fake.reviewNodeId!;
    // Submit via the adapter (crash path — log misses terminal).
    const adapter = new GitHubAdapter({ token: staticToken, fetch: ctx.fakeFetch });
    await adapter.submitReview({ reviewId: reviewNodeId, event: "APPROVE" });
    // Fabricate 60 old submitted reviews to fill the ViewerReviews
    // window — a first:50 query would drop the freshly-submitted
    // one off the page. Round-4's getReviewById(node(id:)) is
    // pagination-free and returns the review directly.
    for (let i = 0; i < 60; i++) {
      (ctx.fake.submits as Array<{ reviewNodeId: string; event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES" }>).push({
        reviewNodeId: `PR_old_review_${i}`,
        event: "COMMENT",
      });
    }
    // Reconcile via the daemon endpoint.
    const reconcile = await fetch(`${ctx.handle.url}/api/review/reconcile`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        origin: ctx.handle.url,
        "sec-fetch-site": "same-origin",
        cookie: ctx.cookie,
      },
      body: "{}",
    });
    expect(reconcile.status).toBe(201);
    const body = (await reconcile.json()) as {
      healedSubmit?: boolean;
      deletedRemotely?: boolean;
    };
    // The correct heal is submitted, NOT deleted-on-github.
    expect(body.healedSubmit).toBe(true);
    expect(body.deletedRemotely).toBeFalsy();
    // The submit count on the fake shows exactly ONE submit —
    // no auto-recreated review.
    // (Old fake `submits` was seeded with 60 dummy entries above
    // — filter them out.)
    const realSubmits = ctx.fake.submits.filter((s) => s.reviewNodeId === reviewNodeId);
    expect(realSubmits.length).toBe(1);
  });

  test("agent bearer cannot reconcile an existing pending review with an unsynced intent", async () => {
    const ctx = await startCtx();
    await postComment(ctx, "already pending", "b3-cookie");
    expect(ctx.fake.reviewNodeId).not.toBeNull();

    const beforeDrafts = ctx.fake.drafts.length;
    const response = await fetch(`${ctx.handle.url}/api/review/reconcile`, {
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
    expect(ctx.fake.drafts.length).toBe(beforeDrafts);
  });
});

describe("B4 — durable reply and resolve intents", () => {
  async function postReply(ctx: Ctx, threadId: string, parentId: string, commentId: string): Promise<Response> {
    return await fetch(`${ctx.handle.url}/api/threads/${encodeURIComponent(threadId)}/replies`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ctx.handle.url,
        "sec-fetch-site": "same-origin",
        cookie: ctx.cookie,
      },
      body: JSON.stringify({ commentId, parentId, body: "durable local reply" }),
    });
  }

  test("reply pre-accept failure survives restart; boot does not post; explicit cookie reconcile posts once", async () => {
    let ctx = await startCtx({ threads: [importedThread("PRT_reply_pre")], failBeforeOnce: "AddReviewThreadReply" });
    const imported = await refreshAndReadImportedThread(ctx);
    expect((await postReply(ctx, imported.id, imported.parentId, "reply-pre")).status).toBe(201);
    expect(ctx.fake.replies).toHaveLength(0);

    ctx = await restartCtx(ctx);
    await Bun.sleep(50);
    expect(ctx.fake.replies).toHaveLength(0);

    const retry = await fetch(`${ctx.handle.url}/api/review/reconcile`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ctx.handle.url,
        "sec-fetch-site": "same-origin",
        cookie: ctx.cookie,
      },
      body: "{}",
    });
    expect(retry.status).toBe(201);
    expect(ctx.fake.replies).toHaveLength(1);
    expect(ctx.fake.replies[0]?.pendingReviewId).toBe(ctx.fake.reviewNodeId!);
  });

  test("reply accepted with a lost response is linked on restart without a duplicate mutation", async () => {
    let ctx = await startCtx({ threads: [importedThread("PRT_reply_lost")], loseResponseOnce: "AddReviewThreadReply" });
    const imported = await refreshAndReadImportedThread(ctx);
    expect((await postReply(ctx, imported.id, imported.parentId, "reply-lost")).status).toBe(201);
    expect(ctx.fake.replies).toHaveLength(1);

    ctx = await restartCtx(ctx);
    for (let i = 0; i < 20; i++) {
      if ((await readState(ctx)).state.unsyncedCommentIds?.length === 0) break;
      await Bun.sleep(10);
    }
    expect(ctx.fake.replies).toHaveLength(1);
    expect((await readState(ctx)).state.unsyncedCommentIds).toEqual([]);
  });

  test("resolve accepted with a lost response heals its external baseline after restart", async () => {
    let ctx = await startCtx({ threads: [importedThread("PRT_resolve_lost")], loseResponseOnce: "ResolveReviewThread" });
    const imported = await refreshAndReadImportedThread(ctx);
    const response = await fetch(`${ctx.handle.url}/api/threads/${encodeURIComponent(imported.id)}/resolve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ctx.handle.url,
        "sec-fetch-site": "same-origin",
        cookie: ctx.cookie,
      },
      body: "{}",
    });
    expect(response.status).toBe(201);
    expect(ctx.fake.resolutions).toHaveLength(1);

    ctx = await restartCtx(ctx);
    await Bun.sleep(50);
    expect(ctx.fake.resolutions).toHaveLength(1);
    const list = await fetch(`${ctx.handle.url}/api/threads`, {
      headers: { cookie: ctx.cookie, "sec-fetch-site": "same-origin" },
    });
    const body = (await list.json()) as { threads: Array<{ id: string; external?: { resolved: boolean } }> };
    expect(body.threads.find((thread) => thread.id === imported.id)?.external?.resolved).toBe(true);
  });

  test("resolve pre-accept failure survives restart and retries only on cookie reconcile", async () => {
    let ctx = await startCtx({ threads: [importedThread("PRT_resolve_pre")], failBeforeOnce: "ResolveReviewThread" });
    const imported = await refreshAndReadImportedThread(ctx);
    const response = await fetch(`${ctx.handle.url}/api/threads/${encodeURIComponent(imported.id)}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ctx.handle.url, "sec-fetch-site": "same-origin", cookie: ctx.cookie },
      body: "{}",
    });
    expect(response.status).toBe(201);
    expect(ctx.fake.resolutions).toHaveLength(0);

    ctx = await restartCtx(ctx);
    await Bun.sleep(50);
    expect(ctx.fake.resolutions).toHaveLength(0);
    const retry = await fetch(`${ctx.handle.url}/api/review/reconcile`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ctx.handle.url, "sec-fetch-site": "same-origin", cookie: ctx.cookie },
      body: "{}",
    });
    expect(retry.status).toBe(201);
    expect(ctx.fake.resolutions).toEqual([{ threadNodeId: "PRT_resolve_pre", op: "resolve" }]);
  });

  test("reopen pre-accept failure is durable; remote imported resolution alone is never treated as local intent", async () => {
    const remote = { ...importedThread("PRT_reopen_pre"), isResolved: true, resolvedByLogin: "other-reviewer" };
    let ctx = await startCtx({ threads: [remote], failBeforeOnce: "UnresolveReviewThread" });
    const imported = await refreshAndReadImportedThread(ctx);
    // Refresh/reconcile of a remotely-resolved import must not invent
    // a local unresolve intent from the separate orphan/status axis.
    expect(ctx.fake.resolutions).toHaveLength(0);

    const response = await fetch(`${ctx.handle.url}/api/threads/${encodeURIComponent(imported.id)}/reopen`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ctx.handle.url, "sec-fetch-site": "same-origin", cookie: ctx.cookie },
      body: "{}",
    });
    expect(response.status).toBe(201);
    expect(ctx.fake.resolutions).toHaveLength(0);

    ctx = await restartCtx(ctx);
    await Bun.sleep(50);
    expect(ctx.fake.resolutions).toHaveLength(0);
    const retry = await fetch(`${ctx.handle.url}/api/review/reconcile`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ctx.handle.url, "sec-fetch-site": "same-origin", cookie: ctx.cookie },
      body: "{}",
    });
    expect(retry.status).toBe(201);
    expect(ctx.fake.resolutions).toEqual([{ threadNodeId: "PRT_reopen_pre", op: "unresolve" }]);
  });

  for (const scenario of [
    { first: "resolve" as const, second: "reopen" as const, initialResolved: false, delayedOperation: "ResolveReviewThread", expectedResolved: false },
    { first: "reopen" as const, second: "resolve" as const, initialResolved: true, delayedOperation: "UnresolveReviewThread", expectedResolved: true },
  ]) {
    test(`a delayed ${scenario.first} completion cannot clear a newer ${scenario.second} intent`, async () => {
      let release!: () => void;
      const wait = new Promise<void>((resolve) => { release = resolve; });
      let accepted!: () => void;
      const acceptedPromise = new Promise<void>((resolve) => { accepted = resolve; });
      const remote = {
        ...importedThread(`PRT_race_${scenario.first}`),
        isResolved: scenario.initialResolved,
        resolvedByLogin: scenario.initialResolved ? "other-reviewer" : null,
      };
      let ctx = await startCtx({
        threads: [remote],
        delayAfterAcceptOnce: { operation: scenario.delayedOperation, onAccepted: accepted, wait },
      });
      const imported = await refreshAndReadImportedThread(ctx);
      const mutate = (operation: "resolve" | "reopen") => fetch(
        `${ctx.handle.url}/api/threads/${encodeURIComponent(imported.id)}/${operation}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", origin: ctx.handle.url, "sec-fetch-site": "same-origin", cookie: ctx.cookie },
          body: "{}",
        },
      );

      const first = mutate(scenario.first);
      await acceptedPromise;
      const second = await mutate(scenario.second);
      expect(second.status).toBe(201);
      release();
      expect((await first).status).toBe(201);

      ctx = await restartCtx(ctx);
      await Bun.sleep(50);
      const before = ctx.fake.resolutions.length;
      const reconcile = await fetch(`${ctx.handle.url}/api/review/reconcile`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ctx.handle.url, "sec-fetch-site": "same-origin", cookie: ctx.cookie },
        body: "{}",
      });
      expect(reconcile.status).toBe(201);
      expect(ctx.fake.resolutions).toHaveLength(before);
      const list = await fetch(`${ctx.handle.url}/api/threads`, {
        headers: { cookie: ctx.cookie, "sec-fetch-site": "same-origin" },
      });
      const body = (await list.json()) as { threads: Array<{ id: string; status: string; external?: { resolved: boolean } }> };
      const thread = body.threads.find((candidate) => candidate.id === imported.id);
      expect(thread?.status).toBe(scenario.expectedResolved ? "resolved" : "open");
      expect(thread?.external?.resolved).toBe(scenario.expectedResolved);
    });
  }

  test("fuzzy head-move persists the scored local anchor and reposts at the same location", async () => {
    const root = mkdtempSync(join(tmpdir(), "revkit-r4-fuzzy-reanchor-"));
    tempDirs.push(root);
    const oldSource = "prelude paragraph\n\nthe target phrase lives here\n\ntrailer paragraph\n";
    const newSource = oldSource.replace("target", "modified");
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs/index.md"), newSource);
    const pending = makePendingState();
    pending.reviewNodeId = "PRR_fuzzy_old";
    pending.commitOid = HEAD_A;
    pending.drafts.push({
      threadNodeId: "PRT_fuzzy_old", commentNodeId: "PRRC_fuzzy_old", databaseId: 901,
      path: "docs/index.md", body: "fuzzy body", line: 3, side: "RIGHT", subjectType: "LINE",
    });
    const fakeFetch = makeFakeGithubFetch([{
      owner: "vig-os", repo: "revkit", pullNumber: 42, headSha: HEAD_B,
      baseSha: "b".repeat(40), baseRef: "main", headRef: "test-head", title: "fuzzy",
      nodeId: "PR_42", state: "open", headRepoFullName: "vig-os/revkit",
      baseRepoFullName: "vig-os/revkit", url: "https://github.com/vig-os/revkit/pull/42",
    }], { pendingState: pending, viewerLogin: "test-reviewer", blobs: new Map([[`${HEAD_B}:docs/index.md`, newSource]]) });
    const adapter = new GitHubAdapter({ token: staticToken, fetch: fakeFetch });
    const { SqliteThreadStore } = await import("../../src/serve/sqlite-store.ts");
    const store = SqliteThreadStore.open({ filename: join(root, "threads.sqlite") });
    const actor = { kind: "local" as const, id: "reviewer", displayName: "Reviewer" };
    const revision = await revisionOf(oldSource);
    await store.append({
      kind: "comment.created", actor, threadId: "thread-fuzzy", commentId: "comment-fuzzy",
      anchor: {
        path: "docs/index.md", startLine: 3, endLine: 3,
        quote: { exact: "the target phrase lives here", prefix: "prelude paragraph\n\n", suffix: "\n\ntrailer paragraph\n" },
        revision,
      },
      body: "fuzzy body",
    });
    await store.append({ kind: "review.opened", actor, reviewNodeId: "PRR_fuzzy_old", headSha: HEAD_A });
    await store.append({
      kind: "comment.sync_requested", actor, commentId: "comment-fuzzy", path: "docs/index.md",
      subjectType: "LINE", side: "RIGHT", line: 3, bodyHash: await revisionOf("fuzzy body"),
    });
    await store.append({
      kind: "comment.linked", actor, commentId: "comment-fuzzy",
      external: { github: { commentId: 901, nodeId: "PRRC_fuzzy_old", pending: true, reviewNodeId: "PRR_fuzzy_old" } },
    });
    store.putSnapshot(revision, oldSource);
    const review = makeReviewModeHandle({
      adapter,
      pr: { owner: "vig-os", repo: "revkit", pullNumber: 42 },
      summary: {
        number: 42, nodeId: "PR_42", title: "fuzzy", state: "open", draft: false,
        headSha: HEAD_B, headRef: "test-head", baseSha: "b".repeat(40), baseRef: "main",
        headRepoFullName: "vig-os/revkit", baseRepoFullName: "vig-os/revkit",
        url: "https://github.com/vig-os/revkit/pull/42",
      },
      viewerLogin: "test-reviewer",
      files: [{ filename: "docs/index.md", status: "modified", patch: "@@ -3 +3 @@\n-the target phrase lives here\n+the modified phrase lives here" }],
    });
    const outcome = await reanchorPendingReviewAtNewHead({
      review, store, actor,
      appendAndPublish: async (event) => {
        const seq = await store.append(event);
        return (await store.since(seq - 1)).find((candidate) => candidate.seq === seq);
      },
    });

    expect(outcome.repositions).toEqual([{ localCommentId: "comment-fuzzy", path: "docs/index.md", outcome: "fuzzy" }]);
    const thread = await store.thread("thread-fuzzy");
    if (thread === undefined) throw new Error("expected thread");
    expect("kind" in thread.anchor ? thread.anchor.kind : undefined).toBeUndefined();
    if ("kind" in thread.anchor) throw new Error("expected line anchor");
    expect(thread?.anchor.quote.exact).toBe("the modified phrase lives here");
    const fuzzyEvent = (await store.since(0)).find((event) => event.kind === "thread.reanchored" && event.method === "fuzzy");
    expect(fuzzyEvent?.kind).toBe("thread.reanchored");
    if (fuzzyEvent?.kind !== "thread.reanchored") throw new Error("expected fuzzy event");
    expect(fuzzyEvent.score).toBeGreaterThan(0);
    expect(pending.drafts).toHaveLength(1);
    expect(pending.drafts[0]?.line).toBe(thread?.anchor.startLine);
    store.close();
  });

  test("head-move replay preserves a pending reply body and reply target", async () => {
    const root = mkdtempSync(join(tmpdir(), "revkit-r4-reply-reanchor-"));
    tempDirs.push(root);
    const oldSource = "line1\nline2 with quote\nline3\n";
    const newSource = "intro\nline1\nline2 with quote\nline3\n";
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs/index.md"), newSource);
    const pending = makePendingState();
    pending.reviewNodeId = "PRR_old";
    pending.commitOid = HEAD_A;
    pending.replies.push({
      threadNodeId: "PRT_reanchor_reply",
      body: "preserve this reply body",
      commentNodeId: "PRRC_old_reply",
      databaseId: 900,
      pendingReviewId: "PRR_old",
    });
    const remote = importedThread("PRT_reanchor_reply");
    const fakeFetch = makeFakeGithubFetch([
      {
        owner: "vig-os", repo: "revkit", pullNumber: 42, headSha: HEAD_B,
        baseSha: "b".repeat(40), baseRef: "main", headRef: "test-head", title: "moved",
        nodeId: "PR_42", state: "open", headRepoFullName: "vig-os/revkit",
        baseRepoFullName: "vig-os/revkit", url: "https://github.com/vig-os/revkit/pull/42",
        threads: [remote],
      },
    ], {
      pendingState: pending,
      viewerLogin: "test-reviewer",
      blobs: new Map([[`${HEAD_B}:docs/index.md`, newSource]]),
    });
    const adapter = new GitHubAdapter({ token: staticToken, fetch: fakeFetch });
    const { SqliteThreadStore } = await import("../../src/serve/sqlite-store.ts");
    const store = SqliteThreadStore.open({ filename: join(root, "threads.sqlite") });
    const actor = { kind: "local" as const, id: "reviewer", displayName: "Reviewer" };
    const revision = await revisionOf(oldSource);
    await store.append({
      kind: "comment.created", actor, threadId: "thread-reanchor-reply", commentId: "remote-opener",
      anchor: {
        path: "docs/index.md", startLine: 2, endLine: 2,
        quote: { exact: "line2 with quote", prefix: "line1\n", suffix: "\nline3" }, revision,
      },
      body: "remote opener",
      external: { provider: "github", threadId: "PRT_reanchor_reply", resolved: false },
    });
    await store.append({
      kind: "comment.linked", actor, commentId: "remote-opener",
      external: { github: { commentId: 700, nodeId: "PRT_reanchor_reply_comment" } },
    });
    await store.append({
      kind: "comment.replied", actor, threadId: "thread-reanchor-reply", commentId: "local-reply",
      parentId: "remote-opener", body: "preserve this reply body",
    });
    await store.append({ kind: "review.opened", actor, reviewNodeId: "PRR_old", headSha: HEAD_A });
    await store.append({
      kind: "comment.sync_requested", actor, commentId: "local-reply", path: "docs/index.md",
      subjectType: "FILE", bodyHash: await revisionOf("preserve this reply body"),
      replyThreadNodeId: "PRT_reanchor_reply", knownCommentNodeIds: ["PRT_reanchor_reply_comment"],
    });
    await store.append({
      kind: "comment.linked", actor, commentId: "local-reply",
      external: { github: { commentId: 900, nodeId: "PRRC_old_reply", pending: true, reviewNodeId: "PRR_old" } },
    });
    store.putSnapshot(revision, oldSource);

    const review = makeReviewModeHandle({
      adapter,
      pr: { owner: "vig-os", repo: "revkit", pullNumber: 42 },
      summary: {
        number: 42, nodeId: "PR_42", title: "moved", state: "open", draft: false,
        headSha: HEAD_B, headRef: "test-head", baseSha: "b".repeat(40), baseRef: "main",
        headRepoFullName: "vig-os/revkit", baseRepoFullName: "vig-os/revkit",
        url: "https://github.com/vig-os/revkit/pull/42",
      },
      viewerLogin: "test-reviewer",
      files: [{ filename: "docs/index.md", status: "modified", patch: "@@ -1,3 +1,4 @@\n+intro\n line1\n line2 with quote\n line3" }],
    });
    const outcome = await reanchorPendingReviewAtNewHead({
      review,
      store,
      actor,
      appendAndPublish: async (event) => {
        const seq = await store.append(event);
        return (await store.since(seq - 1)).find((candidate) => candidate.seq === seq);
      },
    });

    expect(outcome.newIntents).toBe(1);
    expect(pending.drafts).toHaveLength(0);
    expect(pending.replies).toHaveLength(1);
    expect(pending.replies[0]?.threadNodeId).toBe("PRT_reanchor_reply");
    expect(pending.replies[0]?.body).toBe("preserve this reply body");
    expect(pending.replies[0]?.pendingReviewId).toBe(pending.reviewNodeId);
    store.close();
  });
});

// ────────────────────────────────────────────────────────────────
// direct populateStoreFromPr probe for dedupe: no daemon needed.
// ────────────────────────────────────────────────────────────────
describe("B2 (unit) — populateStoreFromPr dedupes on external.github.nodeId", () => {
  test("a later import of a thread whose comment is already comment.linked locally does not create a duplicate", async () => {
    const ctx = await startCtx();
    const adapter = new GitHubAdapter({ token: staticToken, fetch: ctx.fakeFetch });
    // Stop the daemon so we can open its sqlite store directly.
    await ctx.handle.stop();
    const { SqliteThreadStore } = await import("../../src/serve/sqlite-store.ts");
    const store = SqliteThreadStore.open({ filename: join(ctx.root, "threads.sqlite") });
    // Seed a locally-authored comment + comment.linked to a
    // GitHub nodeId. This is what mirrorPendingReviewComment
    // produces for a top-level draft.
    const localCommentId = "c-local-1";
    const remoteNodeId = "PRRC_local_1";
    await store.append({
      kind: "comment.created",
      actor: { kind: "local", id: "me", displayName: "Me" },
      threadId: "th-local-1",
      commentId: localCommentId,
      anchor: {
        path: "docs/index.md",
        startLine: 2,
        endLine: 2,
        quote: { exact: "line2 with quote", prefix: "line1\n", suffix: "\nline3" },
        revision: await revisionOf("line1\nline2 with quote\nline3\n"),
      },
      body: "my local comment",
    });
    await store.append({
      kind: "comment.linked",
      actor: { kind: "local", id: "me", displayName: "Me" },
      commentId: localCommentId,
      external: {
        github: {
          commentId: 42,
          nodeId: remoteNodeId,
        },
      },
    });
    // Now a refresh: the remote returns a thread whose comment
    // carries the SAME nodeId. Round-4 dedupes.
    const remote: GhReviewThread = {
      id: "PRT_local_thread",
      path: "docs/index.md",
      isResolved: false,
      isOutdated: false,
      line: 2,
      startLine: null,
      originalLine: 2,
      originalStartLine: null,
      diffSide: "RIGHT",
      startDiffSide: null,
      subjectType: "LINE",
      resolvedByLogin: null,
      comments: [
        {
          nodeId: remoteNodeId,
          databaseId: 42,
          body: "my local comment",
          authorLogin: "test-reviewer",
          authorType: "User",
          createdAt: "2026-09-30T00:00:00Z",
          url: "https://github.com/example/pull/1#discussion_r42",
          originalCommitOid: HEAD_A,
          diffHunk: null,
        },
      ],
    };
    const outcome = await populateStoreFromPr({
      pr: { owner: "vig-os", repo: "revkit", pullNumber: 42 },
      threads: [remote],
      headSha: HEAD_A,
      baseRef: "main",
      adapter,
      materializedRoot: ctx.root,
      store,
    });
    // Should have skipped (dedupe on nodeId → same local
    // commentId → duplicate-comment-id → counted as skipped).
    expect(outcome.appended).toBeLessThanOrEqual(1); // maybe a thread event fires
    // The store has EXACTLY ONE thread/comment. Checking only the
    // local thread is vacuous: the broken importer creates a second
    // deterministic remote thread while leaving this one unchanged.
    const localThread = await store.thread("th-local-1");
    expect(localThread?.comments.length).toBe(1);
    expect(localThread?.comments[0]!.id).toBe(localCommentId);
    const allThreads = await store.threads();
    expect(allThreads).toHaveLength(1);
    expect(allThreads[0]?.id).toBe("th-local-1");
    store.close();
  });
});
