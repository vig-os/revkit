// `rehype-drop-repo-doc-title` — drop the leading `<h1>` from repo-doc
// pages BEFORE serialisation, without stripping it from the source.
//
// **Why in hast, not in source (PR #38 blocker 1).** The old loader
// path stripped the `# Title` line + trailing blank line from the raw
// markdown before `renderMarkdown`, so `rehype-data-src` stamped every
// downstream block with a position that was off by exactly the number
// of lines dropped (typically 2). That put 789 stamped blocks 2 lines
// early on every ADR/design/matrix page.
//
// Fix: keep the raw source, drop the first `<h1>` in hast. Positions
// are per-node, so removing the h1 doesn't shift its siblings — the
// paragraph on source line 3 keeps its `position.start.line = 3`, and
// `rehype-data-src` stamps it correctly.
//
// The plugin fires only when a predicate returns true for the current
// file (via VFile `path`). The Astro config passes a predicate that
// matches `<repoRoot>/docs/**/*.md` — repo-owned Markdown files —
// so site MDX (which needs its own h1 in the rendered body) is
// untouched.

import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Root, RootContent } from "hast";

/** Options accepted by the plugin. `repoRoot` is required so paths
 * can be compared to the repo's `docs/` directory. */
export interface DropRepoDocTitleOptions {
  /** Absolute path to the repository root. */
  readonly repoRoot: string;
  /** Optional predicate over a repo-relative POSIX path. Defaults to
   * "any `.md` file under `docs/`" — the repo-doc loader's set. */
  readonly matches?: (repoRelPath: string) => boolean;
}

/** Minimal VFile shape — see `rehype-data-src.ts` for the same
 * pattern. `data` is `unknown` so downstream extensions (Astro) do
 * not narrow this type. */
interface VFileLike {
  readonly path?: string;
  readonly history?: readonly string[];
  readonly data?: unknown;
}

/** Default predicate: `.md` files under `docs/` at the repo root.
 * Matches the source set the repo-docs loader ingests. */
function defaultMatches(repoRelPath: string): boolean {
  const lower = repoRelPath.toLowerCase();
  if (!lower.endsWith(".md")) return false;
  return lower.startsWith("docs/");
}

/** Resolve the source file's absolute path from a VFile. */
function filePathOf(file: VFileLike): string | undefined {
  if (typeof file.path === "string" && file.path.length > 0) return file.path;
  if (Array.isArray(file.history) && file.history.length > 0) {
    const last = file.history[file.history.length - 1];
    if (typeof last === "string" && last.length > 0) return last;
  }
  const data = file.data;
  if (data !== undefined && data !== null && typeof data === "object") {
    const astro = (data as { readonly astro?: unknown }).astro;
    if (astro !== undefined && astro !== null && typeof astro === "object") {
      const astroFileUrl = (astro as { readonly fileURL?: unknown }).fileURL;
      if (astroFileUrl instanceof URL) return fileURLToPath(astroFileUrl);
      if (typeof astroFileUrl === "string" && astroFileUrl.length > 0) {
        try {
          return fileURLToPath(new URL(astroFileUrl));
        } catch {
          return astroFileUrl;
        }
      }
    }
  }
  return undefined;
}

/** POSIX-normalised path relative to `repoRoot`, or undefined if the
 * file escapes the root. */
function repoRelativePosix(repoRoot: string, filePath: string): string | undefined {
  const rel = relative(resolve(repoRoot), resolve(filePath));
  if (rel.length === 0 || rel.startsWith("..")) return undefined;
  return sep === "/" ? rel : rel.split(sep).join("/");
}

/** True if a hast node is a whitespace-only text node (mdast-to-hast
 * inserts these between block elements). */
function isWhitespaceText(node: RootContent): boolean {
  return (
    node.type === "text" &&
    typeof node.value === "string" &&
    node.value.trim().length === 0
  );
}

/** Drop the first top-level `<h1>` element AND every whitespace-only
 * text node flanking it (before and after). Exported for direct-tree
 * testing. Returns true when a drop happened. */
export function dropLeadingH1(tree: Root): boolean {
  const children = tree.children;
  // Find the h1 (skipping leading whitespace text).
  let h1Index = 0;
  while (h1Index < children.length && isWhitespaceText(children[h1Index]!)) h1Index++;
  const first = children[h1Index];
  if (
    first === undefined ||
    first.type !== "element" ||
    first.tagName.toLowerCase() !== "h1"
  ) {
    return false;
  }
  // Cut from index 0 (drop leading whitespace too) through the last
  // trailing whitespace after the h1.
  let removeUntil = h1Index + 1;
  while (removeUntil < children.length && isWhitespaceText(children[removeUntil]!)) removeUntil++;
  tree.children = children.slice(removeUntil);
  return true;
}

/** The plugin. Matches unified's `Plugin<[Options], Root>` shape but
 * kept as a plain factory to sidestep the third-party type dependency. */
export function rehypeDropRepoDocTitle(options: DropRepoDocTitleOptions) {
  const repoRoot = resolve(options.repoRoot);
  const matches = options.matches ?? defaultMatches;
  return (tree: Root, file?: VFileLike): void => {
    if (file === undefined) return;
    const filePath = filePathOf(file);
    if (filePath === undefined) return;
    const rel = repoRelativePosix(repoRoot, filePath);
    if (rel === undefined) return;
    if (!matches(rel)) return;
    dropLeadingH1(tree);
  };
}

export default rehypeDropRepoDocTitle;
