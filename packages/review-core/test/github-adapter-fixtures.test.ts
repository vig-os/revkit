// GitHub adapter tests over RECORDED fixtures (M3 part 1).
//
// Fixtures live under `test/fixtures/github/` and were captured from
// public read-only calls to `vig-os/revkit` with `gh api`, then
// scrubbed. See `test/fixtures/github/README.md`.
//
// The adapter is exercised via an injected `fetch` that matches the
// requested URL against a small route table and returns the fixture
// body as a `Response`. No network in these tests.
//
// The fixtures are the read paths (GET/POST-graphql). The write paths
// are covered by `github-adapter-writes.test.ts` against a fake
// server that asserts on exact request bodies.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_GITHUB_BASE_URL,
  DEFAULT_GITHUB_GRAPHQL_URL,
  GitHubAdapter,
  type TokenSource,
} from "../src/index.ts";

const FIXTURES_DIR = new URL("./fixtures/github/", import.meta.url).pathname;
const PR38_PULL = JSON.parse(readFileSync(join(FIXTURES_DIR, "pr-38-pull.json"), "utf8"));
const PR38_FILES = JSON.parse(readFileSync(join(FIXTURES_DIR, "pr-38-files.json"), "utf8")) as Array<{
  filename: string;
  patch?: string;
  status?: string;
  previous_filename?: string;
}>;
const PR38_THREADS = JSON.parse(readFileSync(join(FIXTURES_DIR, "pr-38-review-threads.json"), "utf8"));

/** A fixed-token source so tests don't need Bun's env. */
const staticToken: TokenSource = { async getToken() { return "test-token-value-with-enough-length-01234567"; } };

/** Build a `fetch`-shaped stub that answers based on the request URL
 * and method. Any unmatched request throws — this is intentional so a
 * new adapter call must add a route and can never silently fall
 * through to a canned response for another endpoint. */
function makeFetch(routes: Record<string, (init: RequestInit) => Response>): typeof fetch {
  const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    const key = `${method} ${url}`;
    const handler = routes[key];
    if (handler === undefined) {
      throw new Error(`stub fetch: no route for ${key}`);
    }
    return handler(init);
  };
  // Bun's `fetch` type includes a `preconnect` method (a no-op hint).
  // The adapter never calls it; attach a stub so the assignment
  // typechecks.
  (fn as { preconnect?: (url: string) => void }).preconnect = () => {};
  return fn as unknown as typeof fetch;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("GitHubAdapter over fixtures — getPullRequest", () => {
  test("reads head/base SHAs and metadata from a recorded PR response", async () => {
    const routes = {
      [`GET ${DEFAULT_GITHUB_BASE_URL}/repos/vig-os/revkit/pulls/38`]: () => json(PR38_PULL),
    };
    const adapter = new GitHubAdapter({ token: staticToken, fetch: makeFetch(routes) });
    const pr = await adapter.getPullRequest({ owner: "vig-os", repo: "revkit", pullNumber: 38 });
    expect(pr.number).toBe(38);
    expect(pr.headSha).toBe("9c47428597832d9ad0e21b39f40c9d1ef4fe5df2");
    expect(pr.baseSha).toBe("6b3e54057ffc52b304e56a28402b37411b4469b2");
    expect(pr.state).toBe("closed");
    expect(pr.draft).toBe(false);
    expect(pr.baseRepoFullName).toBe("vig-os/revkit");
    expect(pr.headRepoFullName).toBe("vig-os/revkit");
  });
});

describe("GitHubAdapter over fixtures — listPullRequestFiles", () => {
  test("returns files with patch, status, and preserves rename hints when present", async () => {
    // One page — end of pagination has no Link: rel="next".
    const routes = {
      [`GET ${DEFAULT_GITHUB_BASE_URL}/repos/vig-os/revkit/pulls/38/files?per_page=100`]: () =>
        json(PR38_FILES),
    };
    const adapter = new GitHubAdapter({ token: staticToken, fetch: makeFetch(routes) });
    const files = await adapter.listPullRequestFiles({ owner: "vig-os", repo: "revkit", pullNumber: 38 });
    expect(files.length).toBe(PR38_FILES.length);
    // Files with a patch keep it.
    const someMdxLike = files.find((f) => f.patch !== undefined && f.patch.length > 100);
    expect(someMdxLike).toBeDefined();
    // Files with an "added" status carry it through.
    expect(files.some((f) => f.status === "added")).toBe(true);
  });

  test("follows Link: rel=\"next\" across multiple pages", async () => {
    // Split the fixture into two pages: first 3 files, then the rest.
    const page1 = PR38_FILES.slice(0, 3);
    const page2 = PR38_FILES.slice(3);
    const page2Url = `${DEFAULT_GITHUB_BASE_URL}/repositories/1/pulls/38/files?page=2&per_page=100`;
    const routes: Record<string, (init: RequestInit) => Response> = {
      [`GET ${DEFAULT_GITHUB_BASE_URL}/repos/vig-os/revkit/pulls/38/files?per_page=100`]: () =>
        new Response(JSON.stringify(page1), {
          status: 200,
          headers: {
            "content-type": "application/json",
            link: `<${page2Url}>; rel="next", <...>; rel="last"`,
          },
        }),
      [`GET ${page2Url}`]: () => json(page2),
    };
    const adapter = new GitHubAdapter({ token: staticToken, fetch: makeFetch(routes) });
    const files = await adapter.listPullRequestFiles({ owner: "vig-os", repo: "revkit", pullNumber: 38 });
    expect(files.length).toBe(PR38_FILES.length);
  });

  test("stops paginating and throws when maxFilesPages is hit", async () => {
    const nextUrl = `${DEFAULT_GITHUB_BASE_URL}/repositories/1/pulls/38/files?page=2&per_page=100`;
    const looping: Record<string, (init: RequestInit) => Response> = {};
    looping[`GET ${DEFAULT_GITHUB_BASE_URL}/repos/vig-os/revkit/pulls/38/files?per_page=100`] = () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json", link: `<${nextUrl}>; rel="next"` },
      });
    looping[`GET ${nextUrl}`] = () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json", link: `<${nextUrl}>; rel="next"` },
      });
    const adapter = new GitHubAdapter({
      token: staticToken,
      fetch: makeFetch(looping),
      maxFilesPages: 2,
    });
    await expect(
      adapter.listPullRequestFiles({ owner: "vig-os", repo: "revkit", pullNumber: 38 }),
    ).rejects.toThrow(/maxFilesPages/);
  });
});

describe("GitHubAdapter over fixtures — listReviewThreads (GraphQL)", () => {
  test("shapes real GraphQL response into GhReviewThread with resolved / outdated / originalLine", async () => {
    const routes = {
      [`POST ${DEFAULT_GITHUB_GRAPHQL_URL}`]: () => json(PR38_THREADS),
    };
    const adapter = new GitHubAdapter({ token: staticToken, fetch: makeFetch(routes) });
    const threads = await adapter.listReviewThreads({ owner: "vig-os", repo: "revkit", pullNumber: 38 });
    expect(threads.length).toBe(4);
    for (const t of threads) {
      expect(t.isResolved).toBe(true);
      expect(t.isOutdated).toBe(true);
      // Outdated threads carry a null `line` but an `originalLine`.
      expect(t.line).toBeNull();
      expect(typeof t.originalLine).toBe("number");
      expect(t.diffSide).toBe("RIGHT");
      expect(t.comments.length).toBeGreaterThan(0);
      // The new query captures subjectType and resolvedBy.
      expect(t.subjectType).toBe("LINE");
      expect(t.resolvedByLogin).not.toBeNull();
    }
    // Bot-authored comments carry an authorType of `Bot`.
    const bot = threads.find((t) =>
      t.comments.some((c) => c.authorLogin === "github-advanced-security"),
    );
    expect(bot).toBeDefined();
    expect(bot!.comments[0]!.authorType).toBe("Bot");
  });

  test("paginates the inner comments connection when a thread has more than one page", async () => {
    // Mutation guard: if the inner cursor is not advanced (e.g. a
    // future edit accidentally passes null on every follow-up
    // request), the fake here refuses the second request. Also
    // catches "stop after page 1" — the second page is dropped,
    // so the assertion on comment count goes red.
    const seenCursors: (string | null)[] = [];
    let threadPage = 0;
    const routes: Record<string, (init: RequestInit) => Response> = {
      [`POST ${DEFAULT_GITHUB_GRAPHQL_URL}`]: (init) => {
        const body = JSON.parse((init as { body: string }).body) as {
          query: string;
          variables: { cursor?: string | null; threadId?: string };
        };
        if (/query ReviewThreads/.test(body.query)) {
          threadPage++;
          if (threadPage > 1) return json({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } });
          return json({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: "PRRT_paged",
                        path: "file.mdx",
                        isResolved: false,
                        isOutdated: false,
                        line: 3,
                        startLine: null,
                        originalLine: 3,
                        originalStartLine: null,
                        diffSide: "RIGHT",
                        startDiffSide: null,
                        subjectType: "LINE",
                        resolvedBy: null,
                        comments: {
                          pageInfo: { hasNextPage: true, endCursor: "cursor-A" },
                          nodes: [
                            {
                              id: "c1",
                              databaseId: 1,
                              body: "first",
                              createdAt: "t1",
                              url: "u1",
                              author: { login: "alice", __typename: "User" },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          });
        }
        // Inner ThreadComments query.
        seenCursors.push(body.variables.cursor ?? null);
        if (body.variables.cursor === "cursor-A") {
          return json({
            data: {
              node: {
                __typename: "PullRequestReviewThread",
                comments: {
                  pageInfo: { hasNextPage: true, endCursor: "cursor-B" },
                  nodes: [
                    { id: "c2", databaseId: 2, body: "second", createdAt: "t2", url: "u2", author: { login: "bob", __typename: "User" } },
                  ],
                },
              },
            },
          });
        }
        if (body.variables.cursor === "cursor-B") {
          return json({
            data: {
              node: {
                __typename: "PullRequestReviewThread",
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    { id: "c3", databaseId: 3, body: "third", createdAt: "t3", url: "u3", author: { login: "carol", __typename: "User" } },
                  ],
                },
              },
            },
          });
        }
        return new Response("bad cursor", { status: 500 });
      },
    };
    const adapter = new GitHubAdapter({ token: staticToken, fetch: makeFetch(routes), retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 } });
    const threads = await adapter.listReviewThreads({ owner: "vig-os", repo: "revkit", pullNumber: 999 });
    expect(threads.length).toBe(1);
    // 1 (initial) + 2 (paginated) = 3 comments.
    expect(threads[0]!.comments.length).toBe(3);
    expect(threads[0]!.comments.map((c) => c.databaseId)).toEqual([1, 2, 3]);
    // Cursor advanced from A → B, not stuck.
    expect(seenCursors).toEqual(["cursor-A", "cursor-B"]);
  });
});

describe("GitHubAdapter — request headers", () => {
  test("sends Authorization, Accept, User-Agent and X-GitHub-Api-Version on every REST call", async () => {
    let capturedInit: RequestInit | undefined;
    const routes = {
      [`GET ${DEFAULT_GITHUB_BASE_URL}/repos/vig-os/revkit/pulls/38`]: (init: RequestInit) => {
        capturedInit = init;
        return json(PR38_PULL);
      },
    };
    const adapter = new GitHubAdapter({ token: staticToken, fetch: makeFetch(routes) });
    await adapter.getPullRequest({ owner: "vig-os", repo: "revkit", pullNumber: 38 });
    const headers = capturedInit!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-token-value-with-enough-length-01234567");
    expect(headers["Accept"]).toBe("application/vnd.github+json");
    expect(headers["User-Agent"]).toContain("revkit");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });

  test("uses the injected userAgent when provided", async () => {
    let capturedInit: RequestInit | undefined;
    const routes = {
      [`GET ${DEFAULT_GITHUB_BASE_URL}/repos/vig-os/revkit/pulls/38`]: (init: RequestInit) => {
        capturedInit = init;
        return json(PR38_PULL);
      },
    };
    const adapter = new GitHubAdapter({
      token: staticToken,
      fetch: makeFetch(routes),
      userAgent: "revkit-test/1.2",
    });
    await adapter.getPullRequest({ owner: "vig-os", repo: "revkit", pullNumber: 38 });
    expect((capturedInit!.headers as Record<string, string>)["User-Agent"]).toBe("revkit-test/1.2");
  });
});
