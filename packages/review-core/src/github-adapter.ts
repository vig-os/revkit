// GitHub adapter for the review core (ADR-0025, M3 part 1).
//
// Runs over plain `fetch`. No `node:*` / `bun:*` / `@octokit/*` — the
// same code runs in Bun (the M3 local daemon) and in a Cloudflare
// Worker (the M4 hosted surface). The adapter takes a `TokenSource`
// (`./token-source.ts`) and knows nothing about where the token
// came from.
//
// Surface (post-PR-43 review):
//
//   Reads (REST + GraphQL):
//   - `getPullRequest`      — head/base SHAs, node id, metadata.
//   - `listPullRequestFiles`— every changed file with its `patch`,
//                             paginated (REST).
//   - `listReviewThreads`   — existing PR review threads with
//                             resolution state, subjectType,
//                             `resolvedBy`, and per-thread comments
//                             (GraphQL, both cursors paginated).
//
//   Writes (GraphQL ONLY — see below):
//   - `findOrCreatePendingReview` — reuse the viewer's existing
//                                   PENDING review or create one.
//   - `addPendingReviewThread` — GraphQL mutation
//                                `addPullRequestReviewThread`
//                                (LINE or FILE subject).
//   - `updatePendingReviewComment` — edit body.
//   - `deletePendingReviewComment` — remove one draft comment.
//   - `deletePendingReview`   — discard the pending review.
//   - `submitReview`          — COMMENT / APPROVE / REQUEST_CHANGES.
//
// **No write path goes through REST `POST /pulls/{n}/comments`.** That
// endpoint publishes a comment immediately if the reviewer has no
// pending review, and 422s if one exists (community reports:
// `user_id can only have one pending review per pull request`). Both
// are real harm — a draft becomes public or a submit fails — so the
// adapter refuses that endpoint for writes and there is a test
// (`github-adapter-writes.test.ts:no-legacy-rest-comment-writes`)
// that would fail if a future edit reintroduced the call. The
// GraphQL mutation names and input shapes are verified against the
// live schema by `test/fixtures/github/graphql-schema.json`
// (introspection snapshot; see the fixture's README for the query).
//
// Rate-limit handling: `shouldRetry` and `retryAfterMs` decide the
// backoff plumbing; `restWithRetry` / `graphqlWithRetry` wrap `rest`
// and `graphql` with a bounded, jittered retry loop (cap 3 attempts,
// `Retry-After` / `x-ratelimit-reset` honoured). Other 4xx surface
// immediately.
//
// Runtime-neutral: no `node:*` / `bun:*` imports.

import {
  anchorToPrComment,
  anchorToPrCommentWithHunks,
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
import { newSideLines, parsePatch, type Hunk } from "./patch.ts";
import { buildQuoteFromLines } from "./quote.ts";
import { revisionOf } from "./revision.ts";
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
  /** Retry policy — bounded attempts for rate-limited requests
   * (429 and 403 secondary-rate-limit). Defaults documented on
   * `DEFAULT_RETRY_POLICY`. Callers that don't want retries pass
   * `{ maxAttempts: 1 }` (single attempt, no retry). */
  readonly retryPolicy?: RetryPolicy;
  /** Sleep hook (ms → Promise). Used by the retry loop. Injectable
   * for tests. Defaults to `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Wall-clock hook (ms). Used by `retryAfterMs` when computing a
   * delta from `x-ratelimit-reset`. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Constants exported so tests exercise the same defaults the
 * production callers see (PR-40 review lesson: tests must cover
 * default constants, not only injected options). */
export const DEFAULT_GITHUB_BASE_URL = "https://api.github.com";
export const DEFAULT_GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
export const DEFAULT_USER_AGENT = "revkit/0.0 (+https://github.com/vig-os/revkit)";
export const DEFAULT_MAX_FILES_PAGES = 40;
export const GITHUB_API_VERSION = "2022-11-28";

/** Bounded retry policy for rate-limited responses.
 *
 * - `maxAttempts`: total call count including the first try (3 =
 *   initial + 2 retries).
 * - `baseDelayMs`: the floor for the backoff sleep. When `Retry-After`
 *   or `x-ratelimit-reset` is present the header wins; otherwise the
 *   floor is used with exponential growth.
 * - `maxDelayMs`: cap on any single sleep — so a bogus `Retry-After: 3600`
 *   from a fake server cannot hang the daemon.
 * - `jitterMs`: uniform jitter added to each sleep to spread retries. */
export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  jitterMs: 250,
};

// --- Public types --- //

/** A pull-request coordinate. */
export interface PrRef {
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
}

/** The subset of the PR the adapter surfaces to the review core. `nodeId`
 * is the GraphQL global id (needed by the write mutations); every read
 * fetches it so the write path never has to guess. */
export interface PullRequestSummary {
  readonly number: number;
  readonly nodeId: string;
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
  /** `LINE` (line-scoped comment) or `FILE` (file-scoped). File
   * threads have no `line` / `startLine`. */
  readonly subjectType: "LINE" | "FILE";
  /** The login of the user who resolved the thread — populated when
   * `isResolved`, null otherwise. Used as the actor of the
   * `thread.resolved` event so the human decision is preserved. */
  readonly resolvedByLogin: string | null;
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
  /** The commit SHA the comment was originally made against.
   * Present on both `PullRequestReviewComment.originalCommit` and
   * ${GraphQL} — used to fetch the file at that commit so a stable
   * anchor can be built (PR-43 round-3, Blocker 2). */
  readonly originalCommitOid: string | null;
}

/** Input for `addPendingReviewThread`. `reviewId` is the GraphQL id
 * of a PENDING review (obtain via `findOrCreatePendingReview`).
 *
 * For a line-subject comment set `subjectType: "LINE"` (or leave it
 * undefined — the default), pass `line` and (for a multi-line range)
 * `startLine`. `side` / `startSide` default to `RIGHT`.
 *
 * For a file-subject comment set `subjectType: "FILE"` and omit
 * `line` / `startLine`. */
export interface AddPendingReviewThreadInput {
  readonly reviewId: string;
  readonly path: string;
  readonly body: string;
  readonly line?: number;
  readonly side?: "RIGHT" | "LEFT";
  readonly startLine?: number;
  readonly startSide?: "RIGHT" | "LEFT";
  readonly subjectType?: "LINE" | "FILE";
}

/** A pending review-comment as returned by GraphQL. The GraphQL
 * `PullRequestReviewComment` type does NOT expose `side` /
 * `startSide` — those live on `PullRequestReviewThread`, which is
 * one level up. Callers that need the side query the parent thread
 * via `listReviewThreads` (which does expose `diffSide` /
 * `startDiffSide`). Included fields:
 *
 * `line`  — current head-side position, null if the comment is
 *           outdated (its lines no longer resolve on head).
 * `originalLine` / `originalStartLine` — the coordinates on the
 *           commit the comment was made against; kept even when
 *           `line` is null. */
export interface PendingReviewComment {
  readonly nodeId: string;
  readonly databaseId: number;
  readonly path: string;
  readonly body: string;
  readonly line: number | null;
  readonly startLine: number | null;
  readonly originalLine: number | null;
  readonly originalStartLine: number | null;
  readonly subjectType: "LINE" | "FILE";
  readonly url: string;
}

/** A pending review (state = PENDING). `id` is the GraphQL global id
 * (opaque string) — used by every subsequent write mutation. */
export interface PendingReview {
  readonly id: string;
  readonly databaseId: number;
  readonly commitSha: string | null;
  readonly state: "PENDING" | "COMMENTED" | "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED";
}

export type ReviewSubmissionEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

/** Snapshot for a thread — one of three shapes (see
 * `mapThreadsToEvents` docstring). `live` means "use head";
 * `own-commit` provides the file's content at the thread's
 * originating commit (RIGHT-outdated) or the base commit
 * (LEFT-side); `unavailable` triggers the placeholder-anchor +
 * orphan path with the given reason. */
export type ThreadSnapshot =
  | { readonly kind: "live" }
  | {
      readonly kind: "own-commit";
      readonly content: string;
      readonly revision: string;
      readonly oid: string;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

/** Options for `submitReview`. `body` is the top-level review message. */
export interface SubmitReviewInput {
  readonly reviewId: string;
  readonly event: ReviewSubmissionEvent;
  readonly body?: string;
}

// --- Errors --- //

/** Thrown by every failing adapter call. `status` is the HTTP status
 * (0 for a network error before a response landed). `documentationUrl`
 * mirrors GitHub's field so a caller can surface it. `headers` (when
 * present) exposes `Retry-After` and `x-ratelimit-*` so the retry
 * loop can honour GitHub's own advice — carrying them on the error
 * is the seam PR-43 round-3 asked for. */
export class GitHubApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly url: string;
  readonly documentationUrl?: string;
  readonly retryable: boolean;
  readonly headers?: Headers;

  constructor(init: {
    message: string;
    status: number;
    method: string;
    url: string;
    documentationUrl?: string;
    retryable?: boolean;
    headers?: Headers;
  }) {
    super(init.message);
    this.name = "GitHubApiError";
    this.status = init.status;
    this.method = init.method;
    this.url = init.url;
    this.documentationUrl = init.documentationUrl;
    this.retryable = init.retryable ?? false;
    this.headers = init.headers;
  }
}

/** Typed rate-limit outcome — thrown by the retry loop when the
 * server tells us to wait longer than the configured cap. Callers
 * (M3 daemon; hosted worker) show a "come back later" message
 * rather than blocking. */
export class GitHubRateLimitError extends GitHubApiError {
  readonly retryAfterMs: number;
  constructor(init: ConstructorParameters<typeof GitHubApiError>[0] & { retryAfterMs: number }) {
    super({ ...init, retryable: true });
    this.name = "GitHubRateLimitError";
    this.retryAfterMs = init.retryAfterMs;
  }
}

/** Typed staleness outcome for `findOrCreatePendingReview`. The
 * caller inspects `.kind`. */
export type FindOrCreatePendingReviewResult =
  | { readonly kind: "reused"; readonly review: PendingReview }
  | { readonly kind: "created"; readonly review: PendingReview }
  | {
      readonly kind: "stale";
      readonly review: PendingReview;
      readonly expectedCommitOid: string;
      readonly actualCommitOid: string | null;
    };

// --- Rate limiting helpers --- //

/** True when a response should be retried per GitHub's rate-limit
 * conventions: 429, or 403 with `x-ratelimit-remaining: 0`, or 403
 * with `Retry-After`, or 403 whose body mentions "secondary rate
 * limit". */
export function shouldRetry(status: number, headers: Headers, bodyText: string): boolean {
  if (status === 429) return true;
  if (status === 403) {
    const remaining = headers.get("x-ratelimit-remaining");
    if (remaining === "0") return true;
    if (headers.has("retry-after")) return true;
    if (/secondary rate limit/i.test(bodyText)) return true;
  }
  return false;
}

/** Extract a delay in ms from a `Retry-After` header (seconds OR
 * HTTP-date) or from `x-ratelimit-reset` (epoch seconds). Falls
 * back to the caller's default when neither is present.
 *
 * `now` is injectable so tests are deterministic. */
export function retryAfterMs(headers: Headers, defaultMs: number, now: () => number = Date.now): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const trimmed = retryAfter.trim();
    // Numeric form — seconds (RFC 9110 §10.2.3).
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const seconds = Number.parseFloat(trimmed);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    } else {
      // HTTP-date form — parse via Date. Refuse if it can't parse,
      // rather than silently falling through.
      const millis = Date.parse(trimmed);
      if (Number.isFinite(millis)) {
        const delta = millis - now();
        if (delta > 0) return delta;
        return 0; // date already past → retry now
      }
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

// --- PR context (per-PR patch cache) --- //

/** Per-PR parsed-patch cache — one `parsePatch` call per file, not per
 * anchor lookup. The M3 daemon holds one context per PR view and uses
 * `PrContext.mapAnchor` for every comment. Modelled after the
 * `prepareReanchor` / `reanchorWith` split in `reanchor.ts`. */
export class PrContext {
  private readonly filesByName = new Map<string, PrFile>();
  private readonly filesByPreviousName = new Map<string, PrFile>();
  private readonly hunksCache = new Map<string, Hunk[] | null | Error>();
  private readonly rightLinesCache = new Map<string, Set<number> | null>();
  /** Per-instance counter — bumped when a `hunks()` call falls back
   * to a fresh parse. Tests read it to assert cache hits vs misses,
   * since a "did it use the cache" property is exactly what the
   * PR-43 round-3 nit was about. */
  parseCount = 0;
  readonly files: readonly PrFile[];

  constructor(files: readonly PrFile[]) {
    this.files = files;
    for (const file of files) {
      this.filesByName.set(file.filename, file);
      if (file.previousFilename !== undefined) {
        this.filesByPreviousName.set(file.previousFilename, file);
      }
    }
  }

  /** Look up a file by current-or-old name, using the pre-built
   * lookup maps rather than a linear scan. */
  findFile(path: string): PrFile | undefined {
    return this.filesByName.get(path) ?? this.filesByPreviousName.get(path);
  }

  /** Parse-once patch access. Cached per filename. Errors are
   * remembered so a re-lookup doesn't re-parse the malformed patch. */
  hunks(filename: string): Hunk[] | null {
    const cached = this.hunksCache.get(filename);
    if (cached !== undefined) {
      if (cached instanceof Error) throw cached;
      return cached;
    }
    const file = this.filesByName.get(filename);
    if (file === undefined) return null;
    this.parseCount++;
    try {
      const parsed = parsePatch(file.patch ?? "");
      this.hunksCache.set(filename, parsed);
      return parsed;
    } catch (err) {
      this.hunksCache.set(filename, err as Error);
      throw err;
    }
  }

  /** RIGHT-side line-number set for a file, computed once per PR. */
  rightSideLines(filename: string): Set<number> | null {
    const cached = this.rightLinesCache.get(filename);
    if (cached !== undefined) return cached;
    const hunks = this.hunks(filename);
    const set = hunks === null ? null : newSideLines(hunks);
    this.rightLinesCache.set(filename, set);
    return set;
  }

  /** Map an anchor to a PR-comment target using the cached patches
   * and file lookup. Never re-parses a patch across repeated calls
   * for the same file (PR-43 round-3 nit). Falls back to the pure
   * `anchorToPrComment` behaviour when the file isn't in the PR
   * (a REJECT with a clear message). */
  mapAnchor(anchor: Anchor, options?: AnchorMapOptions): AnchorMapResult {
    const file = this.findFile(anchor.path);
    if (file === undefined) {
      return {
        kind: "reject",
        reason: `anchor path '${anchor.path}' is not in this PR's file list`,
      };
    }
    // `hunks()` is keyed on the CURRENT filename — if the anchor's
    // path is the OLD (rename) name, resolve to the new name first.
    let hunks: Hunk[] | null;
    try {
      hunks = this.hunks(file.filename);
    } catch (err) {
      return {
        kind: "reject",
        reason: `failed to parse patch for '${file.filename}': ${(err as Error).message}`,
      };
    }
    return anchorToPrCommentWithHunks(anchor, file, hunks, options);
  }
}

// --- Adapter --- //

export class GitHubAdapter {
  private readonly token: TokenSource;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly graphqlUrl: string;
  private readonly userAgent: string;
  private readonly maxFilesPages: number;
  private readonly retryPolicy: RetryPolicy;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: GitHubAdapterOptions) {
    this.token = options.token;
    this.fetchFn = options.fetch ?? fetch.bind(globalThis);
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? DEFAULT_GITHUB_BASE_URL);
    this.graphqlUrl = options.graphqlUrl ?? DEFAULT_GITHUB_GRAPHQL_URL;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.maxFilesPages = options.maxFilesPages ?? DEFAULT_MAX_FILES_PAGES;
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  // --- Read paths --- //

  async getPullRequest(pr: PrRef): Promise<PullRequestSummary> {
    const url = `${this.baseUrl}/repos/${enc(pr.owner)}/${enc(pr.repo)}/pulls/${pr.pullNumber}`;
    const res = await this.restWithRetry("GET", url);
    const body = (await res.json()) as PullRequestRestBody;
    return {
      number: body.number,
      nodeId: body.node_id,
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
      const res: Response = await this.restWithRetry("GET", url);
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

  /** Load every review thread on the PR (GraphQL). Both the OUTER
   * `reviewThreads` and the INNER per-thread `comments` connection
   * are cursor-paginated — a thread with more than 100 comments used
   * to have its tail silently truncated (PR-43 nit). */
  async listReviewThreads(pr: PrRef): Promise<GhReviewThread[]> {
    const threads: GhReviewThread[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < this.maxFilesPages; page++) {
      const response: ReviewThreadsGraphqlResponse = await this.graphqlWithRetry<ReviewThreadsGraphqlResponse>(
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
        const mapped = mapReviewThread(node);
        // Fetch remaining comments if the inner connection has more
        // pages. Rare but real (a very active thread).
        let commentsCursor: string | null = node.comments.pageInfo.endCursor;
        let hasMore = node.comments.pageInfo.hasNextPage;
        const extra: GhReviewComment[] = [];
        for (let inner = 0; inner < this.maxFilesPages && hasMore; inner++) {
          const contResp = await this.graphqlWithRetry<ThreadCommentsGraphqlResponse>(
            THREAD_COMMENTS_QUERY,
            { threadId: node.id, cursor: commentsCursor },
          );
          const conn = contResp.data.node?.comments;
          if (conn === undefined || conn === null) break;
          for (const c of conn.nodes) {
            extra.push({
              databaseId: c.databaseId,
              nodeId: c.id,
              body: c.body,
              authorLogin: c.author?.login ?? null,
              authorType:
                c.author?.__typename === "Bot" ? "Bot" : c.author?.__typename === "User" ? "User" : "Unknown",
              createdAt: c.createdAt,
              url: c.url,
              originalCommitOid: c.originalCommit?.oid ?? null,
            });
          }
          hasMore = conn.pageInfo.hasNextPage;
          commentsCursor = conn.pageInfo.endCursor;
        }
        if (hasMore) {
          throw new GitHubApiError({
            message: `listReviewThreads: thread ${node.id} exceeded inner comment page cap (${this.maxFilesPages})`,
            status: 0,
            method: "POST",
            url: this.graphqlUrl,
          });
        }
        const merged: GhReviewThread = extra.length === 0 ? mapped : { ...mapped, comments: [...mapped.comments, ...extra] };
        threads.push(merged);
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
   * the pure engine underneath. For repeated lookups on the same PR
   * use `PrContext.mapAnchor` (caches parsed patches). */
  static mapAnchor(anchor: Anchor, files: readonly PrFile[], options?: AnchorMapOptions): AnchorMapResult {
    return anchorToPrComment(anchor, files, options);
  }

  /** Convenience: reverse-map a GitHub comment onto a review-core
   * anchor position. */
  static mapCommentToAnchor(comment: PrCommentSource): PrCommentToAnchorResult {
    return prCommentToAnchor(comment);
  }

  // --- Write paths (GraphQL only — see file header) --- //

  /**
   * Find the viewer's existing PENDING review on this PR, or create
   * one pinned to `commitOid`. Returns the review's GraphQL id.
   *
   * The viewer's login is looked up via `viewer { login }` when the
   * caller doesn't provide one. Then `reviews(states:[PENDING],
   * author: <login>, first: 1)` finds the existing pending review;
   * if none, `addPullRequestReview` (no `event`) creates one.
   *
   * Never returns two pending reviews — GitHub allows at most one
   * PENDING review per (user, PR), and a race would surface as the
   * mutation's own error, not a silent double-create.
   */
  async findOrCreatePendingReview(input: {
    readonly pullRequestNodeId: string;
    readonly commitOid: string;
    readonly viewerLogin?: string;
  }): Promise<FindOrCreatePendingReviewResult> {
    const login = input.viewerLogin ?? (await this.viewerLogin());
    // 1. Look up an existing pending review by author.
    const existing = await this.graphqlWithRetry<PendingReviewLookupResponse>(
      VIEWER_PENDING_REVIEW_QUERY,
      { id: input.pullRequestNodeId, author: login },
    );
    const node = existing.data.node;
    if (node !== undefined && node !== null && node.__typename === "PullRequest") {
      const pending = node.reviews?.nodes.find((r) => r.state === "PENDING");
      if (pending !== undefined) {
        const review: PendingReview = {
          id: pending.id,
          databaseId: pending.databaseId ?? 0,
          commitSha: pending.commit?.oid ?? null,
          state: pending.state,
        };
        // PR-43 round-3 (Blocker 3): head-move detection. A pending
        // review pinned to an older commit MUST NOT be silently
        // reused — the reviewer's draft comments were made against
        // a different head, so their line numbers don't match. The
        // caller (M3 daemon) decides whether to re-anchor the
        // drafts or ask the user to discard.
        if (review.commitSha !== null && review.commitSha !== input.commitOid) {
          return {
            kind: "stale",
            review,
            expectedCommitOid: input.commitOid,
            actualCommitOid: review.commitSha,
          };
        }
        return { kind: "reused", review };
      }
    }
    // 2. Create one. NOTE: mutation goes through `graphql` (not
    // `graphqlWithRetry`) — mutations must NEVER auto-retry
    // (idempotency risk: a retried `addPullRequestReview` could
    // create a second pending review if the first response was
    // dropped between the server and us).
    const created = await this.graphql<AddReviewMutationResponse>(ADD_REVIEW_MUTATION, {
      pullRequestId: input.pullRequestNodeId,
      commitOID: input.commitOid,
    });
    const created_ = created.data.addPullRequestReview?.pullRequestReview;
    if (created_ === undefined || created_ === null) {
      throw new GitHubApiError({
        message: `findOrCreatePendingReview: addPullRequestReview returned no review`,
        status: 0,
        method: "POST",
        url: this.graphqlUrl,
      });
    }
    return {
      kind: "created",
      review: {
        id: created_.id,
        databaseId: created_.databaseId ?? 0,
        commitSha: created_.commit?.oid ?? null,
        state: created_.state,
      },
    };
  }

  /** Add one draft thread to the pending review. Line- or file-
   * subject; multi-line ranges supported (single side only —
   * `startSide` defaults to `side`, and per the schema both must be
   * `RIGHT` for a head-side range, matching what
   * `anchorToPrComment` emits). */
  async addPendingReviewThread(input: AddPendingReviewThreadInput): Promise<PendingReviewComment> {
    const subject = input.subjectType ?? "LINE";
    const variables: Record<string, unknown> = {
      pullRequestReviewId: input.reviewId,
      path: input.path,
      body: input.body,
      subjectType: subject,
    };
    if (subject === "LINE") {
      if (input.line === undefined) {
        throw new Error("addPendingReviewThread: line is required for a LINE-subject thread");
      }
      variables.line = input.line;
      variables.side = input.side ?? "RIGHT";
      if (input.startLine !== undefined) {
        variables.startLine = input.startLine;
        variables.startSide = input.startSide ?? variables.side;
      }
    }
    // Mutation — never auto-retry (idempotency risk: a retried
    // `addPullRequestReviewThread` could double-post if the first
    // response was dropped between the server and us).
    const result = await this.graphql<AddThreadMutationResponse>(
      ADD_THREAD_MUTATION,
      variables,
    );
    const thread = result.data.addPullRequestReviewThread?.thread;
    if (thread === undefined || thread === null) {
      throw new GitHubApiError({
        message: `addPendingReviewThread: mutation returned no thread`,
        status: 0,
        method: "POST",
        url: this.graphqlUrl,
      });
    }
    const first = thread.comments.nodes[0];
    if (first === undefined) {
      throw new GitHubApiError({
        message: `addPendingReviewThread: thread has no comments`,
        status: 0,
        method: "POST",
        url: this.graphqlUrl,
      });
    }
    return {
      nodeId: first.id,
      databaseId: first.databaseId,
      path: thread.path,
      body: first.body,
      line: thread.line ?? null,
      startLine: thread.startLine ?? null,
      originalLine: thread.line ?? null,
      originalStartLine: thread.startLine ?? null,
      subjectType: thread.subjectType,
      url: first.url,
    };
  }

  /** Edit the body of a pending (or published) review comment. Only
   * the comment's own author can update. Mutation — no auto-retry
   * (would re-edit on a dropped response, which for an idempotent
   * update is technically fine but we keep the rule uniform:
   * mutations go through `graphql`, reads go through
   * `graphqlWithRetry`). */
  async updatePendingReviewComment(input: {
    readonly commentNodeId: string;
    readonly body: string;
  }): Promise<void> {
    await this.graphql(UPDATE_COMMENT_MUTATION, {
      pullRequestReviewCommentId: input.commentNodeId,
      body: input.body,
    });
  }

  /** Delete one draft review comment. Removes an empty parent thread.
   * Mutation — no auto-retry. */
  async deletePendingReviewComment(input: { readonly commentNodeId: string }): Promise<void> {
    await this.graphql(DELETE_COMMENT_MUTATION, { id: input.commentNodeId });
  }

  /** Discard the entire pending review — drops every draft comment.
   * Mutation — no auto-retry. */
  async deletePendingReview(input: { readonly reviewId: string }): Promise<void> {
    await this.graphql(DELETE_REVIEW_MUTATION, { pullRequestReviewId: input.reviewId });
  }

  /** List every comment attached to a review (pending or submitted).
   * Cursor-paginated. */
  async listPendingReviewComments(reviewId: string): Promise<PendingReviewComment[]> {
    const out: PendingReviewComment[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < this.maxFilesPages; page++) {
      const resp: ReviewCommentsGraphqlResponse = await this.graphqlWithRetry<ReviewCommentsGraphqlResponse>(
        REVIEW_COMMENTS_QUERY,
        { id: reviewId, cursor },
      );
      const review = resp.data.node ?? null;
      if (review === undefined || review === null) break;
      for (const c of review.comments.nodes) {
        out.push({
          nodeId: c.id,
          databaseId: c.databaseId,
          path: c.path,
          body: c.body,
          line: c.line ?? null,
          startLine: c.startLine ?? null,
          originalLine: c.originalLine ?? null,
          originalStartLine: c.originalStartLine ?? null,
          subjectType: c.subjectType ?? "LINE",
          url: c.url,
        });
      }
      if (!review.comments.pageInfo.hasNextPage) return out;
      cursor = review.comments.pageInfo.endCursor;
    }
    throw new GitHubApiError({
      message: `listPendingReviewComments: exceeded page cap (${this.maxFilesPages})`,
      status: 0,
      method: "POST",
      url: this.graphqlUrl,
    });
  }

  /** Submit a pending review (COMMENT / APPROVE / REQUEST_CHANGES).
   * Mutation — no auto-retry (double-submit would either 422 or
   * produce a duplicate review). */
  async submitReview(input: SubmitReviewInput): Promise<void> {
    const variables: Record<string, unknown> = {
      pullRequestReviewId: input.reviewId,
      event: input.event,
    };
    if (input.body !== undefined) variables.body = input.body;
    await this.graphql(SUBMIT_REVIEW_MUTATION, variables);
  }

  /** Look up the authenticated user's login (`viewer { login }`).
   * Used by `findOrCreatePendingReview` and exposed so a caller
   * that already has the login can pass it in and skip the round
   * trip. */
  async viewerLogin(): Promise<string> {
    const resp = await this.graphqlWithRetry<ViewerLoginResponse>(VIEWER_LOGIN_QUERY, {});
    const login = resp.data.viewer?.login;
    if (typeof login !== "string" || login.length === 0) {
      throw new GitHubApiError({
        message: `viewerLogin: viewer.login missing from response`,
        status: 0,
        method: "POST",
        url: this.graphqlUrl,
      });
    }
    return login;
  }

  // --- Thread mapping --- //

  /**
   * Map GitHub review threads to review-core thread events, using
   * an **own-commit anchor** for every imported thread.
   *
   * PR-43 round-3 (Blocker 2): a thread whose lines don't resolve
   * on head (outdated / LEFT / file / mixed-sides) used to get an
   * anchor stamped with the head revision but at `originalLine`.
   * That's a wrong anchor — the head content at that line doesn't
   * match, and any re-anchor short-circuits on the identity check.
   *
   * The principled fix: anchor every imported thread in the
   * coordinates of the commit its comment was made against
   * (`originalCommit.oid`), with a `revision` computed from the
   * file's content at THAT commit and a quote cut from THAT
   * content. The daemon's re-anchoring engine
   * (`prepareReanchor` / `reanchorWith`) can then map the anchor
   * to head using the same machinery it uses for local rebuilds,
   * emitting `thread.reanchored` / `thread.orphaned` as
   * appropriate. The adapter deliberately does NOT reanchor
   * itself: separation of concerns.
   *
   * The `resolveSnapshot` callback returns one of three shapes:
   *   - `{ kind: "live" }`      — the thread is a live RIGHT-side
   *                                thread with `line` populated on
   *                                head; use head revision +
   *                                head-side quote (which the
   *                                caller provides via `headSourceOf`).
   *   - `{ kind: "own-commit",
   *        content, oid }`      — the file content at the thread's
   *                                originating commit; anchor built
   *                                from THIS content.
   *   - `{ kind: "unavailable",
   *        reason }`            — content couldn't be fetched
   *                                (deleted, binary, too large).
   *                                The thread is orphaned with the
   *                                stated reason; anchor uses the
   *                                head revision + originalLine as
   *                                a placeholder that the validator
   *                                will accept.
   *
   * Returns the events plus a `snapshots` map keyed on revision.
   * The daemon (M3 part 2 item 5b) persists those snapshots so a
   * later `prepareReanchor(oldSource, newSource)` can run with
   * both texts in hand.
   */
  static mapThreadsToEvents(input: {
    readonly threads: readonly GhReviewThread[];
    readonly threadIdOf: (thread: GhReviewThread) => string;
    readonly commentIdOf: (thread: GhReviewThread, comment: GhReviewComment) => string;
    /** SHA-256 of the head-side file content for a live RIGHT thread.
     * The daemon reads it from disk; the adapter never fetches it. */
    readonly headRevisionOf: (path: string) => string | undefined;
    /** Head-side file content for a live RIGHT thread — used to cut
     * the text-quote selector. Optional; if omitted, `quoteFor` is
     * called instead. */
    readonly headSourceOf?: (path: string) => string | undefined;
    /** Snapshot resolver — see method docstring. */
    readonly resolveSnapshot: (thread: GhReviewThread) => ThreadSnapshot;
    /** Head-side commit oid — attached to the anchor's `commit`
     * field for live RIGHT threads. */
    readonly headCommitOid?: string;
    /** Optional fallback quote builder for live RIGHT threads when
     * `headSourceOf` is unavailable. If missing AND `headSourceOf`
     * doesn't return content, the thread is orphaned. */
    readonly quoteFor?: (thread: GhReviewThread) => { exact: string; prefix: string; suffix: string };
  }): {
    readonly events: ReviewEventInput[];
    readonly orphanedThreadIds: readonly string[];
    /** Map of `revision → source text` — the daemon persists these
     * so a subsequent re-anchor has the OLD source at hand
     * (`prepareReanchor(oldSource, newSource)`). */
    readonly snapshots: Map<string, string>;
  } {
    const events: ReviewEventInput[] = [];
    const orphaned: string[] = [];
    const snapshots = new Map<string, string>();

    for (const thread of input.threads) {
      if (thread.comments.length === 0) continue;
      const threadId = input.threadIdOf(thread);
      const firstComment = thread.comments[0];
      if (firstComment === undefined) continue;
      const firstAuthor: Author = ghAuthorToReviewCoreAuthor(firstComment);

      // What kind of anchor should this thread carry?
      const mapResult = prCommentToAnchor({
        path: thread.path,
        line: thread.line,
        startLine: thread.startLine,
        originalLine: thread.originalLine,
        originalStartLine: thread.originalStartLine,
        side: thread.diffSide,
        startSide: thread.startDiffSide,
        subjectType: thread.subjectType === "FILE" ? "file" : "line",
        isOutdated: thread.isOutdated,
      });

      const snapshot = input.resolveSnapshot(thread);
      let anchor: Anchor | undefined;
      let willOrphan = mapResult.kind === "orphan";
      let orphanReason: string | undefined =
        mapResult.kind === "orphan" ? mapResult.reason : undefined;

      if (snapshot.kind === "unavailable") {
        // Fall back to a head-side placeholder anchor and orphan.
        const headRev = input.headRevisionOf(thread.path);
        if (headRev === undefined) continue; // caller must log this
        const endLine = thread.originalLine ?? thread.line ?? 1;
        const startLine = thread.originalStartLine ?? thread.startLine ?? endLine;
        anchor = {
          path: thread.path,
          startLine,
          endLine,
          quote: input.quoteFor?.(thread) ?? placeholderQuote(firstComment.body),
          revision: headRev,
          ...(input.headCommitOid !== undefined ? { commit: input.headCommitOid } : {}),
        };
        willOrphan = true;
        orphanReason = snapshot.reason;
      } else if (snapshot.kind === "own-commit") {
        // The authoritative branch: anchor in the coordinates of
        // the thread's own commit, with the quote cut from THAT
        // content and the revision hashed from it. The daemon's
        // re-anchor engine now has an honest starting point.
        const endLine = thread.originalLine ?? thread.line ?? 1;
        const startLine = thread.originalStartLine ?? thread.startLine ?? endLine;
        const quote = buildQuoteFromLines(snapshot.content, startLine, endLine);
        // A comment can point at a line that no longer exists in
        // the file at its own commit (rare — GitHub is authoritative
        // on originalLine — but defensively check). If the quote's
        // exact is empty, orphan.
        if (quote.exact.length === 0) {
          const headRev = input.headRevisionOf(thread.path);
          if (headRev === undefined) continue;
          anchor = {
            path: thread.path,
            startLine,
            endLine,
            quote: input.quoteFor?.(thread) ?? placeholderQuote(firstComment.body),
            revision: headRev,
            ...(input.headCommitOid !== undefined ? { commit: input.headCommitOid } : {}),
          };
          willOrphan = true;
          orphanReason = "empty-original-quote";
        } else {
          const revision = snapshot.revision;
          snapshots.set(revision, snapshot.content);
          anchor = {
            path: thread.path,
            startLine,
            endLine,
            quote,
            revision,
            commit: snapshot.oid,
          };
        }
      } else {
        // "live" — a RIGHT-side thread with resolved lines on head.
        const headRev = input.headRevisionOf(thread.path);
        if (headRev === undefined) continue;
        const endLine =
          mapResult.kind === "line" ? mapResult.endLine : thread.line ?? thread.originalLine ?? 1;
        const startLine =
          mapResult.kind === "line"
            ? mapResult.startLine
            : thread.startLine ?? thread.originalStartLine ?? endLine;
        const headSrc = input.headSourceOf?.(thread.path);
        const quote =
          headSrc !== undefined
            ? buildQuoteFromLines(headSrc, startLine, endLine)
            : input.quoteFor?.(thread) ?? placeholderQuote(firstComment.body);
        if (headSrc !== undefined) snapshots.set(headRev, headSrc);
        anchor = {
          path: thread.path,
          startLine,
          endLine,
          quote,
          revision: headRev,
          ...(input.headCommitOid !== undefined ? { commit: input.headCommitOid } : {}),
        };
      }

      if (anchor === undefined) continue;

      // --- Emit the events for the thread. ---
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

      // Terminal transition — resolved wins over orphan (human
      // decision > machine classification). The validator refuses
      // both from `open`.
      if (thread.isResolved) {
        const actor: Author =
          thread.resolvedByLogin !== null
            ? { kind: "gh-user", id: thread.resolvedByLogin, displayName: thread.resolvedByLogin }
            : ghAuthorToReviewCoreAuthor(thread.comments[thread.comments.length - 1]!);
        events.push({
          kind: "thread.resolved",
          actor,
          threadId,
          resolution: "resolved on GitHub",
        });
      } else if (willOrphan) {
        orphaned.push(threadId);
        events.push({
          kind: "thread.orphaned",
          actor: firstAuthor,
          threadId,
          revision: anchor.revision,
          reason: orphanReason,
        });
      }
    }
    return { events, orphanedThreadIds: orphaned, snapshots };
  }

  /**
   * Async convenience over `mapThreadsToEvents`: fetches each
   * thread's OWN-COMMIT content via GraphQL `object(expression:
   * "oid:path")` and hands the results to the pure `mapThreadsToEvents`.
   *
   * Callers that need custom snapshot resolution (a local worktree,
   * a cached blob store) skip this and call `mapThreadsToEvents`
   * directly.
   */
  async importThreads(input: {
    readonly pr: PrRef;
    readonly threads: readonly GhReviewThread[];
    readonly threadIdOf: (thread: GhReviewThread) => string;
    readonly commentIdOf: (thread: GhReviewThread, comment: GhReviewComment) => string;
    readonly headRevisionOf: (path: string) => string | undefined;
    readonly headSourceOf?: (path: string) => string | undefined;
    readonly headCommitOid?: string;
    readonly quoteFor?: (thread: GhReviewThread) => { exact: string; prefix: string; suffix: string };
  }): Promise<ReturnType<typeof GitHubAdapter.mapThreadsToEvents>> {
    // Pre-fetch every thread's snapshot, deduping by (oid, path).
    const cache = new Map<string, ThreadSnapshot>();
    const snapshotFor = new Map<string, ThreadSnapshot>();
    for (const thread of input.threads) {
      const key = `${thread.id}`;
      const first = thread.comments[0];
      if (first === undefined) continue;
      // Live RIGHT thread: no fetch. Signalled by `line !== null`
      // AND diffSide==="RIGHT" AND subjectType==="LINE" AND not outdated.
      const isLive =
        thread.line !== null &&
        thread.diffSide === "RIGHT" &&
        thread.subjectType === "LINE" &&
        !thread.isOutdated &&
        thread.startDiffSide !== "LEFT";
      if (isLive) {
        snapshotFor.set(key, { kind: "live" });
        continue;
      }
      // Own-commit fetch. For RIGHT-side threads (including
      // outdated) we use originalCommit.oid; for LEFT-side we
      // fetch base-commit content at path.
      const oid =
        thread.diffSide === "LEFT" ? undefined /* base fallback below */ : first.originalCommitOid ?? undefined;
      const cacheKey = `${oid ?? "BASE"}:${thread.path}`;
      let snap = cache.get(cacheKey);
      if (snap === undefined) {
        try {
          const content =
            oid !== undefined
              ? await this.fetchBlobText({ owner: input.pr.owner, repo: input.pr.repo, oid, path: thread.path })
              : null; // LEFT: caller-provided base commit content resolution
          if (content === null) {
            snap = { kind: "unavailable", reason: oid === undefined ? "left-side-no-base-oid" : "not-found" };
          } else {
            const rev = await revisionOf(content);
            snap = { kind: "own-commit", content, oid: oid!, revision: rev };
          }
        } catch (err) {
          snap = { kind: "unavailable", reason: `fetch-failed: ${(err as Error).message}` };
        }
        cache.set(cacheKey, snap);
      }
      snapshotFor.set(key, snap);
    }
    return GitHubAdapter.mapThreadsToEvents({
      threads: input.threads,
      threadIdOf: input.threadIdOf,
      commentIdOf: input.commentIdOf,
      headRevisionOf: input.headRevisionOf,
      headSourceOf: input.headSourceOf,
      headCommitOid: input.headCommitOid,
      quoteFor: input.quoteFor,
      resolveSnapshot: (thread) => snapshotFor.get(thread.id) ?? { kind: "unavailable", reason: "no-snapshot" },
    });
  }

  /**
   * Fetch a blob's text content via GraphQL
   * `repository.object(expression: "<oid>:<path>")`. Returns
   * `null` when the object is missing, binary (isBinary) or
   * truncated (isTruncated) — treated the same as "not text
   * we can anchor to".
   *
   * Path is escaped for the expression string. `oid` is a git SHA
   * (40-hex or 64-hex).
   */
  async fetchBlobText(input: {
    readonly owner: string;
    readonly repo: string;
    readonly oid: string;
    readonly path: string;
  }): Promise<string | null> {
    // The expression string is <oid>:<path>. Path is passed as
    // part of a string literal — GraphQL variables don't reach the
    // parser here, so it goes on the variables side of the
    // expression and gets concatenated server-side. Use variables
    // to avoid injection.
    const resp = await this.graphqlWithRetry<BlobTextGraphqlResponse>(FETCH_BLOB_TEXT_QUERY, {
      owner: input.owner,
      name: input.repo,
      expression: `${input.oid}:${input.path}`,
    });
    const object = resp.data.repository?.object ?? null;
    if (object === null || object.__typename !== "Blob") return null;
    if (object.isBinary === true) return null;
    if (object.isTruncated === true) return null;
    if (typeof object.text !== "string") return null;
    return object.text;
  }

  // --- Internals --- //

  /** Low-level REST request. Public so tests exercise arbitrary
   * endpoints, but callers inside the adapter use
   * `restWithRetry` — which wraps this with the rate-limit retry
   * loop — so a rate-limit is never surfaced on the first hit. */
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
      headers: res.headers,
    });
  }

  /** REST with the rate-limit retry loop. Cap `retryPolicy.maxAttempts`;
   * only `retryable` errors trigger a retry. */
  async restWithRetry(method: string, url: string, body?: unknown): Promise<Response> {
    return this.withRetry(() => this.rest(method, url, body));
  }

  /** Low-level GraphQL request. Public so tests exercise queries
   * against the fake fetch. Callers inside the adapter use
   * `graphqlWithRetry`. */
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
        headers: res.headers,
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
      // PR-43 round-3: GraphQL rate-limit surfaces as a 200 with
      // `errors[].type === "RATE_LIMITED"`. Mark it retryable so
      // the retry loop wakes up (and the daemon shows the right
      // "come back later" state rather than a generic error).
      const rateLimited = parsed.errors.some((e) => e.type === "RATE_LIMITED");
      const messages = parsed.errors.map((e) => e.message).join("; ");
      throw new GitHubApiError({
        message: `graphql errors: ${redactTokenInMessage(messages, token)}`,
        status: res.status,
        method: "POST",
        url: this.graphqlUrl,
        retryable: rateLimited,
        headers: res.headers,
      });
    }
    return parsed as T;
  }

  async graphqlWithRetry<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    return this.withRetry(() => this.graphql<T>(query, variables));
  }

  private async withRetry<T>(op: () => Promise<T>): Promise<T> {
    const max = Math.max(1, this.retryPolicy.maxAttempts);
    for (let attempt = 1; attempt <= max; attempt++) {
      try {
        return await op();
      } catch (err) {
        if (!(err instanceof GitHubApiError) || !err.retryable) throw err;
        // Cap check: if the server tells us to wait longer than the
        // policy's maxDelayMs, refuse to sleep — throw a typed
        // rate-limit error so the daemon can show "come back
        // later" rather than block for minutes. This is the
        // "beyond the cap" path PR-43 round-3 named.
        const headers = err.headers ?? new Headers();
        const advised = retryAfterMs(headers, this.retryPolicy.baseDelayMs * 2 ** (attempt - 1), this.now);
        if (advised > this.retryPolicy.maxDelayMs) {
          throw new GitHubRateLimitError({
            message: `rate limit: server advises ${advised} ms wait, exceeding maxDelayMs=${this.retryPolicy.maxDelayMs}`,
            status: err.status,
            method: err.method,
            url: err.url,
            documentationUrl: err.documentationUrl,
            headers: err.headers,
            retryAfterMs: advised,
          });
        }
        if (attempt >= max) throw err;
        const jitter = Math.floor(Math.random() * this.retryPolicy.jitterMs);
        await this.sleep(advised + jitter);
      }
    }
    // Unreachable — the loop either returns or throws.
    throw new Error("withRetry: fell out of loop");
  }
}

// --- Exported helpers --- //

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

/** Fallback text-quote for a thread whose file content is
 * unavailable AND no `quoteFor` callback was supplied. The
 * anchor schema requires a non-empty `exact`; we use the
 * comment body's first non-empty line, truncated to 200 chars,
 * so downstream consumers see something meaningful. The
 * following `thread.orphaned` event makes the placeholder
 * nature explicit. */
function placeholderQuote(commentBody: string): { exact: string; prefix: string; suffix: string } {
  const firstLine = commentBody.split(/\r?\n/).find((line) => line.trim().length > 0) ?? commentBody;
  const trimmed = firstLine.trim().slice(0, 200);
  return { exact: trimmed.length > 0 ? trimmed : "(imported thread — quote unavailable)", prefix: "", suffix: "" };
}

function ghAuthorToReviewCoreAuthor(comment: GhReviewComment): Author {
  const login = comment.authorLogin ?? "ghost";
  return {
    kind: "gh-user",
    id: login,
    displayName: login,
  };
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
    subjectType: node.subjectType === "FILE" ? "FILE" : "LINE",
    resolvedByLogin: node.resolvedBy?.login ?? null,
    comments: node.comments.nodes.map((c) => ({
      databaseId: c.databaseId,
      nodeId: c.id,
      body: c.body,
      authorLogin: c.author?.login ?? null,
      authorType: c.author?.__typename === "Bot" ? "Bot" : c.author?.__typename === "User" ? "User" : "Unknown",
      createdAt: c.createdAt,
      url: c.url,
      originalCommitOid: c.originalCommit?.oid ?? null,
    })),
  };
}

const defaultSleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

/** Parse a `Link` header for `rel="next"`. Returns the URL or `null`. */
export function nextPageUrl(link: string | null): string | null {
  if (link === null || link.length === 0) return null;
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
  readonly node_id: string;
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

// --- GraphQL envelope types (private) --- //

interface PageInfo {
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

interface ReviewThreadsGraphqlResponse {
  readonly data: {
    readonly repository: {
      readonly pullRequest: {
        readonly reviewThreads: {
          readonly pageInfo: PageInfo;
          readonly nodes: readonly ReviewThreadGraphqlNode[];
        };
      } | null;
    } | null;
  };
}

interface ThreadCommentsGraphqlResponse {
  readonly data: {
    readonly node: {
      readonly __typename: string;
      readonly comments: {
        readonly pageInfo: PageInfo;
        readonly nodes: readonly ReviewCommentGraphqlNode[];
      };
    } | null;
  };
}

interface ReviewCommentsGraphqlResponse {
  readonly data: {
    readonly node: {
      readonly __typename: string;
      readonly comments: {
        readonly pageInfo: PageInfo;
        readonly nodes: readonly PendingReviewCommentGraphqlNode[];
      };
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
  readonly subjectType: "LINE" | "FILE";
  readonly resolvedBy: { readonly login: string } | null;
  readonly comments: {
    readonly pageInfo: PageInfo;
    readonly nodes: readonly ReviewCommentGraphqlNode[];
  };
}

interface ReviewCommentGraphqlNode {
  readonly id: string;
  readonly databaseId: number;
  readonly body: string;
  readonly createdAt: string;
  readonly url: string;
  readonly author: { readonly login: string; readonly __typename: string } | null;
  readonly originalCommit: { readonly oid: string } | null;
}

interface PendingReviewCommentGraphqlNode {
  readonly id: string;
  readonly databaseId: number;
  readonly path: string;
  readonly body: string;
  readonly line?: number | null;
  readonly startLine?: number | null;
  readonly originalLine?: number | null;
  readonly originalStartLine?: number | null;
  readonly subjectType?: "LINE" | "FILE";
  readonly url: string;
}

interface PendingReviewLookupResponse {
  readonly data: {
    readonly node: {
      readonly __typename: string;
      readonly reviews?: {
        readonly nodes: readonly {
          readonly id: string;
          readonly databaseId: number | null;
          readonly state: PendingReview["state"];
          readonly commit: { readonly oid: string } | null;
        }[];
      };
    } | null;
  };
}

interface AddReviewMutationResponse {
  readonly data: {
    readonly addPullRequestReview: {
      readonly pullRequestReview: {
        readonly id: string;
        readonly databaseId: number | null;
        readonly state: PendingReview["state"];
        readonly commit: { readonly oid: string } | null;
      } | null;
    } | null;
  };
}

interface AddThreadMutationResponse {
  readonly data: {
    readonly addPullRequestReviewThread: {
      readonly thread: {
        readonly id: string;
        readonly path: string;
        readonly line: number | null;
        readonly startLine: number | null;
        readonly diffSide: "RIGHT" | "LEFT";
        readonly startDiffSide: "RIGHT" | "LEFT" | null;
        readonly subjectType: "LINE" | "FILE";
        readonly comments: {
          readonly nodes: readonly {
            readonly id: string;
            readonly databaseId: number;
            readonly body: string;
            readonly url: string;
          }[];
        };
      } | null;
    } | null;
  };
}

interface ViewerLoginResponse {
  readonly data: {
    readonly viewer: { readonly login: string } | null;
  };
}

interface BlobTextGraphqlResponse {
  readonly data: {
    readonly repository: {
      readonly object: {
        readonly __typename: string;
        readonly text?: string | null;
        readonly isBinary?: boolean | null;
        readonly isTruncated?: boolean | null;
      } | null;
    } | null;
  };
}

// --- GraphQL documents (verified via introspection; see file header) --- //

/** Every GraphQL document the adapter sends, exported so the schema
 * validator (`test/graphql-schema.test.ts`) can walk them against
 * the introspected schema fixture. If a new document is added below,
 * add it to this map — the test iterates the object and validates
 * each entry. */
export const GITHUB_GRAPHQL_DOCUMENTS = {
  get ReviewThreads() {
    return REVIEW_THREADS_QUERY;
  },
  get ThreadComments() {
    return THREAD_COMMENTS_QUERY;
  },
  get ReviewComments() {
    return REVIEW_COMMENTS_QUERY;
  },
  get ViewerLogin() {
    return VIEWER_LOGIN_QUERY;
  },
  get FetchBlobText() {
    return FETCH_BLOB_TEXT_QUERY;
  },
  get ViewerPendingReview() {
    return VIEWER_PENDING_REVIEW_QUERY;
  },
  get AddReview() {
    return ADD_REVIEW_MUTATION;
  },
  get AddThread() {
    return ADD_THREAD_MUTATION;
  },
  get UpdateComment() {
    return UPDATE_COMMENT_MUTATION;
  },
  get DeleteComment() {
    return DELETE_COMMENT_MUTATION;
  },
  get DeleteReview() {
    return DELETE_REVIEW_MUTATION;
  },
  get SubmitReview() {
    return SUBMIT_REVIEW_MUTATION;
  },
} as const;

const REVIEW_THREADS_QUERY = /* GraphQL */ `
  query ReviewThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
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
            subjectType
            resolvedBy { login }
            comments(first: 100) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                databaseId
                body
                createdAt
                url
                author { login __typename }
                originalCommit { oid }
              }
            }
          }
        }
      }
    }
  }
`;

const THREAD_COMMENTS_QUERY = /* GraphQL */ `
  query ThreadComments($threadId: ID!, $cursor: String) {
    node(id: $threadId) {
      __typename
      ... on PullRequestReviewThread {
        comments(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            databaseId
            body
            createdAt
            url
            author { login __typename }
            originalCommit { oid }
          }
        }
      }
    }
  }
`;

const REVIEW_COMMENTS_QUERY = /* GraphQL */ `
  query ReviewComments($id: ID!, $cursor: String) {
    node(id: $id) {
      __typename
      ... on PullRequestReview {
        comments(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            databaseId
            path
            body
            line
            startLine
            originalLine
            originalStartLine
            subjectType
            url
          }
        }
      }
    }
  }
`;

const VIEWER_LOGIN_QUERY = /* GraphQL */ `
  query ViewerLogin { viewer { login } }
`;

const FETCH_BLOB_TEXT_QUERY = /* GraphQL */ `
  query FetchBlobText($owner: String!, $name: String!, $expression: String!) {
    repository(owner: $owner, name: $name) {
      object(expression: $expression) {
        __typename
        ... on Blob {
          text
          isBinary
          isTruncated
        }
      }
    }
  }
`;

const VIEWER_PENDING_REVIEW_QUERY = /* GraphQL */ `
  query ViewerPendingReview($id: ID!, $author: String!) {
    node(id: $id) {
      __typename
      ... on PullRequest {
        reviews(first: 5, states: [PENDING], author: $author) {
          nodes {
            id
            databaseId
            state
            commit { oid }
          }
        }
      }
    }
  }
`;

const ADD_REVIEW_MUTATION = /* GraphQL */ `
  mutation AddReview($pullRequestId: ID!, $commitOID: GitObjectID) {
    addPullRequestReview(input: { pullRequestId: $pullRequestId, commitOID: $commitOID }) {
      pullRequestReview {
        id
        databaseId
        state
        commit { oid }
      }
    }
  }
`;

const ADD_THREAD_MUTATION = /* GraphQL */ `
  mutation AddThread(
    $pullRequestReviewId: ID!,
    $path: String!,
    $body: String!,
    $subjectType: PullRequestReviewThreadSubjectType,
    $line: Int,
    $side: DiffSide,
    $startLine: Int,
    $startSide: DiffSide
  ) {
    addPullRequestReviewThread(input: {
      pullRequestReviewId: $pullRequestReviewId,
      path: $path,
      body: $body,
      subjectType: $subjectType,
      line: $line,
      side: $side,
      startLine: $startLine,
      startSide: $startSide
    }) {
      thread {
        id
        path
        line
        startLine
        diffSide
        startDiffSide
        subjectType
        comments(first: 1) {
          nodes { id databaseId body url }
        }
      }
    }
  }
`;

const UPDATE_COMMENT_MUTATION = /* GraphQL */ `
  mutation UpdateComment($pullRequestReviewCommentId: ID!, $body: String!) {
    updatePullRequestReviewComment(input: {
      pullRequestReviewCommentId: $pullRequestReviewCommentId,
      body: $body
    }) {
      pullRequestReviewComment { id }
    }
  }
`;

const DELETE_COMMENT_MUTATION = /* GraphQL */ `
  mutation DeleteComment($id: ID!) {
    deletePullRequestReviewComment(input: { id: $id }) {
      pullRequestReviewComment { id }
    }
  }
`;

const DELETE_REVIEW_MUTATION = /* GraphQL */ `
  mutation DeleteReview($pullRequestReviewId: ID!) {
    deletePullRequestReview(input: { pullRequestReviewId: $pullRequestReviewId }) {
      pullRequestReview { id state }
    }
  }
`;

const SUBMIT_REVIEW_MUTATION = /* GraphQL */ `
  mutation SubmitReview($pullRequestReviewId: ID!, $event: PullRequestReviewEvent!, $body: String) {
    submitPullRequestReview(input: {
      pullRequestReviewId: $pullRequestReviewId,
      event: $event,
      body: $body
    }) {
      pullRequestReview { id state }
    }
  }
`;
