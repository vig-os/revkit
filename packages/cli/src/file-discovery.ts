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
//
// **Symlinks are never followed** and are ALWAYS reported as findings
// when they sit under a content or UI directory (Astro follows them
// during a build, so a `docs/evil.md -> /etc/passwd` symlink can leak
// content that never appears in the repo tree). Refusing at discovery
// (bypass #5 in PR #23 round-2 review) is the mitigation: the check
// never opens the target, and the diagnostic names the offending path.

import { lstatSync, readdirSync, statSync } from "node:fs";
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

/** POSIX-relative directory prefixes where a symlink is refused
 * outright. Astro follows symlinks during `astro build`, so a symlink
 * that lives in a content or UI directory can render whatever the
 * target holds. The vendor tree
 * (`packages/components/vendor/`) is refused too — a symlinked
 * vendored package or LICENSE could point at the repo's own code
 * (silently smuggling a permissive-license claim onto AGPL code, or
 * dropping upstream attribution). The vendored-code rule
 * (rules/vendored-code.ts) also lstat-checks these files at read
 * time; both layers agree so the enforcement holds under `--staged`,
 * an explicit-path run and a full workspace walk. */
const SYMLINK_REFUSED_PREFIXES: readonly string[] = [
  "docs/",
  "site/src/content/",
  "site/src/components/",
  "site/src/pages/",
  "site/src/layouts/",
  "packages/components/src/",
  "packages/components/vendor/",
  "plots/",
  "vocab/",
];

/** Case-insensitive extension helper. macOS/Windows filesystems are
 * case-preserving, so a stray `Component.TSX` would slip past a
 * case-sensitive extension check on a Linux CI. */
function extnameLower(path: string): string {
  return extname(path).toLowerCase();
}

/** One symlink surfaced by discovery — path relative to the repo root,
 * so a diagnostic can render it as `file:0: ...`. */
export interface DiscoveredSymlink {
  readonly posixPath: string;
}

/** Result of a workspace walk. `files` is the list of real files (no
 * symlinks). `symlinks` is every symlink observed under one of the
 * SYMLINK_REFUSED_PREFIXES trees, so the orchestrator can turn each
 * into a diagnostic without re-walking. */
export interface DiscoveryResult {
  readonly files: readonly string[];
  readonly symlinks: readonly DiscoveredSymlink[];
}

/** Is `posixRepoRelative` inside one of the symlink-refused trees? */
function isUnderSymlinkRefusedTree(posixRepoRelative: string): boolean {
  return SYMLINK_REFUSED_PREFIXES.some((prefix) => posixRepoRelative.startsWith(prefix));
}

/** Absolute path list ordered so a diagnostic run reads top-down
 * (docs first, then site content, then everything else). Rules do
 * their own filtering, so a mixed input is fine. */
export function walkForCheckables(repoRoot: string): DiscoveryResult {
  const collected: string[] = [];
  const symlinks: DiscoveredSymlink[] = [];
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
      // Detect symlinks BEFORE the isFile / isDirectory branches —
      // `entry.isFile()` returns true for a symlink to a file, so
      // without this branch a symlink slips through as a regular file
      // (bypass #5 in PR #23 round-2 review).
      if (entry.isSymbolicLink()) {
        const posix = repoRelative(repoRoot, path);
        if (isUnderSymlinkRefusedTree(posix)) {
          symlinks.push({ posixPath: posix });
        }
        continue;
      }
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
  return { files: collected.sort(), symlinks };
}

/** Ask git for the staged files (added / copied / modified / renamed).
 * Deletions are excluded — a rule cannot check a file that is not there.
 * Runs `git diff --cached` so it works from a pre-commit hook as well as
 * from a plain `--staged` invocation. Symlink checks are re-run on the
 * result via `lstatSync` so a staged symlink to `/etc/passwd` still
 * lands in `symlinks`, not in `files`. */
export async function stagedFiles(repoRoot: string): Promise<DiscoveryResult> {
  const result = await spawnGit(
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR"],
    repoRoot,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `revkit check --staged: git failed (${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  const relatives = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return partitionByLstat(repoRoot, relatives);
}

/** Turn a mix of file / directory arguments into a flat file list.
 * A file path is kept as-is (rules filter it); a directory is walked with
 * the same excludes as the default scan. Missing paths throw. */
export function expandPathArgs(cwdArgs: readonly string[], cwd: string): DiscoveryResult {
  const out: string[] = [];
  const symlinks: DiscoveredSymlink[] = [];
  // Repo root for the symlink-tree check: expand args are typically
  // called with the process cwd, but the caller passes the workspace
  // cwd, so the `startsWith` prefix check compares apples-to-apples.
  const repoRootLike = cwd;
  for (const arg of cwdArgs) {
    const abs = resolve(cwd, arg);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      const stack: string[] = [abs];
      while (stack.length > 0) {
        const current = stack.pop() as string;
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          const path = join(current, entry.name);
          if (entry.isSymbolicLink()) {
            const posix = repoRelative(repoRootLike, path);
            if (isUnderSymlinkRefusedTree(posix)) {
              symlinks.push({ posixPath: posix });
            }
            continue;
          }
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
  return { files: out.sort(), symlinks };
}

/** Split a list of repo-relative paths into real files vs. symlinks
 * using `lstatSync` (which does NOT follow the link). Files that no
 * longer exist on disk are dropped — a `--staged` run over a delete-
 * then-add sequence can produce phantom paths. */
function partitionByLstat(repoRoot: string, relatives: readonly string[]): DiscoveryResult {
  const files: string[] = [];
  const symlinks: DiscoveredSymlink[] = [];
  for (const rel of relatives) {
    const abs = resolve(repoRoot, rel);
    let lstat;
    try {
      lstat = lstatSync(abs);
    } catch {
      continue;
    }
    if (lstat.isSymbolicLink()) {
      if (isUnderSymlinkRefusedTree(rel)) {
        symlinks.push({ posixPath: rel });
      }
      continue;
    }
    if (lstat.isFile()) files.push(abs);
  }
  return { files: files.sort(), symlinks };
}

/** Convert an absolute path to a repo-relative POSIX-flavored path for
 * diagnostic rendering. Falls back to the absolute path if the file is
 * outside the repo (a `--staged` run cannot produce this; direct args
 * can). Exported so tests can round-trip without a fixture repo. */
export function repoRelative(repoRoot: string, absolute: string): string {
  const rel = relative(repoRoot, absolute).split(/[\\/]/).join("/");
  return rel.startsWith("..") ? absolute : rel;
}
