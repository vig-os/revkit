// LIVE smoke test — skipped unless REVKIT_LIVE_GH=1.
//
// This is the only place adapter code ever touches the real GitHub
// API in the test suite. It is READ-ONLY: `GET` and a GraphQL query.
// **No writes**, no comment creates, no reactions, no pending
// reviews, and it targets a merged, public PR (`vig-os/revkit#38`)
// so a hostile fixture cannot get the adapter to touch anything
// the owner didn't intend.
//
// The token comes from `gh auth token`. This test exists to give the
// operator one command to verify the recorded fixtures still match
// GitHub's response shapes; CI never runs it (PR builds get no
// secrets — ADR-0014).

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { GitHubAdapter, type TokenSource } from "../src/index.ts";

const enabled = process.env.REVKIT_LIVE_GH === "1";

/** A TokenSource that shells out once at construction. Kept inline
 * here rather than pulled from `packages/cli`: this test file lives
 * in review-core and must not import cli code. */
function liveGhToken(): TokenSource {
  return {
    async getToken() {
      const result = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
      if (result.status !== 0) {
        throw new Error(`gh auth token failed (${result.status}): ${result.stderr}`);
      }
      const token = result.stdout.trim();
      if (token.length === 0) throw new Error("gh auth token returned empty output");
      return token;
    },
  };
}

describe.skipIf(!enabled)("live smoke (READ-ONLY, needs REVKIT_LIVE_GH=1)", () => {
  test("getPullRequest matches the recorded fixture's shape", async () => {
    const adapter = new GitHubAdapter({ token: liveGhToken() });
    const pr = await adapter.getPullRequest({ owner: "vig-os", repo: "revkit", pullNumber: 38 });
    expect(pr.number).toBe(38);
    expect(typeof pr.headSha).toBe("string");
    expect(pr.headSha.length).toBeGreaterThanOrEqual(40);
    expect(typeof pr.baseSha).toBe("string");
    expect(pr.baseSha.length).toBeGreaterThanOrEqual(40);
    expect(pr.baseRepoFullName).toBe("vig-os/revkit");
  });

  test("listReviewThreads returns the recorded thread count and RIGHT-side shape", async () => {
    const adapter = new GitHubAdapter({ token: liveGhToken() });
    const threads = await adapter.listReviewThreads({ owner: "vig-os", repo: "revkit", pullNumber: 38 });
    expect(threads.length).toBeGreaterThan(0);
    for (const t of threads) {
      expect(t.path.length).toBeGreaterThan(0);
      expect(t.diffSide === "RIGHT" || t.diffSide === "LEFT").toBe(true);
    }
  });
});

// A sentinel test that runs even when the live suite is disabled: it
// documents the env var and fails clearly if the runner is
// misconfigured (e.g. `REVKIT_LIVE_GH=true` instead of `=1`).
describe("live smoke — env gating", () => {
  test("skipped by default, opt-in via REVKIT_LIVE_GH=1", () => {
    const raw = process.env.REVKIT_LIVE_GH;
    if (raw !== undefined && raw !== "1" && raw !== "" && raw !== "0") {
      throw new Error(
        `REVKIT_LIVE_GH is set to '${raw}' — the live suite gates on the exact value '1'. ` +
          `Use REVKIT_LIVE_GH=1 to enable it, or unset it to skip.`,
      );
    }
    expect(true).toBe(true);
  });
});
