// Compute the **tooling diff** — the set of NON-CONTENT paths that
// differ between the PR base and the PR head. ADR-0025 refuses to
// build a PR whose tooling differs from base unless the reviewer
// passes `--trust <sha>` that pins to the exact head commit.
//
// The diff is computed on the git object DB (no working tree needed):
//   `git diff --name-only <base>..<head>` gives every path that
//   differs. Each path is then classified as `content` (see
//   `content-allowlist.ts`) or `tooling`; the tooling set is what
//   `--trust` gates.
//
// Additional statuses come from `git diff --raw` so we can spot a
// path that has FLIPPED its "content vs tooling" character (e.g.
// `.github/workflows/foo.yml.mdx` → tooling because it isn't inside
// a content prefix) or a rename that shifts a file across the
// boundary.

import type { GitRunner } from "../git-runner.ts";
import { classifyPath, isUnderContentPrefix } from "./content-allowlist.ts";
import { runSafeGitOrThrow } from "./git-safe.ts";

/** One classified change between base and head. `kind: "modify"`
 * covers add, modify and delete; the caller only needs to know the
 * path changed, not the specific status, to decide whether to demand
 * `--trust`. `kind: "rename"` names both the old and new paths so the
 * printed diagnostic can show "renamed X → Y". */
export type ToolingChange =
  | { readonly kind: "modify"; readonly path: string; readonly class: "content" | "tooling"; readonly extNote?: string }
  | { readonly kind: "rename"; readonly oldPath: string; readonly newPath: string; readonly class: "content" | "tooling"; readonly extNote?: string };

/** Result of `computeToolingDiff`. `tooling` is the subset of `all`
 * that failed the content-allowlist — the set `--trust` gates.
 * `mergeBase` is the merge-base SHA the diff was computed against
 * (PR #48 round-2 nit). */
export interface ToolingDiff {
  readonly all: readonly ToolingChange[];
  readonly tooling: readonly ToolingChange[];
  readonly content: readonly ToolingChange[];
  readonly mergeBase: string;
}

/**
 * Enumerate the changed paths between the **merge-base of base and
 * head** and `head`, then classify each. Using the merge-base (not
 * the base tip) means a stale PR is not refused for changes that
 * happened on base after the PR forked (PR #48 round-2 nit).
 *
 * The three-dot form `A...B` in `git diff` is exactly that:
 * changes from the merge-base of A and B up to B, ignoring anything
 * on A that happened after the fork point.
 *
 * @param runner git runner (the injectable `GitRunner`)
 * @param cwd    directory containing the repo whose object DB the
 *               commits are in
 * @param baseSha commit SHA of the PR base (a branch tip)
 * @param headSha commit SHA of the PR head
 */
export async function computeToolingDiff(
  runner: GitRunner,
  cwd: string,
  baseSha: string,
  headSha: string,
): Promise<ToolingDiff> {
  // Resolve the merge-base explicitly so we can name it in error
  // messages and so a caller (e.g. materialise, later) can reuse it.
  // `git merge-base <a> <b>` prints the SHA or exits non-zero if
  // there is none (disjoint histories); the safe wrapper surfaces
  // the failure verbatim.
  const mbStdout = await runSafeGitOrThrow(
    runner,
    cwd,
    ["merge-base", baseSha, headSha],
    `tooling-diff: git merge-base ${baseSha} ${headSha} failed`,
  );
  const mergeBase = mbStdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(mergeBase)) {
    throw new Error(
      `tooling-diff: git merge-base returned implausible SHA ${JSON.stringify(mergeBase.slice(0, 80))}`,
    );
  }
  // `git diff --name-status -z` uses NUL as record separator, which
  // handles paths with spaces / newlines. `--find-renames` surfaces
  // rename statuses as `Rnnn\0<old>\0<new>`.
  const stdout = await runSafeGitOrThrow(
    runner,
    cwd,
    [
      "diff",
      "--name-status",
      "--find-renames",
      "-z",
      // Merge-base .. head — see docstring.
      mergeBase,
      headSha,
    ],
    `tooling-diff: git diff ${mergeBase}..${headSha} failed`,
  );

  const changes: ToolingChange[] = [];
  // NUL-separated record parsing: status tokens are NUL-terminated,
  // most records are STATUS-NUL-PATH-NUL, renames are
  // R-SCORE-NUL-OLD-NUL-NEW-NUL.
  const parts = stdout.split("\0");
  let i = 0;
  while (i < parts.length) {
    const status = parts[i];
    if (status === undefined || status.length === 0) {
      i++;
      continue;
    }
    const first = status[0];
    if (first === "R" || first === "C") {
      const oldPath = parts[i + 1] ?? "";
      const newPath = parts[i + 2] ?? "";
      i += 3;
      if (oldPath.length === 0 || newPath.length === 0) continue;
      // Both sides are classified. If either is tooling, the whole
      // change is tooling (a rename FROM content TO tooling means a
      // new tooling file appears; a rename FROM tooling TO content
      // means a base tooling file disappears).
      const cls =
        classifyPath(oldPath) === "tooling" || classifyPath(newPath) === "tooling"
          ? "tooling"
          : "content";
      const extNote = extensionNoteForRename(oldPath, newPath);
      changes.push(
        extNote !== undefined
          ? { kind: "rename", oldPath, newPath, class: cls, extNote }
          : { kind: "rename", oldPath, newPath, class: cls },
      );
    } else {
      // A / M / D / T / U — one path.
      const path = parts[i + 1] ?? "";
      i += 2;
      if (path.length === 0) continue;
      const cls = classifyPath(path);
      const extNote = extensionNoteForModify(path);
      changes.push(
        extNote !== undefined
          ? { kind: "modify", path, class: cls, extNote }
          : { kind: "modify", path, class: cls },
      );
    }
  }

  const tooling = changes.filter((c) => c.class === "tooling");
  const content = changes.filter((c) => c.class === "content");
  return { all: changes, tooling, content, mergeBase };
}

/** Human note about why an under-content-prefix path was still
 * classified as tooling. Only fires for a file whose containing
 * directory IS on the allowlist — a `.js` in `plots/` slips through
 * the prefix check but fails the extension check, and the operator
 * wants to know why the tooling gate refused. */
function extensionNoteForModify(path: string): string | undefined {
  if (classifyPath(path) === "content") return undefined;
  if (!isUnderContentPrefix(path)) return undefined;
  return `under content prefix but extension not in the content allowlist`;
}

/** Same idea for renames. Applies to whichever side is under a
 * content prefix but still classifies as tooling. */
function extensionNoteForRename(oldPath: string, newPath: string): string | undefined {
  const noteNew = extensionNoteForModify(newPath);
  if (noteNew !== undefined) return noteNew;
  const noteOld = extensionNoteForModify(oldPath);
  return noteOld;
}

/**
 * Render the tooling diff as a bulleted list suitable for printing to
 * stdout when refusing the build (or when `--trust` is passed and we
 * still want to show what was trusted). The order matches the git-diff
 * order the caller passed in.
 */
export function formatToolingDiff(diff: ToolingDiff): string {
  if (diff.tooling.length === 0) return "";
  const lines: string[] = [];
  for (const change of diff.tooling) {
    if (change.kind === "modify") {
      lines.push(
        `  - ${change.path}` +
          (change.extNote !== undefined ? `  (${change.extNote})` : ""),
      );
    } else {
      lines.push(
        `  - ${change.oldPath} → ${change.newPath}` +
          (change.extNote !== undefined ? `  (${change.extNote})` : ""),
      );
    }
  }
  return lines.join("\n");
}
