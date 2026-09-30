// Hardened wrapper around the injectable `GitRunner`. Every git call
// the review-safe build makes goes through `runSafeGit` so a hostile
// PR cannot influence git's own execution path.
//
// **The rules** (each one blocks a concrete attack against `revkit
// review <pr>`):
//
//   1. `-c core.hooksPath=/dev/null`
//      A PR that adds a hook (`.git/hooks/post-checkout`, or a
//      `.githooks/` entry via `core.hooksPath`) would run on checkout.
//      We never let git run any hook. `/dev/null` is a directory (an
//      "empty hooks dir") to git's runtime, so hook scripts are never
//      resolved.
//
//   2. `-c protocol.file.allow=never`
//      Refuses `file://`, `--upload-pack`-style submodule origins, and
//      the `.gitmodules → file://` chain. This is the CVE-2022-39253
//      protection surfaced as a config so old git binaries also refuse
//      it.
//
//   3. `-c protocol.ext.allow=never`
//      Refuses the `ext::` transport that would let a repo config point
//      at an arbitrary command as the transport.
//
//   4. `-c core.attributesFile=/dev/null` and
//      `-c core.excludesFile=/dev/null`
//      A PR's `.gitattributes` might declare filter/smudge drivers
//      (arbitrary commands run on checkout). We disable the per-repo
//      attributes lookup by pointing to /dev/null AND never invoke a
//      command that would touch the working tree; the materializer
//      reads blobs directly, so filters are never asked to run.
//
//   5. `-c fetch.recurseSubmodules=no` and `-c submodule.recurse=false`
//      Submodule URLs come from a PR-controlled `.gitmodules`. We
//      never recurse.
//
//   6. `-c gpg.program=/bin/false`
//      A PR might set `commit.gpgsign=true` via `.git/config` — not
//      applicable to a fetch, but we never invoke a commit through
//      this wrapper either.
//
//   7. `--no-optional-locks` (argv-level)
//      Git's optional locks are safe; we drop them anyway so a
//      long-running `revkit review` cannot fight with a concurrent
//      `git status` in another shell.
//
//   8. **No `-c core.symlinks`**: we never `checkout` through this
//      wrapper, so a symlink written to disk by git is impossible.
//      The materializer refuses symlinks itself.
//
// The wrapper takes the same injectable `GitRunner` the rest of the
// CLI uses so unit tests exercise argument construction without ever
// spawning git.

import type { GitResult, GitRunner } from "../git-runner.ts";

/** A brand token — a value of this type can only be produced inside
 * `git-safe.ts`. The brand field is a MODULE-LOCAL symbol, so
 * TypeScript refuses any structural equivalent from another module
 * (only this file exports the wrapper that sets it). The branding
 * is nominal, not structural (PR #48 round-3 nit).
 *
 * Every review-module function that takes a git runner accepts
 * `SafeGitRunner`, not the raw `GitRunner`. The type checker then
 * enforces the "no direct git call" rule that previously depended
 * on a grep test.
 */
const SAFE_GIT_BRAND: unique symbol = Symbol("revkit.safe-git-brand");

/** Nominal-brand type for a git runner that is guaranteed to route
 * through the hardened wrapper. Only `wrapSafeGitRunner` (below) can
 * produce a value of this type — external modules cannot forge one
 * because they don't have access to the module-local
 * `SAFE_GIT_BRAND` symbol. */
export interface SafeGitRunner {
  readonly run: (args: readonly string[], cwd: string) => Promise<GitResult>;
  readonly [SAFE_GIT_BRAND]: true;
}

/** Wrap a raw `GitRunner` — the injectable seam every command uses
 * — into a `SafeGitRunner`. The returned runner prefixes every call
 * with `SAFE_GIT_TOPLEVEL_FLAGS` and `SAFE_GIT_CONFIG_OVERRIDES` (no
 * hooks, no submodules, no filter/smudge, no `protocol.file`, no
 * `protocol.ext`). */
export function wrapSafeGitRunner(raw: GitRunner): SafeGitRunner {
  return {
    run: async (args, cwd) => await raw(buildSafeGitArgs(args), cwd),
    [SAFE_GIT_BRAND]: true,
  };
}

/** The `-c key=value` pairs prefixed onto every safe git invocation.
 * Frozen so a caller cannot mutate the array and silently disable a
 * rule. */
export const SAFE_GIT_CONFIG_OVERRIDES: readonly string[] = Object.freeze([
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "protocol.file.allow=never",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.excludesFile=/dev/null",
  "-c",
  "fetch.recurseSubmodules=no",
  "-c",
  "submodule.recurse=false",
  "-c",
  "gpg.program=/bin/false",
]);

/** Argv flags that ride at the top level (before the subcommand). */
export const SAFE_GIT_TOPLEVEL_FLAGS: readonly string[] = Object.freeze([
  "--no-optional-locks",
]);

/**
 * Build the full argv the safe git runner would spawn for a given
 * subcommand argv. Exposed as a pure function so a unit test can
 * assert on the constructed command without running git.
 */
export function buildSafeGitArgs(subcommandArgs: readonly string[]): readonly string[] {
  return [...SAFE_GIT_TOPLEVEL_FLAGS, ...SAFE_GIT_CONFIG_OVERRIDES, ...subcommandArgs];
}

/**
 * Invoke `git` in `cwd` through `runner` with the safe prefix. Errors
 * throw a `SafeGitError` carrying the exit code and stderr — the
 * caller decides whether to wrap it in a domain-specific message
 * (e.g. "PR not found on remote") or propagate.
 *
 * Accepts either a raw `GitRunner` (legacy in-file helper, kept for
 * `wrapSafeGitRunner`'s implementation) or a `SafeGitRunner`, so
 * both call shapes converge on the same output.
 */
export async function runSafeGit(
  runner: GitRunner | SafeGitRunner,
  cwd: string,
  subcommandArgs: readonly string[],
): Promise<GitResult> {
  if (typeof runner === "function") {
    const args = buildSafeGitArgs(subcommandArgs);
    return await runner(args, cwd);
  }
  return await runner.run(subcommandArgs, cwd);
}

/** Runtime failure surfacing a non-zero git exit through a typed
 * class so callers can catch it precisely. */
export class SafeGitError extends Error {
  readonly exitCode: number;
  readonly stderr: string;
  constructor(message: string, exitCode: number, stderr: string) {
    super(message);
    this.name = "SafeGitError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** Convenience: throw a `SafeGitError` if the git call failed. */
export async function runSafeGitOrThrow(
  runner: GitRunner | SafeGitRunner,
  cwd: string,
  subcommandArgs: readonly string[],
  contextMessage: string,
): Promise<string> {
  const result = await runSafeGit(runner, cwd, subcommandArgs);
  if (result.exitCode !== 0) {
    throw new SafeGitError(
      `${contextMessage} (git exit ${result.exitCode}): ${result.stderr.trim()}`,
      result.exitCode,
      result.stderr,
    );
  }
  return result.stdout;
}
