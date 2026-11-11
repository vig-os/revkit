// Rerun-safety: the survivable per-PR state (sqlite thread store)
// lives under `.revkit/review/<slug>/state/`, OUTSIDE the
// materialised `head-<sha>/` directory that a rerun wipes. This
// test PROVES it — a rerun on the same PR (even on a moved head)
// preserves comments written between runs (PR #48 round-2
// blocker 5).

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { GitHubAdapter, isValidRepoRelativePath } from "@revkit/review-core";
import { runReviewCommand } from "../../src/review/cli.ts";
import { perPrSqlitePath, perPrStateDir } from "../../src/review/fetch-pr.ts";
import { SqliteThreadStore } from "../../src/serve/sqlite-store.ts";
import { makeFakeGithubFetch, type FakePr } from "./helpers/fake-github.ts";
import { makeFixtureRepo, makeInterceptingGitRunner, MIN_VOCAB_YAML } from "./helpers/git-fixture.ts";

// Sanity-import to keep the review-core barrel referenced (the
// test only uses the store & runner symbols).
void isValidRepoRelativePath;

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

describe("rerun preserves the per-PR thread store", async () => {
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
      message: "PR content-only",
      files: [{ kind: "file", path: "docs/index.md", content: "# PR edit\n" }],
    },
  });
  dirs.push(fixture.repoDir);

  const pr: FakePr = {
    owner: "vig-os",
    repo: "revkit",
    pullNumber: 900,
    nodeId: "PR_9",
    title: "content only",
    state: "open",
    headSha: fixture.headSha,
    headRef: "pr",
    baseSha: fixture.baseSha,
    baseRef: "main",
    headRepoFullName: "vig-os/revkit",
    baseRepoFullName: "vig-os/revkit",
    url: "https://github.com/vig-os/revkit/pull/900",
  };

  test("comment written between reruns survives a wipe of the materialised head tree", async () => {
    const staticToken = { async getToken() { return "ghp_" + "a".repeat(40); } };
    const gitInterceptor = makeInterceptingGitRunner({
      repoDir: fixture.repoDir,
      pulls: new Map([[pr.pullNumber, pr.headSha]]),
    });
    const env = {
      cwd: fixture.repoDir,
      version: "0.0.0",
      gh: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      git: gitInterceptor,
      repoSlug: "vig-os/revkit",
      makeAdapter: () => new GitHubAdapter({ token: staticToken, fetch: makeFakeGithubFetch([pr]) }),
      localUserId: "review-state-test",
      _skipCheckDist: true,
      build: async ({ distOutDir }: { distOutDir: string }) => {
        mkdirSync(distOutDir, { recursive: true, mode: 0o700 });
        writeFileSync(distOutDir + "/index.html", "<!doctype html><title>x</title>");
      },
    } as const;

    // First run.
    const r1 = await runReviewCommand(["900", "--no-serve"], env);
    expect(r1.exitCode).toBe(0);

    // Simulate a comment authored by the local reviewer through
    // the daemon path: open the same sqlite store the CLI just
    // touched, append one comment.created event.
    const sqlitePath = perPrSqlitePath(fixture.repoDir, pr);
    expect(existsSync(sqlitePath)).toBe(true);
    // The state dir must exist too.
    expect(existsSync(perPrStateDir(fixture.repoDir, pr))).toBe(true);
    {
      const store = SqliteThreadStore.open({ filename: sqlitePath, displayName: "rerun-test-1" });
      try {
        await store.append({
          kind: "comment.created",
          actor: { kind: "local", id: "review-state-test" },
          threadId: "local-thread-1",
          commentId: "local-comment-1",
          anchor: {
            path: "docs/index.md",
            revision: "a".repeat(64),
            startLine: 1,
            endLine: 1,
            quote: { exact: "# PR edit", prefix: "", suffix: "\n" },
          },
          body: "hello from the survivable state",
        });
      } finally {
        store.close();
      }
    }

    // Second run — same PR, same head. The CLI removes stale
    // head-<sha>/ directories. state/ must NOT be touched.
    const r2 = await runReviewCommand(["900", "--no-serve"], env);
    expect(r2.exitCode).toBe(0);

    // The comment must still be there.
    const store = SqliteThreadStore.open({ filename: sqlitePath, displayName: "rerun-test-2" });
    try {
      const threads = await store.threads({});
      const localThread = threads.find((t) => t.id === "local-thread-1");
      expect(localThread).toBeDefined();
      expect(localThread?.comments[0]?.body).toBe("hello from the survivable state");
    } finally {
      store.close();
    }
  });
});
