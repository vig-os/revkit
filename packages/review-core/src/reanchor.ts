// Re-anchoring engine (ADR-0006 Acceptance, PR-40 review round 2).
//
// Principle: the DIFF decides WHERE a comment may go; similarity only
// decides WHETHER it still fits there. We never do a global fuzzy
// search — orphaning beats a wrong place.
//
// Pipeline:
//   (0) Identity     — `revisionOf(newSource) === anchor.revision`
//                      short-circuits to `anchored`.
//   (1) Snapshot     — `revisionOf(oldSource)` must equal
//                      `anchor.revision`, otherwise we cannot trust
//                      the diff and orphan.
//   (2) Char diff    — `diff_main(oldLF, newLF)` at CHARACTER
//                      granularity, with `diff_cleanupSemantic` and
//                      `Diff_Timeout` bounded. One diff serves the
//                      whole classification.
//   (3) Classify     — locate the anchor's OLD span (byte offsets in
//                      `oldLF`) via the recorded `prefix + exact +
//                      suffix`, then walk the diff to classify:
//                        unchanged is entirely in EQUAL segments,
//                        modified is mixed EQUAL and DELETE,
//                        deleted is entirely in DELETE segments.
//   (4a) unchanged   — map through `diff_xIndex`, verify the new text
//                      equals the exact quote THROUGH the typography
//                      fold (`foldedEquals`), and return
//                      `quote-exact`. No search.
//   (4b) modified    — search ONLY inside a local hunk window
//                      (enclosing changed segments plus a small slack,
//                      ± `DEFAULT_HUNK_SLACK` chars). Bitap at the
//                      diff-mapped position, plus at the window
//                      boundaries, gives a small candidate set.
//                      `alignMatchedText` walks the OLD quote's end
//                      onto the new source and records the ACTUAL
//                      matched text (Blocker 2 fix). Accept when the
//                      quote similarity ≥ `DEFAULT_MIN_QUOTE_SCORE`.
//                      Never global.
//   (4c) deleted     — try `tryMove(...)`: search the new source for
//                      an EXACT `prefix + exact + suffix` match with
//                      substantial context (≥
//                      `DEFAULT_MIN_MOVE_CONTEXT` non-whitespace
//                      characters on each side, or the context
//                      reaches a line boundary). Linear `indexOf`,
//                      stops at the second hit. Exactly one match →
//                      `quote-exact` (moved); zero or several →
//                      orphan. Never a fuzzy or quote-alone fallback.
//                      The search folds first, so a moved block whose
//                      stored quote came from the rendered DOM is found
//                      at its source offsets.
//
// Coherent-anchor guarantee: every non-orphaned result carries the
// NEW text at the matched location as `quote.exact`, `prefix`/`suffix`
// recut around it, and line numbers computed from the actual
// offsets. A subsequent rebuild reads back a coherent anchor.
//
// Performance: `buildLineStartIndex(source)` computes a sorted array
// of line-start offsets once per source; `offsetToLine` /
// `lineToOffset` are O(log n) / O(1). Every offset probe uses the
// precomputed index. Fixture perf tests pin < 200 ms on the 20 k
// `- item` list and the pathological 200 k `a` case.
//
// Typographic fold (ADR-0006 amendment, issue #113): every
// comparison of a RECORDED quote against SOURCE text goes through
// `foldedEquals` (`src/typography.ts`), and every SEARCH folds both
// the haystack and the needle first, mapping the hit back to a
// source offset through `FoldedSource.starts`. The fold is what makes
// a quote stored from the RENDERED DOM — which is what the rail
// captured before the daemon took quote provenance, and which
// `remark-smartypants` guarantees differs from the source on ~43 % of
// this repo's blocks — re-anchor instead of orphaning on the first
// edit. A source quote folds to itself, so the common case is still a
// byte-for-byte comparison.
//
// Runtime-neutral: no `node:*` / `bun:*` imports; the only dependency
// beyond the workspace is `diff-match-patch` (pure JS, browser-safe),
// wrapped in a narrow typed shim (`src/vendor/dmp.ts`) so no ambient
// declaration leaks out of this package.
import { anchorSchema, type Anchor, type TextQuote } from "./anchor.ts";
import { authorSchema, type Author } from "./author.ts";
import { type ReviewEventInput } from "./events.ts";
import { revisionOf } from "./revision.ts";
import {
  findFolded,
  foldPair,
  foldedEquals,
  foldedHasHitFrom,
  foldTypography,
  foldedOffsetFromSource,
  sourceOffsetInFoldedMatch,
  type FoldedSource,
} from "./typography.ts";
import { DiffMatchPatch, type Diff } from "./vendor/dmp.ts";

/** How the re-anchor arrived at the returned anchor. `unchanged` is
 * the identity short-circuit; `quote-exact` is either an unchanged
 * span mapped through the diff or a moved block with intact context;
 * `fuzzy` is a modified span located via diff-mapping inside a local
 * hunk window. There is no global-search method — the removed
 * `"diff-map"` value would only ever produce wrong places. */
export type ReanchorMethod = "unchanged" | "quote-exact" | "fuzzy";

/** A 1-indexed inclusive line range in a source file. */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/** The outcome of `reanchor`. Non-orphan results record the NEW text
 * at the matched location; orphan results carry the reason plus the
 * new revision the pipeline ran against. */
export type ReanchorResult =
  | { readonly kind: "anchored"; readonly anchor: Anchor; readonly method: "unchanged" }
  | { readonly kind: "moved"; readonly anchor: Anchor; readonly method: "quote-exact" }
  | { readonly kind: "fuzzy"; readonly anchor: Anchor; readonly method: "fuzzy"; readonly score: number }
  | { readonly kind: "orphaned"; readonly revision: string; readonly reason: string; readonly score?: number };

/**
 * Minimum similarity between the OLD quote and the matched new text
 * in the MODIFIED path. A small in-line edit scores ~0.7–0.95; a
 * word-level rewrite of a phrase (e.g. "target phrase" → "modified
 * phrase") scores ~0.45. The gate is deliberately moderate so a
 * modified-in-place block anchors correctly, and rewrites orphan.
 * Used ONLY inside the modified path — the deleted path uses exact
 * context matching, no similarity gate.
 */
export const DEFAULT_MIN_QUOTE_SCORE = 0.4;

/**
 * Minimum fraction of the OLD span's characters that must be in
 * EQUAL segments for the "modified" classification to be trusted as
 * a real in-place edit. Below this, the diff is aligning incidental
 * template fragments (e.g. "| 1 |" prefixes on table rows) as EQUAL
 * while everything meaningful is DELETE — a templated-row shift, not
 * an edit. Such spans are demoted to the "deleted" path and go
 * through move detection, which orphans on ambiguous or missing
 * context. Empirically:
 *
 *   in-place word swap ("brown fox" → "brown cat")         ≈ 0.67
 *   in-place phrase edit ("target phrase" → "mod. phrase") ≈ 0.79
 *   templated table row shift (| 1 | ROW | active | ...)   ≈ 0.14
 *
 * 0.5 cleanly separates real edits from templated shifts.
 */
export const DEFAULT_MIN_MODIFIED_EQUAL_FRACTION = 0.5;


/**
 * Characters of slack around a modified hunk when defining the
 * search window. 200 covers a couple of lines of a reflowed
 * paragraph while staying local — never enough to reach a
 * templated sibling elsewhere in the file.
 */
export const DEFAULT_HUNK_SLACK = 200;

/**
 * Minimum non-whitespace characters of context on each side of the
 * quote required for the MOVE path to fire. A block with less
 * context cannot be safely disambiguated; if the context is short
 * but reaches a line boundary (leading or trailing `\n`), that
 * counts too. Below this bar, `tryMove` orphans.
 */
export const DEFAULT_MIN_MOVE_CONTEXT = 16;

/**
 * `Diff_Timeout` for `diff_main` (seconds). Diffing a very large
 * source with many small changes can otherwise run unbounded; the
 * timeout lets DMP return a suboptimal (but sound) diff instead of
 * blocking the pipeline.
 */
export const DEFAULT_DIFF_TIMEOUT_SECONDS = 2.0;

/** Options for `reanchor`. A production caller passes nothing — the
 * defaults are the contract. The options exist only so
 * micro-benchmarks and forensic diagnostics can tweak the timeout. */
export interface ReanchorOptions {
  readonly diffTimeoutSeconds?: number;
}

/**
 * A prepared context for re-anchoring N threads against one (old,
 * new) file pair. The char-level diff and the line-start indices
 * are the expensive shared work; `prepareReanchor` computes them
 * ONCE, and `reanchorWith(ctx, anchor)` re-runs only the per-anchor
 * classification and alignment.
 *
 * Item 5b (the daemon) prepares once per changed file on rebuild,
 * then iterates every open thread anchored to that file. Without
 * the split, a fully-rewritten 1 MB file with N threads costs
 * `N × Diff_Timeout` (potentially 2 s per anchor); with it, the
 * amortised per-anchor cost drops to a few ms.
 *
 * The context is a plain data object — safe to hand to another
 * async task while it is used, and cheap to discard.
 */
export interface ReanchorContext {
  readonly oldLF: string;
  readonly newLF: string;
  readonly oldRevision: string;
  readonly newRevision: string;
  readonly diffs: readonly Diff[];
  readonly oldLineIndex: readonly number[];
  readonly newLineIndex: readonly number[];
  /** Typographic fold of `oldLF` / `newLF` with the offset maps back
   * to source coordinates (ADR-0006 amendment, issue #113). Computed
   * ONCE here, alongside the diff, for the same reason the diff is:
   * it is per-file-pair shared work, and every anchor on the file
   * needs it. See `foldPair` in `typography.ts` for the measurement
   * that put it here rather than in a per-anchor call. */
  readonly folded: { readonly old: FoldedSource; readonly new: FoldedSource };
}

// ---------- Line-offset index (perf) ----------

/**
 * Precompute the sorted list of line-start byte offsets in `source`
 * (LF-normalised). `index[i]` is the offset of line `i+1`'s first
 * character; `index.length` is the number of lines. Called ONCE per
 * source in `reanchor`; subsequent `offsetToLine` / `lineToOffset`
 * calls are O(log n) / O(1) — this is what makes the 20 k-line and
 * 200 k-char perf tests hit their bounds.
 */
export function buildLineStartIndex(source: string): number[] {
  const idx: number[] = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10 /* \n */) idx.push(i + 1);
  }
  return idx;
}

/** Byte offset of the start of line `line` (1-indexed), via the
 * precomputed index. Returns `source.length` for line numbers past
 * the end. */
export function lineToOffset(index: readonly number[], line: number): number {
  if (line <= 1) return 0;
  const i = line - 1;
  if (i >= index.length) return index[index.length - 1] ?? 0;
  return index[i] ?? 0;
}

/** 1-indexed line number that byte `offset` sits on. Binary search
 * over the precomputed index. */
export function offsetToLine(index: readonly number[], offset: number): number {
  if (offset <= 0) return 1;
  let lo = 0;
  let hi = index.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    const v = index[mid] ?? 0;
    if (v <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

// ---------- Character-level diff + span classification ----------

/** The classification of an anchor's OLD span against a full-text
 * char-level diff of old → new. */
export type SpanClass =
  /** Every character of the span is covered by EQUAL segments. */
  | { readonly kind: "unchanged" }
  /** Some of the span is EQUAL, some is DELETE. */
  | { readonly kind: "modified"; readonly equalChars: number; readonly deletedChars: number }
  /** Every character of the span is inside DELETE segments (no EQUAL
   * overlap). */
  | { readonly kind: "deleted" };

/** Walk `diffs` and classify the old span [spanStart, spanEnd) as
 * one of `unchanged` / `modified` / `deleted`. INSERT segments do
 * not consume old chars and are ignored for classification. */
export function classifySpan(diffs: readonly Diff[], spanStart: number, spanEnd: number): SpanClass {
  let oldPos = 0;
  let equalChars = 0;
  let deletedChars = 0;
  for (const [op, text] of diffs) {
    if (op === 1 /* INSERT */) continue;
    const segEnd = oldPos + text.length;
    const overlapStart = spanStart > oldPos ? spanStart : oldPos;
    const overlapEnd = spanEnd < segEnd ? spanEnd : segEnd;
    const overlap = overlapEnd - overlapStart;
    if (overlap > 0) {
      if (op === 0) equalChars += overlap;
      else deletedChars += overlap;
    }
    oldPos = segEnd;
  }
  const spanLen = spanEnd - spanStart;
  if (equalChars === spanLen) return { kind: "unchanged" };
  if (equalChars === 0) return { kind: "deleted" };
  return { kind: "modified", equalChars, deletedChars };
}

/**
 * Local hunk window in the NEW source for a MODIFIED span. Finds the
 * min and max new-source offsets of any changed segment (DELETE or
 * INSERT) that overlaps or is adjacent (within `slack`) to the old
 * span, then expands the returned window by `slack` in each
 * direction. Bounded to the actual `newLength`.
 */
export function findHunkWindow(
  diffs: readonly Diff[],
  spanStart: number,
  spanEnd: number,
  newLength: number,
  slack: number = DEFAULT_HUNK_SLACK,
): { start: number; end: number } {
  let oldPos = 0;
  let newPos = 0;
  let winStart = -1;
  let winEnd = -1;
  for (const [op, text] of diffs) {
    const oldLen = op === 1 ? 0 : text.length;
    const newLen = op === -1 ? 0 : text.length;
    const oldSegEnd = oldPos + oldLen;
    const oldOverlapsSpan = oldSegEnd >= spanStart - slack && oldPos <= spanEnd + slack;
    if (oldOverlapsSpan && op !== 0) {
      if (winStart < 0) winStart = newPos;
      winEnd = newPos + newLen;
    }
    oldPos = oldSegEnd;
    newPos += newLen;
  }
  if (winStart < 0) {
    // No changed hunks touch the span (should not happen for
    // "modified"). Fall back to a hint centred on the diff-mapped
    // span start.
    const dmp = new DiffMatchPatch();
    const hint = dmp.diff_xIndex(diffs as Diff[], spanStart);
    winStart = hint;
    winEnd = hint;
  }
  return {
    start: Math.max(0, winStart - slack),
    end: Math.min(newLength, winEnd + slack),
  };
}

// ---------- Fuzzy alignment (Blocker 2 fix) ----------

/**
 * Align the OLD quote against `newSource` at `startOffset` and return
 * the offset just past where the quote's END lands in the new source,
 * plus the aligned new text. Uses `diff_main` for a char-level
 * alignment and `diff_xIndex(oldQuote.length - 1) + 1` to walk the
 * quote's LAST character to its counterpart, avoiding the boundary-
 * INSERT bug where `diff_xIndex(len)` swallows a trailing `\n` and
 * the next paragraph.
 *
 * After the raw endpoint is computed, whitespace at the START or END
 * of the matched text that the OLD quote did NOT have is trimmed off
 * — so a match that spilled onto the next table row (or picked up a
 * leading `\n` from an insertion) is trimmed back to just the block.
 * The returned `startOffset` may have advanced past leading
 * whitespace.
 */
export function alignMatchedText(
  oldQuote: string,
  newSource: string,
  startOffset: number,
  options: { slack?: number; trailingContext?: string } = {},
): { startOffset: number; endOffset: number; matchedText: string } {
  const slack = options.slack ?? Math.max(Math.floor(oldQuote.length * 0.5), 16);
  const trailing = options.trailingContext ?? "";
  // Append the recorded trailing context to the alignment target so
  // DMP can find a common suffix and bound the INSERT — otherwise a
  // partial-line quote like "brown fox" against a window
  // "brown cat jumps over the fence" aligns the entire "cat jumps
  // over the fence" as one big INSERT and the walker returns way
  // past the real block boundary. With the trailing context, DMP
  // aligns "cat" only and the rest as an EQUAL suffix.
  const alignmentTarget = oldQuote + trailing;
  const windowEnd = Math.min(newSource.length, startOffset + alignmentTarget.length + slack);
  const window = newSource.slice(startOffset, windowEnd);
  const dmp = new DiffMatchPatch();
  const diffs = dmp.diff_main(alignmentTarget, window) as Diff[];
  // Walk to position oldQuote.length (the boundary between the
  // block and the trailing context we appended). The trailing
  // context bounds the diff so the walker does not overrun the
  // block into a following paragraph, which is what would
  // otherwise happen when DMP finds an incidental single-char
  // match past the block. See test `alignMatchedText — does not
  // spill into a following table row`.
  const endInWindow = walkAlignmentEnd(diffs, oldQuote.length);
  let start = startOffset;
  let end = Math.min(newSource.length, startOffset + endInWindow);
  // Trim leading whitespace that the OLD quote does not begin with —
  // this handles the "leading \n" spill.
  const oldStartsWithWs = oldQuote.length > 0 && isWhitespace(oldQuote.charCodeAt(0));
  const oldEndsWithWs = oldQuote.length > 0 && isWhitespace(oldQuote.charCodeAt(oldQuote.length - 1));
  while (!oldStartsWithWs && start < end && isWhitespace(newSource.charCodeAt(start))) start += 1;
  while (!oldEndsWithWs && end > start && isWhitespace(newSource.charCodeAt(end - 1))) end -= 1;
  return { startOffset: start, endOffset: end, matchedText: newSource.slice(start, end) };
}

function isWhitespace(ch: number): boolean {
  return ch === 9 /* \t */ || ch === 10 /* \n */ || ch === 13 /* \r */ || ch === 32 /* space */;
}

/**
 * Walk `diffs` (of `oldQuote` → `window`) and return the position in
 * `window` corresponding to the END of `oldQuote`, including any
 * INSERTs that replace DELETEs at the boundary.
 *
 * `diff_xIndex` alone stops at the position BEFORE a DELETE that
 * covers the end of `oldQuote` — which for a replacement like "fox"
 * → "cat" returns the position just before "cat", not just after.
 * The walker below sums the aligned window characters as it goes
 * and, when the end of `oldQuote` falls inside a DELETE, folds in
 * any subsequent INSERTs before the next EQUAL — those inserts are
 * the NEW text that replaced the deleted characters.
 */
function walkAlignmentEnd(diffs: readonly Diff[], oldQuoteLen: number): number {
  let chars1 = 0;
  let chars2 = 0;
  for (let x = 0; x < diffs.length; x += 1) {
    const entry = diffs[x];
    if (entry === undefined) break;
    const [op, text] = entry;
    const oldLen = op === 1 ? 0 : text.length;
    const newLen = op === -1 ? 0 : text.length;
    const nextChars1 = chars1 + oldLen;
    if (nextChars1 >= oldQuoteLen) {
      if (op === 0) {
        // EQUAL segment covers the end — end is proportional.
        return chars2 + (oldQuoteLen - chars1);
      }
      // DELETE segment covers the end — advance past this DELETE
      // (its chars are gone, so chars2 does not advance) and fold in
      // any INSERTs that come next before an EQUAL (they are the
      // replacement text for the DELETE).
      let end = chars2;
      for (let y = x + 1; y < diffs.length; y += 1) {
        const next = diffs[y];
        if (next === undefined) break;
        const [op2, text2] = next;
        if (op2 === 0) break;
        if (op2 === 1) end += text2.length;
      }
      return end;
    }
    chars1 += oldLen;
    chars2 += newLen;
  }
  return chars2;
}

// ---------- Move detection (deleted spans) ----------

/**
 * Try to detect a MOVE for a fully-deleted or heavily-modified
 * anchor: find `prefix + exact + suffix` verbatim in the new source.
 * Returns the new SOURCE offsets `[start, end)` of the quote's
 * `exact`, or `null` on zero, ambiguous, or insufficient-context
 * cases. A refusal carries `start: -1, end: -1`. The `end` is
 * returned alongside the `start` so a caller cuts the source text this
 * anchor now covers rather than re-deriving a length from
 * `quote.exact` — which is rendered text for any quote the rail
 * captured before the daemon took quote provenance, and whose length
 * is then not the length of the source span it maps to.
 *
 * Requires the pattern to be unique in BOTH the new AND the old
 * source. Round-3 review blocker: without the OLD-side uniqueness
 * check, a copy-pasted block whose original was deleted anchors
 * onto the surviving copy — the pattern is unique in `newSource`
 * because there is only one copy left, but it was NOT unique in
 * `oldSource` and we cannot tell which copy the anchor was on.
 *
 * `sufficientContext` guards against a bare-quote copy: a quote
 * with too little surrounding evidence (short prefix AND short
 * suffix, neither reaching a line boundary) cannot be safely
 * disambiguated and returns `null` regardless of hit counts.
 *
 * Uses linear `indexOf` loops that stop at the second hit — no
 * O(n·m) scan on either side.
 *
 * **The search is folded (ADR-0006 amendment, issue #113).** Both
 * sides go through `foldSource` first, so a `prefix + exact + suffix`
 * captured from the RENDERED DOM still finds its counterpart in the
 * source. A verbatim-only search could not: `“hi”` is not a substring
 * of `"hi"`, so every move detection on such a quote failed and the
 * thread orphaned even when the block had merely shifted. The returned
 * offsets are SOURCE offsets (mapped back through
 * `FoldedSource.starts`), and the caller slices the source text at
 * them, so a re-anchored quote is source text from then on.
 */
export function tryMove(
  oldSource: string,
  newSource: string,
  quote: TextQuote,
  minContext: number = DEFAULT_MIN_MOVE_CONTEXT,
  folded: { readonly old: FoldedSource; readonly new: FoldedSource } = foldPair(oldSource, newSource),
): { start: number; end: number; reason?: string } | null {
  if (!sufficientContext(quote, minContext)) {
    return { start: -1, end: -1, reason: "insufficient context for move detection" };
  }
  const pattern = quote.prefix + quote.exact + quote.suffix;
  if (pattern.length === 0) return { start: -1, end: -1, reason: "empty context pattern" };
  const foldedPattern = foldTypography(pattern);
  if (foldedPattern.length === 0) return { start: -1, end: -1, reason: "empty context pattern" };
  // Where `exact` starts and ends inside the pattern, in folded
  // coordinates (see the header note on why the source lengths of the
  // prefix and the exact cannot be used here).
  const exactAt = foldTypography(quote.prefix).length;
  const exactEndAt = exactAt + foldTypography(quote.exact).length;
  // OLD-side uniqueness. If the pattern appeared twice in the old
  // snapshot, the anchor is on ONE of the copies — deletion of one
  // and preservation of the other in `newSource` looks like a
  // unique move, but the "correct" destination is undefined.
  const oldFirst = findFolded(folded.old, foldedPattern);
  if (oldFirst === null) {
    return { start: -1, end: -1, reason: "prefix+exact+suffix not found in the old snapshot" };
  }
  // A second occurrence, searched from just past the first hit in
  // FOLDED coordinates. The fold never reorders characters, so a
  // later hit in folded space is a later hit in source space too —
  // but the index to continue from is a folded one, so the two
  // coordinate systems are not mixed here.
  if (foldedHasHitFrom(folded.old, foldedPattern, oldFirst.foldedAt + foldedPattern.length)) {
    return {
      start: -1,
      end: -1,
      reason: "ambiguous move (prefix+exact+suffix was not unique in the old snapshot)",
    };
  }
  const first = findFolded(folded.new, foldedPattern);
  if (first === null) return null;
  if (foldedHasHitFrom(folded.new, foldedPattern, first.foldedAt + foldedPattern.length)) {
    return { start: -1, end: -1, reason: "ambiguous move (multiple exact-context matches in new)" };
  }
  // The pattern matched as one unit, so the `exact` span inside it
  // sits between the FOLDED lengths of `prefix` and
  // `prefix + exact` — not their source lengths, which differ
  // wherever either holds a backtick or an em dash. Resolving both
  // boundaries through the map keeps the returned offsets in source
  // coordinates for every caller, and returns the `end` so a caller
  // can cut the source text this anchor now covers rather than
  // re-deriving a length from a possibly-rendered quote.
  return {
    start: sourceOffsetInFoldedMatch(folded.new, first.foldedAt, exactAt),
    end: sourceOffsetInFoldedMatch(folded.new, first.foldedAt, exactEndAt),
  };
}

/** Whether `quote` carries enough context on both sides to allow a
 * move detection. A side is "sufficient" when either it has at
 * least `minContext` non-whitespace characters OR it contains a
 * line boundary (`\n`) — the latter captures a same-line context
 * that reaches to another line, which is the strongest fingerprint
 * a short prose quote can carry. */
function sufficientContext(quote: TextQuote, minContext: number): boolean {
  return sideSufficient(quote.prefix, minContext) && sideSufficient(quote.suffix, minContext);
}

function sideSufficient(context: string, minContext: number): boolean {
  if (context.length === 0) return false;
  if (context.indexOf("\n") >= 0) return true;
  let nonWs = 0;
  for (let i = 0; i < context.length; i += 1) {
    if (!isWhitespace(context.charCodeAt(i))) {
      nonWs += 1;
      if (nonWs >= minContext) return true;
    }
  }
  return false;
}

// ---------- Similarity ----------

/** Normalised (0–1) similarity of two strings via DMP `diff_main` +
 * `diff_levenshtein`. Empty inputs are treated as identical. */
function similarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  const dmp = new DiffMatchPatch();
  const diffs = dmp.diff_main(a, b) as Diff[];
  const distance = dmp.diff_levenshtein(diffs);
  const denom = Math.max(a.length, b.length);
  return denom === 0 ? 1 : 1 - distance / denom;
}

// ---------- Orphan-reason classification (unchanged path) ----------

/**
 * The orphan reason for the UNCHANGED path that found no move. The
 * diff said the span survived unchanged, the mapped slice did not
 * satisfy 4a, and `tryMove` declined — so one of two things is true
 * and the reason must say WHICH, because they are different failures
 * with different fixes.
 *
 * - The mapped text matches the quote through the fold but the
 *   BOUNDARY class differs: a genuine substring accident (E3). The old
 *   quote's edges sat at line boundaries, the new location's sit
 *   mid-sentence. Naming this precisely is the point — issue #113
 *   recorded a reason that said "substring accident" on a case where
 *   nothing was a substring accident, which sent the reader looking
 *   for a collision that did not exist.
 * - The mapped text does not match the quote even folded: the diff
 *   aligned a span it should not have (the source at that offset
 *   carries different words), and `tryMove` could not find the block
 *   with intact context anywhere. That is a real content difference
 *   the diff mis-classified as unchanged, not an accident of
 *   embedding.
 *
 * `moveResult` is threaded in so the second case can still surface
 * WHY the move was refused — an ambiguity or an insufficient-context
 * refusal is information the reader needs and would otherwise lose.
 */
function unchangedSpanOrphanReason(
  mapped: string,
  exact: string,
  moveResult: { start: number; reason?: string } | null,
): string {
  if (foldedEquals(mapped, exact)) {
    return "diff reports unchanged and the quote still matches, but the block's surroundings differ (substring accident) and no move detected.";
  }
  const moveDetail = moveResult === null ? "no move detected" : `move detection: ${moveResult.reason ?? "no unique match"}`;
  return (
    "diff reports unchanged, but the text at the mapped position differs from the quote " +
    "beyond typographic folding (the diff aligned a span whose content had changed) " +
    `and ${moveDetail}.`
  );
}

// ---------- Boundary-class check (unchanged path) ----------

/**
 * Whether the immediate boundary of the OLD span matches the
 * immediate boundary of the NEW span in CHARACTER CLASS: whether
 * each side is at a line boundary (LF or file edge) or in the
 * middle of a line.
 *
 * This catches the substring accident (E3) where the exact quote
 * appears embedded in a rewritten sentence — the old quote was on
 * a line by itself while the new location sits mid-sentence. That
 * is a semantic move to a different context.
 *
 * A byte-for-byte context check was tried in round-4 and rejected:
 * an edit within 8 chars of an unchanged quote (a comment's own
 * answer — `must`→`should`, `teh`→`the`, `**validate**`, and so on)
 * used to trip it and orphan the comment. The class check alone
 * lets those edits re-anchor while still catching E3. See
 * `test/reanchor.test.ts` fixtures B1–B15.
 */
function boundariesMatch(
  oldSource: string,
  oldStart: number,
  oldEnd: number,
  newSource: string,
  newStart: number,
  newEnd: number,
): boolean {
  const oldPre = oldStart > 0 ? oldSource.charCodeAt(oldStart - 1) : -1;
  const newPre = newStart > 0 ? newSource.charCodeAt(newStart - 1) : -1;
  const oldPost = oldEnd < oldSource.length ? oldSource.charCodeAt(oldEnd) : -1;
  const newPost = newEnd < newSource.length ? newSource.charCodeAt(newEnd) : -1;
  return sameBoundaryClass(oldPre, newPre) && sameBoundaryClass(oldPost, newPost);
}

function sameBoundaryClass(a: number, b: number): boolean {
  const aBoundary = a === -1 || a === 10 /* \n */;
  const bBoundary = b === -1 || b === 10;
  return aBoundary === bBoundary;
}

// ---------- Old-span locator ----------

/** Locate the anchor's OLD span in `oldLF`. Uses the recorded
 * `prefix + exact + suffix` when it is unique; otherwise falls back
 * to the recorded line-start offset and searches nearby. Returns
 * `null` when the anchor cannot be located at all (a snapshot bug
 * the caller should refuse). */
function locateOldSpan(
  oldLF: string,
  anchor: Anchor,
  oldLineIndex: readonly number[],
  foldedOld: FoldedSource,
): { start: number; end: number } | null {
  const pattern = anchor.quote.prefix + anchor.quote.exact + anchor.quote.suffix;
  const expectedStart = lineToOffset(oldLineIndex, anchor.startLine);
  // Where `exact` starts and ends INSIDE the pattern, in folded
  // coordinates. Both are needed because the recorded quote may be
  // rendered text, whose length differs from the source span it maps
  // to: adding `quote.exact.length` to a source offset would cut the
  // span short by exactly the punctuation the renderer rewrote.
  const exactAt = foldTypography(anchor.quote.prefix).length;
  const exactEndAt = exactAt + foldTypography(anchor.quote.exact).length;
  if (pattern.length > 0) {
    // Folded search (ADR-0006 amendment, issue #113). A quote the
    // rail captured from the RENDERED DOM holds `“ ”` where the
    // source holds `"`, so a verbatim `indexOf` found nothing and the
    // span locator gave up with "old anchor span not found in
    // snapshot (malformed anchor)" — the first place the defect
    // surfaced, before the diff was ever consulted. Folding both
    // sides finds the span; the offsets are mapped back to source
    // coordinates, so `classifySpan` and `diff_xIndex` keep working in
    // the coordinate system they are defined in.
    const foldedPattern = foldTypography(pattern);
    if (foldedPattern.length > 0) {
      /** The `exact` span inside a hit at folded offset `foldedAt`. */
      const exactSpanAt = (foldedAt: number): { start: number; end: number } => ({
        start: sourceOffsetInFoldedMatch(foldedOld, foldedAt, exactAt),
        end: sourceOffsetInFoldedMatch(foldedOld, foldedAt, exactEndAt),
      });
      const first = findFolded(foldedOld, foldedPattern);
      if (first !== null) {
        if (!foldedHasHitFrom(foldedOld, foldedPattern, first.foldedAt + foldedPattern.length)) {
          return exactSpanAt(first.foldedAt);
        }
        // Multiple matches — pick the one nearest the recorded line
        // offset (deterministic by construction). Enumerated in
        // FOLDED space and scored by SOURCE offset, so the
        // "nearest the recorded line" rule is the same one the
        // verbatim search applied.
        let best = first.foldedAt;
        let bestDist = Math.abs(first.start - expectedStart);
        let searchFrom = first.foldedAt + 1;
        for (;;) {
          const later = foldedOld.text.indexOf(foldedPattern, searchFrom);
          if (later < 0) break;
          const at = foldedOld.starts[later] ?? 0;
          const dist = Math.abs(at - expectedStart);
          if (dist < bestDist) {
            bestDist = dist;
            best = later;
          }
          searchFrom = later + 1;
        }
        return exactSpanAt(best);
      }
    }
  }
  // No context or context not found — look for the exact alone at
  // the recorded line, folded for the same reason. The ±200-char
  // window around the recorded line offset is preserved from the
  // verbatim search, expressed through `foldedOffsetFromSource` so
  // the window stays anchored to the recorded LINE rather than to a
  // folded index.
  if (anchor.quote.exact.length === 0) return null;
  const foldedExact = foldTypography(anchor.quote.exact);
  if (foldedExact.length === 0) return null;
  const windowStart = Math.max(0, expectedStart - 200);
  const at = foldedOld.text.indexOf(foldedExact, foldedOffsetFromSource(foldedOld, windowStart));
  if (at < 0) return null;
  return {
    start: sourceOffsetInFoldedMatch(foldedOld, at, 0),
    end: sourceOffsetInFoldedMatch(foldedOld, at, foldedExact.length),
  };
}

// ---------- The composed pipeline ----------

/**
 * Re-anchor `anchor` against `newSource`, given `oldSource`. Pure
 * and runtime-neutral; no side effects beyond WebCrypto.
 */
/**
 * Precompute the char-level diff and line-start indices for one
 * (old, new) source pair. The returned context is passed to
 * `reanchorWith(ctx, anchor)` for every thread anchored to that
 * file, so the expensive `diff_main` runs once per rebuild — not
 * per anchor.
 */
export async function prepareReanchor(
  oldSource: string,
  newSource: string,
  options: ReanchorOptions = {},
): Promise<ReanchorContext> {
  const oldLF = toLF(oldSource);
  const newLF = toLF(newSource);
  const oldRevision = await revisionOf(oldLF);
  const newRevision = await revisionOf(newLF);
  const dmp = new DiffMatchPatch();
  dmp.Diff_Timeout = options.diffTimeoutSeconds ?? DEFAULT_DIFF_TIMEOUT_SECONDS;
  const diffs = dmp.diff_main(oldLF, newLF) as Diff[];
  dmp.diff_cleanupSemantic(diffs);
  // Deep-freeze the context so a caller (item 5b, or a test) cannot
  // mutate the shared diff or the shared line indices while another
  // in-flight `reanchorWith` call is walking them. `Object.freeze` is
  // shallow, so we freeze the arrays AND every inner diff tuple —
  // otherwise a hostile / buggy caller could still splice `diffs`,
  // append to `oldLineIndex`, or mutate a `[op, text]` diff tuple in
  // place. The pipeline treats these as read-only, so the freeze is
  // an assertion the runtime enforces. Item 5b runs many
  // `reanchorWith` calls against the same context concurrently under
  // `Promise.all`; a mid-flight mutation from another handler would
  // corrupt the classification silently.
  const oldLineIndex = Object.freeze(buildLineStartIndex(oldLF));
  const newLineIndex = Object.freeze(buildLineStartIndex(newLF));
  for (const diff of diffs) Object.freeze(diff);
  Object.freeze(diffs);
  // The typographic fold (issue #113) is the same kind of shared,
  // per-file-pair work as the diff: computed once here, read by every
  // anchor on the file. `FoldedSource.starts` is a typed array, which
  // cannot be frozen (a frozen typed array with elements throws), so
  // the pair is frozen at the object level and the arrays are treated
  // as read-only by the pipeline — the same contract the diff tuples
  // have, minus the runtime assertion the freeze would give.
  const folded = foldPair(oldLF, newLF);
  return Object.freeze({
    oldLF,
    newLF,
    oldRevision,
    newRevision,
    diffs,
    oldLineIndex,
    newLineIndex,
    folded,
  });
}

/**
 * Re-anchor `anchor` against a prepared context. Every step here is
 * O(anchor.quote.length) or O(diff-length), no O(oldLF) work.
 */
export async function reanchorWith(ctx: ReanchorContext, anchor: Anchor): Promise<ReanchorResult> {
  const { oldLF, newLF, oldRevision, newRevision, diffs, oldLineIndex, newLineIndex, folded } = ctx;

  // (0) Identity.
  if (anchor.revision === newRevision) {
    return { kind: "anchored", anchor, method: "unchanged" };
  }

  // (1) Snapshot must correspond to the anchor.
  if (oldRevision !== anchor.revision) {
    return {
      kind: "orphaned",
      revision: newRevision,
      reason: `snapshot revision mismatch (anchor: ${anchor.revision.slice(0, 12)}…, snapshot: ${oldRevision.slice(0, 12)}…) — cannot trust the diff.`,
    };
  }

  const oldSpan = locateOldSpan(oldLF, anchor, oldLineIndex, folded.old);
  if (oldSpan === null) {
    return {
      kind: "orphaned",
      revision: newRevision,
      reason:
        "old anchor span not found in snapshot (the recorded quote matches no text in the snapshot, verbatim or after typographic folding).",
    };
  }

  const dmp = new DiffMatchPatch();
  const cls = classifySpan(diffs, oldSpan.start, oldSpan.end);

  // (4a) Unchanged — map through diff_xIndex and verify, INCLUDING
  // that the character-class of the new-source boundary matches the
  // old-source boundary. Without the boundary check, the diff can
  // report a substring accident as "unchanged": the exact quote
  // appears verbatim as part of a longer inserted sentence, DMP
  // aligns it as EQUAL, and we would anchor onto the wrong place.
  // The boundary check catches the substring accident because the
  // old quote's edges were at line boundaries (or file edges) while
  // the new location's edges are mid-line inside a rewritten
  // sentence.
  if (cls.kind === "unchanged") {
    const newStart = dmp.diff_xIndex(diffs as Diff[], oldSpan.start);
    const newEnd = dmp.diff_xIndex(diffs as Diff[], oldSpan.end - 1) + 1;
    const mapped = newLF.slice(newStart, newEnd);
    // The quote comparison folds typography (issue #113). `mapped` is
    // always NEW-SOURCE text, so the rebuilt anchor below is cut from
    // the source even when the recorded quote was rendered text.
    if (
      foldedEquals(mapped, anchor.quote.exact) &&
      boundariesMatch(oldLF, oldSpan.start, oldSpan.end, newLF, newStart, newEnd)
    ) {
      const rebuilt = await buildAnchor(anchor, newLF, newLineIndex, newStart, mapped, newRevision);
      return { kind: "moved", anchor: rebuilt, method: "quote-exact" };
    }
    // Boundary mismatch or quote mismatch: fall through to
    // move detection. If the block truly moved to a new position
    // with intact context, tryMove will find it; otherwise orphan.
    const moveResult = tryMove(oldLF, newLF, anchor.quote, DEFAULT_MIN_MOVE_CONTEXT, folded);
    if (moveResult !== null && moveResult.start >= 0) {
      const rebuilt = await buildAnchor(
        anchor,
        newLF,
        newLineIndex,
        moveResult.start,
        newLF.slice(moveResult.start, moveResult.end),
        newRevision,
      );
      return { kind: "moved", anchor: rebuilt, method: "quote-exact" };
    }
    return {
      kind: "orphaned",
      revision: newRevision,
      reason: unchangedSpanOrphanReason(mapped, anchor.quote.exact, moveResult),
    };
  }

  // Templated-shift demotion: when the diff calls the span
  // "modified" but only a tiny fraction of it is in EQUAL segments,
  // the diff is aligning incidental template fragments as EQUAL
  // while everything meaningful is DELETE. That is a templated
  // shift, not an edit — demote to the deleted path.
  const spanLen = oldSpan.end - oldSpan.start;
  if (
    cls.kind === "modified" &&
    spanLen > 0 &&
    cls.equalChars / spanLen < DEFAULT_MIN_MODIFIED_EQUAL_FRACTION
  ) {
    const moveResult = tryMove(oldLF, newLF, anchor.quote, DEFAULT_MIN_MOVE_CONTEXT, folded);
    if (moveResult !== null && moveResult.start >= 0) {
      const rebuilt = await buildAnchor(
        anchor,
        newLF,
        newLineIndex,
        moveResult.start,
        newLF.slice(moveResult.start, moveResult.end),
        newRevision,
      );
      return { kind: "moved", anchor: rebuilt, method: "quote-exact" };
    }
    return {
      kind: "orphaned",
      revision: newRevision,
      reason:
        `modified span kept only ${cls.equalChars}/${spanLen} chars unchanged ` +
        `(< ${DEFAULT_MIN_MODIFIED_EQUAL_FRACTION}); treated as deleted. ` +
        `${moveResult === null ? "No move detected." : `Move detection: ${moveResult.reason ?? "no unique match"}.`}`,
    };
  }

  // (4c) Deleted — try move detection. NO fuzzy fallback.
  if (cls.kind === "deleted") {
    const moveResult = tryMove(oldLF, newLF, anchor.quote, DEFAULT_MIN_MOVE_CONTEXT, folded);
    if (moveResult !== null && moveResult.start >= 0) {
      const rebuilt = await buildAnchor(
        anchor,
        newLF,
        newLineIndex,
        moveResult.start,
        newLF.slice(moveResult.start, moveResult.end),
        newRevision,
      );
      return { kind: "moved", anchor: rebuilt, method: "quote-exact" };
    }
    return {
      kind: "orphaned",
      revision: newRevision,
      reason:
        moveResult === null
          ? "block deleted; no move detected."
          : `block deleted; move detection: ${moveResult.reason ?? "no unique match"}.`,
    };
  }

  // (4b) Modified — the diff already localizes the block. We seed a
  // single candidate at `diff_xIndex(oldSpan.start)` inside the
  // enclosing hunk window and let `alignMatchedText` walk the old
  // quote's END onto the new source. The demotion above ensures the
  // span had ≥ 50 % of its chars in EQUAL segments, so the aligned
  // text is by construction recognisably related to the old quote —
  // a small similarity check catches the pathological "50 % EQUAL
  // plus a huge INSERT" edge case that would otherwise leave the
  // aligned text mostly not the quote.
  const hunkWindow = findHunkWindow(diffs, oldSpan.start, oldSpan.end, newLF.length);
  const mappedStart = dmp.diff_xIndex(diffs as Diff[], oldSpan.start);
  const clampedStart = Math.max(hunkWindow.start, Math.min(hunkWindow.end, mappedStart));
  // Alignment runs on the SOURCE span `locateOldSpan` already
  // resolved — never on the recorded quote. `alignMatchedText` returns
  // SOURCE offsets and sizes its search window from the target's
  // length, so a target that is not source-shaped overruns that window
  // and lands on the wrong span. That is not a rounding detail: for a
  // whole-paragraph legacy quote on a line of collapsing runs
  // (`Wait... what... …` renders as `Wait… what… …`, so the rendered
  // paragraph is a third of the source line's length) the unfixed head
  // returned `lines 3-5`, ending mid-word and swallowing the next
  // paragraph — a silent wrong anchor, persisted through
  // `thread.reanchored`, where the rail then looks for a
  // `[data-src="…:3-5"]` that no page carries. The source-quote path
  // never had the problem because its quote IS source text; slicing
  // the resolved span makes the two paths identical by construction
  // (`test/serve/quote-provenance.test.ts`, F1).
  const sourceExact = oldLF.slice(oldSpan.start, oldSpan.end);
  // The trailing context bounds the walker's INSERT, so it must be
  // source-shaped too — hence read from `oldLF`, never from the
  // recorded `suffix`.
  //
  // Its LENGTH is the recorded `suffix.length`, which is exact for a
  // SOURCE quote (the producer cut `contextChars` source bytes, and
  // every comment created since #113 carries one) and approximate for
  // a LEGACY rendered one: there `suffix.length` counts rendered
  // characters, and a collapsed form (`…` for `...`, `—` for `--`) is
  // fewer characters than the source it came from, so this reads
  // slightly FEWER source bytes than the window the old rail cut. The
  // consequence is bounded and one-directional — a shorter trailing
  // context narrows the region the walker may insert into, which can
  // only cost a match the walker would have made past the window, and
  // the similarity gate still sees the recorded quote itself. Measuring
  // the exact source length instead is not possible from the recorded
  // text (the fold is many-to-one: `---` and `…` both fold toward
  // `--`/`...`), so the length stays and the imprecision is recorded
  // here rather than papered over with a guess.
  const sourceTrailingContext = oldLF.slice(oldSpan.end, oldSpan.end + anchor.quote.suffix.length);
  const aligned = alignMatchedText(sourceExact, newLF, clampedStart, {
    trailingContext: sourceTrailingContext,
  });
  // The similarity gate still compares the RECORDED quote, folded on
  // both sides (issue #113): that is the question the gate asks —
  // "is the text the reviewer commented about still recognisably here"
  // — and for a legacy quote the recorded text is the rendered form,
  // so folding it keeps a punctuation-only difference from being
  // scored as an edit. For a source quote the fold is the identity.
  const score = similarity(foldTypography(anchor.quote.exact), foldTypography(aligned.matchedText));
  if (score < DEFAULT_MIN_QUOTE_SCORE) {
    return {
      kind: "orphaned",
      revision: newRevision,
      reason: `modified: quote similarity ${score.toFixed(2)} < gate ${DEFAULT_MIN_QUOTE_SCORE}.`,
      score,
    };
  }
  const rebuilt = await buildAnchor(
    anchor,
    newLF,
    newLineIndex,
    aligned.startOffset,
    aligned.matchedText,
    newRevision,
  );
  return { kind: "fuzzy", anchor: rebuilt, method: "fuzzy", score };
}

/**
 * Re-anchor a single anchor against a fresh `(oldSource, newSource)`
 * pair. Convenience wrapper over `prepareReanchor` +
 * `reanchorWith`; batch callers that process many anchors against
 * the same file should call the two directly to avoid re-computing
 * the diff.
 */
export async function reanchor(
  anchor: Anchor,
  oldSource: string,
  newSource: string,
  options: ReanchorOptions = {},
): Promise<ReanchorResult> {
  const ctx = await prepareReanchor(oldSource, newSource, options);
  return reanchorWith(ctx, anchor);
}

/**
 * Turn a `ReanchorResult` into the `ReviewEventInput` a store
 * `append`s. `anchored` (unchanged) returns `null`.
 */
export function reanchorEvent(
  threadId: string,
  actor: Author,
  result: ReanchorResult,
): ReviewEventInput | null {
  if (threadId.length === 0) {
    throw new Error("reanchorEvent: threadId must be non-empty.");
  }
  const parsedActor = authorSchema.parse(actor);
  switch (result.kind) {
    case "anchored":
      return null;
    case "moved":
      return {
        actor: parsedActor,
        kind: "thread.reanchored",
        threadId,
        anchor: result.anchor,
        method: result.method,
      };
    case "fuzzy":
      return {
        actor: parsedActor,
        kind: "thread.reanchored",
        threadId,
        anchor: result.anchor,
        method: result.method,
        score: result.score,
      };
    case "orphaned":
      return {
        actor: parsedActor,
        kind: "thread.orphaned",
        threadId,
        revision: result.revision,
        reason: result.reason,
      };
  }
}

// ---------- helpers (module-local) ----------

/** Normalise `\r\n` and lone `\r` to `\n`. Every helper that
 * offsets or diffs source content in review-core works on the
 * LF form, so a producer that hands source to
 * `buildQuoteFromLines`, `revisionOf`, or the reanchor engine
 * must pre-normalise (or let those helpers do it). One source
 * of truth so a CRLF fixture never orphans on a normalisation
 * mismatch (PR-43 round-4 nit). */
export function toLF(source: string): string {
  return source.replace(/\r\n?/g, "\n");
}

/**
 * Build the new anchor for a match at `startOffset` with text
 * `matchedText`. Prefix/suffix are recut around the actual match
 * from the new source; the line range is computed from the offset
 * via the precomputed line-start index.
 */
/** Minimum prefix/suffix window used by `buildAnchor` — 32 chars
 * matches the fuzzy engine's fixtures. Exported so producers that
 * mint fresh anchors (`buildQuoteFromLines`, the local rail's
 * `data-src` cutter) use the same window. */
export const DEFAULT_ANCHOR_CONTEXT_CHARS = 32;

async function buildAnchor(
  original: Anchor,
  newSource: string,
  newLineIndex: readonly number[],
  startOffset: number,
  matchedText: string,
  newRevision: string,
): Promise<Anchor> {
  const contextLength = Math.max(original.quote.prefix.length, original.quote.suffix.length, DEFAULT_ANCHOR_CONTEXT_CHARS);
  const endOffset = startOffset + matchedText.length;
  const startLine = offsetToLine(newLineIndex, startOffset);
  const endLine = offsetToLine(newLineIndex, Math.max(startOffset, endOffset - 1));
  const prefixStart = Math.max(0, startOffset - contextLength);
  const suffixEnd = Math.min(newSource.length, endOffset + contextLength);
  const rebuilt: Anchor = {
    path: original.path,
    startLine,
    endLine,
    quote: {
      exact: matchedText,
      prefix: newSource.slice(prefixStart, startOffset),
      suffix: newSource.slice(endOffset, suffixEnd),
    },
    revision: newRevision,
    ...(original.commit === undefined ? {} : { commit: original.commit }),
  };
  return anchorSchema.parse(rebuilt);
}
