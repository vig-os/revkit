// A minimal fake-GitHub `fetch` used by the review CLI tests. Every
// route the review command touches is mocked here; a route the
// adapter reaches that we haven't wired throws so a code change that
// adds a call has to add a route (never silently receives an
// unmocked response).
//
// **The fake refuses all WRITES** by design. `revkit review <pr>` in
// M3 part 2a does no writes (write paths are part 2b), but the
// safety story says "live GitHub calls may only be GET / query /
// introspection". The fake throws on any POST that isn't a GraphQL
// query.

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

/** Build a `fetch`-shaped stub the adapter can be fed. */
export function makeFakeGithubFetch(prs: readonly FakePr[]): typeof fetch {
  const byNumber = new Map<string, FakePr>();
  for (const pr of prs) byNumber.set(`${pr.owner}/${pr.repo}/${pr.pullNumber}`, pr);

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
      // Route on distinctive substrings of the query shape the
      // adapter sends. The exact GraphQL bodies live in
      // review-core; a substring match keeps this fake resilient
      // against a whitespace tweak.
      if (query.includes("reviewThreads(")) {
        const owner = body.variables?.owner as string | undefined;
        const name = body.variables?.name as string | undefined;
        const num = body.variables?.number as number | undefined;
        const pr = byNumber.get(`${owner}/${name}/${num}`);
        return jsonResponse(threadsGraphqlBody(pr?.threads ?? []));
      }
      if (query.includes("repository(") && query.includes("object(expression")) {
        // fetchBlobText — we don't need a real answer for the
        // tests that populate empty threads.
        return jsonResponse({ data: { repository: { object: null } } });
      }
      return jsonResponse({ data: {} });
    }

    // Any other write path: refuse. The review command in 2a
    // must NEVER hit GitHub as a writer.
    if (method !== "GET") {
      throw new Error(`fake github: refusing write call ${method} ${url}`);
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
