// `rehype-data-src` — stamp block-level hast elements with a
// `data-src="<repo-relative path>:<startLine>-<endLine>"` attribute the
// rail reads to anchor comments to source lines (DESIGN-0001 §5.2,
// ADR-0006).
//
// The plugin runs after remark → hast conversion, so every element that
// came from a mdast node carries a `position` field (line/column). We
// stamp only block-level elements — the units a reviewer picks when
// commenting: headings, paragraphs, lists and list items, code blocks,
// tables, blockquotes, figures, and the top-level `section` / `aside` /
// `details` wrappers. Inline elements (`em`, `code`, `a`) are skipped
// because the rail selects by nearest ancestor with `data-src`, not by
// span-level anchors.
//
// Path is resolved relative to `repoRoot` (POSIX-normalised, forward
// slashes always so a Windows build produces the same string as a
// POSIX one). A file outside `repoRoot` is skipped (a docstring embed
// or a symlink chase would not be reviewable anyway).
//
// The plugin is used by Astro's markdown pipeline via
// `astro.config.mjs` (for site-owned MDX AND repo-doc `renderMarkdown`
// calls), and by the unit tests here in the CLI package (which run the
// plugin against a fixture tree — no Astro needed).

import { relative, resolve, sep } from "node:path";
import type { Root, Element, RootContent, ElementContent, Properties } from "hast";
import { fileURLToPath } from "node:url";
import { formatDataSrc } from "./data-src-format.ts";

// Re-export the browser-safe format helpers so tests + rail bundle
// share ONE parser (kept in `data-src-format.ts` so the rail can
// import it without pulling `node:*` through this plugin file).
export { formatDataSrc, parseDataSrc } from "./data-src-format.ts";

/** Tag names the plugin stamps. Block-level elements a reviewer might
 * anchor a comment to. Kept as a `Set` for O(1) lookup during the
 * walk. `code` is INSIDE `pre` in a code block; the `pre` gets the
 * anchor. `td` / `th` inherit from their `tr` ancestor. */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "table",
  "thead",
  "tbody",
  "tr",
  "hr",
  "figure",
  "figcaption",
  "section",
  "aside",
  "details",
  "dl",
  "dt",
  "dd",
]);

/** Position info carried on a hast/mdast node. The `unist` types name
 * this `Point`, but re-declared here so the plugin does not need a
 * `unist` import for one field. */
interface Point {
  readonly line: number;
  readonly column?: number;
}
interface Position {
  readonly start: Point;
  readonly end: Point;
}

/** Options accepted by the plugin. `repoRoot` is required; the Astro
 * config passes an absolute path derived from `import.meta.url`. */
export interface DataSrcPluginOptions {
  /** Absolute path to the repository root. Files outside it are skipped. */
  readonly repoRoot: string;
  /** If false, an existing `data-src` attribute is overwritten (default: false). */
  readonly overwriteExisting?: boolean;
}

/** A minimal `VFile` view. The unified pipeline hands the plugin a
 * `VFile`-shaped object; we touch only `path` (absolute file path when
 * set) and `history` (some pipelines use the last history entry).
 * `data` is deliberately typed `unknown` — we cast inside `filePathOf`
 * — so this shape stays compatible with unified's `VFile['data']` even
 * as downstream ecosystems (Astro / Starlight) extend it. */
interface VFileLike {
  readonly path?: string;
  readonly history?: readonly string[];
  readonly data?: unknown;
}

/** Extract the source file's absolute path from a `VFile`. Returns
 * undefined when the file has no path (a synthetic in-memory tree).
 * Falls back to `file.data.astro.fileURL` when Astro's markdown
 * pipeline hands us a `VFile` with the path in its `data` bag. */
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

/** Compute the repo-relative path in POSIX form. Returns undefined if
 * the file falls outside `repoRoot` (a `..` prefix indicates escape). */
export function repoRelativePosix(
  repoRoot: string,
  filePath: string,
): string | undefined {
  const rel = relative(resolve(repoRoot), resolve(filePath));
  if (rel.length === 0) return undefined;
  if (rel.startsWith("..")) return undefined;
  // Windows delimiter → POSIX forward slash so the string is the same
  // on every platform.
  return sep === "/" ? rel : rel.split(sep).join("/");
}

/** Walk a hast tree and stamp block elements. Exported without the
 * unified wrapper so tests can call it against a fixture. */
export function stampTree(
  tree: Root | Element,
  options: { repoRelPath: string; overwriteExisting: boolean },
): number {
  let stamped = 0;
  const walk = (node: Root | ElementContent | RootContent): void => {
    if (node.type === "element") {
      const element = node;
      const tag = element.tagName.toLowerCase();
      const positioned = element.position as Position | undefined;
      if (
        BLOCK_TAGS.has(tag) &&
        positioned !== undefined &&
        Number.isInteger(positioned.start.line) &&
        Number.isInteger(positioned.end.line)
      ) {
        const properties: Properties = element.properties ?? {};
        const existing = properties["dataSrc"];
        if (existing === undefined || options.overwriteExisting) {
          const value = formatDataSrc(
            options.repoRelPath,
            positioned.start.line,
            positioned.end.line,
          );
          // hast's property naming: `data-src` on the wire is
          // `dataSrc` in properties. `hast-util-to-html` converts it
          // back to `data-src` at serialise time.
          properties["dataSrc"] = value;
          element.properties = properties;
          stamped++;
        }
      }
    }
    if ("children" in node && Array.isArray(node.children)) {
      for (const child of node.children) walk(child as ElementContent);
    }
  };
  walk(tree);
  return stamped;
}

/** The plugin's transformer. Signature matches `unified.Plugin<[Options], Root>`.
 * Kept as a plain factory so the CLI package can also call it directly
 * without pulling in `unified` types at every call site. */
export function rehypeDataSrc(options: DataSrcPluginOptions) {
  const repoRoot = resolve(options.repoRoot);
  const overwriteExisting = options.overwriteExisting ?? false;
  return (tree: Root, file?: VFileLike): void => {
    const filePath = file !== undefined ? filePathOf(file) : undefined;
    if (filePath === undefined) return;
    const repoRelPath = repoRelativePosix(repoRoot, filePath);
    if (repoRelPath === undefined) return;
    stampTree(tree, { repoRelPath, overwriteExisting });
  };
}

/** Default export so the plugin can be registered as
 * `[dataSrcPlugin, { repoRoot }]` in `astro.config.mjs`. Matches the
 * unified/remark convention. */
export default rehypeDataSrc;
