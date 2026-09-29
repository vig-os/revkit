// File discovery for `revkit check`. The CLI has three input modes:
//
// - `--staged`: files git says are staged (pre-commit path). Renames land
//   under their new name; deletions are excluded — nothing to check.
// - explicit `<paths...>`: exactly what the user typed, made absolute.
// - default (no args): every content-shaped file in the workspace that
//   any rule would consider. Excludes vendored directories, `node_modules`,
//   `dist`, `.direnv` and Astro's build cache so a full run stays sub-second.
//
// A path may be a file OR a directory; directories are walked recursively.
// The walk is a stack-based DFS (no recursion into user-controlled trees).

import { readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { spawnGit } from "./git-runner.ts";

/** Directory names that are never worth scanning. `node_modules` shows up
 * under packages/, site/ and the workspace root; `dist` and `.astro` are
 * build outputs; `.direnv` and `.git` are tool state. */
const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  ".astro",
  ".direnv",
  ".git",
  ".vscode",
  ".github_data",
]);

/** Extensions any rule looks at. `.json`/`.yaml`/`.yml` cover
 * plots/vocab; `.md`/`.mdx` cover content; `.astro`/`.tsx`/`.jsx`/
 * `.vue`/`.svelte`/`.html`/`.htm` cover the no-hand-rolled-UI rule's
 * UI-shape allowlist; `.js`/`.ts`/`.mjs`/`.cjs`/`.mts`/`.cts` cover the
 * "no code modules in content directories" branch. Matched
 * case-insensitively by `extnameLower`. Sorted for a stable
 * listing. */
const CONSIDERED_EXTENSIONS: ReadonlySet<string> = new Set([
  ".astro",
  ".cjs",
  ".cts",
  ".htm",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mdx",
  ".mjs",
  ".mts",
  ".svelte",
  ".ts",
  ".tsx",
  ".vue",
  ".yaml",
  ".yml",
]);

/** Case-insensitive extension helper. macOS/Windows filesystems are
 * case-preserving, so a stray `Component.TSX` would slip past a
 * case-sensitive extension check on a Linux CI. */
function extnameLower(path: string): string {
  return extname(path).toLowerCase();
}

/** Absolute path list ordered so a diagnostic run reads top-down (docs
 * first, then site content, then everything else). Rules do their own
 * filtering, so a mixed input is fine. */
export function walkForCheckables(repoRoot: string): string[] {
  const collected: string[] = [];
  const stack: string[] = [repoRoot];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        stack.push(path);
      } else if (entry.isFile()) {
        if (CONSIDERED_EXTENSIONS.has(extnameLower(entry.name))) {
          collected.push(path);
        }
      }
    }
  }
  return collected.sort();
}

/** Ask git for the staged files (added / copied / modified / renamed).
 * Deletions are excluded — a rule cannot check a file that is not there.
 * Runs `git diff --cached` so it works from a pre-commit hook as well as
 * from a plain `--staged` invocation. */
export async function stagedFiles(repoRoot: string): Promise<string[]> {
  const result = await spawnGit(
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR"],
    repoRoot,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `revkit check --staged: git failed (${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((relPath) => resolve(repoRoot, relPath))
    .sort();
}

/** Turn a mix of file / directory arguments into a flat file list.
 * A file path is kept as-is (rules filter it); a directory is walked with
 * the same excludes as the default scan. Missing paths throw. */
export function expandPathArgs(cwdArgs: readonly string[], cwd: string): string[] {
  const out: string[] = [];
  for (const arg of cwdArgs) {
    const abs = resolve(cwd, arg);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      const stack: string[] = [abs];
      while (stack.length > 0) {
        const current = stack.pop() as string;
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          const path = join(current, entry.name);
          if (entry.isDirectory()) {
            if (EXCLUDED_DIRS.has(entry.name)) continue;
            stack.push(path);
          } else if (entry.isFile()) {
            out.push(path);
          }
        }
      }
    } else if (stat.isFile()) {
      out.push(abs);
    }
  }
  return out.sort();
}

/** Convert an absolute path to a repo-relative POSIX-flavored path for
 * diagnostic rendering. Falls back to the absolute path if the file is
 * outside the repo (a `--staged` run cannot produce this; direct args
 * can). Exported so tests can round-trip without a fixture repo. */
export function repoRelative(repoRoot: string, absolute: string): string {
  const rel = relative(repoRoot, absolute).split(/[\\/]/).join("/");
  return rel.startsWith("..") ? absolute : rel;
}
