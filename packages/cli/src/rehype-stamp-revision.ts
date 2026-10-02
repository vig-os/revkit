// `rehype-stamp-revision` — inject `revisionOf(sourceLfNormalised)`
// into the rendered HTML tree as a hidden `<span
// data-revkit-revision="<hex>"></span>` at the very top of the
// article body (M2 item 9 blocker 2 in the PR-56 review, ADR-0001
// amendment).
//
// **Why**: the daemon's request-time logic ("is `site/dist` still
// current for this doc?") needs to know the source revision the
// dist was built against, without storing an out-of-band map that
// a restart would forget. The stamp lives INSIDE the article body
// so `spliceArticleBody`'s wrapper survives a full build and a
// fast-path splice equally — the daemon just regex-extracts the
// attribute from the served HTML.
//
// The plugin is a pure hast walker; it computes `revisionOf` on
// the file value it receives from unified (Astro's markdown
// processor passes the raw source in `file.value`). If the plugin
// cannot recover the source it skips the stamp — the daemon then
// falls back to comparing the fast-render's `data-src` set against
// dist's set (both are cheap regex extractions).

import type { Element, Root } from "hast";
import { revisionOf } from "@revkit/review-core";
import type { VFileLike } from "./rehype-vfile.ts";

/** VFile with a `.value` — unified processors pass the source
 * bytes in `file.value`. Kept local because `VFileLike` in the
 * other rehype helpers deliberately reads only the path bag. */
interface VFileWithValue extends VFileLike {
  readonly value?: string | Uint8Array;
}

/** Attribute name the plugin stamps. Daemon regex-extracts on it
 * with the exact byte spelling, so a rename here must land in
 * `daemon.ts::extractDocRevision` too. Kept as a named export so
 * both sides import ONE constant. */
export const DOC_REVISION_ATTR = "data-revkit-revision";

/** Element name used for the stamp. `<span hidden>` is safe HTML,
 * carries no layout, and is inside `data-src` block scope so the
 * rail's anchor selection never treats it as a comment target. */
export const STAMP_TAG_NAME = "span";

/** Options accepted by `rehypeStampRevision`. Kept for symmetry
 * with the other rehype plugins in this package — currently
 * empty; the plugin reads `file.value` for the source content. */
export interface StampRevisionOptions {
  /** Optional: skip stamping when the vfile has no path (tests
   * without a fileURL). Defaults to true. */
  readonly skipWithoutPath?: boolean;
}

/** The plugin factory. Signature matches unified's
 * `Plugin<[Options], Root>`. */
export function rehypeStampRevision(options: StampRevisionOptions = {}) {
  const skipWithoutPath = options.skipWithoutPath ?? true;
  return async (tree: Root, file?: VFileWithValue): Promise<void> => {
    if (skipWithoutPath && (file?.path === undefined || file.path.length === 0)) return;
    const value = file?.value;
    const raw = typeof value === "string"
      ? value
      : value instanceof Uint8Array
        ? new TextDecoder().decode(value)
        : undefined;
    if (raw === undefined) return;
    // `revisionOf` LF-normalises internally, so we pass the raw
    // bytes as-is — the two sides (build + fast path) produce the
    // same hash on the same source regardless of the checkout's
    // native line-ending.
    const rev = await revisionOf(raw);
    const stamp: Element = {
      type: "element",
      tagName: STAMP_TAG_NAME,
      properties: {
        [`data-${DOC_REVISION_ATTR.slice("data-".length)}`]: rev,
        hidden: true,
      },
      children: [],
    };
    // Prepend to the root so `spliceArticleBody` finds it as the
    // first child of the article body region.
    tree.children.unshift(stamp);
  };
}

/** Extract the stamped revision from a piece of served HTML, or
 * undefined when the stamp is missing (older dist, or a page
 * whose source we can't recover). Case-insensitive attribute
 * name match, tolerant to Astro's own attribute reordering. */
export function extractDocRevision(html: string): string | undefined {
  const attr = DOC_REVISION_ATTR;
  const match = html.match(new RegExp(`${attr}="([0-9a-f]{64})"`, "i"));
  return match !== null && typeof match[1] === "string" ? match[1] : undefined;
}
