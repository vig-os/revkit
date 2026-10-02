// The fake GitHub server enforces the same semantics the real
// GitHub does at the mutations we hit:
//   - Single PENDING review per (viewer, PR); a second AddReview
//     while one exists errors (probe P1).
//   - AddThread against a not-currently-pending reviewId errors
//     (probe P2).
//   - AddReviewThreadReply pinned to a non-pending reviewId
//     errors (probe P3).
//   - SubmitReview against an already-submitted reviewId errors
//     (probe P4).
//   - DeleteReview against an already-terminal reviewId errors.
//
// Every real-GitHub write path the adapter uses is validated
// against the committed GraphQL schema fixture by
// `packages/review-core/test/graphql-schema.test.ts`. This file
// asserts the SEMANTIC invariants on top: the fake enforces them,
// so a review-mode test that would silently drift on the real
// GitHub gets caught locally.

import { describe, expect, test } from "bun:test";
import { GitHubAdapter, type TokenSource } from "@revkit/review-core";
import { makeFakeGithubFetch, makePendingState } from "./fake-github.ts";

const staticToken: TokenSource = { async getToken() { return "ghp_" + "a".repeat(40); } };

async function expectGraphqlError(fn: () => Promise<unknown>, matchers: readonly string[]): Promise<void> {
  let err: Error | undefined;
  try {
    await fn();
  } catch (e) {
    err = e as Error;
  }
  expect(err).toBeDefined();
  if (err === undefined) return;
  const lower = err.message.toLowerCase();
  const hit = matchers.some((m) => lower.includes(m.toLowerCase()));
  if (!hit) {
    throw new Error(`expected error to include one of ${JSON.stringify(matchers)}, got: ${err.message}`);
  }
}

describe("fake GitHub — real-semantic invariants", () => {
  test("probe P1: a second AddReview while one is pending errors", async () => {
    const pending = makePendingState();
    const fetchFn = makeFakeGithubFetch([], { pendingState: pending });
    const adapter = new GitHubAdapter({ token: staticToken, fetch: fetchFn });
    // First AddReview succeeds.
    await adapter.graphql(
      "mutation AddReview($pullRequestId: ID!, $commitOID: GitObjectID) { addPullRequestReview(input: { pullRequestId: $pullRequestId, commitOID: $commitOID }) { pullRequestReview { id state } } }",
      { pullRequestId: "PR_42", commitOID: "0".repeat(40) },
    );
    expect(pending.reviewNodeId).not.toBeNull();
    // Second AddReview errors.
    await expectGraphqlError(
      () =>
        adapter.graphql(
          "mutation AddReview($pullRequestId: ID!, $commitOID: GitObjectID) { addPullRequestReview(input: { pullRequestId: $pullRequestId, commitOID: $commitOID }) { pullRequestReview { id state } } }",
          { pullRequestId: "PR_42", commitOID: "1".repeat(40) },
        ),
      ['pending review already exists'],
    );
  });

  test("probe P2: AddThread against a non-pending reviewId errors", async () => {
    const pending = makePendingState();
    const fetchFn = makeFakeGithubFetch([], { pendingState: pending });
    const adapter = new GitHubAdapter({ token: staticToken, fetch: fetchFn });
    await expectGraphqlError(
      () =>
        adapter.addPendingReviewThread({
          reviewId: "PR_unknown",
          path: "docs/index.md",
          body: "should fail",
          line: 1,
        }),
      ['not pending','not in the pending','not_found'],
    );
  });

  test("probe P3: AddReviewThreadReply pinned to a non-pending review errors", async () => {
    const pending = makePendingState();
    const fetchFn = makeFakeGithubFetch([], { pendingState: pending });
    const adapter = new GitHubAdapter({ token: staticToken, fetch: fetchFn });
    await expectGraphqlError(
      () =>
        adapter.addReviewThreadReply({
          threadNodeId: "PRT_1",
          body: "reply on nothing",
          pendingReviewId: "PR_unknown",
        }),
      ['not pending','not in the pending','not_found'],
    );
  });

  test("probe P4: re-submit of a submitted review errors", async () => {
    const pending = makePendingState();
    const fetchFn = makeFakeGithubFetch([], { pendingState: pending });
    const adapter = new GitHubAdapter({ token: staticToken, fetch: fetchFn });
    // Open + submit.
    const opened = await adapter.findOrCreatePendingReview({
      pullRequestNodeId: "PR_42",
      commitOid: "0".repeat(40),
      viewerLogin: "test-reviewer",
    });
    if (opened.kind === "stale") throw new Error("unexpected stale");
    const reviewId = opened.review.id;
    await adapter.submitReview({ reviewId, event: "COMMENT" });
    // Re-submit fails.
    await expectGraphqlError(
      () => adapter.submitReview({ reviewId, event: "COMMENT" }),
      ['not pending','not in the pending','not_found'],
    );
  });

  test("delete of a non-pending reviewId errors", async () => {
    const pending = makePendingState();
    const fetchFn = makeFakeGithubFetch([], { pendingState: pending });
    const adapter = new GitHubAdapter({ token: staticToken, fetch: fetchFn });
    await expectGraphqlError(
      () => adapter.deletePendingReview({ reviewId: "PR_ghost" }),
      ['not pending','not in the pending','not_found'],
    );
  });
});
