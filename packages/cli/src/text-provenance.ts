// Renderer-derived provenance (ADR-0006, #113). This is a bounded
// substitution walk over ONE positioned text leaf, never a Markdown parser.
// All offsets are UTF-16, half-open, in the LF-normalised source.
import { parseFragment } from "parse5";

/** rendered start/end, absolute source start/end. Identity runs are implicit. */
export type Substitution = readonly [number, number, number, number];
export interface LeafMap {
  readonly start: number;
  readonly end: number;
  readonly length: number;
  readonly intervals?: readonly Substitution[];
}

const ESCAPABLE = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/;
const ENTITY = /^&(?:#[0-9]{1,7}|#x[0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/;

function entityValue(token: string): string | undefined {
  const node = parseFragment(token).childNodes[0];
  return node?.nodeName === "#text" && "value" in node && node.value !== token ? node.value : undefined;
}

/** Accept only the renderer's finite, known substitutions. Mismatch closes
 * the entire leaf. A code leaf's positioned slice includes its delimiters;
 * trim those and CommonMark's single padding space before walking. */
export function alignLeaf(
  slice: string,
  value: string,
  sourceStart: number,
  inlineCode = false,
): LeafMap | undefined {
  let from = 0;
  let to = slice.length;
  if (inlineCode) {
    while (slice[from] === "`") from++;
    let closing = to;
    while (closing > from && slice[closing - 1] === "`") closing--;
    if (from === 0 || to - closing !== from) return undefined;
    to = closing;
    if (slice[from] === " " && slice[to - 1] === " " && /[^ \n]/.test(slice.slice(from, to))) {
      from++;
      to--;
    }
  }
  const start = sourceStart + from;
  if (slice.slice(from, to) === value) return { start, end: sourceStart + to, length: value.length };
  const intervals: Substitution[] = [];
  function* atoms(): Generator<{ value: string; start: number; end: number }> {
    let at = from;
    while (at < to) {
      let width = 1;
      let decoded = slice[at]!;
      if (!inlineCode && decoded === "\\" && at + 1 < to && ESCAPABLE.test(slice[at + 1]!)) {
        width = 2;
        decoded = slice[at + 1]!;
      } else if (!inlineCode && decoded === "&") {
        const token = ENTITY.exec(slice.slice(at, Math.min(to, at + 34)))?.[0];
        const replacement = token === undefined ? undefined : entityValue(token);
        if (replacement !== undefined) { width = token!.length; decoded = replacement; }
      } else if (inlineCode && decoded === "\n") {
        decoded = " ";
      }
      yield { value: decoded, start: sourceStart + at, end: sourceStart + at + width };
      at += width;
    }
  }
  // Decode first, then consume typography runs. This composes the finite
  // table even when e.g. three dot entities collapse to one ellipsis.
  const decoded = atoms();
  let next = decoded.next();
  let out = 0;
  while (!next.done) {
    const atom = next.value;
    next = decoded.next();
    let end = atom.end;
    let text = atom.value;
    if (!inlineCode && (text === "." || text === "-" || text === "'" || text === "`")) {
      let run = 1;
      const individual: Substitution[] = [];
      const remember = (item: typeof atom, offset: number): void => {
        if (slice.slice(item.start - sourceStart, item.end - sourceStart) !== item.value) {
          individual.push([offset, offset + item.value.length, item.start, item.end]);
        }
      };
      remember(atom, out);
      while (!next.done && next.value.value === atom.value) {
        remember(next.value, out + run);
        run++;
        end = next.value.end;
        next = decoded.next();
      }
      if (text === "." && run >= 3 && value[out] === "…") text = "…";
      else if (text === "-" && run === 2 && value[out] === "—") text = "—";
      else if ((text === "'" || text === "`") && run === 2 && (value[out] === "“" || value[out] === "”")) text = value[out]!;
      else if (run > 1) {
        // An unchanged run still contains independently selectable atoms.
        // Only a real typography collapse may combine their intervals.
        text = text.repeat(run);
        if (!value.startsWith(text, out)) return undefined;
        for (const interval of individual) intervals.push(interval);
        out += text.length;
        continue;
      }
    }
    if (!inlineCode) {
      if (text === '"' && (value[out] === "“" || value[out] === "”")) text = value[out]!;
      if (text === "'" && (value[out] === "‘" || value[out] === "’")) text = value[out]!;
    }
    if (!value.startsWith(text, out)) return undefined;
    if (slice.slice(atom.start - sourceStart, end - sourceStart) !== text) intervals.push([out, out + text.length, atom.start, end]);
    out += text.length;
  }
  if (out !== value.length) return undefined;
  return { start, end: sourceStart + to, length: value.length, ...(intervals.length > 0 ? { intervals } : {}) };
}

/** An endpoint inside a lossy token includes that token's full source
 * interval. Endpoints at a token boundary retain half-open semantics. */
export function sourceEndpoint(map: LeafMap, offset: number, side: "start" | "end"): number | undefined {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > map.length) return undefined;
  let delta = map.start;
  for (const [r0, r1, s0, s1] of map.intervals ?? []) {
    if (offset <= r0) return offset + delta;
    if (offset < r1) return side === "start" ? s0 : s1;
    delta = s1 - r1;
  }
  return offset + delta;
}
