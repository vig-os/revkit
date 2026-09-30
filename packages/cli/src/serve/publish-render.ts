// Fast-path renderer for `POST /api/publish` (M2 item 9, story A4,
// ADR-0001 amendment).
//
// The daemon takes a repo-relative `.md` path plus the new source
// bytes and returns the article HTML fragment plus the block-level
// `data-src` stamps the rail anchors on. The pipeline mirrors
// `site/astro.config.mjs` exactly for `.md` files:
//
//   remark-parse
//     → remark-math
//       → remark-rehype
//         → rehype-katex-strict (trust: false)
//           → rehype-drop-repo-doc-title (repo docs only)
//             → rehype-data-src (repoRoot)
//               → rehype-stringify
//
// Note the ordering: `rehype-data-src` runs AFTER
// `rehype-drop-repo-doc-title` so a dropped `<h1>` doesn't leave
// stamped anchors pointing at empty positions; and AFTER
// `rehype-katex-strict` so KaTeX's own hast subtree does not carry
// data-src stamps (KaTeX-generated spans have no source position).
//
// The renderer does NOT wrap the fragment in the Starlight page
// layout — the daemon takes the existing built HTML for the target
// route as the "shell" and swaps only the inner article body. That
// keeps the sidebar/nav/CSP-safe scripts unchanged, so a publish
// that only rewrites content produces a page that byte-matches a
// full build outside the `<article>` region (proven by
// `test/serve/publish-equivalence.test.ts`).
//
// **Scope (M2)**: `.md` files under `docs/adr/`, `docs/designs/`
// and `docs/FEATURE-MATRIX.md`. MDX (`site/src/content/docs/*.mdx`)
// needs the mdx-to-hast pipeline plus starlight expressive-code and
// is documented as a follow-up in the ADR-0001 amendment shipped
// with this PR.

import { extname } from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { rehypeDataSrc } from "../rehype-data-src.ts";
import { rehypeDropRepoDocTitle } from "../rehype-drop-repo-doc-title.ts";
import { rehypeKatexStrict } from "../../../../site/src/lib/rehype-katex-strict.ts";

/** Options accepted by the fast-path renderer. */
export interface RenderDocOptions {
  /** Absolute repo root (matches `startDaemon`'s `repoRoot`). */
  readonly repoRoot: string;
  /** Repo-relative POSIX path of the source file. */
  readonly path: string;
  /** LF-normalised source (matches `revisionOf`'s normalisation). */
  readonly source: string;
}

/** Result of `renderDocFragment`. `html` is the serialised article
 * body — the string that goes into the site's `<article>` element.
 * `dataSrcCount` is the number of block-level anchors stamped, so
 * the caller can log the coverage. */
export interface RenderDocResult {
  readonly html: string;
  readonly dataSrcCount: number;
}

/** File extensions the fast-path knows how to render. `.mdx` is
 * excluded (see file header). */
export const RENDERABLE_EXTENSIONS: readonly string[] = Object.freeze([".md"]);

/** Return true when `path` is one the renderer can produce a
 * fragment for. Callers that hit a non-renderable path still emit
 * `doc.published` (the file was written to disk and re-anchoring
 * ran); they just skip the override injection. */
export function isRenderablePath(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return RENDERABLE_EXTENSIONS.includes(ext);
}

/** Run the fast-path pipeline. Same plugins, same order, same
 * options as `site/astro.config.mjs`; the only difference is
 * `remark-rehype` between them (in `astro.config.mjs` this hop is
 * implicit through `@astrojs/markdown-remark`). Returns the HTML
 * fragment that goes INSIDE the site's `<article>` element.
 *
 * `data-src` stamps use POSIX paths (see `rehype-data-src.ts`), so
 * an output produced on Windows CI still names paths the rail can
 * match against on any platform.
 *
 * A file outside `RENDERABLE_EXTENSIONS` throws — the caller checks
 * `isRenderablePath` first. This is a Bun runtime primitive on the
 * loopback daemon, so a synchronous error is the right shape (the
 * request handler will map it to a 400). */
export async function renderDocFragment(options: RenderDocOptions): Promise<RenderDocResult> {
  if (!isRenderablePath(options.path)) {
    throw new Error(
      `renderDocFragment: path '${options.path}' is not a renderable extension (${RENDERABLE_EXTENSIONS.join(", ")}).`,
    );
  }
  // Count `data-src` stamps by scanning the final HTML — the plugin
  // itself doesn't expose a counter through the unified pipe, and
  // rebuilding the pipe with a counter-taking variant would double
  // the wire.
  const processor = unified()
    .use(remarkParse)
    .use(remarkMath)
    .use(remarkRehype)
    .use(rehypeKatexStrict, { trust: false })
    .use(rehypeDropRepoDocTitle, { repoRoot: options.repoRoot })
    .use(rehypeDataSrc, { repoRoot: options.repoRoot })
    .use(rehypeStringify);
  // `remark-parse` reads `value` from a VFile; we pass `path` too so
  // the two rehype plugins that key on the file's location
  // (`rehype-drop-repo-doc-title` and `rehype-data-src`) see the
  // same repo-relative path Astro would hand them.
  const vfile = await processor.process({
    value: options.source,
    path: `${options.repoRoot}/${options.path}`,
  });
  const html = String(vfile);
  // A cheap counter over the emitted attribute string — no HTML
  // parse. `data-src="…"` is the exact spelling `rehype-data-src`
  // emits (single attribute, ASCII bytes only in the attribute
  // name), so a string count is unambiguous.
  const dataSrcCount = countOccurrences(html, ` data-src="`);
  return { html, dataSrcCount };
}

/** Count non-overlapping occurrences of `needle` in `haystack`.
 * `haystack.split(needle).length - 1` builds an intermediate array
 * we don't need, so a small `indexOf` loop is both clearer and
 * slightly faster on large HTML. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  while (true) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count++;
    from = at + needle.length;
  }
}
