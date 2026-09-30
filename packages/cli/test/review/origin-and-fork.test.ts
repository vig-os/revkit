// Gates that fail closed on a deleted fork or an origin/remote
// mismatch (PR #48 round-2 blocker 4). These test the SHIPPING
// `runReviewCommand` — a mutation that flipped the fail-open
// branch (`headRepoFullName === null → skip fork check`) fails
// its assertion here.

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { GitHubAdapter } from "@revkit/review-core";
import { runReviewCommand } from "../../src/review/cli.ts";
import { spawnGit } from "../../src/git-runner.ts";
import { makeFakeGithubFetch, type FakePr } from "./helpers/fake-github.ts";
import { makeFixtureRepo, MIN_VOCAB_YAML } from "./helpers/git-fixture.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* fine */
    }
  }
});

describe("deleted-fork PR fails closed", async () => {
  const fixture = await makeFixtureRepo({
    base: {
      message: "base",
      files: [
        { kind: "file", path: "package.json", content: JSON.stringify({ name: "revkit", private: true }) },
        { kind: "file", path: "docs/index.md", content: "# base\n" },
        MIN_VOCAB_YAML,
      ],
    },
    head: {
      message: "PR (fork now deleted)",
      files: [{ kind: "file", path: "docs/index.md", content: "# pr\n" }],
    },
  });
  dirs.push(fixture.repoDir);

  const pr: FakePr = {
    owner: "vig-os",
    repo: "revkit",
    pullNumber: 800,
    nodeId: "PR_8",
    title: "orphaned fork",
    state: "open",
    headSha: fixture.headSha,
    headRef: "pr",
    baseSha: fixture.baseSha,
    baseRef: "main",
    // Distinguishing bit: fork repo deleted → GitHub returns null.
    headRepoFullName: null,
    baseRepoFullName: "vig-os/revkit",
    url: "https://github.com/vig-os/revkit/pull/800",
  };

  test("null headRepoFullName is refused without --trust (fail-closed)", async () => {
    const staticToken = { async getToken() { return "ghp_" + "a".repeat(40); } };
    const result = await runReviewCommand(["800", "--no-serve"], {
      cwd: fixture.repoDir,
      version: "0.0.0",
      gh: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      git: spawnGit,
      repoSlug: "vig-os/revkit",
      makeAdapter: () => new GitHubAdapter({ token: staticToken, fetch: makeFakeGithubFetch([pr]) }),
      localUserId: "origin-fork-test",
      _skipCheckDist: true,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("fork");
    expect(result.stderr).toContain("<deleted fork>");
  });
});

describe("origin-remote mismatch fails closed", async () => {
  const fixture = await makeFixtureRepo({
    base: {
      message: "base",
      files: [
        { kind: "file", path: "package.json", content: JSON.stringify({ name: "revkit", private: true }) },
        { kind: "file", path: "docs/index.md", content: "# base\n" },
        MIN_VOCAB_YAML,
      ],
    },
    head: {
      message: "PR",
      files: [{ kind: "file", path: "docs/index.md", content: "# pr\n" }],
    },
    originUrl: "https://github.com/evil/mismatch.git",
  });
  dirs.push(fixture.repoDir);

  const pr: FakePr = {
    owner: "vig-os",
    repo: "revkit",
    pullNumber: 810,
    nodeId: "PR_81",
    title: "origin mismatch",
    state: "open",
    headSha: fixture.headSha,
    headRef: "pr",
    baseSha: fixture.baseSha,
    baseRef: "main",
    headRepoFullName: "vig-os/revkit",
    baseRepoFullName: "vig-os/revkit",
    url: "https://github.com/vig-os/revkit/pull/810",
  };

  test("PR's owner/repo does not match origin → refused", async () => {
    const staticToken = { async getToken() { return "ghp_" + "a".repeat(40); } };
    const result = await runReviewCommand(["810", "--no-serve"], {
      cwd: fixture.repoDir,
      version: "0.0.0",
      gh: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      git: spawnGit,
      repoSlug: "vig-os/revkit",
      makeAdapter: () => new GitHubAdapter({ token: staticToken, fetch: makeFakeGithubFetch([pr]) }),
      localUserId: "origin-mismatch-test",
      _skipCheckDist: true,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("does not match the local 'origin'");
  });
});
