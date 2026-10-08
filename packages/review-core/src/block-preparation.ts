import { freezeBlockMap, validateBlockSnapshot, type BlockMap } from "./block-map.ts";
import { correspondBlocks } from "./block-correspondence.ts";
import { DiffMatchPatch, type Diff } from "./vendor/dmp.ts";
export * from "./block-correspondence.ts";

export interface SegmentationInstrumentation { bytesSegmented: number; snapshotsSegmented: number }
export interface SegmentationTables {
  readonly sourceLength: number;
  readonly graphemeBoundary: Uint8Array;
  readonly wordInterior: Uint8Array;
  readonly wordEnd: Uint8Array;
}
/** Each granularity sees the entire original source once, preserving context.
 * bytesSegmented counts UTF-8 input bytes across both Segmenter passes. */
export function prepareSegmentation(source: string, instrumentation?: SegmentationInstrumentation): SegmentationTables {
  if (source.includes("\r")) throw new Error("Segmentation requires LF source");
  const graphemeBoundary = new Uint8Array(source.length + 1);
  const wordInterior = new Uint8Array(source.length + 1);
  const wordEnd = new Uint8Array(source.length + 1);
  for (const part of new Intl.Segmenter("und", { granularity: "grapheme" }).segment(source)) graphemeBoundary[part.index] = 1;
  graphemeBoundary[source.length] = 1;
  for (const part of new Intl.Segmenter("und", { granularity: "word" }).segment(source)) {
    if (!part.isWordLike) continue;
    const end = part.index + part.segment.length;
    wordInterior.fill(1, part.index + 1, end);
    wordEnd[end] = 1;
  }
  if (instrumentation) { instrumentation.bytesSegmented += new TextEncoder().encode(source).length * 2; instrumentation.snapshotsSegmented++; }
  return Object.freeze({ sourceLength: source.length, graphemeBoundary, wordInterior, wordEnd });
}
export function safePreparedEndpoints(tables: SegmentationTables, start: number, end: number): boolean {
  return start >= 0 && end > start && end <= tables.sourceLength && tables.graphemeBoundary[start] === 1 && tables.graphemeBoundary[end] === 1 && tables.wordInterior[start] === 0 && tables.wordInterior[end] === 0;
}
export interface PreparedBlockSnapshot {
  readonly source: string;
  readonly map: BlockMap;
  readonly segmentation: SegmentationTables;
}
export async function prepareBlockSnapshot(source: string, map: BlockMap, instrumentation?: SegmentationInstrumentation): Promise<PreparedBlockSnapshot> {
  const lf = source.replace(/\r\n?/g, "\n");
  await validateBlockSnapshot(map, lf);
  return Object.freeze({ source: lf, map: freezeBlockMap(map), segmentation: prepareSegmentation(lf, instrumentation) });
}

export interface LocalAlignmentBudget { readonly maxSourceUnits: number; readonly maxPairs: number; readonly timeoutSeconds: number }
export const DEFAULT_LOCAL_ALIGNMENT_BUDGET: LocalAlignmentBudget = Object.freeze({ maxSourceUnits: 1_000_000, maxPairs: 10_000, timeoutSeconds: 0.05 });
/** Separate preparation for slice 2 consumers. Production acceptance does not
 * inspect this data yet. Local alignment is lazy and cached per proven pair;
 * aggregate limits fail closed rather than accumulating per-anchor timeouts. */
export function prepareBlockPair(old: PreparedBlockSnapshot, next: PreparedBlockSnapshot, diffs: readonly Diff[], budget: LocalAlignmentBudget = DEFAULT_LOCAL_ALIGNMENT_BUDGET) {
  const correspondence = correspondBlocks(old.map, next.map, old.source, next.source, diffs);
  const alignments = new Map<number, readonly Diff[]>();
  const oldUnits = new Map(old.map.units.map((unit) => [unit.id, unit]));
  const newUnits = new Map(next.map.units.map((unit) => [unit.id, unit]));
  let sourceUnitsAligned = 0;
  let pairsAligned = 0;
  return Object.freeze({
    old, next, correspondence,
    localAlignment(oldUnit: number): readonly Diff[] | undefined {
      const cached = alignments.get(oldUnit);
      if (cached) return cached;
      const newId = correspondence.pairs.get(oldUnit);
      if (newId === undefined) return undefined;
      const a = oldUnits.get(oldUnit)!; const b = newUnits.get(newId)!;
      const size = a.end - a.start + b.end - b.start;
      if (sourceUnitsAligned + size > budget.maxSourceUnits || pairsAligned >= budget.maxPairs) return undefined;
      sourceUnitsAligned += size; pairsAligned++;
      const dmp = new DiffMatchPatch(); dmp.Diff_Timeout = budget.timeoutSeconds;
      const raw = dmp.diff_main(old.source.slice(a.start, a.end), next.source.slice(b.start, b.end)) as Diff[];
      raw.forEach(Object.freeze);
      const frozen = Object.freeze(raw);
      alignments.set(oldUnit, frozen);
      return frozen;
    },
    alignmentStats: () => ({ sourceUnitsAligned, pairsAligned }),
  });
}
export type PreparedBlockPair = ReturnType<typeof prepareBlockPair>;
