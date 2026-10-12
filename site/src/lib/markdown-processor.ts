// Shared markdown pipeline configuration used by BOTH `site/astro.config.mjs`
// (the full build) AND `packages/cli/src/serve/publish.ts` (the fast-path
// renderer for M2 item 9, story A4).
//
// The rule the ADR-0001 fast-path amendment sets is that publish's HTML
// output MUST equal a real `astro build` result on the same source —
// same `data-src` stamps, same block structure, same registered
// components, same rehype-katex output. Two copies of the plugin list
// would drift; one config file that both consumers import removes that
// class of bug entirely.
//
// The exported factory `buildSharedMarkdownConfig(repoRoot)` returns
// the plugin arrays Astro's `markdown` block wants AND the shape
// `createMarkdownProcessor()` accepts, so the daemon reconstructs
// exactly the same pipeline off the Astro loader path.

import { remarkBlockMap } from "../../../packages/cli/src/remark-block-map.ts";
import type { BlockMap } from "@revkit/review-core/block-map";
import remarkMath from "remark-math";
import { rehypeKatexStrict } from "./rehype-katex-strict.ts";
import { rehypeDataSrc, type DataSrcPluginOptions } from "../../../packages/cli/src/rehype-data-src.ts";
import { rehypeDropRepoDocTitle } from "../../../packages/cli/src/rehype-drop-repo-doc-title.ts";
import { rehypeStampRevision } from "../../../packages/cli/src/rehype-stamp-revision.ts";
import { rehypeRewriteMdLinks } from "../../../packages/cli/src/rehype-rewrite-md-links.ts";

// Astro's markdown pipeline accepts a plugin entry as either a
// bare plugin factory OR a `[plugin, options]` tuple. A local
// alias avoids depending on `@astrojs/markdown-remark`'s type
// export (which is a transitive dep and not always visible to
// site's own `astro check`).
type RemarkPlugins = (unknown | readonly unknown[])[];
type RehypePlugins = (unknown | readonly unknown[])[];

/** Shared markdown-config pieces. Consumers:
 *
 *   - `site/astro.config.mjs` passes `remarkPlugins` and
 *     `rehypePlugins` into Astro's `markdown` block.
 *   - `packages/cli/src/serve/publish-render.ts` calls
 *     `createMarkdownProcessor({ ...buildSharedMarkdownConfig(root) })`
 *     so its pipeline mirrors the site's byte-for-byte on plugin
 *     surface. `syntaxHighlight` remains at the shared default so
 *     both consumers see the SAME shiki output — Starlight's
 *     expressive-code integration wraps that afterwards for its
 *     own UI polish, but the emitted `<pre>` + `<code>` still
 *     carry the `data-language` attribute the rail's stamped
 *     `<div>` wraps around.
 *
 * A single source of truth for the plugin list; a new plugin needs
 * one edit, not two.
 */
export function buildSharedMarkdownConfig(
  repoRoot: string,
  options: Pick<DataSrcPluginOptions, "pathMap" | "onProvenance"> & { readonly onBlockMap?: (map: BlockMap) => void } = {},
): {
  readonly remarkPlugins: RemarkPlugins;
  readonly rehypePlugins: RehypePlugins;
} {
  return {
    remarkPlugins: [[remarkBlockMap, { onBlockMap: options.onBlockMap }], remarkMath],
    rehypePlugins: [
      // `rehype-katex-strict` runs first so the KaTeX subtree is
      // shaped before `rehype-drop-repo-doc-title` inspects the
      // top level and before `rehype-data-src` stamps blocks.
      // KaTeX-generated spans have no source position so
      // `rehype-data-src` skips them naturally.
      [rehypeKatexStrict, { trust: false }],
      // Drop the repo-doc's leading `# Title` in hast — Starlight's
      // layout renders the title from frontmatter separately.
      // Runs before `rehype-data-src` so the surviving blocks
      // keep their ORIGINAL source-line positions (a source-side
      // strip would shift every downstream anchor).
      [rehypeDropRepoDocTitle, { repoRoot, ...(options.pathMap !== undefined ? { pathMap: options.pathMap } : {}) }],
      // Rewrite cross-doc `.md` links to their site route (or a
      // GitHub blob URL for docs outside the publishable roots).
      // Historically the `repo-docs` loader did this as a post-
      // process on the FULL BUILD's HTML only — the fast path
      // then emitted raw `../designs/DESIGN-0001….md` and every
      // cross-doc link 404'd after a publish. Landing the rewrite
      // in the shared rehype chain means both paths agree by
      // construction (PR-56 round 2 blocker 1a).
      [rehypeRewriteMdLinks, { repoRoot }],
      // Stamp every block with `data-src="repo/relative:start-end"`
      // — the rail anchors on these.
      [rehypeDataSrc, { repoRoot, ...options }],
      // Inject a hidden `<span data-revkit-revision="…">` at the
      // top of the article body. The daemon reads this at
      // request time to decide whether the on-disk `site/dist/`
      // is still current for the source, so publishes survive
      // restarts (no in-memory override map) and stale dist
      // never masks a newer source (M2 item 9 blocker 2).
      [rehypeStampRevision, {}],
    ],
  };
}
