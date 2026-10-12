import { revisionOf } from "./revision.ts";

export const BLOCK_MAP_VERSION = 1;
export const MARKDOWN_GRAMMAR_VERSION = "commonmark-gfm-math-v1";
export interface PositionedMarkdownNode {
  readonly type: string;
  readonly position?: { readonly start: { readonly offset?: number }; readonly end: { readonly offset?: number } };
  readonly children?: readonly PositionedMarkdownNode[];
}
export interface BlockNode {
  readonly id: number;
  readonly kind: string;
  readonly parent: number | null;
  readonly start: number;
  readonly end: number;
  readonly barrier: boolean;
}
export interface SyntaxEnvelope {
  readonly container: number;
  readonly start: number;
  readonly end: number;
}
export interface BlockUnit {
  readonly id: number;
  readonly kind: string;
  readonly start: number;
  readonly end: number;
  readonly ancestors: readonly number[];
  readonly envelopes: readonly SyntaxEnvelope[];
}
export interface BlockMap {
  readonly version: number;
  readonly grammarVersion: string;
  readonly revision: string;
  readonly sourceLength: number;
  readonly nodes: readonly BlockNode[];
  readonly units: readonly BlockUnit[];
}
const CONTAINERS = new Set(["root", "list", "listItem", "blockquote", "table", "tableRow", "footnoteDefinition"]);
const UNITS = new Set(["paragraph", "heading", "tableCell", "code", "math", "html"]);
const INLINE = new Set(["text", "emphasis", "strong", "delete", "inlineCode", "inlineMath", "break", "link", "image", "linkReference", "imageReference", "footnoteReference", "html"]);
function unsupportedInline(node: PositionedMarkdownNode): boolean {
  return (node.children ?? []).some((child) => !INLINE.has(child.type) || unsupportedInline(child));
}
const ENVELOPES = new Set(["listItem", "blockquote", "footnoteDefinition"]);

/** Pure extraction. Inline children belong to their atomic parent unit.
 * Missing positions fence the entire containing region, never a blank-line guess. */
export function extractBlockMap(root: PositionedMarkdownNode, source: string, revision: string): BlockMap {
  if (source.includes("\r")) throw new Error("Block maps require LF source");
  const nodes: BlockNode[] = [];
  const units: BlockUnit[] = [];
  function visit(node: PositionedMarkdownNode, parent: number | null, ancestors: readonly number[], fallback: { start: number; end: number }): void {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    const positioned = start !== undefined && end !== undefined;
    const barrier = !positioned || (!CONTAINERS.has(node.type) && !UNITS.has(node.type)) || (UNITS.has(node.type) && unsupportedInline(node));
    const id = nodes.length;
    const interval = positioned ? { start, end } : fallback;
    nodes.push({ id, parent, kind: node.type, ...interval, barrier });
    if (barrier) return;
    if (UNITS.has(node.type)) {
      units.push({ id, kind: node.type, ...interval, ancestors: [...ancestors], envelopes: [] });
    } else {
      // A malformed child makes the whole container unavailable; sibling
      // extents cannot safely be inferred from unpositioned structure.
      if (node.children?.some((child) => child.position?.start.offset === undefined || child.position?.end.offset === undefined)) {
        nodes[id] = { ...nodes[id]!, barrier: true };
        return;
      }
      for (const child of node.children ?? []) visit(child, id, [...ancestors, id], interval);
    }
  }
  visit(root, null, [], { start: 0, end: source.length });
  // Only the first/last descendant can own a container's outer syntax.
  // Internal wrapped-line prefixes already lie inside mdast's interval.
  const first = new Map<number, number>();
  const last = new Map<number, number>();
  units.forEach((unit, index) => {
    for (const ancestor of unit.ancestors) {
      if (!first.has(ancestor)) first.set(ancestor, index);
      last.set(ancestor, index);
    }
  });
  const owned = units.map((unit, index) => {
    const envelopes: SyntaxEnvelope[] = [];
    for (const ancestor of unit.ancestors) {
      const container = nodes[ancestor]!;
      if (!ENVELOPES.has(container.kind)) continue;
      if (first.get(ancestor) === index && container.start < unit.start) envelopes.push({ container: ancestor, start: container.start, end: unit.start });
      if (last.get(ancestor) === index && unit.end < container.end) envelopes.push({ container: ancestor, start: unit.end, end: container.end });
    }
    return { ...unit, envelopes };
  });
  const map = { version: BLOCK_MAP_VERSION, grammarVersion: MARKDOWN_GRAMMAR_VERSION, revision, sourceLength: source.length, nodes, units: owned };
  validateBlockMap(map, { revision, sourceLength: source.length });
  for (const node of nodes) Object.freeze(node);
  for (const unit of owned) {
    unit.envelopes.forEach(Object.freeze);
    Object.freeze(unit.envelopes);
    Object.freeze(unit.ancestors);
    Object.freeze(unit);
  }
  return Object.freeze({ ...map, nodes: Object.freeze(nodes), units: Object.freeze(owned) });
}

export function validateBlockMap(map: BlockMap, expected: { revision: string; sourceLength: number; grammarVersion?: string }): void {
  if (map.version !== BLOCK_MAP_VERSION || map.grammarVersion !== (expected.grammarVersion ?? MARKDOWN_GRAMMAR_VERSION) || map.revision !== expected.revision || map.sourceLength !== expected.sourceLength) throw new Error("Block map snapshot/grammar mismatch");
  const childrenEnd = new Map<number | null, number>();
  for (const [index, node] of map.nodes.entries()) {
    if (node.id !== index || !Number.isSafeInteger(node.start) || !Number.isSafeInteger(node.end) || node.start < 0 || node.end < node.start || node.end > map.sourceLength) throw new Error("Invalid block interval");
    if (index > 0 && node.parent === null) throw new Error("Multiple snapshot roots");
    if (node.parent !== null) {
      const parent = map.nodes[node.parent];
      if (!parent || parent.id >= node.id || parent.barrier || node.start < parent.start || node.end > parent.end) throw new Error("Invalid block nesting");
    }
    if (node.start < (childrenEnd.get(node.parent) ?? 0)) throw new Error("Unsorted block siblings");
    childrenEnd.set(node.parent, node.end);
  }
  if (map.nodes.length === 0 || map.nodes[0]!.parent !== null || map.nodes[0]!.start !== 0 || map.nodes[0]!.end !== map.sourceLength) throw new Error("Missing snapshot root");
  const firstUnits = new Map<number, number>();
  const lastUnits = new Map<number, number>();
  for (const unit of map.units) for (const ancestor of unit.ancestors) {
    if (!firstUnits.has(ancestor)) firstUnits.set(ancestor, unit.id);
    lastUnits.set(ancestor, unit.id);
  }
  let end = 0;
  const seen = new Set<number>();
  for (const unit of map.units) {
    const node = map.nodes[unit.id];
    if (!node || node.barrier || !UNITS.has(node.kind) || node.kind !== unit.kind || node.start !== unit.start || node.end !== unit.end || unit.start < end || seen.has(unit.id)) throw new Error("Invalid ordered block units");
    const ancestors: number[] = [];
    let parent = node.parent;
    while (parent !== null) { ancestors.unshift(parent); parent = map.nodes[parent]!.parent; }
    if (ancestors.join() !== unit.ancestors.join()) throw new Error("Invalid unit ancestry");
    for (const envelope of unit.envelopes) {
      const container = map.nodes[envelope.container];
      if (!container || !unit.ancestors.includes(container.id) || !ENVELOPES.has(container.kind) || envelope.start < container.start || envelope.end > container.end || envelope.start > envelope.end || (envelope.end !== unit.start && envelope.start !== unit.end)) throw new Error("Invalid syntax envelope");
      const leading = envelope.end === unit.start && envelope.start === container.start && firstUnits.get(container.id) === unit.id;
      const trailing = envelope.start === unit.end && envelope.end === container.end && lastUnits.get(container.id) === unit.id;
      if (!leading && !trailing) throw new Error("Syntax envelope widens a child");
    }
    seen.add(unit.id);
    end = unit.end;
  }
  if (map.nodes.some((node) => UNITS.has(node.kind) && !node.barrier && !seen.has(node.id))) throw new Error("Missing block unit");
}

/** Copy validated data so caller-owned arrays cannot alter a prepared snapshot. */
export function freezeBlockMap(map: BlockMap): BlockMap {
  return Object.freeze({ ...map,
    nodes: Object.freeze(map.nodes.map((node) => Object.freeze({ ...node }))),
    units: Object.freeze(map.units.map((unit) => Object.freeze({ ...unit,
      ancestors: Object.freeze([...unit.ancestors]),
      envelopes: Object.freeze(unit.envelopes.map((envelope) => Object.freeze({ ...envelope }))),
    }))),
  });
}

export async function validateBlockSnapshot(map: BlockMap, source: string): Promise<void> {
  const lf = source.replace(/\r\n?/g, "\n");
  validateBlockMap(map, { revision: await revisionOf(lf), sourceLength: lf.length });
}

export interface BlockCoverage {
  readonly units: readonly number[];
  readonly firstOffset: number;
  readonly lastOffset: number;
  readonly envelopes: readonly SyntaxEnvelope[];
  readonly separators: readonly { start: number; end: number }[];
}
/** Syntax permission is derived from the actual span, never the ancestor size. */
export function blockCoverage(map: BlockMap, start: number, end: number): BlockCoverage | undefined {
  if (start < 0 || end <= start || end > map.sourceLength || map.nodes.some((node) => node.barrier && node.start < end && node.end > start)) return undefined;
  const touched = map.units.filter((unit) => unit.start < end && (unit.end > start || (unit.start === unit.end && unit.start >= start)));
  if (!touched.length) return undefined;
  const envelopes = touched.flatMap((unit) => unit.envelopes).filter((env) => env.start < end && env.end > start).map((env) => ({ ...env, start: Math.max(start, env.start), end: Math.min(end, env.end) }));
  const first = touched[0]!;
  const last = touched[touched.length - 1]!;
  if (start < first.start && !envelopes.some((env) => env.start === start && env.end === first.start)) return undefined;
  if (end > last.end && !envelopes.some((env) => env.start === last.end && env.end === end)) return undefined;
  return { units: touched.map((unit) => unit.id), firstOffset: start - first.start, lastOffset: end - last.start, envelopes, separators: touched.slice(1).map((unit, index) => ({ start: touched[index]!.end, end: unit.start })) };
}
