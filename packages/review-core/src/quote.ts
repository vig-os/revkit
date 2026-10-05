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
// **Provenance: the source is the authority (ADR-0006 amendment,
// issue #113).** Every quote this module produces is a slice of the
// source it was handed. `buildQuoteForComment` is the entry point for
// a comment created from a rendered page: the reviewer picks a span in
// the DOM, and the daemon resolves that pick against the file rather
// than trusting the browser's copy of the text. The browser's copy is
// not the source — this repo's pipeline runs `remark-smartypants`, so
// a rendered paragraph differs from its source line on ~43 % of
// blocks — and a quote built from it orphaned on the first edit even
// when the commented paragraph was byte-identical.
//
// Runtime-neutral: no `node:*` / `bun:*` imports.

import type { TextQuote } from "./anchor.ts";
import {
  buildLineStartIndex,
  DEFAULT_ANCHOR_CONTEXT_CHARS,
  lineToOffset,
  toLF,
} from "./reanchor.ts";
import { findFolded, foldSource, foldedHasHitFrom, foldTypography } from "./typography.ts";

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

/**
 * Build the `TextQuote` a comment on `startLine..endLine` should
 * carry, from the SOURCE — never from a client-supplied string.
 *
 * **This is the quote-provenance rule (ADR-0006 amendment, issue
 * #113).** `anchor.quote` is the record of which source text a comment
 * addresses, and the re-anchoring engine compares it against source
 * bytes, so the only text allowed to become that record is text read
 * out of the file. A client that sends its own quote is sending text
 * it read off a RENDERED page, which this repo's markdown pipeline
 * makes different from the source on ~43 % of blocks
 * (`remark-smartypants`: `"` → `“ ”`, `--` → `—`, `...` → `…`), and
 * such a quote orphaned on the first edit even when the commented
 * paragraph was byte-identical.
 *
 * `selectionHint` is a needle that narrows the quote to a span rather
 * than taking the whole line range — the reviewer's selected RENDERED
 * text, or (from a client that sends no `selectionHint`) the `exact` of
 * a quote it already carries. The narrowing searches the SOURCE slice,
 * not the needle, and stores the source bytes it lands on — so the
 * needle can only ever change WHICH source span is quoted, never WHAT
 * is quoted. Two cases fall back to the whole line range rather than
 * guessing: the needle matches nothing in the range, and the needle
 * matches more than once (the client cannot say which span it meant).
 * A wrong span is worse than a wide one.
 *
 * Returns the same quote as `buildQuoteFromLines` when no usable hint
 * is given, so a caller with nothing to narrow by gets identical bytes.
 */
export function buildQuoteForComment(
  source: string,
  startLine: number,
  endLine: number,
  selectionHint?: string,
  options: BuildQuoteOptions = {},
): TextQuote {
  const lf = toLF(source);
  const index = buildLineStartIndex(lf);
  const wholeRange = buildQuoteFromLines(lf, startLine, endLine, options);
  const hint = selectionHint?.trim();
  if (hint === undefined || hint.length === 0) return wholeRange;
  // Search the folded form of the SOURCE slice. Folding is what lets a
  // rendered hint match its source counterpart (`“hi”` is not a
  // substring of `"hi"`), and the hit is mapped back to source offsets
  // so the stored `exact` is source text — with its backticks, its
  // `--`, its `...`.
  const blockFolded = foldSource(wholeRange.exact);
  const foldedHint = foldTypography(hint);
  if (foldedHint.length === 0) return wholeRange;
  const hit = findFolded(blockFolded, foldedHint);
  if (hit === null) return wholeRange;
  if (foldedHasHitFrom(blockFolded, foldedHint, hit.foldedAt + foldedHint.length)) {
    // Ambiguous — the reviewer selected text that occurs twice in the
    // range and the rendered hint cannot say which one. Quote the
    // whole line range; the anchor is still correct, just wider.
    return wholeRange;
  }
  // `wholeRange.exact` is the source from the start of `startLine`
  // (clamped to the file by `buildQuoteFromLines`), so its hits are
  // relative to `lineToOffset(index, clampedStart)`.
  const blockStart = lineToOffset(index, Math.max(1, Math.min(startLine, Math.max(1, index.length))));
  return buildQuoteFromOffsets(lf, blockStart + hit.start, blockStart + hit.end, options);
}

/** Backwards-compat re-export — some earlier tests imported
 * `lineStartsOf` from this module. The reanchor engine's
 * `buildLineStartIndex` is the one to use going forward. */
export { buildLineStartIndex as lineStartsOf } from "./reanchor.ts";
