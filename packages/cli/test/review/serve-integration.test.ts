// End-to-end integration: `revkit review <pr>` materializes, imports
// existing PR review threads and starts a per-review daemon over the
// materialized worktree's `site/dist`. The test uses the fake fetch
// so nothing hits GitHub live.
//
// The one thread the fixture serves is a live RIGHT-side line thread
// against `docs/index.md`. After the daemon starts, `GET
// /api/threads` (bearer-authed) must list it. That proves import →
// store → daemon read all wired correctly, without needing the full
// rail UI.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { GitHubAdapter, type GhReviewThread } from "@revkit/review-core";
import { runReviewCommand } from "../../src/review/cli.ts";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";
import { registerDaemonPid, unregisterDaemonPid } from "../helpers/daemon-registry.ts";
import { makeFakeGithubFetch, type FakePr } from "./helpers/fake-github.ts";
import { makeFixtureRepo, makeInterceptingGitRunner, MIN_VOCAB_YAML } from "./helpers/git-fixture.ts";

const tempDirsToClean: string[] = [];
const daemonsToStop: DaemonHandle[] = [];

afterAll(async () => {
  for (const h of daemonsToStop) {
    try {
      await h.stop();
    } catch {
      /* fine */
    }
  }
  for (const dir of tempDirsToClean) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* fine */
    }
  }
});

describe("revkit review → daemon integration", async () => {
  const fixture = await makeFixtureRepo({
    base: {
      message: "base",
      files: [
        { kind: "file", path: "package.json", content: JSON.stringify({ name: "revkit", private: true }) },
        { kind: "file", path: "docs/index.md", content: "line1\nline2 with quote\nline3\n" },
        MIN_VOCAB_YAML,
      ],
    },
    head: {
      message: "PR: no-op content edit",
      files: [
        { kind: "file", path: "docs/index.md", content: "line1\nline2 with QUOTE\nline3\n" },
      ],
    },
  });
  tempDirsToClean.push(fixture.repoDir);

  // One live RIGHT thread against docs/index.md line 2.
  const thread: GhReviewThread = {
    id: "REV_1",
    path: "docs/index.md",
    isResolved: false,
    isOutdated: false,
    line: 2,
    startLine: null,
    originalLine: 2,
    originalStartLine: null,
    diffSide: "RIGHT",
    startDiffSide: null,
    subjectType: "LINE",
    resolvedByLogin: null,
    comments: [
      {
        databaseId: 999,
        nodeId: "COM_1",
        body: "this line is off",
        authorLogin: "test-reviewer",
        authorType: "User",
        createdAt: "2026-09-30T00:00:00Z",
        url: "https://github.com/vig-os/revkit/pull/700#discussion_r999",
        originalCommitOid: fixture.headSha,
        diffHunk: "@@ -1,3 +1,3 @@\n line1\n-line2 with quote\n+line2 with QUOTE",
      },
    ],
  };

  const pr: FakePr = {
    owner: "vig-os",
    repo: "revkit",
    pullNumber: 700,
    nodeId: "PR_7",
    title: "no-op",
    state: "open",
    headSha: fixture.headSha,
    headRef: "pr",
    baseSha: fixture.baseSha,
    baseRef: "main",
    headRepoFullName: "vig-os/revkit",
    baseRepoFullName: "vig-os/revkit",
    url: "https://github.com/vig-os/revkit/pull/700",
    threads: [thread],
  };

  test("starts a daemon and exposes the imported thread on /api/threads", async () => {
    const staticToken = { async getToken() { return "ghp_" + "a".repeat(40); } };
    const fakeFetch = makeFakeGithubFetch([pr]);

    let daemonHandle: DaemonHandle | undefined;
    const gitInterceptor = makeInterceptingGitRunner({
      repoDir: fixture.repoDir,
      pulls: new Map([[700, fixture.headSha]]),
    });
    const result = await runReviewCommand(
      ["700", "--repo", "vig-os/revkit"],
      {
        cwd: fixture.repoDir,
        version: "0.0.0",
        gh: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        git: gitInterceptor,
        repoSlug: "vig-os/revkit",
        makeAdapter: () => new GitHubAdapter({ token: staticToken, fetch: fakeFetch }),
        localUserId: "review-test-user",
        _skipCheckDist: true,
        build: async ({ distOutDir }) => {
          // Fake a built site: a `site/dist/index.html` the daemon
          // can serve. The daemon doesn't require anything more
          // than an existing dir for `--dir`, but a real page keeps
          // the integration honest.
          mkdirSync(distOutDir, { recursive: true, mode: 0o700 });
          writeFileSync(distOutDir + "/index.html", "<!doctype html><title>PR 700</title>");
        },
        startServe: async ({ distDir, sqlitePath, repoRoot, localUserId }) => {
          const handle = await startDaemon({
            dir: distDir,
            repoRoot,
            sqlitePath,
            version: "0.0.0",
            localUserId,
            port: 0,
            announce: false,
            installSignalHandlers: false,
          });
          daemonHandle = handle;
          daemonsToStop.push(handle);
          registerDaemonPid(process.pid);
          return {
            url: handle.url,
            port: handle.port,
            launchUrl: handle.launchUrl,
            blockForever: new Promise<void>(() => {
              /* never resolves; test tears down via handle.stop() */
            }),
            stop: () => handle.stop(),
          };
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(daemonHandle).toBeDefined();
    if (daemonHandle === undefined) return;

    // Hit the daemon's /api/threads with the bearer token.
    const response = await fetch(`${daemonHandle.url}/api/threads`, {
      headers: { authorization: `Bearer ${daemonHandle.agentToken}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { threads: unknown[]; head: number };
    // Exactly one thread — the one we imported.
    expect(body.threads.length).toBe(1);
    expect(body.head).toBeGreaterThan(0);

    // Static file lands from the fake build.
    const html = await fetch(`${daemonHandle.url}/index.html`, {
      headers: { authorization: `Bearer ${daemonHandle.agentToken}` },
    });
    expect(html.status).toBe(200);

    await daemonHandle.stop();
    unregisterDaemonPid(process.pid);
  });
});
