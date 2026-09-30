// Fetch the PR head and its base into the local git object DB. The
// GitHub adapter names the head SHA and base SHA (through
// `getPullRequest`); this file makes those SHAs resolvable to git in
// the reviewer's local checkout.
//
// **Two fetch paths**:
//
//   1. **Same-repo PR** (headRepoFullName === baseRepoFullName). We
//      fetch `refs/pull/<n>/head` from the `origin` remote. GitHub
//      mirrors every PR head under that ref, so no rework of the
//      remote's URL is needed.
//
//   2. **Fork PR** (headRepoFullName !== baseRepoFullName). We STILL
//      fetch `refs/pull/<n>/head` from the base remote — GitHub also
//      mirrors fork PR heads there. Nothing points at the fork's own
//      remote URL, which keeps the local git config free of a
//      PR-controlled remote (a URL containing shell metacharacters
//      would otherwise ride into `git remote add`).
//
// The fetch itself runs through the safe wrapper so `.gitattributes`
// filters, submodule recursion, and `protocol.file.allow` are locked
// out during the fetch's own `git config` reads.
//
// **The fetch never runs on the CURRENT WORKING TREE**: we point git
// at a bare object directory (either the reviewer's own repo or a
// per-review one). The materializer reads by SHA from that object
// DB, so nothing lands in the reviewer's working files.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GitRunner } from "../git-runner.ts";
import { runSafeGitOrThrow, SafeGitError } from "./git-safe.ts";

/** Options for `ensurePrCommits`. */
export interface EnsurePrCommitsOptions {
  readonly runner: GitRunner;
  /** cwd for the git commands — the reviewer's repo checkout. */
  readonly repoCwd: string;
  /** Which PR number to fetch — the ref is `refs/pull/<n>/head`. */
  readonly pullNumber: number;
  /** The head SHA (from `getPullRequest`) we expect to see after
   * fetch. Verified with `git cat-file -e`. */
  readonly headSha: string;
  /** The base SHA (from `getPullRequest`) we expect to see. If
   * missing after the pull-refs fetch, we fetch the base ref
   * explicitly. */
  readonly baseSha: string;
  /** The base ref (branch name) from `getPullRequest`. Used as the
   * fallback fetch target when `baseSha` isn't resolvable after the
   * head fetch. */
  readonly baseRef: string;
  /** Optional remote name. Defaults to `origin`. */
  readonly remote?: string;
}

/** Ensure both `headSha` and `baseSha` are present in the local git
 * object database. Idempotent: if both SHAs are already there (a
 * prior `revkit review` fetched them), no network call is made.
 */
export async function ensurePrCommits(options: EnsurePrCommitsOptions): Promise<void> {
  const remote = options.remote ?? "origin";

  // Cheap early check — if both SHAs are already objects, skip the
  // fetch entirely. A previous `revkit review` on the same PR-and-
  // sha does not need to hit GitHub again.
  const [hasHead, hasBase] = await Promise.all([
    hasCommit(options.runner, options.repoCwd, options.headSha),
    hasCommit(options.runner, options.repoCwd, options.baseSha),
  ]);
  if (hasHead && hasBase) return;

  // The GitHub-mirrored PR head ref. We fetch it into a namespaced
  // local ref so the reviewer's normal branch layout is untouched.
  // `+refs/pull/N/head:refs/revkit/pr-N/head` forces update.
  const prHeadRefspec = `+refs/pull/${options.pullNumber}/head:refs/revkit/pr-${options.pullNumber}/head`;
  await runSafeGitOrThrow(
    options.runner,
    options.repoCwd,
    ["fetch", "--no-tags", "--no-recurse-submodules", remote, prHeadRefspec],
    `ensurePrCommits: git fetch ${remote} ${prHeadRefspec} failed`,
  );

  // The base SHA may already be in the object DB (the reviewer's
  // own branch is likely tracking it) or not. If not, fetch it too.
  if (!(await hasCommit(options.runner, options.repoCwd, options.baseSha))) {
    // The reviewer's remote may not offer the exact base commit by
    // SHA (some Git servers refuse `fetch <sha>` without
    // `uploadpack.allowReachableSHA1InWant`); fetch by the base
    // ref name and rely on a follow-up `cat-file -e` check.
    const baseRefspec = `+refs/heads/${options.baseRef}:refs/revkit/pr-${options.pullNumber}/base`;
    await runSafeGitOrThrow(
      options.runner,
      options.repoCwd,
      ["fetch", "--no-tags", "--no-recurse-submodules", remote, baseRefspec],
      `ensurePrCommits: git fetch ${remote} ${baseRefspec} failed`,
    );
  }

  // Verify BOTH SHAs are now present. Anything else means GitHub
  // returned a head/base that doesn't match the ref we fetched, so
  // we refuse rather than continue.
  const [afterHead, afterBase] = await Promise.all([
    hasCommit(options.runner, options.repoCwd, options.headSha),
    hasCommit(options.runner, options.repoCwd, options.baseSha),
  ]);
  if (!afterHead) {
    throw new SafeGitError(
      `ensurePrCommits: head SHA ${options.headSha} not present after fetch`,
      1,
      "",
    );
  }
  if (!afterBase) {
    throw new SafeGitError(
      `ensurePrCommits: base SHA ${options.baseSha} not present after fetch`,
      1,
      "",
    );
  }
}

/**
 * Check whether a commit SHA is present in the local object DB.
 * Uses `git cat-file -e <sha>` — exits 0 if present, non-zero if
 * missing. Never emits stdout, so a caller can use the exit code
 * directly.
 */
export async function hasCommit(runner: GitRunner, cwd: string, sha: string): Promise<boolean> {
  const result = await runner(
    ["--no-optional-locks", "cat-file", "-e", `${sha}^{commit}`],
    cwd,
  );
  return result.exitCode === 0;
}

/** Compute the directory the materializer will target for this PR. */
export function reviewTargetDir(repoRoot: string, pullNumber: number, headSha: string): string {
  return join(repoRoot, ".revkit", "review", `${pullNumber}-${shortSha(headSha)}`);
}

/** Directory containing all per-PR review worktrees. */
export function reviewsRoot(repoRoot: string): string {
  return join(repoRoot, ".revkit", "review");
}

/** True when the review target for a given PR + SHA already exists on
 * disk. Callers use this to skip a fetch/materialize when a previous
 * invocation on the same head SHA already produced the tree. */
export function reviewTargetExists(repoRoot: string, pullNumber: number, headSha: string): boolean {
  return existsSync(reviewTargetDir(repoRoot, pullNumber, headSha));
}

function shortSha(sha: string): string {
  // First 12 hex chars — long enough to be unique in a reviewer's
  // working repo, short enough for a readable directory name.
  return sha.slice(0, 12);
}
