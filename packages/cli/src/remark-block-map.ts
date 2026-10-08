import { extractBlockMap, type BlockMap, type PositionedMarkdownNode } from "@revkit/review-core/block-map";
import { revisionOf } from "@revkit/review-core";

const MAX_CAPTURED_MAPS = 16;
const MAX_CAPTURED_SOURCE_UNITS = 1_000_000;
const capturedMaps = new Map<string, BlockMap>();
let capturedSourceUnits = 0;
export function capturedMarkdownMap(revision: string): BlockMap | undefined { return capturedMaps.get(revision); }

/** First remark transformer: positioned source tree, before smartypants,
 * title removal, KaTeX, tight-list flattening or HTML transformations. */
export function remarkBlockMap(options: { readonly onBlockMap?: (map: BlockMap) => void } = {}) {
  return async (tree: PositionedMarkdownNode, file: { readonly value: unknown; readonly path?: string; readonly history?: readonly string[] }): Promise<void> => {
    const path = file.path ?? file.history?.[0] ?? "";
    if (path.endsWith(".mdx")) return;
    const source = String(file.value);
    // Capture must use the same coordinates as the parser; callers normalize
    // before rendering. An external CRLF processor cannot supply authority.
    if (source.includes("\r")) return;
    const revision = await revisionOf(source);
    const map = extractBlockMap(tree, source, revision);
    options.onBlockMap?.(map);
    const previous = capturedMaps.get(revision);
    if (previous) capturedSourceUnits -= previous.sourceLength;
    capturedMaps.delete(revision);
    capturedMaps.set(revision, map);
    capturedSourceUnits += map.sourceLength;
    while (capturedMaps.size > MAX_CAPTURED_MAPS || capturedSourceUnits > MAX_CAPTURED_SOURCE_UNITS) {
      const oldest = capturedMaps.keys().next().value!;
      capturedSourceUnits -= capturedMaps.get(oldest)!.sourceLength;
      capturedMaps.delete(oldest);
    }
  };
}
