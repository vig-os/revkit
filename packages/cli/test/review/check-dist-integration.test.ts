// End-to-end: `revkit review` runs `check-dist` on the built PR
// output BEFORE serving it (PR #48 round-2 blocker 2). If the
// built dist contains a refused pattern (an `on*` attribute, a
// `javascript:` URL, an off-list inline-script hash), the review
// command refuses without starting the daemon.
//
// The build hook is injected so we can hand-craft a hostile dist
// and prove the real `check-dist` code path (via `runReviewCommand`,
// not a hand-rolled reproducer) refuses it.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { GitHubAdapter } from "@revkit/review-core";
import { runReviewCommand } from "../../src/review/cli.ts";
import { spawnGit } from "../../src/git-runner.ts";
import { makeFakeGithubFetch, type FakePr } from "./helpers/fake-github.ts";
import { makeFixtureRepo, MIN_VOCAB_YAML, writeReviewRefs } from "./helpers/git-fixture.ts";

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

describe("revkit review → check-dist gate", async () => {
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
      message: "content-only PR",
      files: [{ kind: "file", path: "docs/index.md", content: "# pr\n" }],
    },
  });
  dirs.push(fixture.repoDir);

  const pr: FakePr = {
    owner: "vig-os",
    repo: "revkit",
    pullNumber: 950,
    nodeId: "PR_9b",
    title: "check-dist gate",
    state: "open",
    headSha: fixture.headSha,
    headRef: "pr",
    baseSha: fixture.baseSha,
    baseRef: "main",
    headRepoFullName: "vig-os/revkit",
    baseRepoFullName: "vig-os/revkit",
    url: "https://github.com/vig-os/revkit/pull/950",
  };

  const staticToken = { async getToken() { return "ghp_" + "a".repeat(40); } };

  test("refuses a built dist that contains an `onclick=` attribute", async () => {
    await writeReviewRefs(fixture.repoDir, { pullNumber: pr.pullNumber, headSha: pr.headSha });
    const result = await runReviewCommand(
      ["950", "--no-serve"],
      {
        cwd: fixture.repoDir,
        version: "0.0.0",
        gh: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        git: spawnGit,
        repoSlug: "vig-os/revkit",
        makeAdapter: () => new GitHubAdapter({ token: staticToken, fetch: makeFakeGithubFetch([pr]) }),
        localUserId: "review-checkdist-test",
        build: async ({ distOutDir }) => {
          mkdirSync(distOutDir, { recursive: true, mode: 0o700 });
          // A hostile page — CSP would refuse it at runtime; we
          // refuse it at build.
          writeFileSync(
            distOutDir + "/index.html",
            "<!doctype html><title>x</title><body><a href=\"#\" onclick=\"alert(1)\">clickme</a></body>",
          );
        },
      },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("check-dist");
    // The specific rule fires — one of check-dist's sanitiser
    // findings. The exact rule id (`on-attribute`) surfaces here.
    expect(result.stderr.toLowerCase()).toContain("on");
  });

  test("accepts a clean built dist", async () => {
    await writeReviewRefs(fixture.repoDir, { pullNumber: pr.pullNumber, headSha: pr.headSha });
    const result = await runReviewCommand(
      ["950", "--no-serve"],
      {
        cwd: fixture.repoDir,
        version: "0.0.0",
        gh: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        git: spawnGit,
        repoSlug: "vig-os/revkit",
        makeAdapter: () => new GitHubAdapter({ token: staticToken, fetch: makeFakeGithubFetch([pr]) }),
        localUserId: "review-checkdist-test-ok",
        build: async ({ distOutDir }) => {
          mkdirSync(distOutDir, { recursive: true, mode: 0o700 });
          writeFileSync(distOutDir + "/index.html", "<!doctype html><title>ok</title><p>hi</p>");
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("check-dist: PR output passed");
  });
});
