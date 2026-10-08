// Authoritative maps are rendered from a confined source snapshot through
// the SAME Astro pipeline as the page. Client-supplied maps/text are never
// evidence. No MDX components are evaluated during recovery.
import { pathToFileURL } from "node:url";
import { createMarkdownProcessor } from "@astrojs/markdown-remark";
import { parseHTML } from "linkedom";
import { buildQuoteFromOffsets, buildLineStartIndex, offsetToLine, type Anchor } from "@revkit/review-core";
import { buildSharedMarkdownConfig } from "../../../../site/src/lib/markdown-processor.ts";
import { parseDataSrc } from "../data-src-format.ts";
import { PROVENANCE_VERSION, type SourceSelection } from "../provenance-format.ts";
import { sourceEndpoint, type LeafMap } from "../text-provenance.ts";
import type { ProvenanceRecords } from "../rehype-data-src.ts";

export interface RenderedProvenance {
  readonly document: Document;
  readonly leaves: ReadonlyMap<string, { readonly element: Element; readonly map: LeafMap }>;
  readonly blocks: ReadonlySet<string>;
}

export async function renderProvenance(repoRoot: string, path: string, source: string): Promise<RenderedProvenance> {
  let captured: ProvenanceRecords = { leaves: new Map(), blocks: new Set() };
  const processor = await createMarkdownProcessor({
    ...buildSharedMarkdownConfig(repoRoot, { onProvenance: (records) => { captured = records; } }), syntaxHighlight: false,
  } as Parameters<typeof createMarkdownProcessor>[0]);
  const { code } = await processor.render(source, { fileURL: pathToFileURL(`${repoRoot}/${path}`) });
  const { document } = parseHTML(`<html><body>${code}</body></html>`);
  const leaves = new Map<string, { element: Element; map: LeafMap }>();
  const duplicates = new Set<string>();
  for (const element of document.querySelectorAll("[data-revkit-leaf]")) {
    const id = element.getAttribute("data-revkit-leaf")!;
    const record = captured.leaves.get(id);
    if (!record || element.children.length !== 0 || element.textContent !== record.value) continue;
    if (leaves.has(id)) { duplicates.add(id); continue; }
    // Linkedom splits entity text into adjacent text nodes; the HTML
    // browser parser emits one text node for the renderer's leaf span.
    element.replaceChildren(document.createTextNode(record.value));
    leaves.set(id, { element, map: record.map });
  }
  for (const id of duplicates) leaves.delete(id);
  return { document, leaves, blocks: captured.blocks };
}

/** Derive both line bounds, quote AND context from the source. A range
 * touching any unmapped/generated text is refused, even if its endpoints
 * map. Whole-block requests are a separate explicit act. */
export function selectionAnchor(
  rendered: RenderedProvenance,
  source: string,
  request: { readonly path: string; readonly startLine: number; readonly endLine: number },
  selection: SourceSelection,
  revision: string,
): Anchor | undefined {
  if (selection.version !== PROVENANCE_VERSION || selection.revision !== revision) return undefined;
  const blockValue = `${request.path}:${request.startLine}-${request.endLine}`;
  if (!rendered.blocks.has(blockValue)) return undefined;
  const blocks = [...rendered.document.querySelectorAll("[data-src]")].filter((el) => el.getAttribute("data-src") === blockValue);
  if (blocks.length === 0) return undefined;
  let start: number;
  let end: number;
  const lines = buildLineStartIndex(source);
  if (selection.kind === "block") {
    const first = lines[request.startLine - 1];
    if (first === undefined || lines[request.endLine - 1] === undefined) return undefined;
    start = first;
    end = lines[request.endLine] === undefined ? source.length : lines[request.endLine]! - 1;
  } else {
    const a = rendered.leaves.get(selection.start.leaf);
    const b = rendered.leaves.get(selection.end.leaf);
    if (a === undefined || b === undefined) return undefined;
    if (selection.start.leaf === selection.end.leaf && selection.start.offset >= selection.end.offset) return undefined;
    const block = blocks.find((el) => el.contains(a.element) && el.contains(b.element));
    if (block === undefined) return undefined;
    const mappedStart = sourceEndpoint(a.map, selection.start.offset, "start");
    const mappedEnd = sourceEndpoint(b.map, selection.end.offset, "end");
    if (mappedStart === undefined || mappedEnd === undefined || mappedStart >= mappedEnd) return undefined;
    const all = [...block.querySelectorAll("[data-revkit-leaf]")];
    const ai = all.indexOf(a.element);
    const bi = all.indexOf(b.element);
    if (ai < 0 || bi < ai) return undefined;
    for (let i = ai; i <= bi; i++) if (!rendered.leaves.has(all[i]!.getAttribute("data-revkit-leaf")!)) return undefined;
    // Raw HTML text has no provenance wrapper. Inspect every text node
    // between the endpoints, rather than treating good endpoints as proof.
    const texts: Node[] = [];
    const walk = (node: Node): void => {
      if (node.nodeType === 3) texts.push(node);
      for (const child of node.childNodes) walk(child);
    };
    walk(block);
    const ta = texts.findIndex((n) => a.element.contains(n));
    const tb = texts.findIndex((n) => b.element.contains(n));
    for (let i = ta; i <= tb; i++) {
      const node = texts[i]!;
      if (!(node.textContent ?? "").trim()) continue;
      const leaf = node.parentElement?.closest("[data-revkit-leaf]");
      if (!leaf || !rendered.leaves.has(leaf.getAttribute("data-revkit-leaf")!)) return undefined;
    }
    start = mappedStart;
    end = mappedEnd;
  }
  if (start < 0 || end > source.length || start >= end) return undefined;
  const startLine = offsetToLine(lines, start);
  const endLine = offsetToLine(lines, end - 1);
  if (startLine < request.startLine || endLine > request.endLine) return undefined;
  return { path: request.path, startLine, endLine, revision, quote: buildQuoteFromOffsets(source, start, end) };
}

/** Inverse bounds for locating only the rendered text that overlaps a
 * recorded source window. Lossy atoms are included, then validated exactly. */
function renderedBound(map: LeafMap, sourceOffset: number, side: "start" | "end"): number {
  if (sourceOffset <= map.start) return 0;
  if (sourceOffset >= map.end) return map.length;
  let delta = map.start;
  for (const [r0, r1, s0, s1] of map.intervals ?? []) {
    if (sourceOffset <= s0) return sourceOffset - delta;
    if (sourceOffset < s1) return side === "start" ? r0 : r1;
    delta = s1 - r1;
  }
  return sourceOffset - delta;
}

interface IndexedText {
  readonly start: number;
  readonly end: number;
  readonly map?: LeafMap;
  readonly invalidBefore: number;
  readonly invalidThrough: number;
}

/** Recover legacy quotes using unique renderer candidates inside their
 * recorded lines. Build text/line indexes once; never validate a candidate
 * by walking its entire containing block. */
export function recoverLegacyAnchor(rendered: RenderedProvenance, source: string, anchor: Anchor): Anchor | undefined {
  const candidates = new Map<string, Anchor>();
  const lines = buildLineStartIndex(source);
  const windowStart = lines[anchor.startLine - 1];
  const last = lines[anchor.endLine - 1];
  if (windowStart === undefined || last === undefined || anchor.quote.exact.length === 0) return undefined;
  // A terminating newline belongs to the preceding line under the
  // engine's end-1 line convention. Keep it inside the legacy window.
  const windowEnd = lines[anchor.endLine] ?? source.length;
  const add = (start: number, end: number): void => {
    if (start < windowStart || end > windowEnd || start >= end) return;
    candidates.set(`${start}:${end}`, { ...anchor, startLine: offsetToLine(lines, start), endLine: offsetToLine(lines, end - 1), quote: buildQuoteFromOffsets(source, start, end) });
  };
  // Search a bounded slice, not the remainder of the document. Context
  // may extend beyond the recorded lines and is checked against source.
  const sourceWindow = source.slice(windowStart, windowEnd);
  let cursor = 0;
  while (cursor < sourceWindow.length) {
    const hit = sourceWindow.indexOf(anchor.quote.exact, cursor);
    if (hit < 0) break;
    const start = windowStart + hit;
    if (source.slice(Math.max(0, start - anchor.quote.prefix.length), start).endsWith(anchor.quote.prefix) && source.startsWith(anchor.quote.suffix, start + anchor.quote.exact.length)) add(start, start + anchor.quote.exact.length);
    if (candidates.size > 1) return undefined;
    cursor = hit + 1;
  }
  for (const block of rendered.document.querySelectorAll("[data-src]")) {
    const stamp = block.getAttribute("data-src")!;
    const bounds = parseDataSrc(stamp);
    if (!rendered.blocks.has(stamp) || !bounds || bounds.path !== anchor.path || bounds.startLine > anchor.startLine || bounds.endLine < anchor.endLine) continue;
    const entries: IndexedText[] = [];
    const parts: string[] = [];
    let length = 0;
    let invalid = 0;
    let low = Infinity;
    let high = 0;
    const walk = (node: Node): void => {
      if (node.nodeType === 3) {
        const value = node.textContent ?? "";
        const leaf = node.parentElement?.closest("[data-revkit-leaf]");
        const record = leaf ? rendered.leaves.get(leaf.getAttribute("data-revkit-leaf")!) : undefined;
        const map = record && record.element === leaf ? record.map : undefined;
        const before = invalid;
        if (!map && (leaf || value.trim())) invalid++;
        entries.push({ start: length, end: length + value.length, map, invalidBefore: before, invalidThrough: invalid });
        if (map && map.end > windowStart && map.start < windowEnd) {
          low = Math.min(low, length + renderedBound(map, windowStart, "start"));
          high = Math.max(high, length + renderedBound(map, windowEnd, "end"));
        }
        length += value.length;
        parts.push(value);
      }
      for (const child of node.childNodes) walk(child);
    };
    walk(block);
    if (low >= high) continue;
    const text = parts.join("");
    const textWindow = text.slice(low, high);
    // Binary endpoint lookup and prefix counts make validation depend on
    // the selected range, rather than all later text nodes or leaves.
    const locate = (offset: number, side: "start" | "end"): IndexedText | undefined => {
      let lo = 0;
      let hi = entries.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (side === "start" ? entries[mid]!.end <= offset : entries[mid]!.end < offset) lo = mid + 1;
        else hi = mid;
      }
      const entry = entries[lo];
      return entry && (side === "start" ? offset >= entry.start && offset < entry.end : offset > entry.start && offset <= entry.end) ? entry : undefined;
    };
    let from = 0;
    while (from < textWindow.length) {
      const hit = textWindow.indexOf(anchor.quote.exact, from);
      if (hit < 0) break;
      from = hit + 1;
      const begin = low + hit;
      const finish = begin + anchor.quote.exact.length;
      if (!text.slice(Math.max(0, begin - anchor.quote.prefix.length), begin).endsWith(anchor.quote.prefix) || !text.startsWith(anchor.quote.suffix, finish)) continue;
      const a = locate(begin, "start");
      const b = locate(finish, "end");
      if (!a?.map || !b?.map || b.invalidThrough !== a.invalidBefore) continue;
      const sa = sourceEndpoint(a.map, begin - a.start, "start");
      const sb = sourceEndpoint(b.map, finish - b.start, "end");
      if (sa !== undefined && sb !== undefined) add(sa, sb);
      if (candidates.size > 1) return undefined;
    }
  }
  return candidates.size === 1 ? [...candidates.values()][0] : undefined;
}
