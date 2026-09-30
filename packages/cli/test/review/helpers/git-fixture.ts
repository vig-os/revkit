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
 * both are ordinary local branches (no remotes are configured, so
 * `ensurePrCommits` is not exercised — every review test that needs
 * that behaviour stubs the GitRunner instead).
 */
export async function makeFixtureRepo(input: {
  readonly base: CommitSpec;
  readonly head: CommitSpec;
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
  return { repoDir, baseSha, headSha, baseRef: "main", headRef: "pr" };
}
