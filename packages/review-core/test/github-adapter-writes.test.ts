// GitHub adapter write-path contract tests (M3 part 1, ADR-0025).
//
// Post-PR-43 review: ALL writes go through GraphQL. REST
// `POST /pulls/{n}/comments` publishes immediately if no pending
// review exists (a draft becomes public — a real harm) and 422s if
// one exists. The adapter therefore never calls it, and the
// "no-legacy-rest-comment-writes" test would go red if a future
// edit reintroduced the call.
//
// The tests run the pending-review workflow (viewer-login → find /
// create pending → add thread → list → delete comment → submit)
// against an in-process fake `fetch` and assert:
//   - the HTTP method and URL each call sends,
//   - the GraphQL operation name and variables each call sends,
//   - the Authorization / Accept / User-Agent headers.
//
// GraphQL mutation names and input field names were verified via
// live introspection (see the PR body / commit message). The fake
// returns canned payloads; only the request shape is under test.

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_GITHUB_BASE_URL,
  DEFAULT_GITHUB_GRAPHQL_URL,
  GitHubAdapter,
  type TokenSource,
} from "../src/index.ts";

const TOKEN = "fake-token-value-with-enough-length-01234567";
const staticToken: TokenSource = { async getToken() { return TOKEN; } };

interface RequestRecord {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function makeRecorder(
  responder: (req: RequestRecord) => Response,
): { fetch: typeof fetch; requests: RequestRecord[] } {
  const requests: RequestRecord[] = [];
  const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    if (init.headers !== undefined) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => (headers[k] = v));
      } else if (Array.isArray(init.headers)) {
        for (const pair of init.headers) {
          const k = pair[0];
          const v = pair[1];
          if (k !== undefined && v !== undefined) headers[k] = v;
        }
      } else {
        for (const [k, v] of Object.entries(init.headers)) headers[k] = v as string;
      }
    }
    let parsedBody: unknown = undefined;
    if (init.body !== undefined && typeof init.body === "string" && init.body.length > 0) {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    const record: RequestRecord = { method, url, headers, body: parsedBody };
    requests.push(record);
    return responder(record);
  };
  (fn as { preconnect?: (url: string) => void }).preconnect = () => {};
  return { fetch: fn as unknown as typeof fetch, requests };
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Route a GraphQL call by the operation name that appears at the
 * start of `query`. Returns whatever the routes map provides. */
function graphqlRouter(
  routes: Record<string, (variables: Record<string, unknown>) => unknown>,
): (req: RequestRecord) => Response {
  return (req) => {
    if (req.url !== DEFAULT_GITHUB_GRAPHQL_URL) {
      return new Response(`unexpected url: ${req.url}`, { status: 500 });
    }
    const body = req.body as { query: string; variables: Record<string, unknown> };
    const opMatch = /(?:query|mutation)\s+(\w+)/.exec(body.query);
    const op = opMatch?.[1] ?? "unknown";
    const handler = routes[op];
    if (handler === undefined) {
      return new Response(`no handler for op ${op}: ${body.query.slice(0, 100)}`, { status: 500 });
    }
    return ok(handler(body.variables));
  };
}

const PR_NODE_ID = "PR_kwDOUyqeeM8AAAABF00FHA";
const REVIEW_NODE_ID = "PRR_kwDOUyqeeM8AAAABF00FHB";
const COMMENT_NODE_ID = "PRRC_kwDOUyqeeM8AAAABF00FHC";
const COMMIT_OID = "9c47428597832d9ad0e21b39f40c9d1ef4fe5df2";
const noRetry = { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 } as const;

describe("findOrCreatePendingReview — contract", () => {
  test("reuses an existing viewer PENDING review, sends no create mutation", async () => {
    const { fetch, requests } = makeRecorder(
      graphqlRouter({
        ViewerLogin: () => ({ data: { viewer: { login: "gerchowl" } } }),
        ViewerPendingReview: (v) => {
          expect(v.id).toBe(PR_NODE_ID);
          expect(v.author).toBe("gerchowl");
          return {
            data: {
              node: {
                __typename: "PullRequest",
                reviews: {
                  nodes: [
                    {
                      id: REVIEW_NODE_ID,
                      databaseId: 1001,
                      state: "PENDING",
                      commit: { oid: COMMIT_OID },
                    },
                  ],
                },
              },
            },
          };
        },
      }),
    );
    const adapter = new GitHubAdapter({ token: staticToken, fetch, retryPolicy: noRetry });
    const result = await adapter.findOrCreatePendingReview({
      pullRequestNodeId: PR_NODE_ID,
      commitOid: COMMIT_OID,
    });
    expect(result.kind).toBe("reused");
    expect(result.review.id).toBe(REVIEW_NODE_ID);
    expect(result.review.state).toBe("PENDING");
    expect(result.review.commitSha).toBe(COMMIT_OID);
    // Two calls: ViewerLogin + ViewerPendingReview. NO AddReview.
    expect(requests.length).toBe(2);
    for (const req of requests) {
      expect(req.method).toBe("POST");
      expect(req.url).toBe(DEFAULT_GITHUB_GRAPHQL_URL);
      const b = req.body as { query: string };
      expect(b.query).not.toContain("addPullRequestReview");
    }
  });

  test("returns kind=stale when the reused pending review is pinned to a different commit", async () => {
    // BLOCKER 3 (PR-43 round-3): head-move detection. A pending
    // review pinned to an older commit MUST NOT be silently reused.
    // The caller needs to re-anchor drafts or ask the user.
    const OLD_OID = "1111111111111111111111111111111111111111";
    const NEW_OID = "2222222222222222222222222222222222222222";
    const { fetch, requests } = makeRecorder(
      graphqlRouter({
        ViewerLogin: () => ({ data: { viewer: { login: "gerchowl" } } }),
        ViewerPendingReview: () => ({
          data: {
            node: {
              __typename: "PullRequest",
              reviews: {
                nodes: [{ id: REVIEW_NODE_ID, databaseId: 1, state: "PENDING", commit: { oid: OLD_OID } }],
              },
            },
          },
        }),
      }),
    );
    const adapter = new GitHubAdapter({ token: staticToken, fetch, retryPolicy: noRetry });
    const result = await adapter.findOrCreatePendingReview({
      pullRequestNodeId: PR_NODE_ID,
      commitOid: NEW_OID,
    });
    expect(result.kind).toBe("stale");
    if (result.kind !== "stale") throw new Error("unreachable");
    expect(result.review.id).toBe(REVIEW_NODE_ID);
    expect(result.expectedCommitOid).toBe(NEW_OID);
    expect(result.actualCommitOid).toBe(OLD_OID);
    // Crucially, NO AddReview mutation was fired — silent reuse
    // would have been the failure mode.
    for (const req of requests) {
      const b = req.body as { query: string };
      expect(b.query).not.toContain("mutation AddReview");
    }
  });

  test("creates a new pending review via addPullRequestReview when none exists", async () => {
    const { fetch, requests } = makeRecorder(
      graphqlRouter({
        ViewerLogin: () => ({ data: { viewer: { login: "gerchowl" } } }),
        ViewerPendingReview: () => ({
          data: { node: { __typename: "PullRequest", reviews: { nodes: [] } } },
        }),
        AddReview: (v) => {
          expect(v.pullRequestId).toBe(PR_NODE_ID);
          expect(v.commitOID).toBe(COMMIT_OID);
          return {
            data: {
              addPullRequestReview: {
                pullRequestReview: {
                  id: REVIEW_NODE_ID,
                  databaseId: 1002,
                  state: "PENDING",
                  commit: { oid: COMMIT_OID },
                },
              },
            },
          };
        },
      }),
    );
    const adapter = new GitHubAdapter({ token: staticToken, fetch, retryPolicy: noRetry });
    const result = await adapter.findOrCreatePendingReview({
      pullRequestNodeId: PR_NODE_ID,
      commitOid: COMMIT_OID,
    });
    expect(result.kind).toBe("created");
    expect(result.review.id).toBe(REVIEW_NODE_ID);
    // Three calls: ViewerLogin + ViewerPendingReview + AddReview.
    expect(requests.length).toBe(3);
    // No REST write to /pulls/:n/reviews.
    for (const req of requests) {
      expect(req.url).toBe(DEFAULT_GITHUB_GRAPHQL_URL);
    }
  });

  test("skips ViewerLogin when caller passes viewerLogin", async () => {
    const { fetch, requests } = makeRecorder(
      graphqlRouter({
        ViewerPendingReview: (v) => {
          expect(v.author).toBe("preset-login");
          return {
            data: {
              node: {
                __typename: "PullRequest",
                reviews: {
                  nodes: [{ id: REVIEW_NODE_ID, databaseId: 1, state: "PENDING", commit: { oid: COMMIT_OID } }],
                },
              },
            },
          };
        },
      }),
    );
    const adapter = new GitHubAdapter({ token: staticToken, fetch, retryPolicy: noRetry });
    await adapter.findOrCreatePendingReview({
      pullRequestNodeId: PR_NODE_ID,
      commitOid: COMMIT_OID,
      viewerLogin: "preset-login",
    });
    expect(requests.length).toBe(1);
  });
});

describe("addPendingReviewThread — contract", () => {
  test("LINE single-line comment sends the expected variables (path, line, side, subjectType)", async () => {
    let captured: Record<string, unknown> | undefined;
    const { fetch, requests } = makeRecorder(
      graphqlRouter({
        AddThread: (v) => {
          captured = v;
          return {
            data: {
              addPullRequestReviewThread: {
                thread: {
                  id: "PRRT_1",
                  path: "docs/a.mdx",
                  line: 3,
                  startLine: null,
                  diffSide: "RIGHT",
                  startDiffSide: null,
                  subjectType: "LINE",
                  comments: {
                    nodes: [
                      {
                        id: COMMENT_NODE_ID,
                        databaseId: 8899,
                        body: "please fix",
                        url: "https://github.com/vig-os/revkit/pull/8#discussion_r8899",
                      },
                    ],
                  },
                },
              },
            },
          };
        },
      }),
    );
    const adapter = new GitHubAdapter({ token: staticToken, fetch, retryPolicy: noRetry });
    const comment = await adapter.addPendingReviewThread({
      reviewId: REVIEW_NODE_ID,
      path: "docs/a.mdx",
      body: "please fix",
      line: 3,
    });
    expect(comment.nodeId).toBe(COMMENT_NODE_ID);
    expect(comment.databaseId).toBe(8899);
    expect(comment.subjectType).toBe("LINE");
    expect(captured).toEqual({
      pullRequestReviewId: REVIEW_NODE_ID,
      path: "docs/a.mdx",
      body: "please fix",
      subjectType: "LINE",
      line: 3,
      side: "RIGHT",
    });
    // Exactly one call. NO REST comments endpoint.
    expect(requests.length).toBe(1);
    for (const req of requests) {
      expect(req.url).toBe(DEFAULT_GITHUB_GRAPHQL_URL);
    }
  });

  test("LINE multi-line sends startLine + startSide + line + side (all RIGHT)", async () => {
    let captured: Record<string, unknown> | undefined;
    const { fetch } = makeRecorder(
      graphqlRouter({
        AddThread: (v) => {
          captured = v;
          return {
            data: {
              addPullRequestReviewThread: {
                thread: {
                  id: "PRRT_2",
                  path: "docs/b.mdx",
                  line: 12,
                  startLine: 8,
                  diffSide: "RIGHT",
                  startDiffSide: "RIGHT",
                  subjectType: "LINE",
                  comments: {
                    nodes: [{ id: "c2", databaseId: 8900, body: "range", url: "u" }],
                  },
                },
              },
            },
          };
        },
      }),
    );
    const adapter = new GitHubAdapter({ token: staticToken, fetch, retryPolicy: noRetry });
    await adapter.addPendingReviewThread({
      reviewId: REVIEW_NODE_ID,
      path: "docs/b.mdx",
      body: "range",
      line: 12,
      startLine: 8,
    });
    expect(captured).toEqual({
      pullRequestReviewId: REVIEW_NODE_ID,
      path: "docs/b.mdx",
      body: "range",
      subjectType: "LINE",
      line: 12,
      side: "RIGHT",
      startLine: 8,
      startSide: "RIGHT",
    });
  });

  test("FILE subject: subjectType FILE, no line/startLine/side sent", async () => {
    let captured: Record<string, unknown> | undefined;
    const { fetch } = makeRecorder(
      graphqlRouter({
        AddThread: (v) => {
          captured = v;
          return {
            data: {
              addPullRequestReviewThread: {
                thread: {
                  id: "PRRT_3",
                  path: "docs/c.mdx",
                  line: null,
                  startLine: null,
                  diffSide: "RIGHT",
                  startDiffSide: null,
                  subjectType: "FILE",
                  comments: {
                    nodes: [{ id: "c3", databaseId: 8901, body: "file-level note", url: "u3" }],
                  },
                },
              },
            },
          };
        },
      }),
    );
    const adapter = new GitHubAdapter({ token: staticToken, fetch, retryPolicy: noRetry });
    await adapter.addPendingReviewThread({
      reviewId: REVIEW_NODE_ID,
      path: "docs/c.mdx",
      body: "file-level note",
      subjectType: "FILE",
    });
    expect(captured).toEqual({
      pullRequestReviewId: REVIEW_NODE_ID,
      path: "docs/c.mdx",
      body: "file-level note",
      subjectType: "FILE",
    });
  });

  test("refuses a LINE thread without a line", async () => {
    const { fetch } = makeRecorder(() => ok({ data: {} }));
    const adapter = new GitHubAdapter({ token: staticToken, fetch, retryPolicy: noRetry });
    await expect(
      adapter.addPendingReviewThread({
        reviewId: REVIEW_NODE_ID,
        path: "docs/a.mdx",
        body: "nope",
      }),
    ).rejects.toThrow(/line is required/);
  });
});

describe("updatePendingReviewComment — contract", () => {
  test("sends the comment node id and new body", async () => {
    let captured: Record<string, unknown> | undefined;
    const { fetch } = makeRecorder(
      graphqlRouter({
        UpdateComment: (v) => {
          captured = v;
          return { data: { updatePullRequestReviewComment: { pullRequestReviewComment: { id: COMMENT_NODE_ID } } } };
        },
      }),
    );
    const adapter = new GitHubAdapter({ token: staticToken, fetch, retryPolicy: noRetry });
    await adapter.updatePendingReviewComment({ commentNodeId: COMMENT_NODE_ID, body: "updated body" });
    expect(captured).toEqual({
      pullRequestReviewCommentId: COMMENT_NODE_ID,
      body: "updated body",
    });
  });
});

describe("deletePendingReviewComment — contract", () => {
  test("sends the comment node id", async () => {
    let captured: Record<string, unknown> | undefined;
    const { fetch } = makeRecorder(
      graphqlRouter({
        DeleteComment: (v) => {
          captured = v;
          return { data: { deletePullRequestReviewComment: { pullRequestReviewComment: { id: COMMENT_NODE_ID } } } };
        },
      }),
    );
    const adapter = new GitHubAdapter({ token: staticToken, fetch, retryPolicy: noRetry });
    await adapter.deletePendingReviewComment({ commentNodeId: COMMENT_NODE_ID });
    expect(captured).toEqual({ id: COMMENT_NODE_ID });
  });
});

describe("deletePendingReview — contract", () => {
  test("sends the review node id (discard)", async () => {
    let captured: Record<string, unknown> | undefined;
    const { fetch } = makeRecorder(
      graphqlRouter({
        DeleteReview: (v) => {
          captured = v;
          return { data: { deletePullRequestReview: { pullRequestReview: { id: REVIEW_NODE_ID, state: "PENDING" } } } };
        },
      }),
    );
    const adapter = new GitHubAdapter({ token: staticToken, fetch, retryPolicy: noRetry });
    await adapter.deletePendingReview({ reviewId: REVIEW_NODE_ID });
    expect(captured).toEqual({ pullRequestReviewId: REVIEW_NODE_ID });
  });
});

describe("submitReview — contract", () => {
  test("APPROVE with body", async () => {
    let captured: Record<string, unknown> | undefined;
    const { fetch } = makeRecorder(
      graphqlRouter({
        SubmitReview: (v) => {
          captured = v;
          return { data: { submitPullRequestReview: { pullRequestReview: { id: REVIEW_NODE_ID, state: "APPROVED" } } } };
        },
      }),
    );
    const adapter = new GitHubAdapter({ token: staticToken, fetch, retryPolicy: noRetry });
    await adapter.submitReview({ reviewId: REVIEW_NODE_ID, event: "APPROVE", body: "LGTM" });
    expect(captured).toEqual({
      pullRequestReviewId: REVIEW_NODE_ID,
      event: "APPROVE",
      body: "LGTM",
    });
  });

  test("REQUEST_CHANGES without body", async () => {
    let captured: Record<string, unknown> | undefined;
    const { fetch } = makeRecorder(
      graphqlRouter({
        SubmitReview: (v) => {
          captured = v;
          return { data: { submitPullRequestReview: { pullRequestReview: { id: REVIEW_NODE_ID, state: "CHANGES_REQUESTED" } } } };
        },
      }),
    );
    const adapter = new GitHubAdapter({ token: staticToken, fetch, retryPolicy: noRetry });
    await adapter.submitReview({ reviewId: REVIEW_NODE_ID, event: "REQUEST_CHANGES" });
    expect(captured).toEqual({
      pullRequestReviewId: REVIEW_NODE_ID,
      event: "REQUEST_CHANGES",
    });
  });
});

describe("listPendingReviewComments — contract", () => {
  test("paginates via the inner cursor and shapes each comment", async () => {
    let calls = 0;
    const { fetch, requests } = makeRecorder(
      graphqlRouter({
        ReviewComments: (v) => {
          calls++;
          if (calls === 1) {
            expect(v.cursor).toBeNull();
            return {
              data: {
                node: {
                  __typename: "PullRequestReview",
                  comments: {
                    pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
                    nodes: [
                      { id: "n1", databaseId: 1, path: "a.mdx", body: "b1", line: 2, startLine: null, originalLine: 2, originalStartLine: null, subjectType: "LINE", url: "u1" },
                    ],
                  },
                },
              },
            };
          }
          expect(v.cursor).toBe("cursor-1");
          return {
            data: {
              node: {
                __typename: "PullRequestReview",
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    { id: "n2", databaseId: 2, path: "b.mdx", body: "b2", line: null, startLine: null, originalLine: null, originalStartLine: null, subjectType: "FILE", url: "u2" },
                  ],
                },
              },
            },
          };
        },
      }),
    );
    const adapter = new GitHubAdapter({ token: staticToken, fetch, retryPolicy: noRetry });
    const list = await adapter.listPendingReviewComments(REVIEW_NODE_ID);
    expect(list.length).toBe(2);
    expect(list[0]!.databaseId).toBe(1);
    expect(list[1]!.subjectType).toBe("FILE");
    expect(requests.length).toBe(2);
  });
});

describe("no legacy REST comment writes (adapter must never publish a draft accidentally)", () => {
  test("every adapter mutation goes to the GraphQL endpoint, never POST /pulls/:n/comments", async () => {
    const { fetch, requests } = makeRecorder(
      graphqlRouter({
        ViewerLogin: () => ({ data: { viewer: { login: "gerchowl" } } }),
        ViewerPendingReview: () => ({
          data: { node: { __typename: "PullRequest", reviews: { nodes: [] } } },
        }),
        AddReview: () => ({
          data: {
            addPullRequestReview: {
              pullRequestReview: { id: REVIEW_NODE_ID, databaseId: 1, state: "PENDING", commit: { oid: COMMIT_OID } },
            },
          },
        }),
        AddThread: () => ({
          data: {
            addPullRequestReviewThread: {
              thread: {
                id: "PRRT",
                path: "a.mdx",
                line: 1,
                startLine: null,
                diffSide: "RIGHT",
                startDiffSide: null,
                subjectType: "LINE",
                comments: { nodes: [{ id: "c", databaseId: 42, body: "b", url: "u" }] },
              },
            },
          },
        }),
        UpdateComment: () => ({ data: { updatePullRequestReviewComment: { pullRequestReviewComment: { id: COMMENT_NODE_ID } } } }),
        DeleteComment: () => ({ data: { deletePullRequestReviewComment: { pullRequestReviewComment: { id: COMMENT_NODE_ID } } } }),
        DeleteReview: () => ({ data: { deletePullRequestReview: { pullRequestReview: { id: REVIEW_NODE_ID, state: "PENDING" } } } }),
        SubmitReview: () => ({ data: { submitPullRequestReview: { pullRequestReview: { id: REVIEW_NODE_ID, state: "COMMENTED" } } } }),
      }),
    );
    const adapter = new GitHubAdapter({ token: staticToken, fetch, retryPolicy: noRetry });

    const result = await adapter.findOrCreatePendingReview({
      pullRequestNodeId: PR_NODE_ID,
      commitOid: COMMIT_OID,
    });
    if (result.kind !== "created" && result.kind !== "reused") {
      throw new Error(`unexpected stale result in this test scenario: ${result.kind}`);
    }
    await adapter.addPendingReviewThread({
      reviewId: result.review.id,
      path: "a.mdx",
      body: "b",
      line: 1,
    });
    await adapter.updatePendingReviewComment({ commentNodeId: COMMENT_NODE_ID, body: "edited" });
    await adapter.deletePendingReviewComment({ commentNodeId: COMMENT_NODE_ID });
    await adapter.deletePendingReview({ reviewId: result.review.id });
    await adapter.submitReview({ reviewId: result.review.id, event: "COMMENT" });

    // Every single call went to the GraphQL endpoint.
    expect(requests.length).toBeGreaterThan(0);
    for (const req of requests) {
      expect(req.url).toBe(DEFAULT_GITHUB_GRAPHQL_URL);
      // Belt-and-braces: not a REST comment endpoint.
      expect(req.url).not.toContain("/pulls/");
      expect(req.url).not.toMatch(/\/comments($|\?)/);
    }
  });
});

describe("error handling and rate limits", () => {
  test("4xx (404) throws a GitHubApiError with status and parsed message", async () => {
    const { fetch } = makeRecorder(
      () =>
        new Response(
          JSON.stringify({ message: "Not Found", documentation_url: "https://docs.github.com/rest" }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
    );
    const adapter = new GitHubAdapter({ token: staticToken, fetch, retryPolicy: noRetry });
    try {
      await adapter.getPullRequest({ owner: "no", repo: "such", pullNumber: 1 });
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as { status: number; message: string; retryable: boolean; documentationUrl?: string };
      expect(e.status).toBe(404);
      expect(e.message).toContain("Not Found");
      expect(e.retryable).toBe(false);
    }
  });

  test("403 with x-ratelimit-remaining: 0 is marked retryable", async () => {
    const { fetch } = makeRecorder(
      () =>
        new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403,
          headers: { "content-type": "application/json", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "9999999999" },
        }),
    );
    const adapter = new GitHubAdapter({ token: staticToken, fetch, retryPolicy: noRetry });
    try {
      await adapter.getPullRequest({ owner: "vig-os", repo: "revkit", pullNumber: 1 });
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as { status: number; retryable: boolean };
      expect(e.status).toBe(403);
      expect(e.retryable).toBe(true);
    }
  });

  test("403 with 'secondary rate limit' body is marked retryable", async () => {
    const { fetch } = makeRecorder(
      () =>
        new Response(
          JSON.stringify({ message: "You have exceeded a secondary rate limit. Please wait a few minutes." }),
          { status: 403, headers: { "content-type": "application/json", "retry-after": "30" } },
        ),
    );
    const adapter = new GitHubAdapter({ token: staticToken, fetch, retryPolicy: noRetry });
    try {
      await adapter.getPullRequest({ owner: "vig-os", repo: "revkit", pullNumber: 1 });
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as { status: number; retryable: boolean };
      expect(e.retryable).toBe(true);
    }
  });

  test("network error before a response is a GitHubApiError with status 0", async () => {
    const throwing = async () => {
      throw new TypeError("connection refused");
    };
    (throwing as { preconnect?: (url: string) => void }).preconnect = () => {};
    const fetch = throwing as unknown as typeof globalThis.fetch;
    const adapter = new GitHubAdapter({ token: staticToken, fetch, retryPolicy: noRetry });
    try {
      await adapter.getPullRequest({ owner: "vig-os", repo: "revkit", pullNumber: 1 });
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as { status: number; message: string };
      expect(e.status).toBe(0);
      expect(e.message).toContain("connection refused");
    }
  });

  test("the token is redacted in error messages that echo it back", async () => {
    const { fetch } = makeRecorder(
      () =>
        new Response(JSON.stringify({ message: `Bad credentials for ${TOKEN}` }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    const adapter = new GitHubAdapter({ token: staticToken, fetch, retryPolicy: noRetry });
    try {
      await adapter.getPullRequest({ owner: "vig-os", repo: "revkit", pullNumber: 1 });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).not.toContain(TOKEN);
      expect((err as Error).message).toContain("<redacted:token>");
    }
  });

  test("GraphQL errors surface with the message list", async () => {
    const { fetch } = makeRecorder(() =>
      ok({ data: null, errors: [{ message: "Field 'foo' doesn't exist" }, { message: "and another one" }] }),
    );
    const adapter = new GitHubAdapter({ token: staticToken, fetch, retryPolicy: noRetry });
    await expect(
      adapter.listReviewThreads({ owner: "vig-os", repo: "revkit", pullNumber: 1 }),
    ).rejects.toThrow(/Field 'foo'.*and another one/);
  });

  test("retry loop honours Retry-After and eventually gives up", async () => {
    let attempts = 0;
    const responder = () => {
      attempts++;
      if (attempts < 3) {
        return new Response(JSON.stringify({ message: "secondary rate limit" }), {
          status: 403,
          headers: { "content-type": "application/json", "retry-after": "0" },
        });
      }
      return ok({
        number: 1,
        node_id: "PR_x",
        title: "t",
        state: "open",
        html_url: "u",
        head: { sha: "1".repeat(40), ref: "h", repo: { full_name: "o/r" } },
        base: { sha: "2".repeat(40), ref: "b", repo: { full_name: "o/r" } },
      });
    };
    const { fetch } = makeRecorder(responder);
    // Deterministic sleep — record durations but resolve immediately.
    const sleeps: number[] = [];
    const adapter = new GitHubAdapter({
      token: staticToken,
      fetch,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 50, jitterMs: 0 },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 1_000_000,
    });
    const pr = await adapter.getPullRequest({ owner: "vig-os", repo: "revkit", pullNumber: 1 });
    expect(pr.number).toBe(1);
    expect(attempts).toBe(3);
    // Two sleeps between three attempts.
    expect(sleeps.length).toBe(2);
  });

  test("retry loop stops after maxAttempts and re-throws the final error", async () => {
    let attempts = 0;
    const { fetch } = makeRecorder(() => {
      attempts++;
      return new Response(JSON.stringify({ message: "secondary rate limit" }), {
        status: 403,
        headers: { "content-type": "application/json", "retry-after": "0" },
      });
    });
    const adapter = new GitHubAdapter({
      token: staticToken,
      fetch,
      retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 5, jitterMs: 0 },
      sleep: async () => {},
    });
    await expect(
      adapter.getPullRequest({ owner: "vig-os", repo: "revkit", pullNumber: 1 }),
    ).rejects.toThrow(/secondary rate limit/);
    expect(attempts).toBe(2);
  });

  test("retry loop sleeps for exactly Retry-After (60s) on a fake clock, not baseDelay", async () => {
    // PR-43 round-3 (Blocker 4): Retry-After must actually be
    // honoured — previously extractHeaders returned empty and the
    // loop fell through to baseDelay. This test breaks if that
    // bug returns.
    let attempts = 0;
    const responder = () => {
      attempts++;
      if (attempts === 1) {
        return new Response(JSON.stringify({ message: "secondary rate limit" }), {
          status: 403,
          headers: { "content-type": "application/json", "retry-after": "60" },
        });
      }
      return ok({
        number: 1, node_id: "PR_x", title: "t", state: "open", html_url: "u",
        head: { sha: "1".repeat(40), ref: "h", repo: { full_name: "o/r" } },
        base: { sha: "2".repeat(40), ref: "b", repo: { full_name: "o/r" } },
      });
    };
    const { fetch } = makeRecorder(responder);
    const sleeps: number[] = [];
    const adapter = new GitHubAdapter({
      token: staticToken,
      fetch,
      // Base is tiny; Retry-After must win.
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 120_000, jitterMs: 0 },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await adapter.getPullRequest({ owner: "vig-os", repo: "revkit", pullNumber: 1 });
    expect(sleeps.length).toBe(1);
    // Retry-After 60 seconds → 60000 ms. Exact (no jitter).
    expect(sleeps[0]).toBe(60_000);
  });

  test("retry loop gives up with a GitHubRateLimitError when advised delay > maxDelayMs", async () => {
    // PR-43 round-3 cap check: don't sleep for minutes just
    // because the server says so.
    const { fetch } = makeRecorder(
      () =>
        new Response(JSON.stringify({ message: "secondary rate limit" }), {
          status: 403,
          headers: { "content-type": "application/json", "retry-after": "600" },
        }),
    );
    const adapter = new GitHubAdapter({
      token: staticToken,
      fetch,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 60_000, jitterMs: 0 },
      sleep: async () => {},
    });
    try {
      await adapter.getPullRequest({ owner: "vig-os", repo: "revkit", pullNumber: 1 });
      throw new Error("should have thrown");
    } catch (err) {
      // Typed error carrying the advised delay.
      expect((err as Error).name).toBe("GitHubRateLimitError");
      expect((err as { retryAfterMs: number }).retryAfterMs).toBe(600_000);
    }
  });

  test("GraphQL RATE_LIMITED error (HTTP 200) is treated as retryable", async () => {
    let attempts = 0;
    const { fetch } = makeRecorder(() => {
      attempts++;
      if (attempts === 1) {
        return ok({
          data: null,
          errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
        });
      }
      return ok({ data: { viewer: { login: "gerchowl" } } });
    });
    const adapter = new GitHubAdapter({
      token: staticToken,
      fetch,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 60_000, jitterMs: 0 },
      sleep: async () => {},
    });
    const login = await adapter.viewerLogin();
    expect(login).toBe("gerchowl");
    expect(attempts).toBe(2);
  });

  test("mutations do NOT auto-retry, even on a retryable error (idempotency safety)", async () => {
    // A retried `addPullRequestReviewThread` could double-post if
    // the first response was dropped between the server and us.
    // PR-43 round-3 Blocker 4.
    let attempts = 0;
    const { fetch } = makeRecorder((req) => {
      const body = req.body as { query: string };
      if (/mutation AddThread/.test(body.query)) {
        attempts++;
        return ok({
          data: null,
          errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
        });
      }
      return new Response("bad", { status: 500 });
    });
    const adapter = new GitHubAdapter({
      token: staticToken,
      fetch,
      // Retry ENABLED for reads; mutations must ignore it.
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 60_000, jitterMs: 0 },
      sleep: async () => {},
    });
    try {
      await adapter.addPendingReviewThread({
        reviewId: REVIEW_NODE_ID,
        path: "x.mdx",
        body: "b",
        line: 1,
      });
      throw new Error("should have thrown");
    } catch {
      // Threw — we expect exactly ONE attempt, no retry.
    }
    expect(attempts).toBe(1);
  });

  test("mutation writes never auto-retry — full pending workflow makes exactly one call per mutation", async () => {
    const calls = new Map<string, number>();
    const { fetch } = makeRecorder(
      graphqlRouter({
        ViewerLogin: () => {
          calls.set("ViewerLogin", (calls.get("ViewerLogin") ?? 0) + 1);
          return { data: { viewer: { login: "gerchowl" } } };
        },
        ViewerPendingReview: () => {
          calls.set("ViewerPendingReview", (calls.get("ViewerPendingReview") ?? 0) + 1);
          return { data: { node: { __typename: "PullRequest", reviews: { nodes: [] } } } };
        },
        AddReview: () => {
          calls.set("AddReview", (calls.get("AddReview") ?? 0) + 1);
          return {
            data: {
              addPullRequestReview: {
                pullRequestReview: { id: REVIEW_NODE_ID, databaseId: 1, state: "PENDING", commit: { oid: COMMIT_OID } },
              },
            },
          };
        },
        AddThread: () => {
          calls.set("AddThread", (calls.get("AddThread") ?? 0) + 1);
          return {
            data: {
              addPullRequestReviewThread: {
                thread: {
                  id: "PRRT",
                  path: "a.mdx",
                  line: 1,
                  startLine: null,
                  diffSide: "RIGHT",
                  startDiffSide: null,
                  subjectType: "LINE",
                  comments: { nodes: [{ id: "c", databaseId: 42, body: "b", url: "u" }] },
                },
              },
            },
          };
        },
        SubmitReview: () => {
          calls.set("SubmitReview", (calls.get("SubmitReview") ?? 0) + 1);
          return { data: { submitPullRequestReview: { pullRequestReview: { id: REVIEW_NODE_ID, state: "COMMENTED" } } } };
        },
      }),
    );
    // Retries enabled; only reads should ever use them.
    const adapter = new GitHubAdapter({
      token: staticToken,
      fetch,
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 100, jitterMs: 0 },
      sleep: async () => {},
    });
    const result = await adapter.findOrCreatePendingReview({
      pullRequestNodeId: PR_NODE_ID,
      commitOid: COMMIT_OID,
    });
    if (result.kind !== "created") throw new Error("expected created");
    await adapter.addPendingReviewThread({ reviewId: result.review.id, path: "a.mdx", body: "b", line: 1 });
    await adapter.submitReview({ reviewId: result.review.id, event: "COMMENT" });
    // Each mutation fired exactly once.
    expect(calls.get("AddReview")).toBe(1);
    expect(calls.get("AddThread")).toBe(1);
    expect(calls.get("SubmitReview")).toBe(1);
  });
});
