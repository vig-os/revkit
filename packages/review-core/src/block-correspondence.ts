import { blockCoverage, validateBlockMap, type BlockMap, type BlockUnit } from "./block-map.ts";
import type { Diff } from "./vendor/dmp.ts";

export interface RetainedRange { readonly oldStart: number; readonly newStart: number; readonly length: number; readonly payload: number }
export interface BlockEvidence {
  readonly oldUnit: number;
  readonly newUnit: number;
  readonly retained: readonly RetainedRange[];
}
export interface BlockCorrespondence {
  readonly forward: ReadonlyMap<number, readonly BlockEvidence[]>;
  readonly reverse: ReadonlyMap<number, readonly BlockEvidence[]>;
  readonly pairs: ReadonlyMap<number, number>;
  readonly splits: ReadonlySet<number>;
  readonly merges: ReadonlySet<number>;
}
function role(map: BlockMap, unit: BlockUnit): string {
  return [unit.kind, ...unit.ancestors.map((id) => map.nodes[id]!.kind).filter((kind) => kind !== "root")].join("/");
}
function contentIndex(map: BlockMap, source: string): Map<string, BlockUnit[]> {
  const index = new Map<string, BlockUnit[]>();
  for (const unit of map.units) {
    // The full string is the key: hash collisions cannot authorize a pair.
    const key = JSON.stringify([role(map, unit), source.slice(unit.start, unit.end)]);
    const found = index.get(key);
    if (found) found.push(unit); else index.set(key, [unit]);
  }
  return index;
}

/** Sparse EQUAL-run sweep. No block Cartesian product or ordinal matching.
 * Crossings (including exact moves) remain outside this monotone relation. */
export function correspondBlocks(oldMap: BlockMap, newMap: BlockMap, oldSource: string, newSource: string, diffs: readonly Diff[]): BlockCorrespondence {
  validateBlockMap(oldMap, { revision: oldMap.revision, sourceLength: oldSource.length });
  validateBlockMap(newMap, { revision: newMap.revision, sourceLength: newSource.length });
  // Prefix maxima let changed-region barrier checks stay O(log B), even
  // when thousands of unsupported nodes separate rewritten units.
  function barrierIndex(map: BlockMap) {
    const barriers = map.nodes.filter((node) => node.barrier);
    const maximumEnd: number[] = [];
    let maximum = 0;
    for (const node of barriers) { maximum = Math.max(maximum, node.end); maximumEnd.push(maximum); }
    return (start: number, end: number): boolean => {
      let low = 0; let high = barriers.length;
      while (low < high) { const mid = (low + high) >>> 1; if (barriers[mid]!.start < end) low = mid + 1; else high = mid; }
      return low > 0 && maximumEnd[low - 1]! > start;
    };
  }
  const oldBarrier = barrierIndex(oldMap);
  const newBarrier = barrierIndex(newMap);
  const edges = new Map<string, { oldUnit: number; newUnit: number; retained: RetainedRange[] }>();
  let oldAt = 0;
  let newAt = 0;
  let oi = 0;
  let ni = 0;
  for (const [op, text] of diffs) {
    if ((op !== 1 && oldSource.slice(oldAt, oldAt + text.length) !== text) || (op !== -1 && newSource.slice(newAt, newAt + text.length) !== text)) throw new Error("Diff snapshot mismatch");
    if (op === 0) {
      const oldEnd = oldAt + text.length;
      const newEnd = newAt + text.length;
      while (oi < oldMap.units.length && oldMap.units[oi]!.end <= oldAt) oi++;
      while (ni < newMap.units.length && newMap.units[ni]!.end <= newAt) ni++;
      let a = oi;
      let b = ni;
      while (a < oldMap.units.length && b < newMap.units.length) {
        const old = oldMap.units[a]!;
        const next = newMap.units[b]!;
        if (old.start >= oldEnd || next.start >= newEnd) break;
        const start = Math.max(0, old.start - oldAt, next.start - newAt);
        const end = Math.min(text.length, old.end - oldAt, next.end - newAt);
        if (start < end) {
          const payload = (text.slice(start, end).match(/[\p{L}\p{N}]/gu) ?? []).length;
          if (payload > 0) {
            const key = `${old.id}/${next.id}`;
            let edge = edges.get(key);
            if (!edge) { edge = { oldUnit: old.id, newUnit: next.id, retained: [] }; edges.set(key, edge); }
            edge.retained.push({ oldStart: oldAt + start, newStart: newAt + start, length: end - start, payload });
          }
        }
        if (old.end - oldAt <= next.end - newAt) a++; else b++;
      }
    }
    if (op !== 1) oldAt += text.length;
    if (op !== -1) newAt += text.length;
  }
  if (oldAt !== oldSource.length || newAt !== newSource.length) throw new Error("Incomplete snapshot diff");
  const forward = new Map<number, BlockEvidence[]>();
  const reverse = new Map<number, BlockEvidence[]>();
  for (const edge of edges.values()) {
    const frozen = Object.freeze({ ...edge, retained: Object.freeze(edge.retained.map((range) => Object.freeze(range))) });
    const a = forward.get(edge.oldUnit) ?? [];
    a.push(frozen); forward.set(edge.oldUnit, a);
    const b = reverse.get(edge.newUnit) ?? [];
    b.push(frozen); reverse.set(edge.newUnit, b);
  }
  const splits = new Set([...forward].filter(([, edges]) => edges.length > 1).map(([id]) => id));
  const merges = new Set([...reverse].filter(([, edges]) => edges.length > 1).map(([id]) => id));
  const pairs = new Map<number, number>();
  const oldIndex = contentIndex(oldMap, oldSource);
  const newIndex = contentIndex(newMap, newSource);
  const candidates = new Map<number, number>();
  const exactDestinations = new Map<number, number>();
  const repeatedChanges = new Set<number>();
  const newRoles = new Map(newMap.units.map((unit) => [unit.id, role(newMap, unit)]));
  for (const [key, units] of oldIndex) {
    const next = newIndex.get(key);
    if (next && (units.length > 1 || next.length > 1) && units.length !== next.length) for (const unit of units) repeatedChanges.add(unit.id);
    if (units.length === 1 && next?.length === 1) {
      const a = units[0]!; const b = next[0]!;
      exactDestinations.set(a.id, b.id);
      // Exact content is an anchor only with retained in-place evidence.
      // A global unique-content lookup alone never grants move permission.
      if (edges.has(`${a.id}/${b.id}`) && oldSource.slice(a.start, a.end) === newSource.slice(b.start, b.end)) candidates.set(a.id, b.id);
    }
  }
  for (const old of oldMap.units) {
    const evidence = forward.get(old.id);
    if (evidence?.length !== 1 || repeatedChanges.has(old.id)) continue;
    const nextId = evidence[0]!.newUnit;
    if ((exactDestinations.get(old.id) === undefined || exactDestinations.get(old.id) === nextId) && reverse.get(nextId)?.length === 1 && role(oldMap, old) === newRoles.get(nextId)) candidates.set(old.id, nextId);
  }
  // Units' IDs are preorder IDs, hence also source order. Reject both sides
  // of any crossing instead of silently keeping whichever was visited first.
  const ordered = [...candidates].sort((a, b) => a[0] - b[0]);
  const suffixMin: number[] = [];
  let minimum = Infinity;
  for (let i = ordered.length - 1; i >= 0; i--) { suffixMin[i] = minimum; minimum = Math.min(minimum, ordered[i]![1]); }
  let maximum = -1;
  for (const [i, [old, next]] of ordered.entries()) {
    if (next > maximum && next < suffixMin[i]! && !splits.has(old) && !merges.has(next)) pairs.set(old, next);
    maximum = Math.max(maximum, next);
  }
  // Unique one/one changed regions may nominate a pair even with no EQUAL
  // payload. Similarity and anchor evidence are still the acceptance gate.
  const oldOrd = new Map(oldMap.units.map((unit, index) => [unit.id, index]));
  const newOrd = new Map(newMap.units.map((unit, index) => [unit.id, index]));
  const boundaries = [[-1, -1], ...[...pairs].sort((a, b) => a[0] - b[0]).map(([a, b]) => [oldOrd.get(a)!, newOrd.get(b)!]), [oldMap.units.length, newMap.units.length]];
  for (let i = 1; i < boundaries.length; i++) {
    const previous = boundaries[i - 1]!; const next = boundaries[i]!;
    if (next[0]! - previous[0]! !== 2 || next[1]! - previous[1]! !== 2) continue;
    const a = oldMap.units[previous[0]! + 1]!; const b = newMap.units[previous[1]! + 1]!;
    const oldRegionStart = previous[0] === -1 ? 0 : oldMap.units[previous[0]!]!.end;
    const newRegionStart = previous[1] === -1 ? 0 : newMap.units[previous[1]!]!.end;
    const oldRegionEnd = next[0] === oldMap.units.length ? oldSource.length : oldMap.units[next[0]!]!.start;
    const newRegionEnd = next[1] === newMap.units.length ? newSource.length : newMap.units[next[1]!]!.start;
    const barrier = oldBarrier(oldRegionStart, oldRegionEnd) || newBarrier(newRegionStart, newRegionEnd);
    if (!barrier && !forward.has(a.id) && !reverse.has(b.id) && role(oldMap, a) === role(newMap, b)) pairs.set(a.id, b.id);
  }
  forward.forEach(Object.freeze); reverse.forEach(Object.freeze);
  return Object.freeze({ forward, reverse, pairs, splits, merges });
}

/** A multi-unit run may survive only with contiguous one-to-one counterparts. */
export function correspondingRun(oldMap: BlockMap, newMap: BlockMap, relation: BlockCorrespondence, start: number, end: number): readonly BlockUnit[] | undefined {
  const coverage = blockCoverage(oldMap, start, end);
  if (!coverage) return undefined;
  const indexes = new Map(newMap.units.map((unit, index) => [unit.id, index]));
  const run: BlockUnit[] = [];
  let previous: number | undefined;
  for (const old of coverage.units) {
    const id = relation.pairs.get(old);
    if (id === undefined) return undefined;
    const index = indexes.get(id)!;
    if (previous !== undefined && index !== previous + 1) return undefined;
    run.push(newMap.units[index]!); previous = index;
  }
  if (newMap.nodes.some((node) => node.barrier && node.start < run[run.length - 1]!.end && node.end > run[0]!.start)) return undefined;
  return Object.freeze(run);
}
