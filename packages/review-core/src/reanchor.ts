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
//                      equals the exact quote, and return
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
// Runtime-neutral: no `node:*` / `bun:*` imports; the only dependency
// beyond the workspace is `diff-match-patch` (pure JS, browser-safe),
// wrapped in a narrow typed shim (`src/vendor/dmp.ts`) so no ambient
// declaration leaks out of this package.
import { anchorSchema, type Anchor, type TextQuote } from "./anchor.ts";
import { authorSchema, type Author } from "./author.ts";
import { type ReviewEventInput } from "./events.ts";
import { revisionOf } from "./revision.ts";
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
 * Returns the new offset (start of `exact`) or `null` on zero,
 * ambiguous, or insufficient-context cases.
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
 */
export function tryMove(
  oldSource: string,
  newSource: string,
  quote: TextQuote,
  minContext: number = DEFAULT_MIN_MOVE_CONTEXT,
): { start: number; reason?: string } | null {
  if (!sufficientContext(quote, minContext)) {
    return { start: -1, reason: "insufficient context for move detection" };
  }
  const pattern = quote.prefix + quote.exact + quote.suffix;
  if (pattern.length === 0) return { start: -1, reason: "empty context pattern" };
  // OLD-side uniqueness. If the pattern appeared twice in the old
  // snapshot, the anchor is on ONE of the copies — deletion of one
  // and preservation of the other in `newSource` looks like a
  // unique move, but the "correct" destination is undefined.
  const oldFirst = oldSource.indexOf(pattern);
  if (oldFirst < 0) {
    return { start: -1, reason: "prefix+exact+suffix not found in the old snapshot" };
  }
  const oldSecond = oldSource.indexOf(pattern, oldFirst + 1);
  if (oldSecond >= 0) {
    return {
      start: -1,
      reason: "ambiguous move (prefix+exact+suffix was not unique in the old snapshot)",
    };
  }
  const first = newSource.indexOf(pattern);
  if (first < 0) return null;
  const second = newSource.indexOf(pattern, first + 1);
  if (second >= 0) {
    return { start: -1, reason: "ambiguous move (multiple exact-context matches in new)" };
  }
  return { start: first + quote.prefix.length };
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
function locateOldSpan(oldLF: string, anchor: Anchor, oldLineIndex: readonly number[]): { start: number; end: number } | null {
  const pattern = anchor.quote.prefix + anchor.quote.exact + anchor.quote.suffix;
  const expectedStart = lineToOffset(oldLineIndex, anchor.startLine);
  if (pattern.length > 0) {
    const first = oldLF.indexOf(pattern);
    if (first >= 0) {
      const second = oldLF.indexOf(pattern, first + 1);
      if (second < 0) {
        return { start: first + anchor.quote.prefix.length, end: first + anchor.quote.prefix.length + anchor.quote.exact.length };
      }
      // Multiple matches — pick the one nearest the recorded line
      // offset (deterministic by construction).
      let best = first;
      let bestDist = Math.abs(first - expectedStart);
      let searchFrom = second;
      while (searchFrom >= 0) {
        const dist = Math.abs(searchFrom - expectedStart);
        if (dist < bestDist) {
          bestDist = dist;
          best = searchFrom;
        }
        searchFrom = oldLF.indexOf(pattern, searchFrom + 1);
      }
      return { start: best + anchor.quote.prefix.length, end: best + anchor.quote.prefix.length + anchor.quote.exact.length };
    }
  }
  // No context or context not found — look for the exact alone at
  // the recorded line.
  if (anchor.quote.exact.length === 0) return null;
  const idx = oldLF.indexOf(anchor.quote.exact, Math.max(0, expectedStart - 200));
  if (idx < 0) return null;
  return { start: idx, end: idx + anchor.quote.exact.length };
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
  return Object.freeze({
    oldLF,
    newLF,
    oldRevision,
    newRevision,
    diffs,
    oldLineIndex,
    newLineIndex,
  });
}

/**
 * Re-anchor `anchor` against a prepared context. Every step here is
 * O(anchor.quote.length) or O(diff-length), no O(oldLF) work.
 */
export async function reanchorWith(ctx: ReanchorContext, anchor: Anchor): Promise<ReanchorResult> {
  const { oldLF, newLF, oldRevision, newRevision, diffs, oldLineIndex, newLineIndex } = ctx;

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

  const oldSpan = locateOldSpan(oldLF, anchor, oldLineIndex);
  if (oldSpan === null) {
    return {
      kind: "orphaned",
      revision: newRevision,
      reason: "old anchor span not found in snapshot (malformed anchor).",
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
    if (
      mapped === anchor.quote.exact &&
      boundariesMatch(oldLF, oldSpan.start, oldSpan.end, newLF, newStart, newEnd)
    ) {
      const rebuilt = await buildAnchor(
        anchor,
        newLF,
        newLineIndex,
        newStart,
        anchor.quote.exact,
        newRevision,
      );
      return { kind: "moved", anchor: rebuilt, method: "quote-exact" };
    }
    // Boundary mismatch or exact slice mismatch: fall through to
    // move detection. If the block truly moved to a new position
    // with intact context, tryMove will find it; otherwise orphan.
    const moveResult = tryMove(oldLF, newLF, anchor.quote);
    if (moveResult !== null && moveResult.start >= 0) {
      const rebuilt = await buildAnchor(
        anchor,
        newLF,
        newLineIndex,
        moveResult.start,
        anchor.quote.exact,
        newRevision,
      );
      return { kind: "moved", anchor: rebuilt, method: "quote-exact" };
    }
    return {
      kind: "orphaned",
      revision: newRevision,
      reason:
        "diff reports unchanged, but the block's surroundings differ (substring accident) and no move detected.",
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
    const moveResult = tryMove(oldLF, newLF, anchor.quote);
    if (moveResult !== null && moveResult.start >= 0) {
      const rebuilt = await buildAnchor(
        anchor,
        newLF,
        newLineIndex,
        moveResult.start,
        anchor.quote.exact,
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
    const moveResult = tryMove(oldLF, newLF, anchor.quote);
    if (moveResult !== null && moveResult.start >= 0) {
      const rebuilt = await buildAnchor(
        anchor,
        newLF,
        newLineIndex,
        moveResult.start,
        anchor.quote.exact,
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
  const aligned = alignMatchedText(anchor.quote.exact, newLF, clampedStart, {
    trailingContext: anchor.quote.suffix,
  });
  const score = similarity(anchor.quote.exact, aligned.matchedText);
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
