// Text-quote selector construction (ADR-0006 dual anchor).
//
// A `TextQuote` (see `anchor.ts`) records the exact substring of the
// source that a comment addresses, plus a bounded amount of context
// on each side. The context lets the re-anchoring pipeline
// (`reanchor.ts`) locate a moved block unambiguously — without it,
// identical text elsewhere in the file (a common template row) would
// tie for the anchor.
//
// One source of truth: every producer that mints an anchor from source
// text — the local rail, `check-dist`, the GitHub adapter's thread
// import — calls `buildQuoteFromLines` (or `buildQuoteFromOffsets`)
// here. A one-off ad-hoc slicer scattered across surfaces would drift
// on line-ending or trimming choices; owning the function centrally
// keeps the invariants identical.
//
// Line-ending handling: line-based inputs work on the source AS
// GIVEN (no LF normalisation). The revision hash uses LF-normalised
// content (see `revisionOf`), so a quote built from the raw source
// and stored with an LF-normalised revision remains consistent as
// long as the caller doesn't intermix representations. The
// re-anchoring engine normalises to LF for its diff, so a `\r\n`
// slice ends up trimmed to `\n` there; the quote stored here is
// truthful to what the reviewer highlighted.
//
// Runtime-neutral: no `node:*` / `bun:*` imports.

import type { TextQuote } from "./anchor.ts";

/** Default context window in characters on each side of the quote.
 * A block-quote fixture around 40 chars gives the re-anchoring
 * engine enough leverage to disambiguate a moved block from a
 * templated neighbour; more than that starts to include content
 * the reviewer might have edited between capture and re-anchor
 * (a false negative). The pipeline (ADR-0006) cares about
 * relative context length, not an exact number — 40 is a safe
 * default that matches the fixtures in `reanchor.test.ts`. */
export const DEFAULT_QUOTE_CONTEXT_CHARS = 40;

/** Options for the quote builders. `contextChars` sets prefix/suffix
 * length in characters; the default is `DEFAULT_QUOTE_CONTEXT_CHARS`. */
export interface BuildQuoteOptions {
  readonly contextChars?: number;
}

/**
 * Build a `TextQuote` for the inclusive line range `startLine..endLine`
 * in `source`.
 *
 * Line numbers are 1-indexed and inclusive on both ends, matching the
 * anchor schema. If a line number lies outside the source, the range
 * is clamped to the file bounds (a start beyond the last line yields
 * an empty exact quote — the caller shouldn't be doing that, and the
 * anchor schema will reject it downstream).
 *
 * The `exact` slice starts at the first character of `startLine` and
 * ends at (but does NOT include) the newline that terminates
 * `endLine`. That matches how a reader would highlight the block —
 * body only, no trailing newline. When the last line is missing its
 * newline (EOF), the slice runs to end-of-source.
 *
 * `prefix` is the last `contextChars` characters of the source
 * BEFORE the quote; `suffix` is the first `contextChars` after it.
 * Both are empty at file bounds.
 */
export function buildQuoteFromLines(
  source: string,
  startLine: number,
  endLine: number,
  options: BuildQuoteOptions = {},
): TextQuote {
  const contextChars = Math.max(0, options.contextChars ?? DEFAULT_QUOTE_CONTEXT_CHARS);

  // Build a line-start index once. `lineStartsOf(source)` returns the
  // offset of the first character of each 1-indexed line, plus one
  // past-the-end sentinel. `lineStartsOf` handles `\r\n` and lone
  // `\r` as line terminators.
  const starts = lineStartsOf(source);
  const totalLines = starts.length - 1;
  // Clamp; anchorSchema will refuse the anchor downstream if the
  // caller ends up with an empty exact, but we still return a valid
  // TextQuote shape here (empty exact would fail the anchor schema
  // but the quote type itself carries it).
  const clampedStart = Math.max(1, Math.min(startLine, Math.max(1, totalLines)));
  const clampedEnd = Math.max(clampedStart, Math.min(endLine, Math.max(1, totalLines)));

  const startOffset = starts[clampedStart - 1] ?? 0;
  // End offset: one past the last character of `clampedEnd`. If
  // `clampedEnd` is the last line, that's the end of source; else
  // it's the offset just before the newline that terminates it —
  // which is `starts[clampedEnd] - length-of-terminator`.
  const endOffsetInclusiveOfNewline = starts[clampedEnd] ?? source.length;
  const endOffset = trimTrailingLineTerminator(source, startOffset, endOffsetInclusiveOfNewline);

  return buildQuoteFromOffsets(source, startOffset, endOffset, { contextChars });
}

/**
 * Build a `TextQuote` for the half-open character range
 * `[startOffset..endOffset)` in `source`. The offsets are byte-like
 * (JavaScript UTF-16 code-unit indices) and `endOffset` is
 * exclusive — the same convention `String.slice` uses.
 *
 * Callers that already know character offsets (e.g. from a DOM
 * selection or a build-time hast pass) use this directly;
 * `buildQuoteFromLines` is a convenience for the common
 * line-range shape.
 */
export function buildQuoteFromOffsets(
  source: string,
  startOffset: number,
  endOffset: number,
  options: BuildQuoteOptions = {},
): TextQuote {
  const contextChars = Math.max(0, options.contextChars ?? DEFAULT_QUOTE_CONTEXT_CHARS);
  const start = Math.max(0, Math.min(startOffset, source.length));
  const end = Math.max(start, Math.min(endOffset, source.length));
  const prefixStart = Math.max(0, start - contextChars);
  const suffixEnd = Math.min(source.length, end + contextChars);
  return {
    prefix: source.slice(prefixStart, start),
    exact: source.slice(start, end),
    suffix: source.slice(end, suffixEnd),
  };
}

/**
 * Compute the sorted offsets where each 1-indexed line starts.
 * Returned array has `n + 1` entries for an n-line source; the last
 * entry is `source.length` (past-the-end sentinel), so
 * `starts[k] - starts[k-1]` gives line `k`'s total length including
 * its terminator.
 *
 * Handles `\r\n`, lone `\n`, and lone `\r` as line terminators — the
 * caller doesn't need to LF-normalise first. A source without any
 * terminator counts as a single line.
 */
export function lineStartsOf(source: string): number[] {
  const starts: number[] = [0];
  const len = source.length;
  let i = 0;
  while (i < len) {
    const ch = source.charCodeAt(i);
    if (ch === 0x0d /* \r */) {
      // CRLF or lone CR — one line terminator either way; start of
      // next line is after the sequence.
      i++;
      if (i < len && source.charCodeAt(i) === 0x0a /* \n */) i++;
      starts.push(i);
    } else if (ch === 0x0a /* \n */) {
      i++;
      starts.push(i);
    } else {
      i++;
    }
  }
  // Sentinel: one past the last character.
  if (starts[starts.length - 1] !== len) {
    starts.push(len);
  }
  return starts;
}

/** Given the offset just past the last character of a line
 * (i.e. `lineStarts[nextLine]`), roll back the terminator so the
 * quote's `exact` doesn't include a trailing `\n` / `\r\n` / `\r`.
 * The `startOffset` is a floor — an empty range never rolls back
 * below its start. */
function trimTrailingLineTerminator(source: string, startOffset: number, endOffsetInclusive: number): number {
  let end = endOffsetInclusive;
  if (end > startOffset) {
    const ch = source.charCodeAt(end - 1);
    if (ch === 0x0a /* \n */) {
      end--;
      if (end > startOffset && source.charCodeAt(end - 1) === 0x0d /* \r */) end--;
    } else if (ch === 0x0d /* \r */) {
      end--;
    }
  }
  return end;
}
