/// <reference path="./vendor/diff-match-patch.d.ts" />
// Re-anchoring engine (ADR-0006 Acceptance). Pure logic:
//
//   reanchor(anchor, oldSource, newSource) → ReanchorResult
//
// Runs the four-stage pipeline the ADR names, in order:
//
//   (a) diff-map — line-mode `diff_main` of oldSource → newSource, then
//       remap the anchor's 1-indexed line range through the diff. A range
//       whose lines survived (even in part) yields a new range.
//   (b) quote verify — the mapped range must contain the anchor's exact
//       quote (checked verbatim; the prefix/suffix context is used to
//       break ties when the quote repeats inside the range).
//   (c) fuzzy — DMP `match_main` with `Match_Distance` and a
//       context-weighted score against the anchor's `prefix + exact +
//       suffix` at the candidate location. Score below the threshold
//       fails and the pipeline falls through to (d).
//   (d) orphan — never guess and never drop; the caller keeps the old
//       anchor and shows the orphan in the rail.
//
// The individual stages are named exports too (`diffMapLines`,
// `mapAnchorRange`, `verifyQuoteInMappedRange`, `fuzzyLocateQuote`).
// They are the building blocks `reanchor` composes; exposing them lets
// stage-level tests exercise one stage at a time and lets the mutation
// tests demonstrate that removing any single stage changes an
// otherwise-passing outcome — proof that no stage is dead weight.
//
// Runtime-neutral: no `node:*` / `bun:*` imports; the only dependency
// beyond the workspace is `diff-match-patch` (pure JS, browser-safe).
// The engine is async only because the identity short-circuit hashes
// the new source through `revisionOf` (WebCrypto), matching how anchors
// were created in the first place.
// `diff-match-patch` types are resolved via `src/vendor/diff-match-patch.d.ts`
// — a local ESM shim over the CJS-shaped upstream types.
import { diff_match_patch, type Diff } from "diff-match-patch";
import { anchorSchema, type Anchor, type TextQuote } from "./anchor.ts";
import { authorSchema, type Author } from "./author.ts";
import { type ReviewEventInput } from "./events.ts";
import { revisionOf } from "./revision.ts";

/** How the re-anchor arrived at the returned anchor. `unchanged` means the
 * source itself did not change (revision hash matched); `diff-map` is
 * unused as a final method here (the pipeline always tightens through
 * quote verify or fuzzy — kept in the union for shape stability when a
 * future stage lands); `quote-exact` means the exact quote was found
 * verbatim inside the diff-mapped window; `fuzzy` means the location
 * came from DMP `match_main` above the score threshold. */
export type ReanchorMethod = "unchanged" | "diff-map" | "quote-exact" | "fuzzy";

/** A 1-indexed inclusive line range in a source file. Same shape the
 * anchor uses. */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/** The outcome of `reanchor`. On `anchored`, `moved` or `fuzzy` the
 * returned `anchor` carries the NEW revision (SHA-256 of `newSource`)
 * and the range/quote captured against `newSource`, ready to feed into
 * a `thread.reanchored` event. On `orphaned`, the caller keeps the old
 * anchor and emits `thread.orphaned`; the new source's revision is
 * carried on the result so the event can name it. */
export type ReanchorResult =
  | { readonly kind: "anchored"; readonly anchor: Anchor; readonly method: "unchanged" }
  | { readonly kind: "moved"; readonly anchor: Anchor; readonly method: "quote-exact" }
  | { readonly kind: "fuzzy"; readonly anchor: Anchor; readonly method: "fuzzy"; readonly score: number }
  | { readonly kind: "orphaned"; readonly revision: string; readonly reason: string; readonly score?: number };

/**
 * Minimum fuzzy score to accept a `match_main` hit.
 *
 * Chosen after the fixture tests in `test/reanchor.test.ts`: a
 * paragraph that had a one-word edit inside the quote scored ~0.87,
 * whereas a paragraph whose sentence was largely rewritten scored
 * ~0.36. 0.75 leaves headroom on the "clean" side and clearly rejects
 * the "torn" side, so a borderline case does not flap between fuzzy
 * and orphaned when an unrelated edit lands elsewhere on the file.
 *
 * The mutation test `threshold_of_zero_would_wrongly_accept_orphan` in
 * `test/reanchor.test.ts` enforces the lower bound: dropping the
 * threshold to 0 (accept anything) turns an expected orphan into an
 * accepted fuzzy, and the assertion trips.
 */
export const DEFAULT_MIN_FUZZY_SCORE = 0.75;

/**
 * DMP `Match_Distance`: how far from the expected location a match may
 * be before its score is penalised. 1000 is DMP's own default; wide
 * enough for a paragraph that moved a page down but not so wide that
 * the pipeline snaps to a coincidental match at the other end of the
 * file.
 */
export const DEFAULT_MATCH_DISTANCE = 1000;

/** Options for `reanchor`. Both fields have documented defaults; a real
 * caller normally passes none. */
export interface ReanchorOptions {
  /** Minimum fuzzy score (0–1) to accept. Defaults to
   * `DEFAULT_MIN_FUZZY_SCORE`. */
  readonly minFuzzyScore?: number;
  /** DMP `Match_Distance`. Defaults to `DEFAULT_MATCH_DISTANCE`. */
  readonly matchDistance?: number;
}

// ---------- Stage exports (composed by `reanchor`) ----------

/**
 * Line-mode diff of `oldSource` → `newSource`. Returns an array indexed
 * by 1-based old-line-number where the value is the 1-based new-line
 * number that line maps to, or `null` if the line was deleted.
 *
 * Internal use: input is expected LF-normalised (the primary `reanchor`
 * entry does that once, up-front).
 */
export function diffMapLines(oldSource: string, newSource: string): (number | null)[] {
  const dmp = new diff_match_patch();
  const chars = dmp.diff_linesToChars_(oldSource, newSource);
  const diffs = dmp.diff_main(chars.chars1, chars.chars2, false) as Diff[];
  dmp.diff_charsToLines_(diffs, chars.lineArray);

  const oldLineCount = splitLines(oldSource).length;
  // Index 0 is unused (line numbers are 1-based); allocate n+1 for
  // convenient `lineMap[i]` reads without an off-by-one on the caller.
  const mapping: (number | null)[] = new Array<number | null>(oldLineCount + 1).fill(null);
  let oldLine = 1;
  let newLine = 1;
  for (const [op, text] of diffs) {
    // Each segment's `text` is one or more whole lines. Count them by
    // counting the LFs — `diff_charsToLines_` appends LF to each line.
    const lineCount = countLines(text);
    if (op === -1 /* DELETE */) {
      oldLine += lineCount;
    } else if (op === 1 /* INSERT */) {
      newLine += lineCount;
    } else {
      for (let i = 0; i < lineCount; i += 1) {
        if (oldLine <= oldLineCount) mapping[oldLine] = newLine;
        oldLine += 1;
        newLine += 1;
      }
    }
  }
  return mapping;
}

/** Map an old 1-indexed line range to the smallest new range that
 * covers the lines that survived. `null` if the whole range was
 * deleted. */
export function mapAnchorRange(
  lineMap: readonly (number | null)[],
  startLine: number,
  endLine: number,
): LineRange | null {
  let start: number | null = null;
  let end: number | null = null;
  for (let i = startLine; i <= endLine; i += 1) {
    const mapped = i >= 0 && i < lineMap.length ? lineMap[i] : null;
    if (mapped === null || mapped === undefined) continue;
    if (start === null) start = mapped;
    end = mapped;
  }
  if (start === null || end === null) return null;
  return { start, end };
}

/**
 * Verify the anchor's exact quote is present inside (or straddling) the
 * mapped range, and return the range tightened to the quote itself.
 * `null` if the quote is not in the window at all — the caller then
 * falls through to fuzzy.
 *
 * The window is widened by one line on each side because a quote whose
 * paragraph reflowed can now start on the neighbouring line without
 * having moved semantically.
 *
 * Inputs are expected LF-normalised.
 */
export function verifyQuoteInMappedRange(
  newSource: string,
  quote: TextQuote,
  range: LineRange,
): LineRange | null {
  const totalLines = splitLines(newSource).length;
  const windowStart = Math.max(1, range.start - 1);
  const windowEnd = Math.min(totalLines, range.end + 1);
  const windowText = sliceLines(newSource, windowStart, windowEnd);
  const windowOffset = lineToOffset(newSource, windowStart);

  const relativeIndex = findQuoteIndexInWindow(windowText, quote);
  if (relativeIndex < 0) return null;
  const startOffset = windowOffset + relativeIndex;
  const endOffset = startOffset + quote.exact.length;
  return {
    start: offsetToLine(newSource, startOffset),
    end: offsetToLine(newSource, Math.max(startOffset, endOffset - 1)),
  };
}

/**
 * Fuzzy-locate the quote in `newSource` using DMP `match_main` for the
 * primary location, then score the candidate against `prefix + exact +
 * suffix` (context-weighted). Returns null if `match_main` finds nothing
 * at all — otherwise the score determines whether the pipeline accepts
 * the location.
 *
 * `expectedOffset` is the character index in `newSource` where the
 * anchor is *expected* to be. When diff-map produced a range, use its
 * start byte; when it didn't, use the anchor's old byte offset
 * projected onto the new source (best available hint).
 *
 * The score is `1 - levenshtein(contextPattern, candidate) / max_len`
 * — 1.0 is a perfect match, 0.0 is nothing in common.
 */
export function fuzzyLocateQuote(
  newSource: string,
  quote: TextQuote,
  expectedOffset: number,
  matchDistance: number = DEFAULT_MATCH_DISTANCE,
): { index: number; score: number } | null {
  const dmp = new diff_match_patch();
  dmp.Match_Distance = matchDistance;
  // Set DMP's own gate permissively so `match_main` returns a location
  // whenever it can; our own `minFuzzyScore` decides whether to accept
  // it downstream.
  dmp.Match_Threshold = 1.0;
  // `match_main` truncates the pattern to `Match_MaxBits` (word size,
  // 32 by default). Longer quotes are located from a prefix and then
  // re-scored against the full context pattern below.
  const searchKey = quote.exact.substring(0, dmp.Match_MaxBits);
  const location = dmp.match_main(newSource, searchKey, expectedOffset);
  if (location < 0) return null;
  const contextPattern = quote.prefix + quote.exact + quote.suffix;
  const candidateStart = Math.max(0, location - quote.prefix.length);
  const candidateEnd = Math.min(newSource.length, location + quote.exact.length + quote.suffix.length);
  const candidate = newSource.slice(candidateStart, candidateEnd);
  const scoringDmp = new diff_match_patch();
  const diffs = scoringDmp.diff_main(contextPattern, candidate);
  const distance = scoringDmp.diff_levenshtein(diffs);
  const denom = Math.max(contextPattern.length, candidate.length);
  const score = denom === 0 ? 1 : 1 - distance / denom;
  return { index: location, score };
}

// ---------- The composed pipeline ----------

/**
 * Re-anchor `anchor` against `newSource`, given `oldSource` — the source
 * the anchor was captured against (its SHA-256 must equal
 * `anchor.revision`; if the caller hands a snapshot for a different
 * revision the engine returns `orphaned` because it cannot trust the
 * diff).
 *
 * Pure and runtime-neutral: no side effects, no I/O beyond WebCrypto.
 * The caller feeds the result to `reanchorEvent(...)` to build the
 * event to append.
 */
export async function reanchor(
  anchor: Anchor,
  oldSource: string,
  newSource: string,
  options: ReanchorOptions = {},
): Promise<ReanchorResult> {
  const minFuzzyScore = options.minFuzzyScore ?? DEFAULT_MIN_FUZZY_SCORE;
  const matchDistance = options.matchDistance ?? DEFAULT_MATCH_DISTANCE;
  const oldLF = toLF(oldSource);
  const newLF = toLF(newSource);
  const newRevision = await revisionOf(newLF);

  // (0) Identity: source is unchanged. Anchor as-is; no event needed.
  if (anchor.revision === newRevision) {
    return { kind: "anchored", anchor, method: "unchanged" };
  }

  // Sanity: the snapshot must actually correspond to the anchor. If it
  // does not, the diff is meaningless — refuse to guess.
  const oldRevision = await revisionOf(oldLF);
  if (oldRevision !== anchor.revision) {
    return {
      kind: "orphaned",
      revision: newRevision,
      reason: `snapshot revision mismatch (anchor: ${anchor.revision.slice(0, 12)}…, snapshot: ${oldRevision.slice(0, 12)}…) — cannot trust the diff.`,
    };
  }

  // (a) diff-map + (b) quote verify.
  const lineMap = diffMapLines(oldLF, newLF);
  const mapped = mapAnchorRange(lineMap, anchor.startLine, anchor.endLine);
  if (mapped !== null) {
    const tightened = verifyQuoteInMappedRange(newLF, anchor.quote, mapped);
    if (tightened !== null) {
      const rebuilt = await anchorFor(anchor, newLF, tightened, newRevision);
      return { kind: "moved", anchor: rebuilt, method: "quote-exact" };
    }
  }

  // (c) Fuzzy. `expectedOffset` is the mapped range's start when
  // diff-map produced one, else the old anchor's byte offset projected
  // onto the new source.
  const expectedOffset =
    mapped !== null
      ? lineToOffset(newLF, mapped.start)
      : Math.min(newLF.length, lineToOffset(oldLF, anchor.startLine));
  const located = fuzzyLocateQuote(newLF, anchor.quote, expectedOffset, matchDistance);
  if (located !== null && located.score >= minFuzzyScore) {
    const startLine = offsetToLine(newLF, located.index);
    const endLine = offsetToLine(
      newLF,
      Math.max(located.index, located.index + anchor.quote.exact.length - 1),
    );
    const rebuilt = await anchorFor(anchor, newLF, { start: startLine, end: endLine }, newRevision);
    return { kind: "fuzzy", anchor: rebuilt, method: "fuzzy", score: located.score };
  }

  // (d) Orphan. Report the diff-map range and the fuzzy score in the
  // reason so an operator can see where the block went.
  const reasonParts: string[] = [];
  if (mapped === null) reasonParts.push("all lines in the anchor's range were deleted");
  else reasonParts.push(`mapped range L${mapped.start}-L${mapped.end} no longer contains the exact quote`);
  if (located === null) reasonParts.push("fuzzy match found no candidate");
  else reasonParts.push(`fuzzy score ${located.score.toFixed(2)} < ${minFuzzyScore}`);
  return {
    kind: "orphaned",
    revision: newRevision,
    reason: reasonParts.join("; "),
    ...(located === null ? {} : { score: located.score }),
  };
}

/**
 * Turn a `ReanchorResult` into the `ReviewEventInput` a store `append`s.
 * `anchored` (unchanged) returns `null` — the caller writes no event.
 *
 * Kept next to `reanchor` so callers wire the two in one import; the
 * daemon (item 5b) is expected to run:
 *
 *   const result = await reanchor(anchor, oldSource, newSource);
 *   const event = reanchorEvent(threadId, actor, result);
 *   if (event) await store.append(event);
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

/** Normalise line endings to LF, matching `revisionOf`. */
function toLF(source: string): string {
  return source.replace(/\r\n?/g, "\n");
}

function splitLines(source: string): string[] {
  if (source.length === 0) return [];
  return source.split("\n");
}

/** Byte offset (in the LF-normalised source) of the start of line `n`
 * (1-indexed). Returns `source.length` if `n` is past the end. */
function lineToOffset(source: string, n: number): number {
  if (n <= 1) return 0;
  let offset = 0;
  let line = 1;
  for (let i = 0; i < source.length; i += 1) {
    if (line === n) return offset;
    if (source.charCodeAt(i) === 10 /* \n */) {
      line += 1;
      offset = i + 1;
    }
  }
  return line === n ? offset : source.length;
}

function offsetToLine(source: string, offset: number): number {
  if (offset <= 0) return 1;
  let line = 1;
  const bound = Math.min(offset, source.length);
  for (let i = 0; i < bound; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function sliceLines(source: string, start: number, end: number): string {
  const lines = splitLines(source);
  const s = Math.max(1, start) - 1;
  const e = Math.min(lines.length, end);
  return lines.slice(s, e).join("\n");
}

function countLines(segment: string): number {
  if (segment.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < segment.length; i += 1) {
    if (segment.charCodeAt(i) === 10) count += 1;
  }
  return count;
}

/** Locate `quote.exact` in `text`, disambiguating a repeated substring
 * by preferring the occurrence whose surrounding text agrees best with
 * `quote.prefix` and `quote.suffix`. Returns -1 when the exact
 * substring is absent. */
function findQuoteIndexInWindow(text: string, quote: TextQuote): number {
  const { exact, prefix, suffix } = quote;
  if (exact.length === 0) return -1;
  const occurrences: number[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = text.indexOf(exact, searchFrom);
    if (idx < 0) break;
    occurrences.push(idx);
    searchFrom = idx + 1;
  }
  if (occurrences.length === 0) return -1;
  if (occurrences.length === 1) return occurrences[0] ?? -1;
  let best = -1;
  let bestScore = -1;
  for (const idx of occurrences) {
    const observedPrefix = text.slice(Math.max(0, idx - prefix.length), idx);
    const observedSuffix = text.slice(idx + exact.length, idx + exact.length + suffix.length);
    const score = commonSuffixLength(observedPrefix, prefix) + commonPrefixLength(observedSuffix, suffix);
    if (score > bestScore) {
      bestScore = score;
      best = idx;
    }
  }
  return best;
}

function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

function commonSuffixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i += 1;
  return i;
}

/**
 * Build a fresh anchor for `newSource` and `range`. `quote.prefix` and
 * `quote.suffix` are recaptured from the actual surrounding text of the
 * quote in `newSource`, so a later re-anchor of the SAME thread on a
 * still-newer source starts from up-to-date disambiguating context.
 * `quote.exact`, `path` and (if set) `commit` carry over.
 */
async function anchorFor(
  original: Anchor,
  newSource: string,
  range: LineRange,
  newRevision: string,
): Promise<Anchor> {
  const contextLength = Math.max(original.quote.prefix.length, original.quote.suffix.length, 32);
  const rangeStartOffset = lineToOffset(newSource, range.start);
  const rangeText = sliceLines(newSource, range.start, range.end);
  const relativeIndex = findQuoteIndexInWindow(rangeText, original.quote);
  const quoteOffset = relativeIndex >= 0 ? rangeStartOffset + relativeIndex : rangeStartOffset;
  const prefixStart = Math.max(0, quoteOffset - contextLength);
  const suffixEnd = Math.min(newSource.length, quoteOffset + original.quote.exact.length + contextLength);
  const rebuilt: Anchor = {
    path: original.path,
    startLine: range.start,
    endLine: range.end,
    quote: {
      exact: original.quote.exact,
      prefix: newSource.slice(prefixStart, quoteOffset),
      suffix: newSource.slice(quoteOffset + original.quote.exact.length, suffixEnd),
    },
    revision: newRevision,
    ...(original.commit === undefined ? {} : { commit: original.commit }),
  };
  return anchorSchema.parse(rebuilt);
}
