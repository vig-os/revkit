import { PROVENANCE_VERSION, type SourceSelection } from "../provenance-format.ts";
import { parseDataSrc } from "../data-src-format.ts";

export interface CommentTarget {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly revision: string;
}

export function rangeBlock(range: Range): HTMLElement | undefined {
  let cursor = range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement;
  while (cursor !== null) {
    if (cursor.hasAttribute("data-src") && cursor.contains(range.endContainer)) return cursor as HTMLElement;
    cursor = cursor.parentElement;
  }
  return undefined;
}

/** Browser Range endpoints, never an indexOf of selected text. Inspect
 * every selected text node so generated content cannot hide between two
 * mapped endpoints. DOM rewrites that split a leaf also fail closed. */
export function rangeSelection(range: Range, block: Element, revision: string): SourceSelection | undefined {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let start: { leaf: string; offset: number } | undefined;
  let end: { leaf: string; offset: number } | undefined;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text;
    if (!range.intersectsNode(text)) continue;
    const from = range.startContainer === text ? range.startOffset : 0;
    const to = range.endContainer === text ? range.endOffset : text.length;
    if (from >= to || range.comparePoint(text, to) < 0 || range.comparePoint(text, from) > 0) continue;
    const leaf = text.parentElement;
    const id = leaf?.getAttribute("data-revkit-leaf");
    if (!id) {
      if (text.data.slice(from, to).trim().length === 0) continue;
      return undefined;
    }
    if (leaf!.getAttribute("data-revkit-map") === "unmapped" || leaf!.childNodes.length !== 1) return undefined;
    if (start === undefined) start = { leaf: id, offset: from };
    end = { leaf: id, offset: to };
  }
  return start === undefined || end === undefined ? undefined : { kind: "range", version: PROVENANCE_VERSION, revision, start, end };
}

/** Pick the smallest source block containing BOTH bounds. An exact
 * block-line match is not necessary for a precise sub-block quote. */
export function containingBlock(anchor: { path: string; startLine: number; endLine: number }): HTMLElement | undefined {
  let found: HTMLElement | undefined;
  let width = Infinity;
  for (const element of document.querySelectorAll<HTMLElement>("[data-src]")) {
    const range = parseDataSrc(element.getAttribute("data-src")!);
    if (!range || range.path !== anchor.path || range.startLine > anchor.startLine || range.endLine < anchor.endLine) continue;
    const size = range.endLine - range.startLine;
    if (size < width || (size === width && found?.contains(element))) { found = element; width = size; }
  }
  return found;
}
