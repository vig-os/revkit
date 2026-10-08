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

/** Recover legacy quotes using unique renderer candidates inside their
 * recorded block. Source-shaped and rendered candidates must agree. */
export function recoverLegacyAnchor(rendered: RenderedProvenance, source: string, anchor: Anchor): Anchor | undefined {
  const candidates = new Map<string, Anchor>();
  const lines = buildLineStartIndex(source);
  const add = (start: number, end: number): void => {
    if (offsetToLine(lines, start) < anchor.startLine || offsetToLine(lines, end - 1) > anchor.endLine) return;
    candidates.set(`${start}:${end}`, { ...anchor, startLine: offsetToLine(lines, start), endLine: offsetToLine(lines, end - 1), quote: buildQuoteFromOffsets(source, start, end) });
  };
  let cursor = 0;
  while (cursor < source.length) {
    const hit = source.indexOf(anchor.quote.exact, cursor);
    if (hit < 0) break;
    if (source.slice(Math.max(0, hit - anchor.quote.prefix.length), hit).endsWith(anchor.quote.prefix) && source.startsWith(anchor.quote.suffix, hit + anchor.quote.exact.length)) add(hit, hit + anchor.quote.exact.length);
    if (candidates.size > 1) return undefined;
    cursor = hit + 1;
  }
  for (const block of rendered.document.querySelectorAll("[data-src]")) {
    const bounds = parseDataSrc(block.getAttribute("data-src")!);
    if (!bounds || bounds.path !== anchor.path || bounds.startLine > anchor.startLine || bounds.endLine < anchor.endLine) continue;
    const textNodes: Text[] = [];
    const walk = (node: Node): void => { if (node.nodeType === 3) textNodes.push(node as Text); for (const child of node.childNodes) walk(child); };
    walk(block);
    const text = textNodes.map((n) => n.data).join("");
    const pattern = anchor.quote.prefix + anchor.quote.exact + anchor.quote.suffix;
    let from = 0;
    while (from <= text.length) {
      const hit = text.indexOf(pattern, from);
      if (hit < 0) break;
      const begin = hit + anchor.quote.prefix.length;
      const finish = begin + anchor.quote.exact.length;
      let length = 0;
      let a: { leaf: string; offset: number } | undefined;
      let b: { leaf: string; offset: number } | undefined;
      for (const node of textNodes) {
        const leaf = node.parentElement?.closest("[data-revkit-leaf]")?.getAttribute("data-revkit-leaf");
        if (leaf) {
          if (begin >= length && begin < length + node.length) a = { leaf, offset: begin - length };
          if (finish > length && finish <= length + node.length) b = { leaf, offset: finish - length };
        }
        length += node.length;
      }
      if (a && b) {
        const resolved = selectionAnchor(rendered, source, bounds, { kind: "range", version: PROVENANCE_VERSION, revision: anchor.revision, start: a, end: b }, anchor.revision);
        if (resolved) {
          const sa = sourceEndpoint(rendered.leaves.get(a.leaf)!.map, a.offset, "start")!;
          const sb = sourceEndpoint(rendered.leaves.get(b.leaf)!.map, b.offset, "end")!;
          add(sa, sb);
          if (candidates.size > 1) return undefined;
        }
      }
      from = hit + 1;
    }
  }
  return candidates.size === 1 ? [...candidates.values()][0] : undefined;
}
