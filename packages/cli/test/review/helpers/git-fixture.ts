// Reusable helper that builds a real local git repository with a
// base branch and a PR branch, using the actual `git` binary
// (through `Bun.spawn`). Kept small and self-contained so every
// review test can point at a fresh fixture without a network round
// trip.
//
// The fixture writes files to a temp directory and returns the SHAs
// of the base and head commits, plus the absolute path to the repo
// dir. The tests then instantiate a `GitRunner` bound to that path
// and drive the review pipeline against it.

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnGit } from "../../../src/git-runner.ts";

/** A file to write inside the repo. `mode: "exec"` sets the +x bit;
 * `mode: "symlink"` creates a symlink whose target is `target`. */
export type FixtureFile =
  | { readonly kind: "file"; readonly path: string; readonly content: string; readonly executable?: boolean }
  | { readonly kind: "symlink"; readonly path: string; readonly target: string };

/** The minimal `vocab/terms.yaml` `revkit check` needs (schema
 * requires `entries.min(1)`). Every fixture that runs `runCheck`
 * against the materialized tree gets this in its base commit so
 * `loadVocab` finds a valid file. */
export const MIN_VOCAB_YAML: FixtureFile = {
  kind: "file",
  path: "vocab/terms.yaml",
  content:
    `schemaVersion: 1\nentries:\n  - id: anchor\n    term: anchor\n    definition: a stable pointer.\n`,
};

/** One committed state (base commit or PR-head commit). */
export interface CommitSpec {
  readonly message: string;
  readonly files: readonly FixtureFile[];
  /** Files to REMOVE at this commit — the delete is `git rm -f` on
   * each path before adding this commit's files. */
  readonly remove?: readonly string[];
}

/** Result of `makeFixtureRepo`. */
export interface FixtureRepo {
  /** Repo root (absolute). Contains `.git/`. */
  readonly repoDir: string;
  /** Base commit SHA. */
  readonly baseSha: string;
  /** PR-head commit SHA. */
  readonly headSha: string;
  /** Ref name used for the base branch. */
  readonly baseRef: string;
  /** Ref name used for the PR branch. */
  readonly headRef: string;
}

const TMP_PREFIX = "revkit-review-fixture-";

/** Run a git subcommand synchronously inside `cwd`. Uses `spawnSync`
 * for deterministic ordering — commits in tests must be made
 * strictly in the given sequence. Throws on non-zero exit with the
 * stderr attached. */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    // Force a stable identity/environment so commit SHAs are
    // reproducible in a test run (though we don't assert on them).
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00+0000",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00+0000",
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr}`);
  }
  return stdout;
}

/** Apply a `CommitSpec` to the repo: remove listed paths, write
 * listed files, `git add -A`, `git commit`. Returns the commit SHA. */
async function applyCommit(repoDir: string, spec: CommitSpec): Promise<string> {
  for (const removePath of spec.remove ?? []) {
    // `git rm -f` handles the "file might not be tracked" case with
    // --ignore-unmatch.
    await git(repoDir, ["rm", "-rf", "--ignore-unmatch", "--", removePath]);
  }
  for (const file of spec.files) {
    const abs = join(repoDir, file.path);
    mkdirSync(join(repoDir, file.path, ".."), { recursive: true });
    if (file.kind === "file") {
      writeFileSync(abs, file.content, { mode: 0o600 });
      if (file.executable === true) chmodSync(abs, 0o700);
    } else {
      // Symlink — the target string is used verbatim (may be
      // relative or absolute, including escaping paths, so tests
      // can prove refusal).
      symlinkSync(file.target, abs);
    }
  }
  await git(repoDir, ["add", "-A"]);
  const sha = (await git(repoDir, ["commit", "--allow-empty", "-m", spec.message])).trim();
  // `commit` prints something like `[base sha] message`. We can
  // ask for the actual SHA via `rev-parse HEAD` — cleaner than
  // parsing the commit output.
  void sha;
  return (await git(repoDir, ["rev-parse", "HEAD"])).trim();
}

/**
 * Build a fresh git repo with a base commit and a PR-head commit.
 * Returns both SHAs so a test can pass them straight into
 * `materializeSafeTree` / `computeToolingDiff`.
 *
 * The fixture uses `main` as the base ref and `pr` as the head ref;
 * both are ordinary local branches. `origin` is set to a github.com
 * URL for `vig-os/revkit` by default so the CLI's origin-remote
 * gate accepts the fixture; a test that needs a different origin
 * passes `originUrl`.
 *
 * `ensurePrCommits` is not exercised — the review tests stub the
 * GitRunner or skip the fetch by pre-populating refs directly.
 */
export async function makeFixtureRepo(input: {
  readonly base: CommitSpec;
  readonly head: CommitSpec;
  /** Origin URL to set on the fixture. Defaults to a
   * `vig-os/revkit`-shaped github.com URL so the CLI's owner/repo
   * gate accepts the default PR fixtures. */
  readonly originUrl?: string;
}): Promise<FixtureRepo> {
  const repoDir = mkdtempSync(join(tmpdir(), TMP_PREFIX));
  await git(repoDir, ["init", "-q", "--initial-branch=main"]);
  await git(repoDir, ["config", "commit.gpgSign", "false"]);
  await git(repoDir, ["config", "core.autocrlf", "false"]);
  await git(repoDir, ["config", "core.symlinks", "true"]);
  const baseSha = await applyCommit(repoDir, input.base);
  await git(repoDir, ["checkout", "-b", "pr"]);
  const headSha = await applyCommit(repoDir, input.head);
  // Return to main so `git diff base..head` in tests reads cleanly.
  await git(repoDir, ["checkout", "main"]);
  const originUrl = input.originUrl ?? "https://github.com/vig-os/revkit.git";
  await git(repoDir, ["remote", "add", "origin", originUrl]);
  return { repoDir, baseSha, headSha, baseRef: "main", headRef: "pr" };
}

/**
 * Pre-populate `refs/revkit/pr-<n>/head` so the CLI's post-fetch
 * verification (`readFetchedHeadSha`) finds a real SHA without a
 * network round-trip. Also touches `refs/heads/<baseRef>` (already
 * present by `makeFixtureRepo`) so the fetch-branch below is a
 * no-op. Call this after `makeFixtureRepo` and before
 * `runReviewCommand`.
 */
export async function writeReviewRefs(
  repoDir: string,
  input: { readonly pullNumber: number; readonly headSha: string },
): Promise<void> {
  await git(repoDir, [
    "update-ref",
    `refs/revkit/pr-${input.pullNumber}/head`,
    input.headSha,
  ]);
}

/** A `GitRunner` that intercepts `fetch … +refs/pull/<n>/head:…`
 * calls and rewrites them as a local `update-ref` — the fixture's
 * `origin` is not a real GitHub remote, so a real fetch fails.
 * Every other command is delegated to `spawnGit`. */
export function makeInterceptingGitRunner(input: {
  readonly repoDir: string;
  readonly pulls: ReadonlyMap<number, string>;
}): (args: readonly string[], cwd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return async (args, cwd) => {
    // The safe wrapper prepends its config overrides + `fetch` at
    // the end. Look for a fetch refspec of the form
    // `+refs/pull/<n>/head:refs/revkit/pr-<n>/head`.
    const fetchIdx = args.indexOf("fetch");
    if (fetchIdx !== -1) {
      const refspecArg = args.find((a) => /^\+refs\/pull\/\d+\/head:refs\/revkit\/pr-\d+\/head$/.test(a));
      if (refspecArg !== undefined) {
        const match = refspecArg.match(/^\+refs\/pull\/(\d+)\/head:refs\/revkit\/pr-\d+\/head$/);
        const num = Number.parseInt(match![1] ?? "", 10);
        const target = input.pulls.get(num);
        if (target === undefined) {
          return {
            stdout: "",
            stderr: `intercept: no head registered for PR #${num}\n`,
            exitCode: 1,
          };
        }
        // Rewrite as an `update-ref` — force it, so a stale ref
        // (from a previous run where head moved) is overwritten.
        const updateArgs = args
          .slice(0, fetchIdx)
          .concat([
            "update-ref",
            `refs/revkit/pr-${num}/head`,
            target,
          ]);
        return await spawnGit(updateArgs, cwd);
      }
    }
    return await spawnGit(args, cwd);
  };
}
