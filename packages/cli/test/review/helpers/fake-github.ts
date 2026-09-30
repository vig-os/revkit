// A minimal fake-GitHub `fetch` used by the review CLI tests. Every
// route the review command touches is mocked here; a route the
// adapter reaches that we haven't wired throws so a code change that
// adds a call has to add a route (never silently receives an
// unmocked response).
//
// **REST writes are refused** by design. `revkit review <pr>` may
// only hit the REST GET path — a REST write has no legitimate use.
// GraphQL, on the other hand, IS how the adapter mutates: the M3
// part 2b write paths (`addPullRequestReviewThread`,
// `submitPullRequestReview`, `deletePullRequestReview`) all go
// through GraphQL. The fake routes those explicitly and records
// each call so tests can assert on the request shape (op name,
// variables). Any unrouted GraphQL op throws so a new adapter
// method that lands without a fake route fails loudly.

import {
  DEFAULT_GITHUB_BASE_URL,
  DEFAULT_GITHUB_GRAPHQL_URL,
  type GhReviewThread,
} from "@revkit/review-core";

/** One PR the fake serves. Shape matches the subset the adapter reads
 * (see `GitHubAdapter.getPullRequest` and `listReviewThreads`). */
export interface FakePr {
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly nodeId: string;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly headSha: string;
  readonly headRef: string;
  readonly baseSha: string;
  readonly baseRef: string;
  readonly headRepoFullName: string | null;
  readonly baseRepoFullName: string;
  readonly url: string;
  /** Optional review threads returned by the adapter's GraphQL. */
  readonly threads?: readonly GhReviewThread[];
  /** Optional file list from `listPullRequestFiles`. */
  readonly files?: ReadonlyArray<{
    readonly filename: string;
    readonly status?: string;
    readonly patch?: string;
    readonly previous_filename?: string;
  }>;
}

/** Build the REST body the adapter's `getPullRequest` unpacks. */
function restBody(pr: FakePr): unknown {
  return {
    number: pr.pullNumber,
    node_id: pr.nodeId,
    title: pr.title,
    state: pr.state,
    draft: false,
    head: {
      sha: pr.headSha,
      ref: pr.headRef,
      repo: pr.headRepoFullName !== null ? { full_name: pr.headRepoFullName } : null,
    },
    base: {
      sha: pr.baseSha,
      ref: pr.baseRef,
      repo: { full_name: pr.baseRepoFullName },
    },
    html_url: pr.url,
  };
}

/** GraphQL body shape for `listReviewThreads`. */
function threadsGraphqlBody(threads: readonly GhReviewThread[]): unknown {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: threads.map((t) => ({
              id: t.id,
              path: t.path,
              isResolved: t.isResolved,
              isOutdated: t.isOutdated,
              line: t.line,
              startLine: t.startLine,
              originalLine: t.originalLine,
              originalStartLine: t.originalStartLine,
              diffSide: t.diffSide,
              startDiffSide: t.startDiffSide,
              subjectType: t.subjectType,
              resolvedBy: t.resolvedByLogin !== null ? { login: t.resolvedByLogin } : null,
              comments: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: t.comments.map((c) => ({
                  id: c.nodeId,
                  databaseId: c.databaseId,
                  body: c.body,
                  author: c.authorLogin !== null ? { __typename: c.authorType, login: c.authorLogin } : null,
                  createdAt: c.createdAt,
                  url: c.url,
                  path: t.path,
                  line: t.line,
                  startLine: t.startLine,
                  originalLine: t.originalLine,
                  originalStartLine: t.originalStartLine,
                  diffSide: t.diffSide,
                  startDiffSide: t.startDiffSide,
                  subjectType: t.subjectType,
                  originalCommit: c.originalCommitOid !== null ? { oid: c.originalCommitOid } : null,
                  diffHunk: c.diffHunk,
                })),
              },
            })),
          },
        },
      },
    },
  };
}

/** Options for `makeFakeGithubFetch`. `viewerLogin` is the login
 * the `ViewerLogin` query returns — the daemon looks this up on
 * `startServe` in review mode. `pendingState` (optional) is a
 * mutable slot the fake mutates as callers post pending drafts
 * and submit; the test injects it so multiple `fetch` calls agree
 * on the pending review's state. `refuseAllWrites` (default false)
 * flips the M3 part 2a safety back on for tests that specifically
 * verify the read-only path (they never touch the review-mode
 * daemon). `blobs` maps a `<oid|ref>:<path>` git-rev-parse
 * expression to blob text — used by the head-move reanchor so
 * the pipeline sees new-side source instead of the default
 * not-found. */
export interface FakeFetchOptions {
  readonly viewerLogin?: string;
  readonly pendingState?: FakePendingState;
  readonly refuseAllWrites?: boolean;
  readonly blobs?: ReadonlyMap<string, string>;
}

/** Mutable pending-review state the fake maintains across calls.
 * Round-2 (BLOCK-fix): mirrors GitHub's real semantics —
 *   - a single pending review per viewer per PR (a second
 *     AddReview against an already-pending viewer errors);
 *   - a SUBMITTED review is IMMUTABLE (AddThread / Submit / reply
 *     pinned to it error);
 *   - node ids must EXIST (a reply / submit / delete on an
 *     unknown reviewNodeId errors);
 *   - drafts posted with `pullRequestReviewId` are DRAFTS on that
 *     pending review; discarding it removes them.
 * Tests read this slot after a POST to assert on what the daemon
 * sent. */
export interface FakePendingState {
  /** The current pending review's node id (if any). */
  reviewNodeId: string | null;
  /** Sha the review is pinned to. */
  commitOid: string | null;
  /** The next pending comment/thread id counter — bumped on each
   * `addPullRequestReviewThread`. */
  nextCommentId: number;
  /** Every draft comment that has been posted since the last
   * clear-out. */
  drafts: Array<{
    threadNodeId: string;
    commentNodeId: string;
    databaseId: number;
    path: string;
    body: string;
    line?: number;
    startLine?: number;
    side?: "RIGHT" | "LEFT";
    subjectType: "LINE" | "FILE";
  }>;
  /** Reviews that have been submitted — for the "submitted review
   * is immutable" invariant. */
  submittedReviewIds: Set<string>;
  /** Every submit call. */
  submits: Array<{ reviewNodeId: string; event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES"; body?: string }>;
  /** Every delete-review call. */
  deletes: Array<{ reviewNodeId: string }>;
  /** Every reply-to-thread call. `pendingReviewId` is set when
   * the caller pinned the reply to a pending review (ADR-0025 (b)). */
  replies: Array<{ threadNodeId: string; body: string; commentNodeId: string; databaseId: number; pendingReviewId?: string }>;
  /** Every resolve/unresolve call. */
  resolutions: Array<{ threadNodeId: string; op: "resolve" | "unresolve" }>;
}

/** Build a fresh mutable pending state. Tests create one per case
 * so state doesn't leak between tests. */
export function makePendingState(): FakePendingState {
  return {
    reviewNodeId: null,
    commitOid: null,
    nextCommentId: 100_000,
    drafts: [],
    submittedReviewIds: new Set<string>(),
    submits: [],
    deletes: [],
    replies: [],
    resolutions: [],
  };
}

/** Build a `fetch`-shaped stub the adapter can be fed. */
export function makeFakeGithubFetch(prs: readonly FakePr[], options: FakeFetchOptions = {}): typeof fetch {
  const byNumber = new Map<string, FakePr>();
  for (const pr of prs) byNumber.set(`${pr.owner}/${pr.repo}/${pr.pullNumber}`, pr);
  const viewerLogin = options.viewerLogin ?? "test-reviewer";
  const pending = options.pendingState;
  const refuseAllWrites = options.refuseAllWrites === true;
  const blobs = options.blobs ?? new Map<string, string>();

  const fn = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init.method ?? "GET").toUpperCase();

    // REST: `GET /repos/{o}/{r}/pulls/{n}`.
    const restPullMatch = url.match(
      new RegExp(`^${escapeRe(DEFAULT_GITHUB_BASE_URL)}/repos/([^/]+)/([^/]+)/pulls/([0-9]+)$`),
    );
    if (restPullMatch !== null && method === "GET") {
      const [_, owner, repo, num] = restPullMatch;
      const pr = byNumber.get(`${owner}/${repo}/${num}`);
      if (pr === undefined) return new Response("not found", { status: 404 });
      return jsonResponse(restBody(pr));
    }

    // REST: `GET /repos/{o}/{r}/pulls/{n}/files`.
    const restFilesMatch = url.match(
      new RegExp(`^${escapeRe(DEFAULT_GITHUB_BASE_URL)}/repos/([^/]+)/([^/]+)/pulls/([0-9]+)/files\\?`),
    );
    if (restFilesMatch !== null && method === "GET") {
      const [_, owner, repo, num] = restFilesMatch;
      const pr = byNumber.get(`${owner}/${repo}/${num}`);
      if (pr === undefined) return new Response("not found", { status: 404 });
      return jsonResponse(pr.files ?? []);
    }

    // REST: compare (used by importThreads for merge-base). Return a
    // safe null merge-base for the fixtures we run.
    const restCompareMatch = url.match(
      new RegExp(`^${escapeRe(DEFAULT_GITHUB_BASE_URL)}/repos/([^/]+)/([^/]+)/compare/`),
    );
    if (restCompareMatch !== null && method === "GET") {
      // The fake returns a `merge_base_commit.sha` matching the
      // base — that way importThreads doesn't try to fetch a blob
      // at a non-existent SHA.
      return jsonResponse({ merge_base_commit: { sha: "0".repeat(40) } });
    }

    // GraphQL — the adapter posts a query to
    // `DEFAULT_GITHUB_GRAPHQL_URL`. We inspect the body to route.
    if (url === DEFAULT_GITHUB_GRAPHQL_URL && method === "POST") {
      const bodyText = init.body === undefined ? "" : String(init.body);
      let body: { query?: string; variables?: Record<string, unknown> };
      try {
        body = JSON.parse(bodyText);
      } catch {
        return new Response("bad json", { status: 400 });
      }
      const query = body.query ?? "";
      const opMatch = /(?:query|mutation)\s+(\w+)/.exec(query);
      const op = opMatch?.[1] ?? "";
      // Route on operation name first (more precise than a substring
      // match), then fall back to substring for queries whose op name
      // isn't stable across changes.
      const vars = (body.variables ?? {}) as Record<string, unknown>;
      switch (op) {
        case "ReviewThreads": {
          const owner = vars.owner as string | undefined;
          const name = vars.name as string | undefined;
          const num = vars.number as number | undefined;
          const pr = byNumber.get(`${owner}/${name}/${num}`);
          return jsonResponse(threadsGraphqlBody(pr?.threads ?? []));
        }
        case "FetchBlobText": {
          const expr = String(vars.expression ?? "");
          const text = blobs.get(expr);
          if (text === undefined) {
            return jsonResponse({ data: { repository: { object: null } } });
          }
          return jsonResponse({
            data: { repository: { object: { __typename: "Blob", text, isBinary: false, isTruncated: false } } },
          });
        }
        case "ViewerLogin":
          return jsonResponse({ data: { viewer: { login: viewerLogin } } });
        case "ViewerPendingReview": {
          if (pending === undefined) return jsonResponse({ data: { node: { __typename: "PullRequest", reviews: { nodes: [] } } } });
          if (pending.reviewNodeId === null) {
            return jsonResponse({ data: { node: { __typename: "PullRequest", reviews: { nodes: [] } } } });
          }
          return jsonResponse({
            data: {
              node: {
                __typename: "PullRequest",
                reviews: {
                  nodes: [
                    {
                      id: pending.reviewNodeId,
                      databaseId: 1,
                      state: "PENDING",
                      commit: { oid: pending.commitOid },
                    },
                  ],
                },
              },
            },
          });
        }
        case "ReviewComments": {
          // Serve back the drafts on the review named by `id`.
          if (pending === undefined || pending.reviewNodeId !== vars.id) {
            return jsonResponse({ data: { node: null } });
          }
          return jsonResponse({
            data: {
              node: {
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: pending.drafts.map((d) => ({
                    id: d.commentNodeId,
                    databaseId: d.databaseId,
                    path: d.path,
                    body: d.body,
                    line: d.line ?? null,
                    startLine: d.startLine ?? null,
                    originalLine: d.line ?? null,
                    originalStartLine: d.startLine ?? null,
                    subjectType: d.subjectType,
                    url: `https://github.com/example/repo/pull/1#discussion_r${d.databaseId}`,
                  })),
                },
              },
            },
          });
        }
        case "AddReview": {
          if (refuseAllWrites || pending === undefined) {
            throw new Error(`fake github: refusing AddReview (no pending state)`);
          }
          // Semantic: at most ONE pending review per viewer per PR.
          // A second AddReview while one exists errors — mirrors
          // GitHub's real behaviour.
          if (pending.reviewNodeId !== null) {
            return jsonResponse({
              errors: [
                {
                  type: "UNPROCESSABLE",
                  message: `A pending review already exists for this pull request (${pending.reviewNodeId}).`,
                },
              ],
            });
          }
          const oid = vars.commitOID as string;
          const id = `PR_review_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
          pending.reviewNodeId = id;
          pending.commitOid = oid;
          return jsonResponse({
            data: { addPullRequestReview: { pullRequestReview: { id, databaseId: 1, state: "PENDING", commit: { oid } } } },
          });
        }
        case "AddThread": {
          if (refuseAllWrites || pending === undefined) {
            throw new Error(`fake github: refusing AddThread`);
          }
          const reviewId = vars.pullRequestReviewId as string | undefined;
          // Refuse an AddThread on a review that is not currently
          // the pending review (submitted / dismissed / unknown).
          if (reviewId !== pending.reviewNodeId) {
            return jsonResponse({
              errors: [
                {
                  type: "NOT_FOUND",
                  message: `Pull request review '${String(reviewId)}' is not in the PENDING state.`,
                },
              ],
            });
          }
          const dbId = pending.nextCommentId++;
          const commentNodeId = `PRRC_${dbId}`;
          const threadNodeId = `PRT_${dbId}`;
          const draft = {
            threadNodeId,
            commentNodeId,
            databaseId: dbId,
            path: vars.path as string,
            body: vars.body as string,
            ...(typeof vars.line === "number" ? { line: vars.line as number } : {}),
            ...(typeof vars.startLine === "number" ? { startLine: vars.startLine as number } : {}),
            ...(typeof vars.side === "string" ? { side: vars.side as "RIGHT" | "LEFT" } : {}),
            subjectType: ((vars.subjectType as string) === "FILE" ? "FILE" : "LINE") as "LINE" | "FILE",
          };
          pending.drafts.push(draft);
          return jsonResponse({
            data: {
              addPullRequestReviewThread: {
                thread: {
                  id: threadNodeId,
                  path: draft.path,
                  line: draft.line ?? null,
                  startLine: draft.startLine ?? null,
                  diffSide: draft.side ?? "RIGHT",
                  startDiffSide: draft.side ?? "RIGHT",
                  subjectType: draft.subjectType,
                  comments: {
                    nodes: [
                      {
                        id: commentNodeId,
                        databaseId: dbId,
                        body: draft.body,
                        url: `https://github.com/example/repo/pull/1#discussion_r${dbId}`,
                      },
                    ],
                  },
                },
              },
            },
          });
        }
        case "SubmitReview": {
          if (refuseAllWrites || pending === undefined) {
            throw new Error(`fake github: refusing SubmitReview`);
          }
          const submitReviewId = vars.pullRequestReviewId as string;
          // Refuse a submit on an unknown / already-terminal review.
          // Probe P4: a re-submit of a submitted review must fail.
          if (submitReviewId !== pending.reviewNodeId) {
            return jsonResponse({
              errors: [
                {
                  type: "NOT_FOUND",
                  message: `Pull request review '${submitReviewId}' is not PENDING (already submitted or unknown).`,
                },
              ],
            });
          }
          pending.submits.push({
            reviewNodeId: submitReviewId,
            event: vars.event as "COMMENT" | "APPROVE" | "REQUEST_CHANGES",
            ...(typeof vars.body === "string" ? { body: vars.body as string } : {}),
          });
          pending.submittedReviewIds.add(submitReviewId);
          pending.reviewNodeId = null;
          pending.commitOid = null;
          pending.drafts.length = 0;
          return jsonResponse({
            data: { submitPullRequestReview: { pullRequestReview: { id: submitReviewId, state: "COMMENTED" } } },
          });
        }
        case "DeleteReview": {
          if (refuseAllWrites || pending === undefined) {
            throw new Error(`fake github: refusing DeleteReview`);
          }
          const deleteReviewId = vars.pullRequestReviewId as string;
          if (deleteReviewId !== pending.reviewNodeId) {
            return jsonResponse({
              errors: [
                { type: "NOT_FOUND", message: `Pull request review '${deleteReviewId}' is not PENDING.` },
              ],
            });
          }
          pending.deletes.push({ reviewNodeId: deleteReviewId });
          pending.reviewNodeId = null;
          pending.commitOid = null;
          pending.drafts.length = 0;
          return jsonResponse({
            data: { deletePullRequestReview: { pullRequestReview: { id: deleteReviewId, state: "DISMISSED" } } },
          });
        }
        case "AddReviewThreadReply": {
          if (refuseAllWrites || pending === undefined) {
            throw new Error(`fake github: refusing AddReviewThreadReply`);
          }
          const replyReviewId = vars.pullRequestReviewId as string | undefined;
          // If pinned to a pending review, that review must exist
          // AND be the current pending review.
          if (replyReviewId !== undefined && replyReviewId !== pending.reviewNodeId) {
            return jsonResponse({
              errors: [
                { type: "NOT_FOUND", message: `Pull request review '${replyReviewId}' is not PENDING.` },
              ],
            });
          }
          const dbId = pending.nextCommentId++;
          const commentNodeId = `PRRC_${dbId}`;
          pending.replies.push({
            threadNodeId: vars.pullRequestReviewThreadId as string,
            body: vars.body as string,
            commentNodeId,
            databaseId: dbId,
            ...(replyReviewId !== undefined ? { pendingReviewId: replyReviewId } : {}),
          });
          return jsonResponse({
            data: {
              addPullRequestReviewThreadReply: {
                comment: {
                  id: commentNodeId,
                  databaseId: dbId,
                  body: vars.body,
                  url: `https://github.com/example/repo/pull/1#discussion_r${dbId}`,
                },
              },
            },
          });
        }
        case "ResolveReviewThread":
        case "UnresolveReviewThread": {
          if (refuseAllWrites || pending === undefined) {
            throw new Error(`fake github: refusing ${op}`);
          }
          pending.resolutions.push({
            threadNodeId: vars.threadId as string,
            op: op === "ResolveReviewThread" ? "resolve" : "unresolve",
          });
          const shape = op === "ResolveReviewThread"
            ? { resolveReviewThread: { thread: { id: vars.threadId, isResolved: true } } }
            : { unresolveReviewThread: { thread: { id: vars.threadId, isResolved: false } } };
          return jsonResponse({ data: shape });
        }
        default:
          break;
      }
      // Legacy substring fallbacks — kept because some tests rely
      // on them for pre-op-name query shapes.
      if (query.includes("reviewThreads(")) {
        const owner = vars.owner as string | undefined;
        const name = vars.name as string | undefined;
        const num = vars.number as number | undefined;
        const pr = byNumber.get(`${owner}/${name}/${num}`);
        return jsonResponse(threadsGraphqlBody(pr?.threads ?? []));
      }
      if (query.includes("repository(") && query.includes("object(expression")) {
        return jsonResponse({ data: { repository: { object: null } } });
      }
      if (query.includes("viewer") && query.includes("login")) {
        return jsonResponse({ data: { viewer: { login: viewerLogin } } });
      }
      throw new Error(`fake github: unrouted GraphQL op '${op}' — add a route`);
    }

    // Any other write path: refuse. The review command must NEVER
    // hit GitHub through REST for a mutation — REST review write
    // paths (`POST /pulls/N/comments`) publish immediately without
    // a pending-review draft (see PR #43 review notes).
    if (method !== "GET") {
      throw new Error(`fake github: refusing REST write call ${method} ${url}`);
    }
    throw new Error(`fake github: unmocked ${method} ${url}`);
  };

  (fn as { preconnect?: (u: string) => void }).preconnect = () => {};
  return fn as unknown as typeof fetch;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
