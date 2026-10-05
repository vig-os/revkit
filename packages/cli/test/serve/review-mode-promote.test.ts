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
import { Database } from "bun:sqlite";
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
  type ReviewEvent,
  type ReviewEventInput,
  type TokenSource,
} from "@revkit/review-core";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";
import { SqliteThreadStore } from "../../src/serve/sqlite-store.ts";
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
  sqlitePath: string;
  cookie: string;
}

const SOURCE = "line1\nline2 with quote\nline3\n";
/** A path under the repo root that the fake PR's `files` omits. */
const OUTSIDE_PATH = "docs/outside-diff.md";
const OUTSIDE_SOURCE = "outside1\noutside2\n";

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
  // A real file under the repo root that the PR's file list does NOT
  // mention. `POST /api/threads` validates the path against the repo
  // root only, so a comment can anchor here — and its anchor then has no
  // GitHub position to map to, which is the `promote-mapping-orphan`
  // refusal the BLOCKER-1 probe needs.
  writeFileSync(join(root, OUTSIDE_PATH), OUTSIDE_SOURCE);
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
  return {
    handle,
    fake: pending,
    fakeFetch,
    root,
    sqlitePath: join(root, "threads.sqlite"),
    cookie: setCookie.slice(0, setCookie.indexOf(";")),
  };
}

/** Read the daemon's own sqlite with a SECOND store handle — the log
 * as bytes on disk, not as any route projects it. Used to assert that a
 * refusal appended nothing, and to read the crash-window state. */
async function readRawEvents(sqlitePath: string): Promise<ReviewEvent[]> {
  const store = SqliteThreadStore.open({ filename: sqlitePath });
  try {
    const events: ReviewEvent[] = [];
    let after = 0;
    for (;;) {
      const page = await store.since(after);
      if (page.length === 0) break;
      events.push(...page);
      after = page[page.length - 1]!.seq;
    }
    return events;
  } finally {
    store.close();
  }
}

/** Rewrite a stored comment's body in place, directly on the sqlite —
 * the only way to reach the state a future `comment.edited` route would
 * produce, and the point of pinning the promotion's content. Done with a
 * raw UPDATE rather than an event so the daemon's own log order is
 * untouched; an edit route would append, and the pin refuses either. */
function rewriteCommentBody(sqlitePath: string, commentId: string, body: string): void {
  const db = new Database(sqlitePath);
  try {
    const rows = db
      .query<{ seq: number }, []>("SELECT seq FROM events ORDER BY seq ASC")
      .all();
    for (const { seq } of rows) {
      const payloadRow = db
        .query<{ payload: string }, [number]>("SELECT payload FROM events WHERE seq = ?")
        .get(seq);
      if (payloadRow === null) continue;
      const event = JSON.parse(payloadRow.payload) as { commentId?: string; body?: string };
      if (event.commentId !== commentId || typeof event.body !== "string") continue;
      event.body = body;
      db.query("UPDATE events SET payload = ? WHERE seq = ?").run(JSON.stringify(event), seq);
    }
  } finally {
    db.close();
  }
}

/** Reproduce the crash window EXACTLY, without racing a process: with
 * the daemon stopped, append only what `promoteAgentDraft`'s first
 * append would have written — `draft.promoted` with no intent after it.
 * The two appends are adjacent in the code and nothing fallible sits
 * between them, so this is byte-for-byte what a process death leaves
 * behind. */
async function appendPromotionOnly(ctx: Ctx, event: ReviewEventInput): Promise<void> {
  const store = SqliteThreadStore.open({ filename: ctx.sqlitePath });
  try {
    await store.append(event);
  } finally {
    store.close();
  }
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
 * refuses a non-local actor, so this can only ever land locally.
 * `path` defaults to the file the PR's diff covers; pass
 * `OUTSIDE_PATH` for an anchor with no GitHub position. */
async function postCommentAsAgent(
  ctx: Ctx,
  body: string,
  suffix: string,
  path = "docs/index.md",
): Promise<Response> {
  const outside = path === OUTSIDE_PATH;
  const source = outside ? OUTSIDE_SOURCE : SOURCE;
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
        path,
        startLine: 2,
        endLine: 2,
        quote: outside
          ? { exact: "outside2", prefix: "outside1\n", suffix: "" }
          : { exact: "line2 with quote", prefix: "line1\n", suffix: "\nline3" },
        revision: await revisionOf(source),
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
    readonly unsyncedCommentIds?: readonly string[];
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

// The reviewer's two probes against PR #123 (`bf2fd9c6`), verbatim.
// Both were reachable through ordinary reviewer/agent actions and the
// fake only.
describe("#70 round 1 — PROBE 1: a refused promotion must not retire the draft (review finding 1)", () => {
  test("a promote-mapping-orphan refusal leaves agentDrafts unchanged and a later valid promotion still works", async () => {
    const ctx = await startCtx();
    expect((await postComment(ctx, "reviewer first", "own")).status).toBe(201);
    // An agent draft on a path OUTSIDE the PR's file list: the anchor
    // is real under the repo root, so the comment lands, but it has no
    // GitHub position to map to.
    expect((await postCommentAsAgent(ctx, "agent draft outside the diff", "outside", OUTSIDE_PATH)).status).toBe(201);
    const writesBefore = writes(ctx);

    const before = await readState(ctx);
    expect(before.state.agentDrafts).toEqual([
      { threadId: "th-outside", target: "comment", commentId: "c-outside", path: OUTSIDE_PATH },
    ]);

    // PROBE 1: the refusal.
    const refusal = await promote(ctx, { threadId: "th-outside", target: "comment", commentId: "c-outside" });
    expect(refusal.status).toBe(409);
    const body = (await refusal.json()) as { error: string };
    expect(body.error).toBe("promote-mapping-orphan");

    // The four harms the review named, each asserted.
    //   1-2. the log did NOT record a promotion for a promotion that did
    //         not happen — the draft is still listed
    //   3.   the comment is still reachable as a draft
    //   4.   the rail's affordance still exists, because it reads this
    //         very list
    const after = await readState(ctx);
    expect(after.state.agentDrafts).toEqual(before.state.agentDrafts);
    // Nothing was written to GitHub by the refusal.
    expect(writes(ctx)).toBe(writesBefore);
    // And the comment is not left stranded as an unsynced intent either.
    expect(after.state.unsyncedCommentIds).toEqual([]);

    // A later, valid promotion of a DIFFERENT draft still works, so the
    // refusal did not poison the route or the pending review.
    expect((await postCommentAsAgent(ctx, "agent draft inside the diff", "inside")).status).toBe(201);
    const valid = await promote(ctx, { threadId: "th-inside", target: "comment", commentId: "c-inside" });
    expect(valid.status).toBe(201);
    expect(ctx.fake.drafts).toHaveLength(2);
    expect(ctx.fake.drafts[1]?.body).toContain("agent draft inside the diff");

    // The refused draft is STILL there — the reviewer can retry it (or
    // re-anchor it) rather than having lost it.
    const final = await readState(ctx);
    expect(final.state.agentDrafts).toEqual([
      { threadId: "th-outside", target: "comment", commentId: "c-outside", path: OUTSIDE_PATH },
    ]);
  });

  test("retrying the refused promotion refuses identically — it does not claim the draft was promoted", async () => {
    const ctx = await startCtx();
    expect((await postComment(ctx, "reviewer first", "own")).status).toBe(201);
    expect((await postCommentAsAgent(ctx, "agent draft outside the diff", "outside", OUTSIDE_PATH)).status).toBe(201);
    const writesBefore = writes(ctx);

    const first = await promote(ctx, { threadId: "th-outside", target: "comment", commentId: "c-outside" });
    expect(first.status).toBe(409);
    const retry = await promote(ctx, { threadId: "th-outside", target: "comment", commentId: "c-outside" });
    // The old code answered 200 with promoted:false and
    // reason "already-promoted" here — the false claim the finding is
    // about, since nothing had been promoted.
    expect(retry.status).toBe(409);
    expect(((await retry.json()) as { error: string }).error).toBe("promote-mapping-orphan");
    expect(writes(ctx)).toBe(writesBefore);
    expect((await readState(ctx)).state.agentDrafts).toHaveLength(1);
  });
});

describe("#70 round 1 — PROBE 2: a superseded promotion must not fire (review finding 2)", () => {
  test("a promoted resolve followed by a reopen gives zero resolve writes to the fake", async () => {
    // The adapter write FAILS so the promoted resolve is still an
    // outstanding intent when the agent reopens the thread — which is
    // the window the finding is about.
    const ctx = await startCtx({ threads: [importedThread("PRT_stale")], failBeforeOnce: "ResolveReviewThread" });
    const imported = await refreshAndReadImportedThread(ctx);
    expect((await postComment(ctx, "reviewer opens the review", "own")).status).toBe(201);
    expect((await agentLifecycle(ctx, imported.id, "resolve", {})).status).toBe(201);

    // PROBE 2: the promotion's own write fails, so the intent survives.
    const promoted = await promote(ctx, { threadId: imported.id, target: "resolve" });
    expect(promoted.status).toBe(500);
    expect(ctx.fake.resolutions).toHaveLength(0);

    // The agent reopens the thread locally.
    expect((await agentLifecycle(ctx, imported.id, "reopen", {})).status).toBe(201);
    expect((await readState(ctx)).state.agentDrafts).toEqual([
      { threadId: imported.id, target: "reopen", path: "docs/index.md" },
    ]);

    // The route refuses the now-stale resolve — the reviewer is told.
    const stale = await promote(ctx, { threadId: imported.id, target: "resolve" });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toBe("stale-lifecycle-draft");

    // The next cookie-authenticated reconcile must NOT resurrect it.
    const reconcile = await fetch(`${ctx.handle.url}/api/review/reconcile`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ctx.handle.url, "sec-fetch-site": "same-origin", cookie: ctx.cookie },
      body: "{}",
    });
    expect(reconcile.status).toBe(201);
    expect(ctx.fake.resolutions).toHaveLength(0);

    // And the local thread is open, so GitHub agrees with it.
    const threads = await fetch(`${ctx.handle.url}/api/threads`, {
      headers: { cookie: ctx.cookie, "sec-fetch-site": "same-origin" },
    });
    const listed = (await threads.json()) as { threads: Array<{ id: string; status: string }> };
    expect(listed.threads.find((thread) => thread.id === imported.id)?.status).toBe("open");
  });

  test("the same supersession holds across a restart (boot never resurrects a superseded intent)", async () => {
    let ctx = await startCtx({ threads: [importedThread("PRT_stale_restart")], failBeforeOnce: "ResolveReviewThread" });
    const imported = await refreshAndReadImportedThread(ctx);
    expect((await postComment(ctx, "reviewer opens the review", "own")).status).toBe(201);
    expect((await agentLifecycle(ctx, imported.id, "resolve", {})).status).toBe(201);
    expect((await promote(ctx, { threadId: imported.id, target: "resolve" })).status).toBe(500);

    expect((await agentLifecycle(ctx, imported.id, "reopen", {})).status).toBe(201);

    ctx = await restartCtx(ctx);
    await Bun.sleep(50);
    expect(ctx.fake.resolutions).toHaveLength(0);

    const reconcile = await fetch(`${ctx.handle.url}/api/review/reconcile`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ctx.handle.url, "sec-fetch-site": "same-origin", cookie: ctx.cookie },
      body: "{}",
    });
    expect(reconcile.status).toBe(201);
    expect(ctx.fake.resolutions).toHaveLength(0);
  });

  test("promoting the REOPEN after a superseded resolve writes only the unresolve", async () => {
    const ctx = await startCtx({ threads: [importedThread("PRT_stale_then_reopen")] });
    const imported = await refreshAndReadImportedThread(ctx);
    expect((await postComment(ctx, "reviewer opens the review", "own")).status).toBe(201);
    expect((await agentLifecycle(ctx, imported.id, "resolve", {})).status).toBe(201);
    // Promote the resolve, but the adapter write fails.
    expect((await promote(ctx, { threadId: imported.id, target: "resolve" })).status).toBe(201);
    expect(ctx.fake.resolutions).toEqual([{ threadNodeId: "PRT_stale_then_reopen", op: "resolve" }]);
    expect((await agentLifecycle(ctx, imported.id, "reopen", {})).status).toBe(201);

    const reopen = await promote(ctx, { threadId: imported.id, target: "reopen" });
    expect(reopen.status).toBe(201);
    // Exactly one unresolve; the resolve is not repeated.
    expect(ctx.fake.resolutions).toEqual([
      { threadNodeId: "PRT_stale_then_reopen", op: "resolve" },
      { threadNodeId: "PRT_stale_then_reopen", op: "unresolve" },
    ]);
    expect((await readState(ctx)).state.agentDrafts).toEqual([]);
  });
});

// ── Round 2 ────────────────────────────────────────────────────────────
// (a) the content pin, (b) an agent lifecycle change superseding the
// reviewer's own pending intent, (c) the crash window, (d) the N3
// invariant behind `intentRecordedFor`.

describe("#70 round 2 — the promotion PINS the content it approves", () => {
  test("a promotion records the comment's authoring seq and its body hash", async () => {
    const ctx = await startCtx();
    expect((await postComment(ctx, "reviewer first", "own")).status).toBe(201);
    expect((await postCommentAsAgent(ctx, "agent draft body", "pinned")).status).toBe(201);

    const before = await readRawEvents(ctx.sqlitePath);
    const authored = before.find((event) => event.kind === "comment.created" && event.commentId === "c-pinned");
    if (authored === undefined) throw new Error("no authored event");
    expect(before.some((event) => event.kind === "draft.promoted")).toBe(false);

    expect((await promote(ctx, { threadId: "th-pinned", target: "comment", commentId: "c-pinned" })).status).toBe(201);
    const after = await readRawEvents(ctx.sqlitePath);
    const recorded = after.find((event) => event.kind === "draft.promoted");
    if (recorded === undefined || recorded.kind !== "draft.promoted") throw new Error("no promotion recorded");
    expect(recorded.commentSeq).toBe(authored.seq);
    expect(recorded.bodyHash).toBe(await revisionOf("agent draft body"));
    // The pin is the SAME text the intent carries, so a reviewer who
    // reads one has read the other.
    const intent = after.find((event) => event.kind === "comment.sync_requested" && event.commentId === "c-pinned");
    expect(intent?.kind === "comment.sync_requested" ? intent.bodyHash : undefined).toBe(recorded.bodyHash);
  });

  test("a comment whose body no longer matches the pin is refused (promoted-body-changed)", async () => {
    // There is no edit route today, so this reproduces the shape an edit
    // route would produce: the log's `comment.created` body is replaced
    // with different text behind the daemon's back (a second store
    // handle on the same sqlite, the only way to do it today).
    const ctx = await startCtx();
    expect((await postComment(ctx, "reviewer first", "own")).status).toBe(201);
    expect((await postCommentAsAgent(ctx, "agent draft body", "swapped")).status).toBe(201);
    // Promote, and let the intent append be lost (the crash window), so
    // the promotion is on the log with its pin and NO intent.
    await ctx.handle.stop();
    const authored = (await readRawEvents(ctx.sqlitePath)).find(
      (event) => event.kind === "comment.created" && event.commentId === "c-swapped",
    );
    if (authored === undefined) throw new Error("no authored event");
    await appendPromotionOnly(ctx, {
      kind: "draft.promoted",
      actor: { kind: "local", id: "p70-user" },
      threadId: "th-swapped",
      target: "comment",
      commentId: "c-swapped",
      commentSeq: authored.seq,
      bodyHash: await revisionOf("agent draft body"),
    });
    // Now rewrite the stored body, as an edit would.
    rewriteCommentBody(ctx.sqlitePath, "c-swapped", "SWAPPED TEXT THE REVIEWER NEVER READ");

    const restarted = await restartCtx(ctx);
    const draftsBefore = restarted.fake.drafts.length;
    const refusal = await promote(restarted, { threadId: "th-swapped", target: "comment", commentId: "c-swapped" });
    expect(refusal.status).toBe(409);
    const body = (await refusal.json()) as { error: string };
    expect(body.error).toBe("promoted-body-changed");
    // Nothing was posted, and the daemon did not heal an intent either.
    await Bun.sleep(100);
    expect(restarted.fake.drafts.length).toBe(draftsBefore);
    expect((await readState(restarted)).state.agentDrafts).toEqual([]);
  });
});

describe("#70 round 2 — an agent lifecycle change supersedes the reviewer's own pending intent", () => {
  test("a reviewer resolve whose write failed is dropped when the agent reopens — no write", async () => {
    // The behaviour change vs bf56d878: the reconciler used to keep a
    // reviewer's OWN unresolved intent alive no matter what came after
    // it. Now the thread's current lifecycle change wins whoever
    // authored it, so the agent's reopen retires the reviewer's
    // resolve. Both threads end `open`, which is the point: firing the
    // stale resolve would make GitHub disagree with the log.
    const ctx = await startCtx({ threads: [importedThread("PRT_local_pending")], failBeforeOnce: "ResolveReviewThread" });
    const imported = await refreshAndReadImportedThread(ctx);
    expect((await postComment(ctx, "reviewer opens the review", "own")).status).toBe(201);

    // The REVIEWER resolves (cookie) and the write fails, so the intent
    // is still outstanding.
    const reviewResolve = await fetch(`${ctx.handle.url}/api/threads/${encodeURIComponent(imported.id)}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ctx.handle.url, "sec-fetch-site": "same-origin", cookie: ctx.cookie },
      body: "{}",
    });
    expect(reviewResolve.status).toBe(201);
    expect(ctx.fake.resolutions).toHaveLength(0);

    // The agent reopens the thread locally.
    expect((await agentLifecycle(ctx, imported.id, "reopen", {})).status).toBe(201);

    // A cookie reconcile must not now fire the reviewer's stale resolve.
    const reconcile = await fetch(`${ctx.handle.url}/api/review/reconcile`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ctx.handle.url, "sec-fetch-site": "same-origin", cookie: ctx.cookie },
      body: "{}",
    });
    expect(reconcile.status).toBe(201);
    expect(ctx.fake.resolutions).toHaveLength(0);

    // And it survives a restart: the supersession is a property of the
    // log, not of the process that read it.
    const restarted = await restartCtx(ctx);
    await Bun.sleep(60);
    expect(restarted.fake.resolutions).toHaveLength(0);
    const reconcile2 = await fetch(`${restarted.handle.url}/api/review/reconcile`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: restarted.handle.url, "sec-fetch-site": "same-origin", cookie: restarted.cookie },
      body: "{}",
    });
    expect(reconcile2.status).toBe(201);
    expect(restarted.fake.resolutions).toHaveLength(0);

    // No `thread.external_synced` claims a baseline that never happened.
    const log = await readRawEvents(restarted.sqlitePath);
    expect(log.filter((event) => event.kind === "thread.external_synced")).toEqual([]);
  });

  test("the reverse order: the agent resolves, the reviewer reopens — the reviewer's own current change is what acts", async () => {
    // The counterpart to the case above, so the precedence is pinned from
    // both directions: a reviewer's OWN later change supersedes an agent
    // draft (and, being authorized already, it acts without promotion).
    const ctx = await startCtx({ threads: [importedThread("PRT_reverse")] });
    const imported = await refreshAndReadImportedThread(ctx);
    expect((await postComment(ctx, "reviewer opens the review", "own")).status).toBe(201);

    // The agent resolves (a draft, unpromoted: no write), then the
    // reviewer reopens. A reopen needs a resolved thread, so the order
    // here is resolve-then-reopen with the REVIEWER reopening.
    expect((await agentLifecycle(ctx, imported.id, "resolve", {})).status).toBe(201);
    expect(ctx.fake.resolutions).toHaveLength(0);
    expect((await readState(ctx)).state.agentDrafts).toEqual([
      { threadId: imported.id, target: "resolve", path: "docs/index.md" },
    ]);
    const reviewReopen = await fetch(`${ctx.handle.url}/api/threads/${encodeURIComponent(imported.id)}/reopen`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ctx.handle.url, "sec-fetch-site": "same-origin", cookie: ctx.cookie },
      body: "{}",
    });
    expect(reviewReopen.status).toBe(201);

    // The agent's resolve is superseded: no draft, and nothing was ever
    // promoted, so no write.
    expect((await readState(ctx)).state.agentDrafts).toEqual([]);
    const reconcile = await fetch(`${ctx.handle.url}/api/review/reconcile`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ctx.handle.url, "sec-fetch-site": "same-origin", cookie: ctx.cookie },
      body: "{}",
    });
    expect(reconcile.status).toBe(201);
    expect(ctx.fake.resolutions).toHaveLength(0);
  });
});

describe("#70 round 2 — the crash window: boot heals a promotion with no intent", () => {
  test("a promotion with no intent is repaired on the next start, and writes exactly once", async () => {
    const ctx = await startCtx();
    expect((await postComment(ctx, "reviewer first", "own")).status).toBe(201);
    expect((await postCommentAsAgent(ctx, "agent draft body", "crash")).status).toBe(201);
    const writesBefore = writes(ctx);

    // Kill between the two appends, exactly.
    await ctx.handle.stop();
    const authored = (await readRawEvents(ctx.sqlitePath)).find(
      (event) => event.kind === "comment.created" && event.commentId === "c-crash",
    );
    if (authored === undefined) throw new Error("no authored event");
    await appendPromotionOnly(ctx, {
      kind: "draft.promoted",
      actor: { kind: "local", id: "p70-user" },
      threadId: "th-crash",
      target: "comment",
      commentId: "c-crash",
      commentSeq: authored.seq,
      bodyHash: await revisionOf("agent draft body"),
    });
    const crashed = await readRawEvents(ctx.sqlitePath);
    // The window really is "promotion, no intent".
    expect(crashed.some((event) => event.kind === "draft.promoted")).toBe(true);
    expect(crashed.some((event) => event.kind === "comment.sync_requested" && event.commentId === "c-crash")).toBe(false);

    // Restart. Boot heals the intent and, being read-only on the remote,
    // does NOT write.
    const restarted = await restartCtx(ctx);
    await Bun.sleep(120);
    const healed = await readRawEvents(restarted.sqlitePath);
    const repaired = healed.find((event) => event.kind === "comment.sync_requested" && event.commentId === "c-crash");
    expect(repaired).toBeDefined();
    if (repaired?.kind !== "comment.sync_requested") throw new Error("no repaired intent");
    // The repaired intent carries the pinned text, not a fresh reading.
    expect(repaired.bodyHash).toBe(await revisionOf("agent draft body"));
    expect(writes(restarted)).toBe(writesBefore);

    // The draft is back in the unsynced set (it is no longer invisible),
    // and the reviewer's next cookie action posts it — exactly once.
    expect((await readState(restarted)).state.unsyncedCommentIds).toContain("c-crash");
    // The reviewer's promote answers 200 here: the boot heal already
    // recorded the intent, so this call appends no event — it only runs
    // the read-first reconcile that posts it.
    const retry = await promote(restarted, { threadId: "th-crash", target: "comment", commentId: "c-crash" });
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { promoted: boolean }).promoted).toBe(false);
    expect(writes(restarted)).toBe(writesBefore + 1);
    expect(restarted.fake.drafts[restarted.fake.drafts.length - 1]?.body).toContain("agent draft body");

    // A second promote, a second reconcile and a restart add nothing.
    expect((await promote(restarted, { threadId: "th-crash", target: "comment", commentId: "c-crash" })).status).toBe(200);
    const reconcile = await fetch(`${restarted.handle.url}/api/review/reconcile`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: restarted.handle.url, "sec-fetch-site": "same-origin", cookie: restarted.cookie },
      body: "{}",
    });
    expect(reconcile.status).toBe(201);
    expect(writes(restarted)).toBe(writesBefore + 1);
  });

  test("the boot heal is idempotent: a restart over a healed log appends nothing new", async () => {
    const ctx = await startCtx();
    expect((await postComment(ctx, "reviewer first", "own")).status).toBe(201);
    expect((await postCommentAsAgent(ctx, "agent draft body", "healed")).status).toBe(201);
    expect((await promote(ctx, { threadId: "th-healed", target: "comment", commentId: "c-healed" })).status).toBe(201);
    const afterPromote = (await readRawEvents(ctx.sqlitePath)).length;

    let restarted = await restartCtx(ctx);
    await Bun.sleep(120);
    expect((await readRawEvents(restarted.sqlitePath)).length).toBe(afterPromote);
    restarted = await restartCtx(restarted);
    await Bun.sleep(120);
    expect((await readRawEvents(restarted.sqlitePath)).length).toBe(afterPromote);
    expect(writes(restarted)).toBe(2);
  });

  test("a promotion with no intent and an unmappable anchor is NOT healed", async () => {
    const ctx = await startCtx();
    expect((await postComment(ctx, "reviewer first", "own")).status).toBe(201);
    expect((await postCommentAsAgent(ctx, "agent draft outside", "outside", OUTSIDE_PATH)).status).toBe(201);
    const writesBefore = writes(ctx);

    await ctx.handle.stop();
    const authored = (await readRawEvents(ctx.sqlitePath)).find(
      (event) => event.kind === "comment.created" && event.commentId === "c-outside",
    );
    if (authored === undefined) throw new Error("no authored event");
    await appendPromotionOnly(ctx, {
      kind: "draft.promoted",
      actor: { kind: "local", id: "p70-user" },
      threadId: "th-outside",
      target: "comment",
      commentId: "c-outside",
      commentSeq: authored.seq,
      bodyHash: await revisionOf("agent draft outside"),
    });

    const restarted = await restartCtx(ctx);
    await Bun.sleep(120);
    const log = await readRawEvents(restarted.sqlitePath);
    expect(log.some((event) => event.kind === "comment.sync_requested" && event.commentId === "c-outside")).toBe(false);
    expect(writes(restarted)).toBe(writesBefore);
    // The promotion still stands as the record of what was attempted.
    expect(log.some((event) => event.kind === "draft.promoted")).toBe(true);
  });
});

describe("#70 round 2 — N3: the invariant behind intentRecordedFor", () => {
  test("a linked agent comment always has an intent behind it", async () => {
    // `intentRecordedFor` treats a bare `comment.linked` as "the intent
    // was already recorded". That is only safe while nothing links a
    // comment without an intent, so this pins the fact the docstring
    // names: every `comment.linked` the daemon appends for an
    // agent-authored comment is preceded by its `comment.sync_requested`.
    const ctx = await startCtx();
    expect((await postComment(ctx, "reviewer first", "own")).status).toBe(201);
    expect((await postCommentAsAgent(ctx, "agent draft body", "linked")).status).toBe(201);
    expect((await promote(ctx, { threadId: "th-linked", target: "comment", commentId: "c-linked" })).status).toBe(201);
    const reconcile = await fetch(`${ctx.handle.url}/api/review/reconcile`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ctx.handle.url, "sec-fetch-site": "same-origin", cookie: ctx.cookie },
      body: "{}",
    });
    expect(reconcile.status).toBe(201);

    const log = await readRawEvents(ctx.sqlitePath);
    for (const event of log) {
      if (event.kind !== "comment.linked") continue;
      const intent = log.find(
        (candidate) => candidate.kind === "comment.sync_requested" && candidate.commentId === event.commentId,
      );
      expect(intent !== undefined && intent.seq < event.seq).toBe(true);
    }
  });
});
