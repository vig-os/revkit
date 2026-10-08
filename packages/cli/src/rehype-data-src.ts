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

import { resolve } from "node:path";
import type { Root, Element, RootContent, ElementContent, Properties } from "hast";
import { formatDataSrc } from "./data-src-format.ts";
import { filePathOf, repoRelativePosix, type VFileLike } from "./rehype-vfile.ts";
import { alignLeaf, type LeafMap } from "./text-provenance.ts";
import { PROVENANCE_VERSION } from "./provenance-format.ts";

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
  /** Server-side capture; never read authoritative maps from authored HTML. */
  readonly onProvenance?: (records: ProvenanceRecords) => void;
  /** Absolute path to the repository root. Files outside it are skipped. */
  readonly repoRoot: string;
  /** If false, an existing `data-src` attribute is overwritten (default: false). */
  readonly overwriteExisting?: boolean;
  /** Optional path remaps applied to the file's absolute path
   * BEFORE the repo-relative calculation (issue #57 blocker).
   * `revkit build` stages a COPY of the consumer's `docs/` under
   * `<consumer>/.revkit/build/src/content/docs/`; without a remap
   * the anchor `data-src` would point at the throwaway staging
   * path instead of the reviewer-facing source path. Each entry
   * `{ from, to }` rewrites paths starting with `from + '/'` (or
   * exactly `from`) to have their prefix replaced with `to`.
   * Order matters — the first matching entry wins, so a caller
   * ordering longer/more-specific prefixes first refines the
   * mapping. Both `from` and `to` MUST be absolute paths. */
  readonly pathMap?: readonly { readonly from: string; readonly to: string }[];
}

// `VFileLike`, `filePathOf`, and `repoRelativePosix` moved to
// `./rehype-vfile.ts` (shared with `rehype-drop-repo-doc-title`).
// Re-export the path helper so external callers (tests, tools) keep
// their import path stable.
export { repoRelativePosix };

/** Walk a hast tree and stamp block elements. Exported without the
 * unified wrapper so tests can call it against a fixture.
 *
 * `<pre>` gets special treatment: Starlight's expressive-code
 * integration REPLACES the plain `<pre>` with a wrapped
 * `<figure><pre>…</pre>…</figure>`, silently dropping any
 * attribute (including `data-src`) on the original pre. To
 * survive that pass, we WRAP the pre in a stamped `<div>` — the
 * outer div's attributes are preserved through expressive-code's
 * rewrite, so the rail can still anchor on it (PR #38 round-2
 * review: code-block anchors). */
export function stampTree(
  tree: Root | Element,
  options: { repoRelPath: string; overwriteExisting: boolean },
): number {
  let stamped = 0;
  const walk = (parent: { children?: unknown } | Root | ElementContent | RootContent): void => {
    if ((parent as { type?: string }).type === "element") {
      const element = parent as Element;
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
          properties["dataSrc"] = value;
          element.properties = properties;
          stamped++;
        }
      }
    }
    // Walk children AND rewrite <pre> children in-place with a
    // stamped <div> wrapper.
    const container = parent as { children?: ElementContent[] };
    if (Array.isArray(container.children)) {
      for (let i = 0; i < container.children.length; i++) {
        const child = container.children[i]!;
        walk(child);
        if (child.type === "element" && child.tagName.toLowerCase() === "pre") {
          const positioned = child.position as Position | undefined;
          if (
            positioned !== undefined &&
            Number.isInteger(positioned.start.line) &&
            Number.isInteger(positioned.end.line)
          ) {
            const value = formatDataSrc(
              options.repoRelPath,
              positioned.start.line,
              positioned.end.line,
            );
            const wrapper: Element = {
              type: "element",
              tagName: "div",
              properties: { dataSrc: value, className: ["revkit-code-anchor"] },
              children: [child],
              position: child.position,
            };
            container.children[i] = wrapper;
            stamped++;
          }
        }
      }
    }
  };
  walk(tree);
  return stamped;
}

/** Apply the `pathMap` rewrites to an absolute file path. Exported
 * so tests can exercise the mapping without a full plugin run. The
 * first entry whose `from` prefix matches wins; falls through to
 * the input path when nothing matches. `from` matches when the
 * path equals it exactly OR starts with `from + '/'` — a prefix
 * match on a substring that is not a full directory boundary is
 * rejected on purpose (so `/foo/bar` does not accidentally match
 * a `from` of `/foo/ba`). */
export function applyPathMap(
  absPath: string,
  pathMap: readonly { readonly from: string; readonly to: string }[] | undefined,
): string {
  if (pathMap === undefined) return absPath;
  for (const entry of pathMap) {
    if (absPath === entry.from) return entry.to;
    if (absPath.startsWith(entry.from + "/")) {
      return entry.to + absPath.slice(entry.from.length);
    }
  }
  return absPath;
}

/** The plugin's transformer. Signature matches `unified.Plugin<[Options], Root>`.
 * Kept as a plain factory so the CLI package can also call it directly
 * without pulling in `unified` types at every call site. */
export function rehypeDataSrc(options: DataSrcPluginOptions) {
  const repoRoot = resolve(options.repoRoot);
  const overwriteExisting = options.overwriteExisting ?? false;
  const pathMap = options.pathMap;
  return (tree: Root, file?: VFileLike): void => {
    const filePath = file !== undefined ? filePathOf(file) : undefined;
    if (filePath === undefined) return;
    // Remap staged paths to their source path BEFORE computing the
    // repo-relative form. A comment anchored on a rendered page
    // should target the reviewer-facing source, not the
    // staging copy that vanishes on the next `revkit build`.
    const mappedPath = applyPathMap(filePath, pathMap);
    const repoRelPath = repoRelativePosix(repoRoot, mappedPath);
    if (repoRelPath === undefined) return;
    stampTree(tree, { repoRelPath, overwriteExisting });
    const value = (file as VFileLike & { value?: unknown }).value;
    const raw = typeof value === "string" ? value : value instanceof Uint8Array ? new TextDecoder().decode(value) : undefined;
    if (raw !== undefined) {
      const records = stampLeafProvenance(tree, raw.replace(/\r\n?/g, "\n"), repoRelPath);
      options.onProvenance?.(records);
    }
  };
}

/** Wrap positioned leaves before HTML/MDX normalization drops positions.
 * Source line/column coordinates survive CRLF normalization; raw offsets
 * do not. Generated text has no wrapper and selections fail closed. */
export interface ProvenanceRecords {
  readonly leaves: ReadonlyMap<string, { readonly map: LeafMap; readonly value: string }>;
  readonly blocks: ReadonlySet<string>;
}

export function stampLeafProvenance(tree: Root, source: string, path: string): ProvenanceRecords {
  const leaves = new Map<string, { map: LeafMap; value: string }>();
  const blocks = new Set<string>();
  const lines = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") lines.push(i + 1);
  const walk = (parent: Root | Element): void => {
    if (parent.type === "element" && parent.position) {
      const expected = formatDataSrc(path, parent.position.start.line, parent.position.end.line);
      if (parent.properties.dataSrc === expected) blocks.add(expected);
    }
    for (let i = 0; i < parent.children.length; i++) {
      const child = parent.children[i]!;
      if (child.type === "element") { walk(child); continue; }
      if (child.type !== "text" || !child.position) continue;
      // HTML's input stream normalizes line endings in the browser. Use
      // that same visible value before recording UTF-16 endpoints.
      child.value = child.value.replace(/\r\n?/g, "\n");
      const pos = child.position;
      const start = pos && lines[pos.start.line - 1] !== undefined ? lines[pos.start.line - 1]! + pos.start.column - 1 : undefined;
      const end = pos && lines[pos.end.line - 1] !== undefined ? lines[pos.end.line - 1]! + pos.end.column - 1 : undefined;
      const map = start !== undefined && end !== undefined && start >= 0 && end >= start && end <= source.length && !path.toLowerCase().endsWith(".mdx")
        ? alignLeaf(source.slice(start, end), child.value, start, parent.type === "element" && parent.tagName === "code")
        : undefined;
      const wrapper: Element = {
        type: "element", tagName: "span",
        properties: {
          dataRevkitLeaf: `v${PROVENANCE_VERSION}-${start}-${end}`,
          dataRevkitMap: map === undefined ? "unmapped" : JSON.stringify(map),
        },
        children: [child],
      };
      if (map !== undefined) leaves.set(wrapper.properties.dataRevkitLeaf as string, { map, value: child.value });
      parent.children[i] = wrapper;
    }
  };
  walk(tree);
  return { leaves, blocks };
}

/** Default export so the plugin can be registered as
 * `[dataSrcPlugin, { repoRoot }]` in `astro.config.mjs`. Matches the
 * unified/remark convention. */
export default rehypeDataSrc;
