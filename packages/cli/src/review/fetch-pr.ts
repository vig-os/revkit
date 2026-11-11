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
import { runSafeGit, runSafeGitOrThrow, SafeGitError, type SafeGitRunner } from "./git-safe.ts";

/** Options for `ensurePrCommits`. */
export interface EnsurePrCommitsOptions {
  readonly runner: SafeGitRunner;
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

/** Ensure `refs/revkit/pr-<n>/head` (and `refs/revkit/pr-<n>/base`
 * when the base SHA is not otherwise reachable) reflect the current
 * GitHub state, and that both SHAs are present in the local
 * object DB.
 *
 * **PR #48 round-3 blocker 3**: this function used to early-return
 * when both SHAs were already local, on the assumption that
 * `refs/revkit/pr-<n>/head` would still be pointing at the head
 * from the previous fetch. That's wrong on TWO paths:
 *   1. A same-repo PR: the head SHA is already on
 *      `refs/heads/<branch>` before we ever fetch, so the early
 *      return skipped the `+refs/pull/<n>/head` refspec entirely
 *      and the `refs/revkit/…` ref never got written — the
 *      subsequent `readFetchedHeadSha` then failed with
 *      "could not verify fetched head SHA".
 *   2. A rerun after a head move where a STALE
 *      `refs/revkit/pr-<n>/head` points at the old head; the
 *      early-return leaves it pointing at the wrong commit.
 *
 * The fix: always fetch (`+refs/pull/<n>/head` force-updates the
 * ref), even when both SHAs are already local. GitHub only refuses
 * the fetch on a genuinely missing PR — a shallow clone / rate
 * limit does not open a bypass. The fetch is fast on already-local
 * objects (only the tips move).
 */
export async function ensurePrCommits(options: EnsurePrCommitsOptions): Promise<void> {
  const remote = options.remote ?? "origin";

  // Always fetch `refs/pull/<n>/head` into `refs/revkit/pr-<n>/head`
  // (force-update). The `+` prefix makes git accept a
  // non-fast-forward move (a rebased or force-pushed PR head).
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
 *
 * Routed through the safe wrapper so the same hardening (no hooks,
 * no submodule recursion, no filter/smudge driver reads,
 * `protocol.file.allow=never`, `protocol.ext.allow=never`) applies
 * to this call as every other git invocation on the review path
 * (PR #48 round-2 nit).
 */
export async function hasCommit(runner: SafeGitRunner, cwd: string, sha: string): Promise<boolean> {
  const result = await runSafeGit(runner, cwd, ["cat-file", "-e", `${sha}^{commit}`]);
  return result.exitCode === 0;
}

/**
 * Re-read the `refs/revkit/pr-<n>/head` SHA that `ensurePrCommits`
 * just wrote. **Closes the TOCTOU window** between `getPullRequest`
 * (adapter) and `materializeSafeTree` (git object DB): the reviewer
 * saw commit X on GitHub, fetched it into the local DB, and the
 * materializer/build must operate on THAT SHA — not on a value that
 * moved between the adapter call and the fetch (PR #48 round-2
 * blocker 3).
 *
 * Returns the 40-hex SHA the fetched ref resolves to now.
 * `git rev-parse --verify` refuses ambiguous names and does not
 * spawn a network call, so this is cheap.
 */
export async function readFetchedHeadSha(
  runner: SafeGitRunner,
  cwd: string,
  pullNumber: number,
): Promise<string> {
  const ref = `refs/revkit/pr-${pullNumber}/head`;
  const out = await runSafeGitOrThrow(
    runner,
    cwd,
    ["rev-parse", "--verify", `${ref}^{commit}`],
    `readFetchedHeadSha: git rev-parse ${ref} failed`,
  );
  const trimmed = out.trim();
  if (!/^[0-9a-f]{40}$/i.test(trimmed)) {
    throw new SafeGitError(
      `readFetchedHeadSha: git rev-parse returned an implausible SHA: ${JSON.stringify(trimmed.slice(0, 80))}`,
      0,
      "",
    );
  }
  return trimmed.toLowerCase();
}

/**
 * Return the `origin` remote's URL, or `undefined` when no `origin`
 * remote is configured. Used by the CLI's owner/repo verification
 * step (PR #48 round-2 blocker 4): a PR ref whose owner/repo does
 * not match the local `origin` is refused, so a reviewer cannot
 * accidentally build a PR from a repo their checkout does not
 * track.
 */
export async function readOriginUrl(runner: SafeGitRunner, cwd: string): Promise<string | undefined> {
  const result = await runSafeGit(runner, cwd, ["remote", "get-url", "origin"]);
  if (result.exitCode !== 0) return undefined;
  return result.stdout.trim();
}

/**
 * Parse a git remote URL into its `{owner, repo}` slug. Handles both
 * HTTPS (`https://github.com/o/r.git`) and SSH
 * (`git@github.com:o/r.git`) shapes. Trailing `.git` is stripped.
 * Returns `undefined` for a non-github or malformed URL.
 */
export function parseGithubRemoteUrl(url: string): { readonly owner: string; readonly repo: string } | undefined {
  const trimmed = url.trim();
  // SSH: `git@github.com:owner/repo(.git)?`
  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(\.git)?$/);
  if (ssh !== null) {
    return { owner: ssh[1] ?? "", repo: ssh[2] ?? "" };
  }
  // HTTPS: `https://github.com/owner/repo(.git)?` (also `http://`).
  try {
    const u = new URL(trimmed);
    if (u.hostname !== "github.com" && u.hostname !== "www.github.com") return undefined;
    const parts = u.pathname.split("/").filter((s) => s.length > 0);
    if (parts.length < 2) return undefined;
    const owner = parts[0] ?? "";
    let repo = parts[1] ?? "";
    if (repo.endsWith(".git")) repo = repo.slice(0, -4);
    return { owner, repo };
  } catch {
    return undefined;
  }
}

/** Per-PR root — keyed by `<owner>-<repo>-<number>` so a rerun on the
 * same PR reuses its **state** even after the PR head moves.
 * (PR #48 round-2 blocker 5.) A subdirectory `head-<sha>/` holds the
 * per-head materialised tree and per-head dist; `state/` holds the
 * survivable per-PR state (sqlite, snapshots) that MUST live outside
 * the materialised tree so a rerun that wipes the head dir does not
 * destroy comments. */
export function perPrRoot(repoRoot: string, pr: { owner: string; repo: string; pullNumber: number }): string {
  // Slugs are already validated (see `pr-ref.ts`), but be defensive
  // — refuse a path segment with a separator.
  const slug = safeSlug(pr.owner, pr.repo, pr.pullNumber);
  return join(repoRoot, ".revkit", "review", slug);
}

/** Absolute path to the materialised worktree for a given head SHA.
 *
 * **PR #48 round-4 blocker 2** — the materialised worktree lives
 * INSIDE the reviewer's trusted `site/` at
 * `<repoRoot>/site/.revkit-review/<slug>/head-<sha>/`. This has
 * three consequences we want:
 *
 *   1. Astro's default `.astro/` cache lands at
 *      `<materialised>/.astro/`, and vite's `node_modules/.vite/`
 *      lands under `<materialised>/node_modules/` — both entirely
 *      inside the sandbox, never inside the reviewer's real
 *      `site/node_modules/`.
 *   2. Node's module resolution walking up from `<materialised>/site/`
 *      finds `<repoRoot>/site/node_modules/` (four `..`s up). No
 *      symlink into the trusted checkout is needed.
 *   3. Astro's content-collection paths, stored as
 *      `path.relative(config.root, contentFile)`, resolve
 *      correctly at load time.
 *
 * `<repoRoot>/site/.revkit-review/` is gitignored (added by the
 * cli).
 *
 * The per-PR **state** dir (`state/threads.sqlite`) still lives
 * under `<repoRoot>/.revkit/review/<slug>/state/` (see
 * `perPrStateDir`) so a rerun finds it. */
export function reviewTargetDir(
  repoRoot: string,
  pr: { owner: string; repo: string; pullNumber: number },
  headSha: string,
): string {
  return join(sandboxParent(repoRoot, pr), `head-${shortSha(headSha)}`);
}

/** Sandbox parent dir for the materialised worktree — public so
 * the CLI can prune stale `head-<sha>/` siblings there without
 * touching the state/ dir under `<repoRoot>/.revkit/review/<slug>/`. */
export function perPrScratchRoot(pr: { owner: string; repo: string; pullNumber: number }): string {
  // Callers pass repoRoot too via the full-path helpers; keep
  // this signature callable without repoRoot for legacy paths.
  return join(".", ".revkit-review", safeSlug(pr.owner, pr.repo, pr.pullNumber));
}

function sandboxParent(
  repoRoot: string,
  pr: { owner: string; repo: string; pullNumber: number },
): string {
  const slug = safeSlug(pr.owner, pr.repo, pr.pullNumber);
  return join(repoRoot, "site", ".revkit-review", slug);
}

/** Absolute path to the sandbox parent for pruning stale
 * `head-<sha>/` siblings — the CLI passes `repoRoot`. */
export function perPrSandboxParent(
  repoRoot: string,
  pr: { owner: string; repo: string; pullNumber: number },
): string {
  return sandboxParent(repoRoot, pr);
}

/** Absolute path to the survivable per-PR state directory. Contains
 * `threads.sqlite` and any snapshot bytes the re-anchor pipeline needs
 * across head moves. This directory is NEVER removed by a rerun; a
 * `--clean` flag (future) would remove it explicitly. */
export function perPrStateDir(
  repoRoot: string,
  pr: { owner: string; repo: string; pullNumber: number },
): string {
  return join(perPrRoot(repoRoot, pr), "state");
}

/** Absolute path to the sqlite thread store for this PR. Lives under
 * `state/` so it survives a `rm -rf` of the head tree. */
export function perPrSqlitePath(
  repoRoot: string,
  pr: { owner: string; repo: string; pullNumber: number },
): string {
  return join(perPrStateDir(repoRoot, pr), "threads.sqlite");
}

/** Directory containing all per-PR review worktrees. */
export function reviewsRoot(repoRoot: string): string {
  return join(repoRoot, ".revkit", "review");
}

/** True when the materialised head-<sha> tree already exists. */
export function reviewTargetExists(
  repoRoot: string,
  pr: { owner: string; repo: string; pullNumber: number },
  headSha: string,
): boolean {
  return existsSync(reviewTargetDir(repoRoot, pr, headSha));
}

/** Build a safe path segment `<owner>-<repo>-<number>` — refuses
 * anything but ASCII alphanumeric and `._-` so a hostile slug cannot
 * escape the reviews root. `pr-ref.ts` already validates owner/repo,
 * but this is the last line of defence between an on-wire value and
 * a filesystem path. */
function safeSlug(owner: string, repo: string, num: number): string {
  const ok = /^[A-Za-z0-9._-]+$/;
  if (!ok.test(owner) || !ok.test(repo)) {
    throw new SafeGitError(
      `perPrRoot: refusing unsafe slug '${owner}/${repo}'`,
      0,
      "",
    );
  }
  return `${owner}-${repo}-${num}`;
}

function shortSha(sha: string): string {
  // First 12 hex chars — long enough to be unique in a reviewer's
  // working repo, short enough for a readable directory name.
  return sha.slice(0, 12);
}
