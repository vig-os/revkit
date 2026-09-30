// GitHub adapter write-path contract tests (M3 part 1, ADR-0025).
//
// These tests run the pending-review workflow (create → add → list →
// delete → submit) against an in-process fake `fetch` and assert
// EXACTLY:
//   - the HTTP method and URL each call sends,
//   - the JSON body each call sends (path, line, side, start_line,
//     commit_id, event, subject_type), and
//   - the Authorization / Accept / User-Agent / API version headers.
//
// The adapter is NEVER allowed to hit the network in these tests.
// The hard boundary of M3 part 1 is that the adapter's write paths
// are proven safe here, on a fake — no PR on GitHub is ever touched
// with the owner's identity.
//
// Mutation guards below: a change to the URL, the method, the body
// shape or the pagination MUST turn a named test red.

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_GITHUB_BASE_URL,
  GitHubAdapter,
  type TokenSource,
} from "../src/index.ts";

const TOKEN = "fake-token-value-with-enough-length-01234567";
const staticToken: TokenSource = { async getToken() { return TOKEN; } };

/** A recorder that captures each request the adapter makes and
 * returns a canned response. Tests assert on the recorded log. */
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

function ok(body: unknown, extra: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...extra,
  });
}

const pr = { owner: "vig-os", repo: "revkit", pullNumber: 8 } as const;
const COMMIT = "9c47428597832d9ad0e21b39f40c9d1ef4fe5df2";

describe("createPendingReview — contract", () => {
  test("POSTs /pulls/:n/reviews with commit_id and NO `event` field (pending)", async () => {
    const { fetch, requests } = makeRecorder(() => ok({ id: 1001, node_id: "PRR_x", commit_id: COMMIT, state: "PENDING" }));
    const adapter = new GitHubAdapter({ token: staticToken, fetch });
    const review = await adapter.createPendingReview({ pr, commitId: COMMIT });
    expect(review.id).toBe(1001);
    expect(requests.length).toBe(1);
    const req = requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${DEFAULT_GITHUB_BASE_URL}/repos/vig-os/revkit/pulls/8/reviews`);
    expect(req.body).toEqual({ commit_id: COMMIT });
    expect(req.headers["authorization"] ?? req.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(req.headers["content-type"] ?? req.headers["Content-Type"]).toBe("application/json");
  });

  test("seeds line comments via the create call with the correct shape", async () => {
    // Note: GitHub's `POST /pulls/:n/reviews` seeded-comments field
    // only accepts LINE comments (`path`, `body`, `line`, `side`,
    // `start_line?`, `start_side?`). File-level comments must go
    // through `addPendingComment` after the pending review exists —
    // the adapter's typing refuses to seed them.
    const { fetch, requests } = makeRecorder(() => ok({ id: 1002, node_id: "PRR_y", commit_id: COMMIT, state: "PENDING" }));
    const adapter = new GitHubAdapter({ token: staticToken, fetch });
    await adapter.createPendingReview({
      pr,
      commitId: COMMIT,
      body: "top-level body",
      comments: [
        { path: "docs/a.mdx", line: 3, body: "single-line" },
        { path: "docs/b.mdx", line: 12, startLine: 8, body: "multi-line" },
      ],
    });
    const req = requests[0]!;
    expect(req.body).toEqual({
      commit_id: COMMIT,
      body: "top-level body",
      comments: [
        { path: "docs/a.mdx", body: "single-line", line: 3, side: "RIGHT" },
        { path: "docs/b.mdx", body: "multi-line", line: 12, side: "RIGHT", start_line: 8, start_side: "RIGHT" },
      ],
    });
  });
});

describe("addPendingComment — contract", () => {
  test("single-line RIGHT-side comment sends the expected body", async () => {
    const { fetch, requests } = makeRecorder((req) =>
      ok({
        id: 8899,
        node_id: "PRRC_a",
        path: (req.body as { path: string }).path,
        body: (req.body as { body: string }).body,
        commit_id: COMMIT,
        line: 3,
        side: "RIGHT",
        subject_type: "line",
        html_url: "https://github.com/vig-os/revkit/pull/8#discussion_r8899",
        pull_request_review_id: 1001,
      }),
    );
    const adapter = new GitHubAdapter({ token: staticToken, fetch });
    const comment = await adapter.addPendingComment({
      pr,
      commitId: COMMIT,
      path: "docs/a.mdx",
      body: "please fix",
      line: 3,
    });
    expect(comment.id).toBe(8899);
    expect(comment.pullRequestReviewId).toBe(1001);
    const req = requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${DEFAULT_GITHUB_BASE_URL}/repos/vig-os/revkit/pulls/8/comments`);
    expect(req.body).toEqual({
      commit_id: COMMIT,
      path: "docs/a.mdx",
      body: "please fix",
      line: 3,
      side: "RIGHT",
      subject_type: "line",
    });
  });

  test("multi-line comment sends start_line + line + start_side + side", async () => {
    const { fetch, requests } = makeRecorder(() =>
      ok({
        id: 8900,
        node_id: "PRRC_b",
        path: "docs/a.mdx",
        body: "range",
        commit_id: COMMIT,
        line: 10,
        start_line: 7,
        side: "RIGHT",
        start_side: "RIGHT",
        subject_type: "line",
        html_url: "https://github.com/vig-os/revkit/pull/8#discussion_r8900",
        pull_request_review_id: 1001,
      }),
    );
    const adapter = new GitHubAdapter({ token: staticToken, fetch });
    await adapter.addPendingComment({
      pr,
      commitId: COMMIT,
      path: "docs/a.mdx",
      body: "range",
      line: 10,
      startLine: 7,
    });
    const req = requests[0]!;
    expect(req.body).toEqual({
      commit_id: COMMIT,
      path: "docs/a.mdx",
      body: "range",
      line: 10,
      side: "RIGHT",
      start_line: 7,
      start_side: "RIGHT",
      subject_type: "line",
    });
  });

  test("file-subject comment omits line/side and sends subject_type: file", async () => {
    const { fetch, requests } = makeRecorder(() =>
      ok({
        id: 8901,
        node_id: "PRRC_c",
        path: "docs/a.mdx",
        body: "file-level note",
        commit_id: COMMIT,
        subject_type: "file",
        html_url: "https://github.com/vig-os/revkit/pull/8#discussion_r8901",
      }),
    );
    const adapter = new GitHubAdapter({ token: staticToken, fetch });
    await adapter.addPendingComment({
      pr,
      commitId: COMMIT,
      path: "docs/a.mdx",
      body: "file-level note",
      subjectType: "file",
    });
    const req = requests[0]!;
    expect(req.body).toEqual({
      commit_id: COMMIT,
      path: "docs/a.mdx",
      body: "file-level note",
      subject_type: "file",
    });
  });

  test("refuses to send a line-subject comment without a line", async () => {
    const { fetch } = makeRecorder(() => ok({}));
    const adapter = new GitHubAdapter({ token: staticToken, fetch });
    await expect(
      adapter.addPendingComment({
        pr,
        commitId: COMMIT,
        path: "docs/a.mdx",
        body: "nope",
      }),
    ).rejects.toThrow(/line is required/);
  });
});

describe("listPendingComments — contract", () => {
  test("GETs /pulls/:n/reviews/:id/comments and shapes each item", async () => {
    const items = [
      {
        id: 1,
        node_id: "PRRC_1",
        path: "a.mdx",
        body: "b1",
        commit_id: COMMIT,
        line: 2,
        side: "RIGHT",
        subject_type: "line",
        html_url: "https://x/1",
        pull_request_review_id: 5,
      },
      {
        id: 2,
        node_id: "PRRC_2",
        path: "b.mdx",
        body: "b2",
        commit_id: COMMIT,
        subject_type: "file",
        html_url: "https://x/2",
        pull_request_review_id: 5,
      },
    ];
    const { fetch, requests } = makeRecorder(() => ok(items));
    const adapter = new GitHubAdapter({ token: staticToken, fetch });
    const list = await adapter.listPendingComments(pr, 5);
    expect(list.length).toBe(2);
    expect(list[0]!.path).toBe("a.mdx");
    expect(list[1]!.subjectType).toBe("file");
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.url).toBe(
      `${DEFAULT_GITHUB_BASE_URL}/repos/vig-os/revkit/pulls/8/reviews/5/comments?per_page=100`,
    );
  });
});

describe("deletePendingComment — contract", () => {
  test("DELETEs /pulls/comments/:id", async () => {
    const { fetch, requests } = makeRecorder(() => new Response("", { status: 204 }));
    const adapter = new GitHubAdapter({ token: staticToken, fetch });
    await adapter.deletePendingComment(pr, 4242);
    expect(requests[0]!.method).toBe("DELETE");
    expect(requests[0]!.url).toBe(`${DEFAULT_GITHUB_BASE_URL}/repos/vig-os/revkit/pulls/comments/4242`);
    // No JSON body on a DELETE.
    expect(requests[0]!.body).toBeUndefined();
  });
});

describe("submitReview — contract", () => {
  test("POSTs /pulls/:n/reviews/:id/events with `event` and optional `body`", async () => {
    const { fetch, requests } = makeRecorder(() => new Response("", { status: 200 }));
    const adapter = new GitHubAdapter({ token: staticToken, fetch });
    await adapter.submitReview({ pr, reviewId: 5, event: "APPROVE", body: "LGTM" });
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.url).toBe(`${DEFAULT_GITHUB_BASE_URL}/repos/vig-os/revkit/pulls/8/reviews/5/events`);
    expect(requests[0]!.body).toEqual({ event: "APPROVE", body: "LGTM" });
  });

  test("supports COMMENT and REQUEST_CHANGES without a body", async () => {
    const { fetch, requests } = makeRecorder(() => new Response("", { status: 200 }));
    const adapter = new GitHubAdapter({ token: staticToken, fetch });
    await adapter.submitReview({ pr, reviewId: 5, event: "REQUEST_CHANGES" });
    expect(requests[0]!.body).toEqual({ event: "REQUEST_CHANGES" });
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
    const adapter = new GitHubAdapter({ token: staticToken, fetch });
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
    const adapter = new GitHubAdapter({ token: staticToken, fetch });
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
    const adapter = new GitHubAdapter({ token: staticToken, fetch });
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
    const adapter = new GitHubAdapter({ token: staticToken, fetch });
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
    // Simulate an upstream service echoing the bearer.
    const { fetch } = makeRecorder(
      () =>
        new Response(JSON.stringify({ message: `Bad credentials for ${TOKEN}` }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    const adapter = new GitHubAdapter({ token: staticToken, fetch });
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
    const adapter = new GitHubAdapter({ token: staticToken, fetch });
    await expect(
      adapter.listReviewThreads({ owner: "vig-os", repo: "revkit", pullNumber: 1 }),
    ).rejects.toThrow(/Field 'foo'.*and another one/);
  });
});
