// Fast-path renderer for `POST /api/publish` (M2 item 9, story A4,
// ADR-0001 amendment).
//
// The daemon takes a repo-relative `.md` path plus the new source
// bytes and returns the article HTML fragment plus the block-level
// `data-src` stamps the rail anchors on. The pipeline is built
// FROM THE SAME shared config `site/astro.config.mjs` passes to
// Astro (`buildSharedMarkdownConfig`), running through Astro's
// own `createMarkdownProcessor` so every default plugin Astro
// applies — `remark-gfm` (tables, task lists, footnotes),
// `remark-smartypants` (typographic punctuation), `rehype-heading-ids`
// (heading `id="…"` slugs), `rehype-raw`, `rehype-stringify` — lands
// in the fast render too. A plugin change on either side reaches
// both; a config drift is impossible by construction.
//
// **Why an Astro processor and not a hand-rolled `unified()` chain**
// (blocker 1 in the PR-56 review): the earlier version built a bare
// `remark-parse → remark-rehype` pipe and got `.md` tables wrong
// (`FEATURE-MATRIX.md` lost 40 of 44 `data-src` anchors because
// GFM was missing), lost heading ids, and dropped smartypants
// output. Using Astro's own factory guarantees byte-parity on the
// article body.
//
// **What is NOT identical to a full build**: Starlight's
// expressive-code integration re-renders `<pre>` blocks with its
// own CSS classes AFTER Astro's markdown pass. The fast path here
// stops at Astro's default `shiki` syntax highlighter (which
// emits `<pre>` with a language attribute the rail can still
// anchor on) — code blocks look different for the ~1 second
// between publish and the background full build catching up.
// `renderDocFragment` reports the source blocks it saw so the
// caller can log the coverage without a second parse pass.
//
// **Refuse-and-fall-back**: MDX under `site/src/content/docs/` is
// not accepted by the fast path today. `isRenderablePath` returns
// false; the caller emits `doc.published` without an override.

import { extname } from "node:path";
import { pathToFileURL } from "node:url";
import { createMarkdownProcessor } from "@astrojs/markdown-remark";
import { buildSharedMarkdownConfig } from "../../../../site/src/lib/markdown-processor.ts";

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
 * the caller can log the coverage. A refusal indicates the source
 * uses a feature the fast path cannot render byte-for-byte with
 * the full build (see `fastPathRefusalFor`). */
export type RenderDocResult =
  | {
      readonly refused?: undefined;
      readonly html: string;
      readonly dataSrcCount: number;
    }
  | FastPathRefusal;

/** File extensions the fast-path knows how to render. `.mdx` is
 * excluded (see file header). */
export const RENDERABLE_EXTENSIONS: readonly string[] = Object.freeze([".md"]);

/** Return true when `path` is one the renderer can produce a
 * fragment for. Callers that hit a non-renderable path still emit
 * `doc.published` (the file was written to disk and re-anchoring
 * ran); they just skip the override injection. Extension check is
 * case-INsensitive so `README.MD` normalises to `.md`. */
export function isRenderablePath(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return RENDERABLE_EXTENSIONS.includes(ext);
}

/** Markdown source features the fast path CANNOT match against
 * the full build's Starlight-driven output. The daemon refuses
 * to fast-render these — dist keeps serving the old HTML until
 * the background full build lands the update. Kept as a single
 * source-content predicate so both the render side (short-
 * circuits before invoking the shared processor) and the
 * equivalence test (asserts the refusal contract) look at the
 * same rules.
 *
 * Refused features:
 *   1. **Fenced code blocks** (```…``` or ~~~…~~~). The full
 *      build wraps every code block in Starlight's expressive-
 *      code frame (`<div class="expressive-code">…</div>` with
 *      themed shiki output and copy-button chrome). The fast
 *      path renders a plain `<pre>` and therefore diverges on
 *      HTML byte parity. Adding expressive-code to the shared
 *      chain is tracked as follow-up work — it wants Starlight's
 *      full theme + i18n preprocessor to match byte-for-byte.
 *   2. **Starlight directives / asides** (`:::note`, `:::tip`,
 *      `:::caution`, `:::danger`). Starlight compiles these
 *      through `remark-directive` + a custom transformer;
 *      dropping either from the shared chain lets the fast path
 *      emit `<span class="…">` where the full build emits an
 *      `<aside>` with a translated title. Refused to keep the
 *      "same HTML or refuse" contract crisp.
 *
 * On a refusal, `renderDocFragment` returns `{ refused: true,
 * reason }` and the daemon skips the fast-path override — the
 * on-disk dist serves the previous full build's HTML. */
export interface FastPathRefusal {
  readonly refused: true;
  readonly reason: "code-fence" | "starlight-directive";
}

/** Detect whether the fast path can render `source` byte-parity
 * with a full build. Returns `undefined` when the source is
 * renderable; a `FastPathRefusal` otherwise. Reads only the
 * source — no filesystem I/O. */
export function fastPathRefusalFor(source: string): FastPathRefusal | undefined {
  // Fenced code blocks — three or more backticks or tildes at
  // the start of a line, treated as an opening fence per the
  // CommonMark spec. Indentation up to three spaces is still a
  // fence; four or more is a code block by indentation (which
  // Astro's default shiki handles the same as expressive-code
  // would — so no divergence — and does NOT trigger a refusal).
  const fenceLine = /^ {0,3}(?:```+|~~~+)/m;
  if (fenceLine.test(source)) return { refused: true, reason: "code-fence" };
  // Starlight asides: `:::note`, `:::tip`, `:::caution`,
  // `:::danger` at the start of a line. `:::` (three colons)
  // is remark-directive's block-container prefix.
  const asideLine = /^ {0,3}::: ?(?:note|tip|caution|danger)\b/m;
  if (asideLine.test(source)) return { refused: true, reason: "starlight-directive" };
  return undefined;
}

/** Cached processor keyed by repo root. `createMarkdownProcessor`
 * is not cheap (it loads a handful of unified plugins); a daemon
 * usually renders many docs against the same root. */
const processorCache = new Map<string, Promise<Awaited<ReturnType<typeof createMarkdownProcessor>>>>();

/** Run the fast-path pipeline. Delegates to Astro's own
 * `createMarkdownProcessor` with the shared plugin config, so the
 * output equals what `astro build` would emit (whitespace-
 * normalised) on the article body. Returns the HTML fragment that
 * goes INSIDE the site's `<article>` element.
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
  const refusal = fastPathRefusalFor(options.source);
  if (refusal !== undefined) return refusal;
  let processorPromise = processorCache.get(options.repoRoot);
  if (processorPromise === undefined) {
    // `syntaxHighlight: false` matches what Starlight's
    // `astro-expressive-code` integration does in the full build
    // (it disables shiki and takes over code-block rendering via
    // its own rehype plugin). Skipping shiki here keeps position
    // information on the mdast → hast `<pre>` element so
    // `rehype-data-src` can wrap it in a `<div data-src="…"
    // class="revkit-code-anchor">` — the same wrapper the full
    // build ships. Expressive-code's inner chrome is a visual
    // detail the background rebuild catches up; the anchor
    // survives publishes.
    // `createMarkdownProcessor`'s options type refers to a private
    // `RemarkPlugin` / `RehypePlugin` union that a plain `readonly`
    // array can't satisfy without a cast; the runtime shape (an
    // array of `[plugin, options]` tuples) is what the loader
    // reads. Same shape Astro's `markdown` block accepts in
    // `astro.config.mjs`.
    processorPromise = createMarkdownProcessor({
      ...buildSharedMarkdownConfig(options.repoRoot),
      syntaxHighlight: false,
    } as Parameters<typeof createMarkdownProcessor>[0]);
    processorCache.set(options.repoRoot, processorPromise);
  }
  const processor = await processorPromise;
  const fileUrl = pathToFileURL(`${options.repoRoot}/${options.path}`);
  const result = await processor.render(options.source, { fileURL: fileUrl });
  const html = result.code;
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

/** Reset the internal processor cache. Test-only. */
export function _resetProcessorCacheForTests(): void {
  processorCache.clear();
}
