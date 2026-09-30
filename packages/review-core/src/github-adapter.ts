// GitHub adapter for the review core (ADR-0025, M3 part 1).
//
// Runs over plain `fetch`. No `node:*` / `bun:*` / `@octokit/*` — the
// same code runs in Bun (the M3 local daemon) and in a Cloudflare
// Worker (the M4 hosted surface). The adapter takes a `TokenSource`
// (`./token-source.ts`) and knows nothing about where the token
// came from.
//
// Surface:
//   - `getPullRequest`      — head/base SHAs and metadata (REST).
//   - `listPullRequestFiles`— every changed file with its `patch`,
//                             paginated (REST).
//   - `listReviewThreads`   — existing PR review threads with
//                             resolution state and per-thread comments
//                             (GraphQL — REST doesn't expose
//                             `isResolved`/`isOutdated`).
//   - `createPendingReview` — POST /pulls/:n/reviews, no `event`.
//   - `addPendingComment`   — POST /pulls/:n/comments (attaches to
//                             the reviewer's pending review).
//   - `listPendingComments` — GET /pulls/:n/reviews/:id/comments.
//   - `deletePendingComment`— DELETE /pulls/comments/:id.
//   - `submitReview`        — POST /pulls/:n/reviews/:id/events.
//
// Rate-limit handling: 403 with `x-ratelimit-remaining: 0` or a
// `Retry-After` header, and 429, are retried with backoff at the
// caller's request (opt-in). Other 4xx responses raise immediately
// with the GitHub message. The retry policy is a small, testable
// helper (`shouldRetry`, `retryAfterMs`) — the request path decides.
//
// Runtime-neutral: no `node:*` / `bun:*` imports.

import {
  anchorToPrComment,
  fileFallbackPreamble,
  prCommentToAnchor,
  type AnchorMapOptions,
  type AnchorMapResult,
  type PrCommentSource,
  type PrCommentToAnchorResult,
  type PrFile,
} from "./anchor-map.ts";
import type { Anchor } from "./anchor.ts";
import type { Author } from "./author.ts";
import type { ReviewEventInput } from "./events.ts";
import type { ExternalRef } from "./thread.ts";
import { redactTokenInMessage, type TokenSource } from "./token-source.ts";

// --- Public config --- //

/** Options for constructing a `GitHubAdapter`. `baseUrl` and
 * `graphqlUrl` default to the public GitHub endpoints; a test fake
 * overrides them, and an enterprise deployment (out of scope for M3
 * but on the roadmap) will too. */
export interface GitHubAdapterOptions {
  readonly token: TokenSource;
  /** Injectable fetch — defaults to the global `fetch`. Tests pass a
   * function that returns canned Responses. */
  readonly fetch?: typeof fetch;
  /** REST base URL. Defaults to `https://api.github.com`. */
  readonly baseUrl?: string;
  /** GraphQL endpoint. Defaults to `https://api.github.com/graphql`. */
  readonly graphqlUrl?: string;
  /** `User-Agent` header value. GitHub requires a non-empty UA. */
  readonly userAgent?: string;
  /** Number of pages the file lister will walk before giving up. A
   * defensive stop so a bogus `Link` header from a fake fetch cannot
   * loop forever. */
  readonly maxFilesPages?: number;
}

/** Constants exported so tests exercise the same defaults the
 * production callers see (PR-40 review lesson: tests must cover
 * default constants, not only injected options). */
export const DEFAULT_GITHUB_BASE_URL = "https://api.github.com";
export const DEFAULT_GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
export const DEFAULT_USER_AGENT = "revkit/0.0 (+https://github.com/vig-os/revkit)";
export const DEFAULT_MAX_FILES_PAGES = 40;
export const GITHUB_API_VERSION = "2022-11-28";

// --- Public types --- //

/** A pull-request coordinate. */
export interface PrRef {
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
}

/** The subset of the PR the adapter surfaces to the review core. Kept
 * small so a change in GitHub's REST envelope has one place to
 * absorb. */
export interface PullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly draft: boolean;
  readonly headSha: string;
  readonly headRef: string;
  readonly baseSha: string;
  readonly baseRef: string;
  readonly headRepoFullName: string | null;
  readonly baseRepoFullName: string;
  readonly url: string;
}

/** A GitHub review thread as surfaced by the GraphQL adapter. */
export interface GhReviewThread {
  readonly id: string;
  readonly path: string;
  readonly isResolved: boolean;
  readonly isOutdated: boolean;
  readonly line: number | null;
  readonly startLine: number | null;
  readonly originalLine: number | null;
  readonly originalStartLine: number | null;
  readonly diffSide: "RIGHT" | "LEFT";
  readonly startDiffSide: "RIGHT" | "LEFT" | null;
  readonly comments: readonly GhReviewComment[];
}

/** A single review comment inside a thread. */
export interface GhReviewComment {
  readonly databaseId: number;
  readonly nodeId: string;
  readonly body: string;
  readonly authorLogin: string | null;
  readonly authorType: "User" | "Bot" | "Unknown";
  readonly createdAt: string;
  readonly url: string;
}

/** Input for `addPendingComment`. `commitId` MUST match the pending
 * review's pinned commit (`createPendingReview({commitId})`). */
export interface AddPendingCommentInput {
  readonly pr: PrRef;
  readonly commitId: string;
  readonly path: string;
  readonly body: string;
  readonly line?: number;
  readonly side?: "RIGHT" | "LEFT";
  readonly startLine?: number;
  readonly startSide?: "RIGHT" | "LEFT";
  readonly subjectType?: "line" | "file";
}

/** A pending review-comment as returned by GitHub. */
export interface PendingReviewComment {
  readonly id: number;
  readonly nodeId: string;
  readonly path: string;
  readonly body: string;
  readonly commitId: string;
  readonly line: number | null;
  readonly startLine: number | null;
  readonly side: "RIGHT" | "LEFT" | null;
  readonly startSide: "RIGHT" | "LEFT" | null;
  readonly subjectType: "line" | "file";
  readonly url: string;
  readonly pullRequestReviewId: number | null;
}

/** Return shape for `createPendingReview`. */
export interface PendingReview {
  readonly id: number;
  readonly nodeId: string;
  readonly commitId: string;
  readonly state: string;
}

export type ReviewSubmissionEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

/** Options for `submitReview`. `body` is the top-level review message. */
export interface SubmitReviewInput {
  readonly pr: PrRef;
  readonly reviewId: number;
  readonly event: ReviewSubmissionEvent;
  readonly body?: string;
}

// --- Errors --- //

/** Thrown by every failing adapter call. `status` is the HTTP status
 * (0 for a network error before a response landed). `documentationUrl`
 * mirrors GitHub's field so a caller can surface it. */
export class GitHubApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly url: string;
  readonly documentationUrl?: string;
  readonly retryable: boolean;

  constructor(init: {
    message: string;
    status: number;
    method: string;
    url: string;
    documentationUrl?: string;
    retryable?: boolean;
  }) {
    super(init.message);
    this.name = "GitHubApiError";
    this.status = init.status;
    this.method = init.method;
    this.url = init.url;
    this.documentationUrl = init.documentationUrl;
    this.retryable = init.retryable ?? false;
  }
}

// --- Rate limiting helpers --- //

/** True when a response should be retried per GitHub's rate-limit
 * conventions: 429, or 403 with `x-ratelimit-remaining: 0`, or 403
 * whose body mentions "secondary rate limit" and a `Retry-After`. */
export function shouldRetry(status: number, headers: Headers, bodyText: string): boolean {
  if (status === 429) return true;
  if (status === 403) {
    const remaining = headers.get("x-ratelimit-remaining");
    if (remaining === "0") return true;
    if (headers.has("retry-after")) return true;
    // GitHub sometimes returns 403 with a JSON message about the
    // secondary rate limit and no `x-ratelimit-remaining: 0`.
    if (/secondary rate limit/i.test(bodyText)) return true;
  }
  return false;
}

/** Extract a delay in ms from a `Retry-After` header (seconds) or from
 * `x-ratelimit-reset` (epoch seconds). Falls back to the caller's
 * default when neither is present.
 *
 * `now` is injectable so tests are deterministic. */
export function retryAfterMs(headers: Headers, defaultMs: number, now: () => number = Date.now): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset !== null) {
    const epoch = Number.parseInt(reset, 10);
    if (Number.isFinite(epoch)) {
      const delta = epoch * 1000 - now();
      if (delta > 0) return delta;
    }
  }
  return defaultMs;
}

// --- Adapter --- //

export class GitHubAdapter {
  private readonly token: TokenSource;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly graphqlUrl: string;
  private readonly userAgent: string;
  private readonly maxFilesPages: number;

  constructor(options: GitHubAdapterOptions) {
    this.token = options.token;
    this.fetchFn = options.fetch ?? fetch.bind(globalThis);
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? DEFAULT_GITHUB_BASE_URL);
    this.graphqlUrl = options.graphqlUrl ?? DEFAULT_GITHUB_GRAPHQL_URL;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.maxFilesPages = options.maxFilesPages ?? DEFAULT_MAX_FILES_PAGES;
  }

  // --- Read paths --- //

  async getPullRequest(pr: PrRef): Promise<PullRequestSummary> {
    const url = `${this.baseUrl}/repos/${enc(pr.owner)}/${enc(pr.repo)}/pulls/${pr.pullNumber}`;
    const res = await this.rest("GET", url);
    const body = (await res.json()) as PullRequestRestBody;
    return {
      number: body.number,
      title: body.title,
      state: body.state === "closed" ? "closed" : "open",
      draft: body.draft === true,
      headSha: body.head.sha,
      headRef: body.head.ref,
      baseSha: body.base.sha,
      baseRef: body.base.ref,
      headRepoFullName: body.head.repo?.full_name ?? null,
      baseRepoFullName: body.base.repo.full_name,
      url: body.html_url,
    };
  }

  /** Walk `pull_request_files` across pages until exhausted (or the
   * defensive `maxFilesPages` cap trips). Uses the `Link: rel="next"`
   * header for pagination — no manual page counting on the caller. */
  async listPullRequestFiles(pr: PrRef): Promise<PrFile[]> {
    const files: PrFile[] = [];
    let url: string | null = `${this.baseUrl}/repos/${enc(pr.owner)}/${enc(pr.repo)}/pulls/${pr.pullNumber}/files?per_page=100`;
    let page = 0;
    while (url !== null) {
      if (page >= this.maxFilesPages) {
        throw new GitHubApiError({
          message: `listPullRequestFiles: exceeded maxFilesPages (${this.maxFilesPages}); refusing to page further`,
          status: 0,
          method: "GET",
          url,
        });
      }
      const res: Response = await this.rest("GET", url);
      const items = (await res.json()) as PullRequestFileRestBody[];
      for (const item of items) {
        files.push({
          filename: item.filename,
          previousFilename: item.previous_filename,
          patch: item.patch,
          status: item.status,
        });
      }
      url = nextPageUrl(res.headers.get("link"));
      page++;
    }
    return files;
  }

  /** Load every review thread on the PR (GraphQL, paginated). */
  async listReviewThreads(pr: PrRef): Promise<GhReviewThread[]> {
    const threads: GhReviewThread[] = [];
    let cursor: string | null = null;
    // Defensive page cap mirroring the REST walker.
    for (let page = 0; page < this.maxFilesPages; page++) {
      const response: ReviewThreadsGraphqlResponse = await this.graphql<ReviewThreadsGraphqlResponse>(
        REVIEW_THREADS_QUERY,
        {
          owner: pr.owner,
          name: pr.repo,
          number: pr.pullNumber,
          cursor,
        },
      );
      const pr_ = response.data.repository?.pullRequest ?? null;
      if (pr_ === undefined || pr_ === null) {
        throw new GitHubApiError({
          message: `listReviewThreads: repository ${pr.owner}/${pr.repo} PR #${pr.pullNumber} not found`,
          status: 404,
          method: "POST",
          url: this.graphqlUrl,
        });
      }
      for (const node of pr_.reviewThreads.nodes) {
        threads.push(mapReviewThread(node));
      }
      if (!pr_.reviewThreads.pageInfo.hasNextPage) return threads;
      cursor = pr_.reviewThreads.pageInfo.endCursor;
    }
    throw new GitHubApiError({
      message: `listReviewThreads: exceeded page cap (${this.maxFilesPages})`,
      status: 0,
      method: "POST",
      url: this.graphqlUrl,
    });
  }

  // --- Anchor mapping helpers --- //

  /** Convenience: map an anchor onto a PR's file list. Kept on the
   * adapter so callers can pass the anchor and the PR ref and get a
   * ready-to-send request payload back — the anchor-map module is
   * the pure engine underneath. */
  static mapAnchor(anchor: Anchor, files: readonly PrFile[], options?: AnchorMapOptions): AnchorMapResult {
    return anchorToPrComment(anchor, files, options);
  }

  /** Convenience: reverse-map a GitHub comment onto a review-core
   * anchor position. */
  static mapCommentToAnchor(comment: PrCommentSource): PrCommentToAnchorResult {
    return prCommentToAnchor(comment);
  }

  // --- Write paths (pending review) --- //

  /** Create a pending review pinned to `commitId`. `comments` seeds
   * initial line comments in one round-trip (GitHub's create-review
   * endpoint accepts `{path, body, line, side, start_line?,
   * start_side?}` items — not `subject_type: file`). File-level
   * comments must go through `addPendingComment` after the pending
   * review exists. */
  async createPendingReview(input: {
    readonly pr: PrRef;
    readonly commitId: string;
    readonly body?: string;
    readonly comments?: ReadonlyArray<{
      readonly path: string;
      readonly body: string;
      readonly line: number;
      readonly side?: "RIGHT" | "LEFT";
      readonly startLine?: number;
      readonly startSide?: "RIGHT" | "LEFT";
    }>;
  }): Promise<PendingReview> {
    const url = `${this.baseUrl}/repos/${enc(input.pr.owner)}/${enc(input.pr.repo)}/pulls/${input.pr.pullNumber}/reviews`;
    // Deliberately omit `event` → pending review.
    const body: Record<string, unknown> = { commit_id: input.commitId };
    if (input.body !== undefined) body.body = input.body;
    if (input.comments !== undefined && input.comments.length > 0) {
      body.comments = input.comments.map((c) => shapeCommentPayload(c));
    }
    const res = await this.rest("POST", url, body);
    const parsed = (await res.json()) as ReviewRestBody;
    return {
      id: parsed.id,
      nodeId: parsed.node_id,
      commitId: parsed.commit_id,
      state: parsed.state,
    };
  }

  /** Add a comment to the reviewer's pending review. GitHub attaches
   * a new review-comment to the pending review if one exists;
   * otherwise it starts a standalone single-comment review — the
   * caller must call `createPendingReview` first for the pending
   * behaviour. */
  async addPendingComment(input: AddPendingCommentInput): Promise<PendingReviewComment> {
    const url = `${this.baseUrl}/repos/${enc(input.pr.owner)}/${enc(input.pr.repo)}/pulls/${input.pr.pullNumber}/comments`;
    const body: Record<string, unknown> = {
      commit_id: input.commitId,
      path: input.path,
      body: input.body,
    };
    if (input.subjectType === "file") {
      body.subject_type = "file";
    } else {
      // Default: line comment.
      if (input.line === undefined) {
        throw new Error("addPendingComment: line is required for a line-subject comment");
      }
      body.line = input.line;
      body.side = input.side ?? "RIGHT";
      if (input.startLine !== undefined) {
        body.start_line = input.startLine;
        body.start_side = input.startSide ?? body.side;
      }
      body.subject_type = "line";
    }
    const res = await this.rest("POST", url, body);
    return this.parsePendingCommentResponse(await res.json());
  }

  /** List comments belonging to a specific review (pending or
   * submitted). */
  async listPendingComments(pr: PrRef, reviewId: number): Promise<PendingReviewComment[]> {
    const comments: PendingReviewComment[] = [];
    let url: string | null = `${this.baseUrl}/repos/${enc(pr.owner)}/${enc(pr.repo)}/pulls/${pr.pullNumber}/reviews/${reviewId}/comments?per_page=100`;
    let page = 0;
    while (url !== null) {
      if (page >= this.maxFilesPages) {
        throw new GitHubApiError({
          message: `listPendingComments: exceeded maxFilesPages (${this.maxFilesPages})`,
          status: 0,
          method: "GET",
          url,
        });
      }
      const res: Response = await this.rest("GET", url);
      const items = (await res.json()) as unknown[];
      for (const item of items) {
        comments.push(this.parsePendingCommentResponse(item));
      }
      url = nextPageUrl(res.headers.get("link"));
      page++;
    }
    return comments;
  }

  /** Delete a pending review comment. */
  async deletePendingComment(pr: PrRef, commentId: number): Promise<void> {
    const url = `${this.baseUrl}/repos/${enc(pr.owner)}/${enc(pr.repo)}/pulls/comments/${commentId}`;
    await this.rest("DELETE", url);
  }

  /** Submit a pending review. */
  async submitReview(input: SubmitReviewInput): Promise<void> {
    const url = `${this.baseUrl}/repos/${enc(input.pr.owner)}/${enc(input.pr.repo)}/pulls/${input.pr.pullNumber}/reviews/${input.reviewId}/events`;
    const body: Record<string, unknown> = { event: input.event };
    if (input.body !== undefined) body.body = input.body;
    await this.rest("POST", url, body);
  }

  // --- Thread mapping --- //

  /** Map GitHub review threads to review-core thread events.
   *
   * Each thread emits one `comment.created` (with its dual anchor
   * built from the thread's line range and quote text), followed by
   * one `comment.replied` per additional comment. The first
   * `comment.linked` event follows each comment.created / replied
   * so the review-core thread carries the GitHub external ids.
   *
   * The revision is provided by the caller — this module does not
   * read from disk. Callers pass the SHA-256 of the file's PR-head
   * content, LF-normalised (`revisionOf` from `./revision.ts`).
   *
   * `quoteForLines(path, startLine, endLine)` returns the text-quote
   * selector for the given range on the current head. Callers who
   * have the file contents build a fresh selector; callers who
   * don't (they can only run adapter-side without pulling files)
   * fall back to the comment body text — the review-core anchor
   * schema requires a non-empty `exact`, so a helper is provided
   * below. */
  static mapThreadsToEvents(input: {
    readonly threads: readonly GhReviewThread[];
    readonly threadIdOf: (thread: GhReviewThread) => string;
    readonly commentIdOf: (thread: GhReviewThread, comment: GhReviewComment) => string;
    readonly revisionOf: (path: string) => string | undefined;
    readonly commitId?: string;
    readonly quoteFor: (thread: GhReviewThread) => { exact: string; prefix: string; suffix: string };
  }): {
    readonly events: ReviewEventInput[];
    readonly orphanedThreadIds: readonly string[];
  } {
    const events: ReviewEventInput[] = [];
    const orphaned: string[] = [];
    for (const thread of input.threads) {
      if (thread.comments.length === 0) continue;
      const threadId = input.threadIdOf(thread);
      const revision = input.revisionOf(thread.path);
      if (revision === undefined) {
        // We can't build an anchor without a revision — skip this
        // thread rather than emit an invalid event. The caller
        // should report this to the operator.
        continue;
      }
      const mapResult = prCommentToAnchor({
        path: thread.path,
        line: thread.line,
        startLine: thread.startLine,
        originalLine: thread.originalLine,
        originalStartLine: thread.originalStartLine,
        side: thread.diffSide,
        startSide: thread.startDiffSide,
        subjectType: "line",
        isOutdated: thread.isOutdated,
      });
      // Choose a startLine/endLine even for orphans, so the anchor
      // schema is satisfied. Callers that record the orphan reason
      // for UI use `orphanedThreadIds`; the anchor still records
      // where the reviewer WAS looking (originalLine).
      let startLine: number;
      let endLine: number;
      if (mapResult.kind === "line") {
        startLine = mapResult.startLine;
        endLine = mapResult.endLine;
      } else {
        // Fall back to originalLine / originalStartLine — the
        // ORIGINAL commit's coordinates, which GitHub keeps even
        // when the current position is null (outdated).
        endLine = thread.originalLine ?? thread.line ?? 1;
        startLine = thread.originalStartLine ?? thread.startLine ?? endLine;
        orphaned.push(threadId);
      }
      const quote = input.quoteFor(thread);
      const firstComment = thread.comments[0];
      if (firstComment === undefined) continue;

      const anchor: Anchor = {
        path: thread.path,
        startLine,
        endLine,
        quote,
        revision,
        ...(input.commitId !== undefined ? { commit: input.commitId } : {}),
      };
      const firstAuthor: Author = ghAuthorToReviewCoreAuthor(firstComment);
      events.push({
        kind: "comment.created",
        actor: firstAuthor,
        threadId,
        commentId: input.commentIdOf(thread, firstComment),
        anchor,
        body: firstComment.body,
      });
      events.push({
        kind: "comment.linked",
        actor: firstAuthor,
        commentId: input.commentIdOf(thread, firstComment),
        external: githubExternal(firstComment),
      });
      for (let i = 1; i < thread.comments.length; i++) {
        const c = thread.comments[i];
        if (c === undefined) continue;
        const prev = thread.comments[i - 1];
        if (prev === undefined) continue;
        const author = ghAuthorToReviewCoreAuthor(c);
        events.push({
          kind: "comment.replied",
          actor: author,
          threadId,
          commentId: input.commentIdOf(thread, c),
          parentId: input.commentIdOf(thread, prev),
          body: c.body,
        });
        events.push({
          kind: "comment.linked",
          actor: author,
          commentId: input.commentIdOf(thread, c),
          external: githubExternal(c),
        });
      }
      if (thread.isResolved) {
        const lastComment = thread.comments[thread.comments.length - 1];
        if (lastComment === undefined) continue;
        events.push({
          kind: "thread.resolved",
          actor: ghAuthorToReviewCoreAuthor(lastComment),
          threadId,
          resolution: "resolved on GitHub",
        });
      }
    }
    return { events, orphanedThreadIds: orphaned };
  }

  // --- Internals --- //

  private parsePendingCommentResponse(item: unknown): PendingReviewComment {
    const c = item as PullRequestCommentRestBody;
    return {
      id: c.id,
      nodeId: c.node_id,
      path: c.path,
      body: c.body,
      commitId: c.commit_id,
      line: c.line ?? null,
      startLine: c.start_line ?? null,
      side: c.side ?? null,
      startSide: c.start_side ?? null,
      subjectType: c.subject_type ?? "line",
      url: c.html_url,
      pullRequestReviewId: c.pull_request_review_id ?? null,
    };
  }

  /** Low-level REST request. Every REST endpoint goes through here so
   * headers, error handling and token redaction are one place. Public
   * so tests may exercise arbitrary endpoints against the fake fetch
   * without adding a wrapper method for every REST endpoint. */
  async rest(method: string, url: string, body?: unknown): Promise<Response> {
    const token = await this.token.getToken();
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": this.userAgent,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      (init as { body?: string }).body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await this.fetchFn(url, init);
    } catch (err) {
      throw new GitHubApiError({
        message: `network error: ${redactTokenInMessage((err as Error).message, token)}`,
        status: 0,
        method,
        url,
      });
    }
    if (res.ok) return res;
    const text = await res.text();
    let message = text;
    let documentationUrl: string | undefined;
    try {
      const parsed = JSON.parse(text) as { message?: string; documentation_url?: string };
      if (typeof parsed.message === "string") message = parsed.message;
      if (typeof parsed.documentation_url === "string") documentationUrl = parsed.documentation_url;
    } catch {
      // Non-JSON error body; keep the raw text.
    }
    throw new GitHubApiError({
      message: `${method} ${maskPath(url)} → ${res.status}: ${redactTokenInMessage(message, token)}`,
      status: res.status,
      method,
      url,
      documentationUrl,
      retryable: shouldRetry(res.status, res.headers, text),
    });
  }

  /** Low-level GraphQL request. Public so tests exercise queries
   * against the fake fetch. */
  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const token = await this.token.getToken();
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": this.userAgent,
    };
    let res: Response;
    try {
      res = await this.fetchFn(this.graphqlUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      throw new GitHubApiError({
        message: `network error: ${redactTokenInMessage((err as Error).message, token)}`,
        status: 0,
        method: "POST",
        url: this.graphqlUrl,
      });
    }
    const text = await res.text();
    if (!res.ok) {
      throw new GitHubApiError({
        message: `POST ${this.graphqlUrl} → ${res.status}: ${redactTokenInMessage(text, token)}`,
        status: res.status,
        method: "POST",
        url: this.graphqlUrl,
        retryable: shouldRetry(res.status, res.headers, text),
      });
    }
    let parsed: T & { errors?: Array<{ message: string; type?: string }> };
    try {
      parsed = JSON.parse(text) as T & { errors?: Array<{ message: string }> };
    } catch (err) {
      throw new GitHubApiError({
        message: `graphql: non-JSON response: ${(err as Error).message}`,
        status: res.status,
        method: "POST",
        url: this.graphqlUrl,
      });
    }
    if (parsed.errors !== undefined && parsed.errors.length > 0) {
      const messages = parsed.errors.map((e) => e.message).join("; ");
      throw new GitHubApiError({
        message: `graphql errors: ${redactTokenInMessage(messages, token)}`,
        status: res.status,
        method: "POST",
        url: this.graphqlUrl,
      });
    }
    return parsed as T;
  }
}

// --- Exported helpers for the mapping side --- //

/** Build a `comment.linked` external ref for a GitHub review comment. */
export function githubExternal(comment: {
  readonly databaseId: number;
  readonly nodeId: string;
}): ExternalRef {
  return {
    github: {
      commentId: comment.databaseId,
      nodeId: comment.nodeId,
    },
  };
}

/** Compose a comment body that starts with the file-fallback preamble.
 * Callers use this when `anchorToPrComment` returns `kind: "file"` so
 * the reviewer's body always names the intended lines. */
export function composeFileFallbackBody(
  anchor: Pick<Anchor, "path" | "startLine" | "endLine">,
  reason: import("./anchor-map.ts").FileFallbackReason,
  body: string,
): string {
  return `${fileFallbackPreamble(anchor, reason)}\n\n${body}`;
}

// --- Internal helpers --- //

function ghAuthorToReviewCoreAuthor(comment: GhReviewComment): Author {
  // Bots (dependabot[bot]) and Users both become `gh-user` on the
  // review-core side — the review core does not model bots. If a
  // consumer needs to know it was a bot, the login carries the
  // `[bot]` suffix.
  const login = comment.authorLogin ?? "ghost";
  return {
    kind: "gh-user",
    id: login,
    displayName: login,
  };
}

function shapeCommentPayload(c: {
  readonly path: string;
  readonly body: string;
  readonly line: number;
  readonly side?: "RIGHT" | "LEFT";
  readonly startLine?: number;
  readonly startSide?: "RIGHT" | "LEFT";
}): Record<string, unknown> {
  // Line-only shape — file-level comments go through the separate
  // `addPendingComment` call (see `createPendingReview`'s doc-comment).
  const payload: Record<string, unknown> = {
    path: c.path,
    body: c.body,
    line: c.line,
    side: c.side ?? "RIGHT",
  };
  if (c.startLine !== undefined) {
    payload.start_line = c.startLine;
    payload.start_side = c.startSide ?? payload.side;
  }
  return payload;
}

function mapReviewThread(node: ReviewThreadGraphqlNode): GhReviewThread {
  return {
    id: node.id,
    path: node.path,
    isResolved: node.isResolved,
    isOutdated: node.isOutdated,
    line: node.line ?? null,
    startLine: node.startLine ?? null,
    originalLine: node.originalLine ?? null,
    originalStartLine: node.originalStartLine ?? null,
    diffSide: node.diffSide === "LEFT" ? "LEFT" : "RIGHT",
    startDiffSide: node.startDiffSide === "LEFT" ? "LEFT" : node.startDiffSide === "RIGHT" ? "RIGHT" : null,
    comments: node.comments.nodes.map((c) => ({
      databaseId: c.databaseId,
      nodeId: c.id,
      body: c.body,
      authorLogin: c.author?.login ?? null,
      authorType: c.author?.__typename === "Bot" ? "Bot" : c.author?.__typename === "User" ? "User" : "Unknown",
      createdAt: c.createdAt,
      url: c.url,
    })),
  };
}

/** Parse a `Link` header for `rel="next"`. Returns the URL or `null`. */
export function nextPageUrl(link: string | null): string | null {
  if (link === null || link.length === 0) return null;
  // A Link header looks like: `<https://.../files?page=2>; rel="next", <...>; rel="last"`.
  // A structural parse: split on comma (safe — URLs don't contain
  // unescaped commas here), then extract `<url>; rel="next"`.
  for (const part of link.split(",")) {
    const match = /^\s*<([^>]+)>;\s*rel="([^"]+)"/.exec(part);
    if (match !== null && match[2] === "next" && typeof match[1] === "string") {
      return match[1];
    }
  }
  return null;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** Return the path + query of a URL as-is, without the origin. Used in
 * error messages so we don't leak an environment-specific host to the
 * logger (the URL is already known to the caller). */
function maskPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

// --- REST envelope types (private) --- //

interface PullRequestRestBody {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly draft?: boolean;
  readonly html_url: string;
  readonly head: { readonly sha: string; readonly ref: string; readonly repo?: { readonly full_name: string } | null };
  readonly base: { readonly sha: string; readonly ref: string; readonly repo: { readonly full_name: string } };
}

interface PullRequestFileRestBody {
  readonly filename: string;
  readonly previous_filename?: string;
  readonly patch?: string;
  readonly status?: PrFile["status"];
}

interface ReviewRestBody {
  readonly id: number;
  readonly node_id: string;
  readonly commit_id: string;
  readonly state: string;
}

interface PullRequestCommentRestBody {
  readonly id: number;
  readonly node_id: string;
  readonly path: string;
  readonly body: string;
  readonly commit_id: string;
  readonly line?: number;
  readonly start_line?: number;
  readonly side?: "RIGHT" | "LEFT";
  readonly start_side?: "RIGHT" | "LEFT";
  readonly subject_type?: "line" | "file";
  readonly html_url: string;
  readonly pull_request_review_id?: number;
}

interface ReviewThreadsGraphqlResponse {
  readonly data: {
    readonly repository: {
      readonly pullRequest: {
        readonly reviewThreads: {
          readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
          readonly nodes: readonly ReviewThreadGraphqlNode[];
        };
      } | null;
    } | null;
  };
}

interface ReviewThreadGraphqlNode {
  readonly id: string;
  readonly path: string;
  readonly isResolved: boolean;
  readonly isOutdated: boolean;
  readonly line: number | null;
  readonly startLine: number | null;
  readonly originalLine: number | null;
  readonly originalStartLine: number | null;
  readonly diffSide: "RIGHT" | "LEFT";
  readonly startDiffSide: "RIGHT" | "LEFT" | null;
  readonly comments: {
    readonly nodes: readonly {
      readonly id: string;
      readonly databaseId: number;
      readonly body: string;
      readonly createdAt: string;
      readonly url: string;
      readonly author: { readonly login: string; readonly __typename: string } | null;
    }[];
  };
}

const REVIEW_THREADS_QUERY = /* GraphQL */ `
  query ReviewThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 50, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            path
            isResolved
            isOutdated
            line
            startLine
            originalLine
            originalStartLine
            diffSide
            startDiffSide
            comments(first: 100) {
              nodes {
                id
                databaseId
                body
                createdAt
                url
                author {
                  login
                  __typename
                }
              }
            }
          }
        }
      }
    }
  }
`;
