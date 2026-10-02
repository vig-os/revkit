// `rehype-rewrite-md-links` — the ONE place `.md` cross-doc links
// get rewritten to their site route (or a GitHub blob URL for
// files outside the publishable set). Kept as a rehype plugin so
// BOTH the full build (via Astro's markdown config) AND the
// fast-path renderer see the same transform on the same source —
// the string post-processing pass the earlier repo-docs loader
// ran (see `rewriteInternalMarkdownLinks`) always ran ONLY on the
// full build's output, so a fast-path render emitted raw
// `../designs/DESIGN-0001….md` where the full build had
// `/designs/design-0001-…/` and every cross-doc link 404'd after
// a publish (PR-56 round 2 blocker 1a).
//
// The plugin walks the hast tree and rewrites every `<a href>`
// attribute whose target ends with `.md` (with or without a
// fragment). Absolute URLs (`https:`, `mailto:`, protocol-
// relative `//`, in-page `#`) pass through unchanged.
//
// Routing rules match `site/src/content/loaders/repo-docs.ts::
// siteRouteForDoc`: `docs/adr/<slug>.md` → `/adr/<slug>/` (slug
// lowercased); same shape for designs; `docs/FEATURE-MATRIX.md`
// → `/feature-matrix/`. Everything else becomes a GitHub blob
// URL on `main` (the fixed default branch, so a link stays live
// after a feature branch is deleted).

import type { Element, Root } from "hast";
import { dirname, relative, resolve } from "node:path";
import { posix } from "node:path";
import type { VFileLike } from "./rehype-vfile.ts";
import { filePathOf } from "./rehype-vfile.ts";

/** GitHub blob URL prefix (pinned to `main`). Matches the constant
 * in the loader; kept local so a change here needs a matching
 * change in the loader, on purpose — the two consumers must
 * always agree on where to send a non-publishable link. */
const GITHUB_BLOB_BASE = "https://github.com/vig-os/revkit/blob/main/";

/** Options accepted by the plugin. */
export interface RewriteMdLinksOptions {
  /** Absolute repo root — the plugin computes repo-relative paths
   * from the source file's absolute path against this root. */
  readonly repoRoot: string;
  /** Skip when the vfile has no path (a bare test source). */
  readonly skipWithoutPath?: boolean;
}

/** Map a repo-relative `.md` path to its site route, or `null`
 * when the doc is not one of the publishable roots. Mirrors the
 * loader's `siteRouteForDoc` — kept a local copy so this plugin
 * has no cross-package dep on the site tree. */
export function siteRouteForDoc(repoRelative: string): string | null {
  if (repoRelative === "docs/FEATURE-MATRIX.md") return "/feature-matrix/";
  const adrMatch = repoRelative.match(/^docs\/adr\/(.+)\.md$/);
  if (adrMatch !== null && adrMatch[1] !== undefined) {
    return `/adr/${adrMatch[1].toLowerCase()}/`;
  }
  const designMatch = repoRelative.match(/^docs\/designs\/(.+)\.md$/);
  if (designMatch !== null && designMatch[1] !== undefined) {
    return `/designs/${designMatch[1].toLowerCase()}/`;
  }
  return null;
}

/** Walk every element in a hast tree, iteratively. Kept local so
 * the plugin doesn't pull in `unist-util-visit` for a two-line
 * walk. */
function walk(node: Root | Element, visitor: (element: Element) => void): void {
  const stack: (Root | Element)[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    if (current.type === "element") visitor(current);
    for (const child of current.children) {
      if (child.type === "element") stack.push(child);
    }
  }
}

export function rehypeRewriteMdLinks(options: RewriteMdLinksOptions) {
  const skipWithoutPath = options.skipWithoutPath ?? true;
  return (tree: Root, file?: VFileLike): void => {
    const sourceAbs = filePathOf(file ?? {});
    if (skipWithoutPath && sourceAbs === undefined) return;
    const sourceDir = sourceAbs !== undefined ? dirname(sourceAbs) : options.repoRoot;
    walk(tree, (element) => {
      if (element.tagName !== "a") return;
      const props = element.properties;
      if (props === undefined || props === null) return;
      const rawHref = props.href;
      if (typeof rawHref !== "string") return;
      const rewritten = rewriteHref(rawHref, sourceDir, options.repoRoot);
      if (rewritten !== rawHref) props.href = rewritten;
    });
  };
}

/** Rewrite ONE `href` value. Exported so the equivalence and unit
 * tests can exercise the mapping in isolation. */
export function rewriteHref(
  href: string,
  sourceDirAbsolute: string,
  repoRoot: string,
): string {
  // External / mailto / protocol-relative / fragment-only: pass through.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  if (href.startsWith("//") || href.startsWith("#")) return href;
  // Only `.md` (with optional fragment) is rewritten. Anything
  // else (assets, subpaths of images) is left as-is — the
  // markdown renderer's own resolution stays authoritative.
  const mdMatch = href.match(/^([^#?]+\.md)(#[^?]*)?$/i);
  if (mdMatch === null) return href;
  const relativeMdPath = mdMatch[1]!;
  const fragment = mdMatch[2] ?? "";
  const targetAbsolute = resolve(sourceDirAbsolute, relativeMdPath);
  const repoRelative = posix.normalize(
    relative(repoRoot, targetAbsolute).split(/[\\/]/).join("/"),
  );
  const route = siteRouteForDoc(repoRelative);
  if (route !== null) return `${route}${fragment}`;
  return `${GITHUB_BLOB_BASE}${repoRelative}${fragment}`;
}
