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

interface IndexedText {
  readonly start: number;
  readonly end: number;
  readonly map?: LeafMap;
  readonly block?: IndexedBlock;
  readonly invalidBefore: number;
  readonly invalidThrough: number;
}

interface IndexedBlock {
  readonly start: number;
  end: number;
  readonly bounds: NonNullable<ReturnType<typeof parseDataSrc>>;
}

interface LegacyIndex {
  readonly revision: string;
  readonly lines: ReturnType<typeof buildLineStartIndex>;
  readonly text: string;
  readonly entries: readonly IndexedText[];
  readonly blocks: readonly IndexedBlock[];
}

// A rendered snapshot is immutable. The digest binds its source line index.
// weak ownership releases the DOM/index when its rebuild bucket is finished.
const legacyIndexes = new WeakMap<RenderedProvenance, LegacyIndex>();

/** One iterative top-down pass assigns innermost block/leaf membership.
 * Block ranges share ONE text stream: even equal-stamped nested containers
 * never duplicate text or walk their descendants again. */
function legacyIndex(rendered: RenderedProvenance, source: string, revision: string): LegacyIndex {
  const cached = legacyIndexes.get(rendered);
  if (cached?.revision === revision) return cached;
  const entries: IndexedText[] = [];
  const blocks: IndexedBlock[] = [];
  const parts: string[] = [];
  let length = 0;
  let invalid = 0;
  interface Frame {
    readonly node: Node;
    readonly leaf?: Element;
    readonly map?: LeafMap;
    readonly block?: IndexedBlock;
    readonly close?: IndexedBlock;
  }
  const stack: Frame[] = [{ node: rendered.document }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.close) { frame.close.end = length; continue; }
    const { node } = frame;
    let { leaf, map, block } = frame;
    if (node.nodeType === 1) {
      const element = node as Element;
      const stamp = element.getAttribute("data-src");
      const bounds = stamp && rendered.blocks.has(stamp) ? parseDataSrc(stamp) : undefined;
      if (bounds) {
        block = { start: length, end: length, bounds };
        blocks.push(block);
        stack.push({ node, close: block });
      }
      const id = element.getAttribute("data-revkit-leaf");
      if (id !== null) {
        leaf = element;
        const record = rendered.leaves.get(id);
        map = record?.element === element ? record.map : undefined;
      }
    }
    if (node.nodeType === 3) {
      const value = node.textContent ?? "";
      const before = invalid;
      if (!map && (leaf || value.trim())) invalid++;
      entries.push({ start: length, end: length + value.length, map, block, invalidBefore: before, invalidThrough: invalid });
      parts.push(value);
      length += value.length;
    }
    for (let child = node.lastChild; child !== null; child = child.previousSibling) stack.push({ node: child, leaf, map, block });
  }
  const index: LegacyIndex = { revision, lines: buildLineStartIndex(source), text: parts.join(""), entries, blocks };
  legacyIndexes.set(rendered, index);
  return index;
}

/** KMP includes prefix/suffix in the pattern, so rejecting overlapping
 * exact-quote hits never compares the quote or context again. */
function failureTable(pattern: string): Uint32Array {
  const table = new Uint32Array(pattern.length);
  let matched = 0;
  for (let i = 1; i < pattern.length; i++) {
    while (matched > 0 && pattern[i] !== pattern[matched]) matched = table[matched - 1]!;
    if (pattern[i] === pattern[matched]) matched++;
    table[i] = matched;
  }
  return table;
}

function* matches(text: string, pattern: string, table: Uint32Array, start = 0, end = text.length): Generator<number> {
  let matched = 0;
  for (let i = start; i < end; i++) {
    while (matched > 0 && text[i] !== pattern[matched]) matched = table[matched - 1]!;
    if (text[i] === pattern[matched]) matched++;
    if (matched === pattern.length) {
      yield i + 1 - pattern.length;
      matched = table[matched - 1]!;
    }
  }
}

/** Matches arrive in text order. Each endpoint cursor visits each text
 * entry and lossy interval at most once, including rejected candidates. */
function endpointCursor(entries: readonly IndexedText[], side: "start" | "end") {
  let at = 0;
  let interval = 0;
  let delta: number | undefined;
  return (offset: number): { entry: IndexedText; source: number } | undefined => {
    while (at < entries.length && (side === "start" ? entries[at]!.end <= offset : entries[at]!.end < offset)) {
      at++;
      interval = 0;
      delta = undefined;
    }
    const entry = entries[at];
    if (!entry?.map || (side === "start" ? offset < entry.start || offset >= entry.end : offset <= entry.start || offset > entry.end)) return undefined;
    const local = offset - entry.start;
    if (local > entry.map.length) return undefined;
    delta ??= entry.map.start;
    const intervals = entry.map.intervals ?? [];
    while (interval < intervals.length) {
      const [r0, r1, s0, s1] = intervals[interval]!;
      if (local <= r0) return { entry, source: local + delta };
      if (local < r1) return { entry, source: side === "start" ? s0 : s1 };
      delta = s1 - r1;
      interval++;
    }
    return { entry, source: local + delta };
  };
}

/** Recover unique source/rendered candidates inside the recorded lines.
 * Indexing and candidate search are linear in document plus quote/context
 * size, independent of nesting depth and overlapping exact-quote hits. */
export function recoverLegacyAnchor(rendered: RenderedProvenance, source: string, anchor: Anchor): Anchor | undefined {
  if (anchor.quote.exact.length === 0) return undefined;
  const { lines, text, entries, blocks } = legacyIndex(rendered, source, anchor.revision);
  const windowStart = lines[anchor.startLine - 1];
  const last = lines[anchor.endLine - 1];
  if (windowStart === undefined || last === undefined) return undefined;
  // A terminating newline belongs to the preceding line (end-1).
  const windowEnd = lines[anchor.endLine] ?? source.length;
  const candidates = new Map<string, Anchor>();
  const add = (start: number, end: number): void => {
    if (start < windowStart || end > windowEnd || start >= end) return;
    const key = `${start}:${end}`;
    if (candidates.has(key)) return;
    candidates.set(key, { ...anchor, startLine: offsetToLine(lines, start), endLine: offsetToLine(lines, end - 1), quote: buildQuoteFromOffsets(source, start, end) });
  };
  const { exact, prefix, suffix } = anchor.quote;
  const pattern = prefix + exact + suffix;
  const table = failureTable(pattern);
  // Context may extend outside the recorded lines; only the exact range
  // must fit them. Scan this expanded window without copying its text.
  for (const hit of matches(source, pattern, table, Math.max(0, windowStart - prefix.length), Math.min(source.length, windowEnd + suffix.length))) {
    add(hit + prefix.length, hit + prefix.length + exact.length);
    if (candidates.size > 1) return undefined;
  }
  const eligible = blocks.filter(({ bounds }) => bounds.path === anchor.path && bounds.startLine <= anchor.startLine && bounds.endLine >= anchor.endLine);
  let blockAt = 0;
  let containingEnd = -1;
  const startEndpoint = endpointCursor(entries, "start");
  const endEndpoint = endpointCursor(entries, "end");
  for (const hit of matches(text, pattern, table)) {
    // Preorder block starts and KMP hits are monotonic. An ancestor must
    // contain the FULL pattern: context cannot spill into a sibling block.
    while (blockAt < eligible.length && eligible[blockAt]!.start <= hit) {
      containingEnd = Math.max(containingEnd, eligible[blockAt]!.end);
      blockAt++;
    }
    if (containingEnd < hit + pattern.length) continue;
    const a = startEndpoint(hit + prefix.length);
    const b = endEndpoint(hit + prefix.length + exact.length);
    if (!a || !b || b.entry.invalidThrough !== a.entry.invalidBefore) continue;
    add(a.source, b.source);
    if (candidates.size > 1) return undefined;
  }
  return candidates.size === 1 ? candidates.values().next().value : undefined;
}
