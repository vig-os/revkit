// `ensurePrCommits` must ALWAYS fetch — never early-return when
// both SHAs are already local — because a same-repo PR's head SHA
// is on `refs/heads/<branch>` from the start, and the CLI's
// `readFetchedHeadSha` reads `refs/revkit/pr-<n>/head`, which only
// the fetch writes (PR #48 round-3 blocker 3).
//
// Both scenarios covered here:
//   1. Head + base are already local (same-repo PR shape) → the
//      fetch STILL runs and populates `refs/revkit/pr-<n>/head`.
//   2. A stale `refs/revkit/pr-<n>/head` from a previous run
//      points at an OLD head → the fetch force-updates it to the
//      current head.

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { ensurePrCommits, readFetchedHeadSha } from "../../src/review/fetch-pr.ts";
import { wrapSafeGitRunner } from "../../src/review/git-safe.ts";
import { makeFixtureRepo, makeInterceptingGitRunner } from "./helpers/git-fixture.ts";

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

describe("ensurePrCommits always fetches", async () => {
  const fixture = await makeFixtureRepo({
    base: { message: "base", files: [{ kind: "file", path: "a.md", content: "1\n" }] },
    head: { message: "head", files: [{ kind: "file", path: "a.md", content: "2\n" }] },
  });
  dirs.push(fixture.repoDir);

  test("already-local PR: fetch STILL runs and refs/revkit/pr-N/head is written", async () => {
    // The head + base SHAs are already in the object DB (the
    // fixture created them). Under the old bug, the early return
    // meant the ref was never written; under the fix, the fetch
    // always runs and force-updates the ref.
    const pulls = new Map<number, string>([[42, fixture.headSha]]);
    const runner = wrapSafeGitRunner(makeInterceptingGitRunner({ repoDir: fixture.repoDir, pulls }));
    await ensurePrCommits({
      runner,
      repoCwd: fixture.repoDir,
      pullNumber: 42,
      headSha: fixture.headSha,
      baseSha: fixture.baseSha,
      baseRef: "main",
    });
    const readback = await readFetchedHeadSha(runner, fixture.repoDir, 42);
    expect(readback).toBe(fixture.headSha.toLowerCase());
  });

  test("stale refs/revkit/pr-N/head from a previous run is force-updated", async () => {
    // Simulate a stale ref pointing at the BASE (as if the PR
    // head had moved since the last run).
    const runner = wrapSafeGitRunner(makeInterceptingGitRunner({
      repoDir: fixture.repoDir,
      pulls: new Map<number, string>([[43, fixture.headSha]]),
    }));
    // First, plant a stale ref pointing at base.
    const proc = Bun.spawn(
      ["git", "-C", fixture.repoDir, "update-ref", "refs/revkit/pr-43/head", fixture.baseSha],
      { stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
    // The stale ref is at baseSha.
    const staleRead = await readFetchedHeadSha(runner, fixture.repoDir, 43);
    expect(staleRead).toBe(fixture.baseSha.toLowerCase());
    // Now run ensurePrCommits and verify the ref moves to the new head.
    await ensurePrCommits({
      runner,
      repoCwd: fixture.repoDir,
      pullNumber: 43,
      headSha: fixture.headSha,
      baseSha: fixture.baseSha,
      baseRef: "main",
    });
    const readback = await readFetchedHeadSha(runner, fixture.repoDir, 43);
    expect(readback).toBe(fixture.headSha.toLowerCase());
  });
});
