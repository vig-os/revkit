// Text-quote selector construction (ADR-0006 dual anchor).
//
// A `TextQuote` (see `anchor.ts`) records the exact substring of the
// source that a comment addresses, plus a bounded amount of context
// on each side. The context lets the re-anchoring pipeline
// (`reanchor.ts`) locate a moved block unambiguously — without it,
// identical text elsewhere in the file (a common template row) would
// tie for the anchor.
//
// **One source of truth.** This module is the single quote builder
// every review-core surface uses (rail, check-dist, GitHub adapter's
// thread import) and it **reuses** the reanchor engine's own
// helpers (`toLF`, `buildLineStartIndex`, `lineToOffset`,
// `DEFAULT_ANCHOR_CONTEXT_CHARS`) so a fresh quote and a
// reanchored one carve out identical byte windows. Two copies
// would drift on LF-normalisation or context length — the exact
// class of bug PR-43 round-4 called out (a CRLF multi-line quote
// that always orphans because the fresh producer keeps `\r\n` in
// `exact` and the engine looks for LF).
//
// **LF normalisation.** Input source is passed through `toLF` before
// slicing; `exact` / `prefix` / `suffix` are LF-only. The engine
// runs on the LF form and the anchor's `revision` is the SHA-256
// of the LF form (see `revisionOf`), so all three are consistent
// end-to-end.
//
// Runtime-neutral: no `node:*` / `bun:*` imports.

import type { TextQuote } from "./anchor.ts";
import {
  buildLineStartIndex,
  DEFAULT_ANCHOR_CONTEXT_CHARS,
  lineToOffset,
  toLF,
} from "./reanchor.ts";

/** Default context window — reuses the reanchor engine's constant so
 * both producers cut identical windows. */
export const DEFAULT_QUOTE_CONTEXT_CHARS = DEFAULT_ANCHOR_CONTEXT_CHARS;

/** Options for the quote builders. `contextChars` defaults to
 * `DEFAULT_QUOTE_CONTEXT_CHARS`. */
export interface BuildQuoteOptions {
  readonly contextChars?: number;
}

/**
 * Build a `TextQuote` for the inclusive line range `startLine..endLine`
 * in `source` (LF-normalised).
 *
 * Line numbers are 1-indexed and inclusive on both ends, matching
 * the anchor schema. If a line number lies outside the source, the
 * range is clamped to the file bounds; a truly empty exact quote
 * still returns a valid TextQuote shape (the anchor schema will
 * refuse an empty `exact` downstream, which is the safe path).
 *
 * The `exact` slice starts at the first character of `startLine` and
 * ends at (but does NOT include) the newline that terminates
 * `endLine`. Any `\r` before that newline is dropped by the LF
 * normalisation — so a CRLF source produces the SAME quote as its
 * LF counterpart, and the reanchor engine (which normalises
 * likewise) will match it.
 */
export function buildQuoteFromLines(
  source: string,
  startLine: number,
  endLine: number,
  options: BuildQuoteOptions = {},
): TextQuote {
  const lf = toLF(source);
  const index = buildLineStartIndex(lf);
  const totalLines = Math.max(1, index.length);

  const clampedStart = Math.max(1, Math.min(startLine, totalLines));
  const clampedEnd = Math.max(clampedStart, Math.min(endLine, totalLines));
  const startOffset = lineToOffset(index, clampedStart);
  // End offset = start of the line AFTER `clampedEnd`, minus its
  // terminator. When `clampedEnd` is the last line,
  // `lineToOffset(index, N+1)` returns the LAST line's start (via
  // its clamp), so we substitute `lf.length` for the true EOF.
  const nextLineStart = clampedEnd + 1 > totalLines ? lf.length : lineToOffset(index, clampedEnd + 1);
  const endOffset = trimTrailingNewline(lf, startOffset, nextLineStart);
  return buildQuoteFromOffsets(lf, startOffset, endOffset, options);
}

/**
 * Build a `TextQuote` for the half-open character range
 * `[startOffset..endOffset)` in `source` (LF-normalised).
 * `endOffset` is exclusive — the same convention `String.slice`
 * uses. The caller is expected to have LF-normalised the source
 * already (or use `buildQuoteFromLines`, which does it).
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

/** Drop a single trailing `\n` from the range so the quote's
 * `exact` doesn't include the line terminator. `startOffset` is a
 * floor — an empty range never rolls back below its start. */
function trimTrailingNewline(source: string, startOffset: number, endOffset: number): number {
  if (endOffset > startOffset && source.charCodeAt(endOffset - 1) === 0x0a /* \n */) {
    return endOffset - 1;
  }
  return endOffset;
}

/** Backwards-compat re-export — some earlier tests imported
 * `lineStartsOf` from this module. The reanchor engine's
 * `buildLineStartIndex` is the one to use going forward. */
export { buildLineStartIndex as lineStartsOf } from "./reanchor.ts";
