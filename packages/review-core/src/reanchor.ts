// Re-anchoring engine (ADR-0006 Acceptance). Pure logic:
//
//   reanchor(anchor, oldSource, newSource) → ReanchorResult
//
// Runs the ADR's four stages, in order, with the corrections from the
// PR-40 review:
//
//   (a) exact pass — enumerate every occurrence of the anchor's exact
//       quote in the new source. Exactly one occurrence anchors as
//       `quote-exact`, immediately (and covers the "block moved far"
//       case that would otherwise fall to fuzzy). Multiple occurrences
//       are scored by prefix/suffix agreement — one candidate wins
//       only when it beats the runner-up by a clear margin; otherwise
//       the pipeline continues to fuzzy so the ambiguity check runs.
//   (b) fuzzy pass — gather MULTIPLE candidate locations (bitap probes
//       at the mapped hint, the anchor's original offset, and from the
//       start of the file), score each by BOTH the quote's own
//       similarity and its context similarity, reject any candidate
//       whose quote similarity is below its own gate (so a matching
//       context cannot carry a wrong quote), and accept the best only
//       when it clears `minFuzzyScore` AND beats the runner-up by
//       `minMargin`.
//   (c) orphan — kept, never guessed and never dropped.
//
// Recording the accepted anchor:
//   The new anchor stores the NEW text at the matched location. For
//   `quote-exact` this equals the anchor's own `exact` (it was found
//   verbatim). For `fuzzy`, `diff_main` + `diff_xIndex` walk the old
//   quote's end onto the new source, so the recorded `exact` is
//   `newSource.slice(matchStart, matchEnd)` — never a stale string
//   that is no longer in the file. `prefix` and `suffix` are recut
//   around the ACTUAL match, and the line range is computed from the
//   real offsets. On the next rebuild the engine reads a coherent
//   anchor back.
//
// The individual stages are named exports too (`diffMapLines`,
// `mapAnchorRange`, `exactOccurrences`, `scoreCandidate`,
// `bitapProbes`, `alignMatchedText`). Stage-level tests exercise them
// directly, and mutation tests demonstrate that removing any single
// stage — the exact-first pass, the margin check, the context weight,
// the quote-only gate, or a realistic `Match_Threshold` — turns a
// green test red.
//
// Runtime-neutral: no `node:*` / `bun:*` imports; the only dependency
// beyond the workspace is `diff-match-patch` (pure JS, browser-safe),
// wrapped in a narrow typed shim (`src/vendor/dmp.ts`) so no
// ambient declaration leaks out of this package.
import { anchorSchema, type Anchor, type TextQuote } from "./anchor.ts";
import { authorSchema, type Author } from "./author.ts";
import { type ReviewEventInput } from "./events.ts";
import { revisionOf } from "./revision.ts";
import { DiffMatchPatch, type Diff } from "./vendor/dmp.ts";

/** How the re-anchor arrived at the returned anchor. `unchanged` is
 * the identity short-circuit (revision hash matches). `quote-exact`
 * means the exact quote was found verbatim (either as a lone
 * occurrence in the file, or as the disambiguated winner in a
 * multi-occurrence file). `fuzzy` means the location came from a
 * scored bitap probe that cleared both the fuzzy threshold AND the
 * margin over the runner-up. */
export type ReanchorMethod = "unchanged" | "quote-exact" | "fuzzy";

/** A 1-indexed inclusive line range in a source file. */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/** The outcome of `reanchor`. On `anchored`, `moved` or `fuzzy` the
 * returned `anchor` carries the NEW revision (SHA-256 of `newSource`)
 * and the range/quote captured against `newSource` (the quote is the
 * NEW text at the matched location — never a stale string). On
 * `orphaned`, the caller keeps the old anchor and emits
 * `thread.orphaned`; the new source's revision is carried on the
 * result so the event can name it. `reason` explains which stage
 * failed. */
export type ReanchorResult =
  | { readonly kind: "anchored"; readonly anchor: Anchor; readonly method: "unchanged" }
  | { readonly kind: "moved"; readonly anchor: Anchor; readonly method: "quote-exact" }
  | { readonly kind: "fuzzy"; readonly anchor: Anchor; readonly method: "fuzzy"; readonly score: number }
  | { readonly kind: "orphaned"; readonly revision: string; readonly reason: string; readonly score?: number };

/**
 * Minimum combined score for a fuzzy match. Combined score is the
 * mean of the quote's own similarity and its context similarity. The
 * fixture band this was tuned against:
 *
 *   - a one-word edit inside a unique paragraph scores ~0.85–0.95;
 *   - a wholly-rewritten paragraph scores ~0.30–0.45;
 *   - a repeated templated row (bullet, table row, code line)
 *     scores ~0.60–0.75 on the wrong-line candidate — this is why
 *     the margin check is load-bearing, not the threshold alone.
 *
 * 0.75 keeps the "clean" side and rejects the "torn" side; the margin
 * check (below) rejects the templated-repeat case where two candidates
 * both clear the threshold. Mutation tests trip if this drops to 0
 * (`threshold_of_zero_would_wrongly_accept_orphan`) or below the
 * context-weighted band (`context_removed_would_wrongly_accept`).
 */
export const DEFAULT_MIN_FUZZY_SCORE = 0.75;

/**
 * How much the best fuzzy candidate must beat the runner-up by
 * (combined score delta) to be accepted. On templated content (a
 * bullet list, a table row, a code block with repeated lines) two
 * candidates often clear `minFuzzyScore` by luck — the margin check
 * is what makes the pipeline "orphaned, never guessed" on those
 * inputs. Empirically 0.1 separates confident real hits from
 * coincidence on the fixtures in `test/reanchor.test.ts`.
 * Mutation test `margin_removed_would_wrongly_accept` trips if this
 * is set to 0.
 */
export const DEFAULT_MIN_MARGIN = 0.1;

/**
 * Minimum standalone quote similarity for a candidate to survive.
 * Enforced BEFORE the combined score so a matching context cannot
 * paper over a wrong quote (the templated-list failure mode).
 * Mutation test `quote_gate_removed_would_wrongly_accept` trips if
 * this is lowered.
 */
export const DEFAULT_MIN_QUOTE_SCORE = 0.6;

/**
 * DMP `Match_Distance`. 1000 lets a paragraph move a page without
 * penalty, but the exact-first pass (stage a) has already covered
 * long moves — the fuzzy pass mostly deals with local reflows. Kept
 * exposed so a caller can widen it for very large files.
 */
export const DEFAULT_MATCH_DISTANCE = 1000;

/**
 * DMP `Match_Threshold`. A realistic 0.5 (not the pipeline's own
 * threshold — that runs on the scored candidates). At 1.0 (the old
 * value) bitap accepts almost anything within `Match_Distance` and
 * feeds it into the scorer, which is what the PR-40 reviewer flagged
 * as wrong-place anchoring. 0.5 already filters out obviously-poor
 * bitap hits before scoring.
 */
export const DEFAULT_BITAP_THRESHOLD = 0.5;

/** Options for `reanchor`. A production caller normally passes none. */
export interface ReanchorOptions {
  readonly minFuzzyScore?: number;
  readonly minMargin?: number;
  readonly minQuoteScore?: number;
  readonly matchDistance?: number;
  readonly bitapThreshold?: number;
}

// ---------- Stage exports (composed by `reanchor`) ----------

/**
 * Line-mode diff of `oldSource` → `newSource`. Returns an array
 * indexed by 1-based old-line-number where the value is the 1-based
 * new-line-number that line maps to, or `null` if the line was
 * deleted.
 *
 * Input is expected LF-normalised (the primary `reanchor` entry does
 * that once, up-front).
 */
export function diffMapLines(oldSource: string, newSource: string): (number | null)[] {
  const dmp = new DiffMatchPatch();
  const chars = dmp.diff_linesToChars_(oldSource, newSource);
  const diffs = dmp.diff_main(chars.chars1, chars.chars2, false);
  dmp.diff_charsToLines_(diffs, chars.lineArray);

  const oldLineCount = splitLines(oldSource).length;
  const mapping: (number | null)[] = new Array<number | null>(oldLineCount + 1).fill(null);
  let oldLine = 1;
  let newLine = 1;
  for (const [op, text] of diffs) {
    const lineCount = countLinesInSegment(text);
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

/** Every offset in `newSource` where `quote.exact` occurs verbatim
 * (0-indexed). Empty when the quote is not in the file at all. */
export function exactOccurrences(newSource: string, exact: string): number[] {
  const occurrences: number[] = [];
  if (exact.length === 0) return occurrences;
  let searchFrom = 0;
  while (true) {
    const idx = newSource.indexOf(exact, searchFrom);
    if (idx < 0) break;
    occurrences.push(idx);
    searchFrom = idx + 1;
  }
  return occurrences;
}

/** A single fuzzy candidate: its start offset in `newSource`, plus
 * the two scores that gate acceptance (quote-only and context-
 * weighted). `combined` is the mean of the two, and drives the
 * ordering and the margin check. */
export interface Candidate {
  readonly index: number;
  readonly quoteScore: number;
  readonly contextScore: number;
  readonly combined: number;
}

/** Score a candidate at `index` against the anchor's quote.
 *
 *   quoteScore = 1 - levenshtein(exact, newSource.slice(index, index+|exact|)) / max_len
 *   contextScore = 1 - levenshtein(prefix+exact+suffix, newSource.slice(index-|prefix|, index+|exact|+|suffix|)) / max_len
 *   combined = (quoteScore + contextScore) / 2
 */
export function scoreCandidate(newSource: string, quote: TextQuote, index: number): Candidate {
  const dmp = new DiffMatchPatch();
  const exactLen = quote.exact.length;
  const quoteCandidate = newSource.slice(index, index + exactLen);
  const quoteScore = similarity(dmp, quote.exact, quoteCandidate);

  const contextPattern = quote.prefix + quote.exact + quote.suffix;
  const ctxStart = Math.max(0, index - quote.prefix.length);
  const ctxEnd = Math.min(newSource.length, index + exactLen + quote.suffix.length);
  const contextCandidate = newSource.slice(ctxStart, ctxEnd);
  const contextScore = similarity(dmp, contextPattern, contextCandidate);

  return {
    index,
    quoteScore,
    contextScore,
    combined: (quoteScore + contextScore) / 2,
  };
}

/**
 * Gather bitap probe offsets in `newSource` for a quote. Handles
 * `Match_MaxBits` explicitly: for a quote longer than the bitap word
 * size we probe with a distinctive middle slice (the middle is more
 * often unique than the head or tail — a leading `- ` bullet or a
 * trailing punctuation carries little signal). Callers score each
 * returned offset against the FULL quote.
 *
 * Multiple probes: at the caller-supplied expected offset (usually
 * the diff-map hint), at the anchor's original byte offset (before
 * edits), and from 0 (whole-file search). Duplicates are collapsed
 * by the caller via a Map.
 */
export function bitapProbes(
  newSource: string,
  quote: TextQuote,
  hints: readonly number[],
  bitapThreshold: number,
  matchDistance: number,
): number[] {
  const dmp = new DiffMatchPatch();
  dmp.Match_Threshold = bitapThreshold;
  dmp.Match_Distance = matchDistance;
  const maxBits = dmp.Match_MaxBits;
  const key = distinctiveSlice(quote.exact, maxBits);
  const seen = new Set<number>();
  const results: number[] = [];
  for (const hint of hints) {
    const boundedHint = Math.max(0, Math.min(newSource.length, hint));
    const raw = dmp.match_main(newSource, key, boundedHint);
    if (raw < 0) continue;
    // `match_main` returns the start of the SEARCH KEY in `newSource`,
    // not the start of the full quote. When we sliced from the
    // middle, back-project to the quote's start.
    const projected = raw - keyOffsetInQuote(quote.exact, key, maxBits);
    if (projected < 0 || projected > newSource.length) continue;
    if (seen.has(projected)) continue;
    seen.add(projected);
    results.push(projected);
  }
  return results;
}

/**
 * Align the OLD quote against the new source at `startOffset` and
 * return the offset just past where the quote's END lands in the new
 * source. Uses `diff_main` for a character-level alignment and
 * `diff_xIndex` to walk the end offset — so an accepted fuzzy match
 * records the ACTUAL new text at the location, not a stale string
 * that may no longer be in the file (PR-40 review, blocker 2).
 *
 * `slack` is how much extra window we take past the quote's length,
 * to accommodate insertions inside the block.
 */
export function alignMatchedText(
  oldQuote: string,
  newSource: string,
  startOffset: number,
  slack: number = Math.max(Math.floor(oldQuote.length * 0.5), 16),
): { endOffset: number; matchedText: string } {
  const windowEnd = Math.min(newSource.length, startOffset + oldQuote.length + slack);
  const window = newSource.slice(startOffset, windowEnd);
  const dmp = new DiffMatchPatch();
  const diffs = dmp.diff_main(oldQuote, window);
  // Ask for the location of the LAST char of the old quote, not the
  // position just past it. Requesting `oldQuote.length` (past-the-end)
  // pulls in any INSERT that DMP emitted at the boundary — e.g. a
  // trailing `\n` and the next paragraph — because the walker keeps
  // consuming until `chars1 > loc`. Requesting `oldQuote.length - 1`
  // and adding 1 back stops at the position that maps to the quote's
  // actual last char, then advances one to keep an exclusive end.
  const lastCharSource = Math.max(0, oldQuote.length - 1);
  const endInWindow = dmp.diff_xIndex(diffs, lastCharSource) + 1;
  const endOffset = Math.min(newSource.length, startOffset + endInWindow);
  return { endOffset, matchedText: newSource.slice(startOffset, endOffset) };
}

// ---------- The composed pipeline ----------

/**
 * Re-anchor `anchor` against `newSource`, given `oldSource` — the
 * source the anchor was captured against (its SHA-256 must equal
 * `anchor.revision`; the engine returns `orphaned` if the caller
 * hands a snapshot for a different revision).
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
  const minMargin = options.minMargin ?? DEFAULT_MIN_MARGIN;
  const minQuoteScore = options.minQuoteScore ?? DEFAULT_MIN_QUOTE_SCORE;
  const matchDistance = options.matchDistance ?? DEFAULT_MATCH_DISTANCE;
  const bitapThreshold = options.bitapThreshold ?? DEFAULT_BITAP_THRESHOLD;
  const oldLF = toLF(oldSource);
  const newLF = toLF(newSource);
  const newRevision = await revisionOf(newLF);

  // (0) Identity: source is unchanged.
  if (anchor.revision === newRevision) {
    return { kind: "anchored", anchor, method: "unchanged" };
  }

  // Sanity: the snapshot must correspond to the anchor. If it does
  // not, the diff is meaningless.
  const oldRevision = await revisionOf(oldLF);
  if (oldRevision !== anchor.revision) {
    return {
      kind: "orphaned",
      revision: newRevision,
      reason: `snapshot revision mismatch (anchor: ${anchor.revision.slice(0, 12)}…, snapshot: ${oldRevision.slice(0, 12)}…) — cannot trust the diff.`,
    };
  }

  // (a) Exact-first pass: enumerate every occurrence of the exact
  // quote. One occurrence anchors immediately. Multiple occurrences
  // are disambiguated by prefix/suffix; a clear winner anchors as
  // quote-exact, an ambiguous set falls through to fuzzy (which
  // applies the same margin check on scored candidates).
  const exactHits = exactOccurrences(newLF, anchor.quote.exact);
  if (exactHits.length === 1) {
    const start = exactHits[0] ?? 0;
    const rebuilt = await buildMovedAnchor(anchor, newLF, start, anchor.quote.exact, newRevision);
    return { kind: "moved", anchor: rebuilt, method: "quote-exact" };
  }
  if (exactHits.length > 1) {
    const disambiguated = disambiguateExact(newLF, anchor.quote, exactHits, minMargin);
    if (disambiguated !== null) {
      const rebuilt = await buildMovedAnchor(anchor, newLF, disambiguated, anchor.quote.exact, newRevision);
      return { kind: "moved", anchor: rebuilt, method: "quote-exact" };
    }
    // fall through to fuzzy; the margin check there gives one more
    // chance to accept.
  }

  // (b) Fuzzy: multiple probes → score each → gate on quote-only
  // score → apply threshold + margin.
  const lineMap = diffMapLines(oldLF, newLF);
  const mapped = mapAnchorRange(lineMap, anchor.startLine, anchor.endLine);
  const originalOffset = lineToOffset(oldLF, anchor.startLine);
  const mappedOffset = mapped === null ? null : lineToOffset(newLF, mapped.start);
  const hints: number[] = [];
  if (mappedOffset !== null) hints.push(mappedOffset);
  hints.push(Math.min(newLF.length, originalOffset));
  hints.push(0);
  if (newLF.length > 0) hints.push(newLF.length - 1);

  const probeOffsets = bitapProbes(newLF, anchor.quote, hints, bitapThreshold, matchDistance);
  // Also seed with any exact hits — even ambiguous ones deserve
  // scoring, since context may still pick one clearly.
  for (const hit of exactHits) probeOffsets.push(hit);
  // Fallback: bitap can return nothing when the whole line was
  // rewritten (no fuzzy match beats its threshold). We still want
  // the scorer to run at the diff-map hint / original offset so the
  // combined-score gate decides — not a silent orphan on "0 probes
  // tried". Seed the hint offsets directly.
  for (const h of hints) probeOffsets.push(h);

  // NEIGHBOUR SCAN. Bitap gives us one location per hint, but a
  // templated repeat (bullet list, table rows, code lines) needs the
  // margin check on the SIBLINGS to catch ambiguity. Expand every
  // probe by scoring its ±3 line neighbours too. Bounded to at most
  // three lines each side so we do 7 * (# bitap hits) scorings — a
  // constant per hit, safe on a 1 MB templated file.
  //
  // All candidates are SNAPPED to line-start offsets, so an off-by-a-
  // few-chars probe (bitap can return a start a couple of chars into
  // a line) does not compete against its own line-aligned self as if
  // they were two different candidates — that was the source of the
  // margin-check false positive on unique quotes.
  const NEIGHBOUR_RADIUS = 3;
  const neighbourOffsets = new Set<number>();
  for (const probe of probeOffsets) {
    if (probe < 0 || probe > newLF.length) continue;
    const line = offsetToLine(newLF, probe);
    for (let d = -NEIGHBOUR_RADIUS; d <= NEIGHBOUR_RADIUS; d += 1) {
      const l = line + d;
      if (l < 1) continue;
      const off = lineToOffset(newLF, l);
      if (off >= 0 && off <= newLF.length) neighbourOffsets.add(off);
    }
  }
  const candidatesByIndex = new Map<number, Candidate>();
  for (const offset of neighbourOffsets) {
    candidatesByIndex.set(offset, scoreCandidate(newLF, anchor.quote, offset));
  }
  // CLUSTER nearby candidates. Two offsets that are within half the
  // quote's length of each other correspond to essentially the same
  // match location (e.g. an empty-line start at 72 vs a real line
  // start at 73 both grab most of the same content when scored). The
  // margin check must not fire against the shifted-by-one view of
  // the same location. Keep the higher-scoring representative of each
  // cluster.
  const clusterRadius = Math.max(Math.floor(anchor.quote.exact.length / 2), 1);
  const byOffset = [...candidatesByIndex.values()].sort((a, b) => a.index - b.index);
  const clustered: Candidate[] = [];
  for (const c of byOffset) {
    const last = clustered[clustered.length - 1];
    if (last !== undefined && c.index - last.index < clusterRadius) {
      if (c.combined > last.combined) clustered[clustered.length - 1] = c;
    } else {
      clustered.push(c);
    }
  }
  // Drop candidates whose STANDALONE quote score is below the gate.
  const candidates = clustered
    .filter((c) => c.quoteScore >= minQuoteScore)
    .sort((a, b) => b.combined - a.combined);

  if (candidates.length === 0) {
    return {
      kind: "orphaned",
      revision: newRevision,
      reason:
        "no fuzzy candidate cleared the quote-only gate " +
        `(min ${minQuoteScore.toFixed(2)}); ${probeOffsets.length} probes tried.`,
    };
  }
  const best = candidates[0];
  if (best === undefined) {
    return {
      kind: "orphaned",
      revision: newRevision,
      reason: "internal: no candidate after sort (unreachable if candidates.length > 0)",
    };
  }
  if (best.combined < minFuzzyScore) {
    return {
      kind: "orphaned",
      revision: newRevision,
      reason: `best fuzzy score ${best.combined.toFixed(2)} < ${minFuzzyScore}`,
      score: best.combined,
    };
  }
  // AMBIGUITY / MARGIN CHECK. Only candidates that ALSO clear the
  // combined threshold on their own are viable alternates — a weak
  // candidate near a strong one (e.g. a blank line or an unrelated
  // paragraph that happens to share a few words) is not "ambiguous",
  // it is just a low-scoring probe the scan surfaced.
  //
  // The margin check triggers when TWO viable candidates exist and
  // the winner does not beat the runner-up by `minMargin`. This is
  // the templated-repeat case (bullet list, table row, code block
  // with repeated lines) the reviewer flagged.
  const viableRunnerUp = candidates.find(
    (c, i) => i > 0 && c.combined >= minFuzzyScore,
  );
  if (viableRunnerUp !== undefined && best.combined - viableRunnerUp.combined < minMargin) {
    return {
      kind: "orphaned",
      revision: newRevision,
      reason:
        `ambiguous fuzzy match: best ${best.combined.toFixed(2)} at offset ` +
        `${best.index} does not beat runner-up ${viableRunnerUp.combined.toFixed(2)} ` +
        `at offset ${viableRunnerUp.index} by ${minMargin} (delta ` +
        `${(best.combined - viableRunnerUp.combined).toFixed(2)}).`,
      score: best.combined,
    };
  }

  // Accepted. Record the ACTUAL matched text — walk the old quote's
  // end onto the new source with diff_xIndex, so the recorded `exact`
  // is what's actually at the location, not a stale string.
  const aligned = alignMatchedText(anchor.quote.exact, newLF, best.index);
  const rebuilt = await buildMovedAnchor(anchor, newLF, best.index, aligned.matchedText, newRevision);
  return { kind: "fuzzy", anchor: rebuilt, method: "fuzzy", score: best.combined };
}

/**
 * Turn a `ReanchorResult` into the `ReviewEventInput` a store
 * `append`s. `anchored` (unchanged) returns `null` — the caller
 * writes no event. The daemon (item 5b) is expected to run:
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

/** Byte offset of the start of line `n` (1-indexed). Returns
 * `source.length` if `n` is past the end. */
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

/**
 * Number of lines a DMP-emitted diff segment covers.
 *
 * The bug this replaces (PR-40 review nit): counting only `\n` misses
 * the final "line without trailing newline" case — a file whose last
 * line has no terminating `\n` produces a partial last line that
 * `diff_charsToLines_` emits without an `\n`, and the old counter
 * mapped it to zero lines. Any anchor on that last line then fell
 * out of the diff-map's coverage and re-anchored via fuzzy instead
 * of quote-exact.
 */
function countLinesInSegment(segment: string): number {
  if (segment.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < segment.length; i += 1) {
    if (segment.charCodeAt(i) === 10) count += 1;
  }
  // Trailing content without a terminating LF is still a line.
  if (segment.charCodeAt(segment.length - 1) !== 10) count += 1;
  return count;
}

/** Normalised (0–1) similarity of two strings, via DMP's Levenshtein
 * over `diff_main`. Empty inputs are treated as a perfect match
 * (`prefix` and `suffix` are allowed to be empty). */
function similarity(dmp: DiffMatchPatch, a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  const diffs = dmp.diff_main(a, b);
  const distance = dmp.diff_levenshtein(diffs);
  const denom = Math.max(a.length, b.length);
  return denom === 0 ? 1 : 1 - distance / denom;
}

/**
 * Pick the most distinctive slice of `quote` up to `maxBits`
 * characters, for feeding into bitap `match_main` (which errors on
 * patterns longer than `Match_MaxBits`). Strategy: prefer the middle
 * (leading indentation, bullet markers and trailing punctuation
 * repeat across templated content; the middle is where the
 * discriminative words live). For quotes shorter than `maxBits` the
 * whole quote is returned.
 */
function distinctiveSlice(quote: string, maxBits: number): string {
  if (quote.length <= maxBits) return quote;
  const start = Math.max(0, Math.floor((quote.length - maxBits) / 2));
  return quote.slice(start, start + maxBits);
}

/** Offset of `key` inside `quote` (where `distinctiveSlice` cut).
 * Used to back-project a bitap match on the slice to the START of
 * the full quote. */
function keyOffsetInQuote(quote: string, key: string, maxBits: number): number {
  if (quote.length <= maxBits) return 0;
  return Math.max(0, Math.floor((quote.length - maxBits) / 2));
}

/**
 * Choose ONE of `hits` (byte offsets) whose surrounding context best
 * matches the anchor's `prefix`/`suffix`. Returns the offset when
 * exactly one candidate wins by `minMargin`, else `null` — the
 * caller then falls through to fuzzy (which repeats the margin check
 * on scored candidates and can still orphan).
 */
function disambiguateExact(
  newSource: string,
  quote: TextQuote,
  hits: readonly number[],
  minMargin: number,
): number | null {
  const scored = hits
    .map((hit) => {
      const c = scoreCandidate(newSource, quote, hit);
      return { hit, score: c.contextScore };
    })
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const runnerUp = scored[1];
  if (best === undefined) return null;
  if (runnerUp !== undefined && best.score - runnerUp.score < minMargin) return null;
  return best.hit;
}

/**
 * Build the new anchor for a match starting at `startOffset` with
 * text `matchedText` (equal to `anchor.quote.exact` for a
 * quote-exact match; equal to the aligned new text for a fuzzy
 * match). `prefix`/`suffix` are recaptured around the ACTUAL match
 * so the recorded anchor is coherent — a subsequent rebuild reads
 * back a quote that is really at those offsets in the new source.
 */
async function buildMovedAnchor(
  original: Anchor,
  newSource: string,
  startOffset: number,
  matchedText: string,
  newRevision: string,
): Promise<Anchor> {
  const contextLength = Math.max(original.quote.prefix.length, original.quote.suffix.length, 32);
  const endOffset = startOffset + matchedText.length;
  const startLine = offsetToLine(newSource, startOffset);
  const endLine = offsetToLine(newSource, Math.max(startOffset, endOffset - 1));
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
