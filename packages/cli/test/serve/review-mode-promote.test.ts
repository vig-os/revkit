// Issue #70 (B6 remainder, option B): an agent-authored reply /
// resolve / reopen stays a LOCAL draft until a reviewer explicitly
// promotes it into their own pending GitHub review.
//
// Everything here runs against the STRICT fake GitHub
// (`../review/helpers/fake-github.ts`) — the only thing that counts as
// "written to GitHub" in these tests is a mutation the fake recorded,
// so "zero writes" is an assertion, not an inference.
//
// Each test states one claim.
//   - without a promotion, the fake sees ZERO writes
//   - with one, exactly ONE write, into the pending review
//   - from the agent bearer, a 403 and ZERO writes
//   - a double promote, or one after a submit or a discard, gives one
//     write, or a precise refusal and no write
//   - a restart between the promotion and its reconcile gives no
//     duplicate

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitHubAdapter,
  revisionOf,
  type GhReviewThread,
  type PrFile,
  type PrRef,
  type PullRequestSummary,
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

const SOURCE = "line1\nline2 with quote\nline3\n";

async function startCtx(overrides?: {
  threads?: readonly GhReviewThread[];
  loseResponseOnce?: string;
  failBeforeOnce?: string;
}): Promise<Ctx> {
  const root = mkdtempSync(join(tmpdir(), "revkit-p70-"));
  tempDirs.push(root);
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><h1>PR</h1>");
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs/index.md"), SOURCE);
  const pending = makePendingState();
  const baseFetch = makeFakeGithubFetch(
    [
      {
        owner: "vig-os", repo: "revkit", pullNumber: 42, headSha: HEAD_A,
        baseSha: "b".repeat(40), baseRef: "main", headRef: "test-head",
        title: "promote PR", nodeId: "PR_42",
        state: "open" as const,
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
        ...(overrides?.threads !== undefined ? { threads: overrides.threads } : {}),
      },
    ],
    { pendingState: pending, viewerLogin: "test-reviewer" },
  );
  let injected = false;
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === "string" ? init.body : "";
    const operation = overrides?.loseResponseOnce ?? overrides?.failBeforeOnce;
    if (!injected && operation !== undefined && body.includes(`mutation ${operation}`)) {
      injected = true;
      if (overrides?.failBeforeOnce !== undefined) throw new Error("injected-before-accept");
      await baseFetch(input, init);
      throw new Error("injected-response-lost");
    }
    return await baseFetch(input, init);
  }) as typeof fetch;
  const adapter = new GitHubAdapter({ token: staticToken, fetch: fakeFetch });
  const pr: PrRef = { owner: "vig-os", repo: "revkit", pullNumber: 42 };
  const summary: PullRequestSummary = {
    number: 42, nodeId: "PR_42", title: "promote PR", state: "open", draft: false,
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
    version: "0.0.0-test", localUserId: "p70-user",
    installSignalHandlers: false,
    logSink: sink,
    reviewMode: { adapter, pr, summary, viewerLogin: "test-reviewer", files },
  });
  daemonsToStop.push(handle);
  const authUrl = new URL(handle.url + "/-/auth");
  authUrl.searchParams.set("code", handle.launchCode);
  const authResponse = await fetch(authUrl, { redirect: "manual" });
  const setCookie = authResponse.headers.get("set-cookie")!;
  return { handle, fake: pending, fakeFetch, root, cookie: setCookie.slice(0, setCookie.indexOf(";")) };
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
    localUserId: "p70-user",
    installSignalHandlers: false,
    logSink: { write: () => {} },
    reviewMode: {
      adapter,
      pr: { owner: "vig-os", repo: "revkit", pullNumber: 42 },
      summary: {
        number: 42, nodeId: "PR_42", title: "promote PR", state: "open", draft: false,
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

/** Post a top-level comment as the LOCAL reviewer (cookie). */
async function postComment(ctx: Ctx, body: string, suffix: string): Promise<Response> {
  const revision = await revisionOf(SOURCE);
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

/** Post a top-level comment as the AGENT (bearer). The mirror path
 * refuses a non-local actor, so this can only ever land locally. */
async function postCommentAsAgent(ctx: Ctx, body: string, suffix: string): Promise<Response> {
  const revision = await revisionOf(SOURCE);
  return await fetch(`${ctx.handle.url}/api/threads`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      origin: ctx.handle.url,
      "sec-fetch-site": "same-origin",
      authorization: `Bearer ${ctx.handle.agentToken}`,
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

/** A reply / resolve / reopen on a thread, as the AGENT (bearer). */
async function agentLifecycle(
  ctx: Ctx,
  threadId: string,
  operation: "replies" | "resolve" | "reopen",
  body: Record<string, unknown>,
): Promise<Response> {
  return await fetch(`${ctx.handle.url}/api/threads/${encodeURIComponent(threadId)}/${operation}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ctx.handle.url,
      "sec-fetch-site": "same-origin",
      authorization: `Bearer ${ctx.handle.agentToken}`,
    },
    body: JSON.stringify(body),
  });
}

/** The reviewer's promotion action, under the session cookie. */
async function promote(
  ctx: Ctx,
  body: Record<string, unknown>,
  as: "cookie" | "bearer" = "cookie",
): Promise<Response> {
  return await fetch(`${ctx.handle.url}/api/review/promote`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      origin: ctx.handle.url,
      "sec-fetch-site": "same-origin",
      ...(as === "cookie" ? { cookie: ctx.cookie } : { authorization: `Bearer ${ctx.handle.agentToken}` }),
    },
    body: JSON.stringify(body),
  });
}

interface StateBody {
  readonly stale: boolean;
  readonly state: {
    readonly openPending: { readonly reviewNodeId: string; readonly comments: ReadonlyArray<{ readonly commentId: string }> } | null;
    readonly terminal: ReadonlyArray<{ readonly reviewNodeId: string; readonly outcome: { readonly kind: string; readonly reason?: string } }>;
    readonly agentDrafts: ReadonlyArray<{ readonly threadId: string; readonly target: string; readonly commentId?: string; readonly path: string }>;
  };
}

async function readState(ctx: Ctx): Promise<StateBody> {
  const response = await fetch(`${ctx.handle.url}/api/review/state`, {
    headers: { cookie: ctx.cookie, "sec-fetch-site": "same-origin" },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as StateBody;
}

/** Import a GitHub thread so replies/resolves have a remote target. */
async function refreshAndReadImportedThread(ctx: Ctx): Promise<{ id: string; parentId: string }> {
  const refresh = await fetch(`${ctx.handle.url}/api/review/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ctx.handle.url, "sec-fetch-site": "same-origin", cookie: ctx.cookie },
    body: "{}",
  });
  expect([200, 201]).toContain(refresh.status);
  const list = await fetch(`${ctx.handle.url}/api/threads`, {
    headers: { cookie: ctx.cookie, "sec-fetch-site": "same-origin" },
  });
  const body = (await list.json()) as { threads: Array<{ id: string; external?: { provider: string }; comments: Array<{ id: string }> }> };
  const thread = body.threads.find((candidate) => candidate.external?.provider === "github");
  if (thread?.comments[0] === undefined) throw new Error("expected an imported thread");
  return { id: thread.id, parentId: thread.comments[0].id };
}

function importedThread(id: string, isResolved = false): GhReviewThread {
  return {
    id,
    path: "docs/index.md",
    isResolved,
    isOutdated: false,
    line: 2,
    startLine: null,
    originalLine: 2,
    originalStartLine: null,
    diffSide: "RIGHT",
    startDiffSide: null,
    subjectType: "LINE",
    resolvedByLogin: isResolved ? "other-reviewer" : null,
    comments: [
      {
        nodeId: `${id}_comment`,
        databaseId: 700,
        body: "remote opener",
        authorLogin: "other-reviewer",
        authorType: "User",
        createdAt: "2026-10-01T00:00:00Z",
        url: "https://github.com/example/pull/42#discussion_r700",
        originalCommitOid: HEAD_A,
        diffHunk: "@@ -1,3 +1,3 @@\n line1\n line2 with quote\n line3",
      },
    ],
  };
}

/** Every mutation the fake recorded — the "was anything written?"
 * ledger the promotion tests assert on. */
function writes(ctx: Ctx): number {
  return ctx.fake.drafts.length + ctx.fake.replies.length + ctx.fake.resolutions.length;
}

describe("#70 — an agent draft is not mirrored before promotion (zero writes)", () => {
  test("an agent's top-level comment lands locally only; the fake sees zero extra writes", async () => {
    const ctx = await startCtx();
    expect((await postComment(ctx, "reviewer first", "own")).status).toBe(201);
    expect(writes(ctx)).toBe(1);

    const agent = await postCommentAsAgent(ctx, "agent draft body", "agent1");
    expect(agent.status).toBe(201);

    // The agent's comment is a draft the reviewer can see…
    const before = await readState(ctx);
    expect(before.state.agentDrafts).toEqual([
      { threadId: "th-agent1", target: "comment", commentId: "c-agent1", path: "docs/index.md" },
    ]);
    // …and NOTHING reached GitHub.
    expect(writes(ctx)).toBe(1);
    expect(ctx.fake.drafts).toHaveLength(1);
    expect(ctx.fake.replies).toHaveLength(0);
    expect(ctx.fake.resolutions).toHaveLength(0);
  });

  test("an agent's reply on an imported thread lands locally only; the fake sees zero replies", async () => {
    const ctx = await startCtx({ threads: [importedThread("PRT_reply_draft")] });
    const imported = await refreshAndReadImportedThread(ctx);
    expect((await postComment(ctx, "reviewer opens the review", "own")).status).toBe(201);
    const writesBefore = writes(ctx);

    const reply = await agentLifecycle(ctx, imported.id, "replies", { commentId: "agent-reply-1", parentId: imported.parentId, body: "agent reply body" });
    expect(reply.status).toBe(201);

    expect(writes(ctx)).toBe(writesBefore);
    expect(ctx.fake.replies).toHaveLength(0);
    const state = await readState(ctx);
    expect(state.state.agentDrafts).toEqual([
      { threadId: imported.id, target: "comment", commentId: "agent-reply-1", path: "docs/index.md" },
    ]);
  });

  test("an agent's resolve / reopen lands locally only; the fake sees zero resolutions", async () => {
    const ctx = await startCtx({ threads: [importedThread("PRT_resolve_draft")] });
    const imported = await refreshAndReadImportedThread(ctx);
    expect((await postComment(ctx, "reviewer opens the review", "own")).status).toBe(201);
    const writesBefore = writes(ctx);

    expect((await agentLifecycle(ctx, imported.id, "resolve", {})).status).toBe(201);
    expect(writes(ctx)).toBe(writesBefore);
    expect(ctx.fake.resolutions).toHaveLength(0);
    expect((await readState(ctx)).state.agentDrafts).toEqual([
      { threadId: imported.id, target: "resolve", path: "docs/index.md" },
    ]);

    expect((await agentLifecycle(ctx, imported.id, "reopen", {})).status).toBe(201);
    expect(writes(ctx)).toBe(writesBefore);
    expect(ctx.fake.resolutions).toHaveLength(0);
    expect((await readState(ctx)).state.agentDrafts).toEqual([
      { threadId: imported.id, target: "reopen", path: "docs/index.md" },
    ]);
  });
});

describe("#70 — promotion attaches the draft to the reviewer's pending review", () => {
  test("a promoted top-level agent comment is exactly one draft in the pending review, under the reviewer", async () => {
    const ctx = await startCtx();
    expect((await postComment(ctx, "reviewer first", "own")).status).toBe(201);
    expect((await postCommentAsAgent(ctx, "agent draft body", "agent1")).status).toBe(201);
    expect(ctx.fake.drafts).toHaveLength(1);
    const pendingReviewNodeId = ctx.fake.reviewNodeId;

    const response = await promote(ctx, { threadId: "th-agent1", target: "comment", commentId: "c-agent1" });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { ok: boolean; promoted: boolean; target: string; newlySynced: readonly string[] };
    expect(body.ok).toBe(true);
    expect(body.promoted).toBe(true);
    expect(body.target).toBe("comment");
    expect(body.newlySynced).toEqual(["c-agent1"]);

    // EXACTLY one new draft, in the reviewer's own pending review.
    expect(ctx.fake.drafts).toHaveLength(2);
    const promotedDraft = ctx.fake.drafts[1]!;
    expect(promotedDraft.body).toContain("agent draft body");
    expect(promotedDraft.path).toBe("docs/index.md");
    expect(ctx.fake.reviewNodeId).toBe(pendingReviewNodeId);

    // The intent log records the promotion as the REVIEWER's act.
    const state = await readState(ctx);
    expect(state.state.openPending?.comments.map((entry) => entry.commentId)).toEqual(["c-own", "c-agent1"]);
    expect(state.state.agentDrafts).toEqual([]);
  });

  test("a promoted agent reply is exactly one reply, pinned to the pending review", async () => {
    const ctx = await startCtx({ threads: [importedThread("PRT_reply_promote")] });
    const imported = await refreshAndReadImportedThread(ctx);
    expect((await postComment(ctx, "reviewer opens the review", "own")).status).toBe(201);
    expect((await agentLifecycle(ctx, imported.id, "replies", { commentId: "agent-reply-1", parentId: imported.parentId, body: "agent reply body" })).status).toBe(201);
    const writesBefore = writes(ctx);

    const response = await promote(ctx, { threadId: imported.id, target: "comment", commentId: "agent-reply-1" });
    expect(response.status).toBe(201);
    expect(ctx.fake.replies).toHaveLength(1);
    expect(ctx.fake.replies[0]?.body).toBe("agent reply body");
    expect(ctx.fake.replies[0]?.threadNodeId).toBe("PRT_reply_promote");
    expect(ctx.fake.replies[0]?.pendingReviewId).toBe(ctx.fake.reviewNodeId ?? undefined);
    expect(writes(ctx)).toBe(writesBefore + 1);
    expect((await readState(ctx)).state.agentDrafts).toEqual([]);
  });

  test("a promoted agent resolve is exactly one resolveReviewThread, under the reviewer", async () => {
    const ctx = await startCtx({ threads: [importedThread("PRT_resolve_promote")] });
    const imported = await refreshAndReadImportedThread(ctx);
    expect((await postComment(ctx, "reviewer opens the review", "own")).status).toBe(201);
    expect((await agentLifecycle(ctx, imported.id, "resolve", {})).status).toBe(201);
    expect(ctx.fake.resolutions).toHaveLength(0);

    const response = await promote(ctx, { threadId: imported.id, target: "resolve" });
    expect(response.status).toBe(201);
    expect(ctx.fake.resolutions).toEqual([{ threadNodeId: "PRT_resolve_promote", op: "resolve" }]);
    expect((await readState(ctx)).state.agentDrafts).toEqual([]);
  });

  test("a promoted agent reopen is exactly one unresolveReviewThread", async () => {
    const ctx = await startCtx({ threads: [importedThread("PRT_reopen_promote", true)] });
    const imported = await refreshAndReadImportedThread(ctx);
    expect((await postComment(ctx, "reviewer opens the review", "own")).status).toBe(201);
    expect((await agentLifecycle(ctx, imported.id, "reopen", {})).status).toBe(201);
    expect(ctx.fake.resolutions).toHaveLength(0);

    const response = await promote(ctx, { threadId: imported.id, target: "reopen" });
    expect(response.status).toBe(201);
    expect(ctx.fake.resolutions).toEqual([{ threadNodeId: "PRT_reopen_promote", op: "unresolve" }]);
    expect((await readState(ctx)).state.agentDrafts).toEqual([]);
  });
});

describe("#70 — SECURITY: the agent bearer can author a draft but never promote one", () => {
  test("promote with the agent bearer → 403 and zero writes", async () => {
    const ctx = await startCtx();
    expect((await postComment(ctx, "reviewer first", "own")).status).toBe(201);
    expect((await postCommentAsAgent(ctx, "agent draft body", "agent1")).status).toBe(201);
    const writesBefore = writes(ctx);

    const response = await promote(ctx, { threadId: "th-agent1", target: "comment", commentId: "c-agent1" }, "bearer");
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string; reason: string };
    expect(body.error).toBe("agent-forbidden");
    expect(body.reason).toContain("reviewer");
    expect(writes(ctx)).toBe(writesBefore);
    // Still an unpromoted draft, not a published one.
    expect((await readState(ctx)).state.agentDrafts).toHaveLength(1);
  });

  test("promoting the reviewer's OWN comment is refused (not-an-agent-draft) with no write", async () => {
    const ctx = await startCtx();
    expect((await postComment(ctx, "reviewer first", "own")).status).toBe(201);
    const writesBefore = writes(ctx);

    const response = await promote(ctx, { threadId: "th-own", target: "comment", commentId: "c-own" });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; reason: string };
    expect(body.error).toBe("not-an-agent-draft");
    expect(writes(ctx)).toBe(writesBefore);
  });

  test("an unknown thread / comment is refused precisely, with no write", async () => {
    const ctx = await startCtx();
    expect((await postComment(ctx, "reviewer first", "own")).status).toBe(201);
    const writesBefore = writes(ctx);

    const missingThread = await promote(ctx, { threadId: "th-nope", target: "resolve" });
    expect(missingThread.status).toBe(409);
    expect(((await missingThread.json()) as { error: string }).error).toBe("unknown-thread");

    const missingComment = await promote(ctx, { threadId: "th-own", target: "comment", commentId: "c-nope" });
    expect(missingComment.status).toBe(409);
    expect(((await missingComment.json()) as { error: string }).error).toBe("unknown-comment");

    expect(writes(ctx)).toBe(writesBefore);
  });
});

describe("#70 — idempotency", () => {
  test("a double promote is one write; the second call says already-promoted", async () => {
    const ctx = await startCtx();
    expect((await postComment(ctx, "reviewer first", "own")).status).toBe(201);
    expect((await postCommentAsAgent(ctx, "agent draft body", "agent1")).status).toBe(201);

    const first = await promote(ctx, { threadId: "th-agent1", target: "comment", commentId: "c-agent1" });
    expect(first.status).toBe(201);
    expect(ctx.fake.drafts).toHaveLength(2);

    const second = await promote(ctx, { threadId: "th-agent1", target: "comment", commentId: "c-agent1" });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { ok: boolean; promoted: boolean; reason?: string };
    expect(body.promoted).toBe(false);
    expect(body.reason).toBe("already-promoted");
    // One write, not two.
    expect(ctx.fake.drafts).toHaveLength(2);
  });

  test("a double promote of a resolve is one resolution", async () => {
    const ctx = await startCtx({ threads: [importedThread("PRT_resolve_twice")] });
    const imported = await refreshAndReadImportedThread(ctx);
    expect((await postComment(ctx, "reviewer opens the review", "own")).status).toBe(201);
    expect((await agentLifecycle(ctx, imported.id, "resolve", {})).status).toBe(201);

    expect((await promote(ctx, { threadId: imported.id, target: "resolve" })).status).toBe(201);
    expect(ctx.fake.resolutions).toHaveLength(1);
    expect((await promote(ctx, { threadId: imported.id, target: "resolve" })).status).toBe(200);
    expect(ctx.fake.resolutions).toHaveLength(1);
  });

  test("a promote after the review was SUBMITTED is refused with no write", async () => {
    const ctx = await startCtx();
    expect((await postComment(ctx, "reviewer first", "own")).status).toBe(201);
    expect((await postCommentAsAgent(ctx, "agent draft body", "agent1")).status).toBe(201);
    const submit = await fetch(`${ctx.handle.url}/api/review/submit`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ctx.handle.url, "sec-fetch-site": "same-origin", cookie: ctx.cookie },
      body: JSON.stringify({ event: "COMMENT" }),
    });
    expect(submit.status).toBe(201);
    const writesBefore = writes(ctx);

    const response = await promote(ctx, { threadId: "th-agent1", target: "comment", commentId: "c-agent1" });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; reason: string };
    expect(body.error).toBe("no-open-pending-review");
    expect(body.reason).toContain("no open pending review");
    // The submitted review is untouched and no new review opened.
    expect(writes(ctx)).toBe(writesBefore);
    expect(ctx.fake.submits).toHaveLength(1);
  });

  test("a promote after the review was DISCARDED is refused with no write", async () => {
    const ctx = await startCtx();
    expect((await postComment(ctx, "reviewer first", "own")).status).toBe(201);
    expect((await postCommentAsAgent(ctx, "agent draft body", "agent1")).status).toBe(201);
    const discard = await fetch(`${ctx.handle.url}/api/review/discard`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ctx.handle.url, "sec-fetch-site": "same-origin", cookie: ctx.cookie },
      body: JSON.stringify({ reason: "user-discarded" }),
    });
    expect(discard.status).toBe(201);
    expect(ctx.fake.reviewNodeId).toBeNull();
    const writesBefore = writes(ctx);

    const response = await promote(ctx, { threadId: "th-agent1", target: "comment", commentId: "c-agent1" });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe("no-open-pending-review");
    // No pending review was quietly reopened behind the reviewer.
    expect(ctx.fake.reviewNodeId).toBeNull();
    expect(writes(ctx)).toBe(writesBefore);
  });

  test("a restart between the promotion and its reconcile heals without a duplicate write", async () => {
    let ctx = await startCtx({ threads: [importedThread("PRT_promote_lost")], loseResponseOnce: "AddReviewThreadReply" });
    const imported = await refreshAndReadImportedThread(ctx);
    expect((await postComment(ctx, "reviewer opens the review", "own")).status).toBe(201);
    expect((await agentLifecycle(ctx, imported.id, "replies", { commentId: "agent-reply-1", parentId: imported.parentId, body: "agent reply body" })).status).toBe(201);

    // GitHub accepted the reply but the response was lost: the fake has
    // the write, the log has the intent but not the completion.
    const promote1 = await promote(ctx, { threadId: imported.id, target: "comment", commentId: "agent-reply-1" });
    expect(promote1.status).toBe(201);
    expect(ctx.fake.replies).toHaveLength(1);

    ctx = await restartCtx(ctx);
    await Bun.sleep(50);
    // Boot never mutates: still exactly one reply.
    expect(ctx.fake.replies).toHaveLength(1);

    // The retry completes the SAME promotion — no second event, no
    // second write.
    const retry = await promote(ctx, { threadId: imported.id, target: "comment", commentId: "agent-reply-1" });
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { promoted: boolean }).promoted).toBe(false);
    expect(ctx.fake.replies).toHaveLength(1);
    expect((await readState(ctx)).state.agentDrafts).toEqual([]);
  });
});
