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
// **Two contracts, one geometry (issue #113, PR #124 round 2).**
// `buildQuoteFromLines` is total: it clamps a range that overruns the
// file. `buildQuoteForComment` is not, because the two have callers
// with different standing. The adapter's range came from a diff hunk it
// matched itself, so a small overrun should degrade rather than throw.
// A COMMENT's range came from a `data-src` stamp in a built page, and
// the quote taken from it is compared against the file for the life of
// the thread — clamping there stored the last paragraph's text as the
// quote for lines that do not exist, which the engine then reported as
// a successful `move` onto that paragraph. So the create path refuses,
// with a reason, and shares the line geometry with the total path
// rather than a second copy of it.
//
// Runtime-neutral: no `node:*` / `bun:*` imports.

import type { TextQuote } from "./anchor.ts";
import {
  buildLineStartIndex,
  DEFAULT_ANCHOR_CONTEXT_CHARS,
  lineToOffset,
  toLF,
} from "./reanchor.ts";
import {
  findFolded,
  foldSourcePlain,
  foldedHasHitFrom,
  foldTypographyLoose,
} from "./typography.ts";

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
 * **This clamping is safe here and NOT on the comment-create path.**
 * This function's callers own a line range that is already trusted to
 * name something in this content — the GitHub adapter reads it from a
 * diff hunk it matched itself — so a range that overruns the file
 * degrades to the nearest text rather than failing. For a COMMENT, the
 * range comes from the `data-src` stamp in a built page and the daemon
 * is slicing a quote that will be compared against the file for years;
 * clamping there stores a different paragraph's text and then reports
 * `moved` onto it (issue #113, PR #124 round 2). `buildQuoteForComment`
 * is the refusing variant, and it is the one the create path uses.
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
 * **A quote is cut from the anchored block, or there is no quote**
 * (issue #113, PR #124 round 2 — the review BLOCKER). This function
 * therefore REFUSES rather than inventing one, and says why:
 *
 * - `range-past-eof` — the anchor's line range does not exist in the
 *   source. Line numbers come from the `data-src` stamps in the BUILT
 *   page, so the ordinary cause is a stale build: the file shrank
 *   after the page was built. Clamping the range to EOF (what this did
 *   before) stores a DIFFERENT paragraph's text as the quote, and the
 *   engine then reports `moved` onto that paragraph — a silent wrong
 *   anchor, where the pre-#113 code reported `orphaned` honestly.
 * - `empty-range` — the range exists but holds no text (the empty last
 *   line a trailing newline creates). A different fact, with a
 *   different reason.
 * - `hint-not-found` — a `selectionHint` was sent and matches nothing
 *   in the range. The hint is the reviewer's rendered selection, so a
 *   hint the source does not contain means the page is not describing
 *   the file the daemon just read. Widening to the whole range stored
 *   text the reviewer never selected, on an anchor they can no longer
 *   trust.
 *
 * `selectionHint` narrows the quote to a span rather than taking the
 * whole line range. The narrowing searches the SOURCE slice, not the
 * needle, and stores the source bytes it lands on — so the needle can
 * only ever change WHICH source span is quoted, never WHAT is quoted.
 * Two needles are handled without guessing: one that matches more than
 * once widens to the whole block (a coarse but truthful anchor, and the
 * block IS what the reviewer commented on — see the ambiguity note
 * below), and one that matches nothing is refused.
 *
 * Returns a `QuoteBuild` rather than a `TextQuote`: the caller is a
 * request handler that has to turn a refusal into a response, and a
 * refusal that still carried a quote would be one refactor away from
 * being stored.
 */
export function buildQuoteForComment(
  source: string,
  startLine: number,
  endLine: number,
  selectionHint?: string,
  options: BuildQuoteOptions = {},
): QuoteBuild {
  const lf = toLF(source);
  const index = buildLineStartIndex(lf);
  const totalLines = index.length;
  // NO clamping on this path (issue #113, PR #124 round 2). A range past
  // the end of the file describes nothing, and the text nearest to its
  // end belongs to a block the reviewer never read. `buildQuoteFromLines`
  // above keeps clamping for the callers whose contract is total — see
  // its note.
  if (startLine > totalLines || endLine > totalLines) {
    return { ok: false, reason: "range-past-eof", totalLines };
  }
  const start = Math.max(1, startLine);
  const end = Math.max(start, endLine);
  const blockStart = lineToOffset(index, start);
  const blockEnd =
    end + 1 > totalLines ? lf.length : trimTrailingNewline(lf, blockStart, lineToOffset(index, end + 1));
  const wholeRange = buildQuoteFromOffsets(lf, blockStart, blockEnd, options);
  if (wholeRange.exact.length === 0) return { ok: false, reason: "empty-range", totalLines };

  const hint = selectionHint?.trim();
  if (hint === undefined || hint.length === 0) return { ok: true, quote: wholeRange };
  // Search the range's PLAIN-TEXT projection — the text the rendered
  // page shows, which is what `selection.toString()` reports. Three
  // projections are stacked here, and each exists because the browser's
  // text differs from the source in that way:
  //
  //   typographic fold — `“hi”` is not a substring of the source `"hi"`
  //   collapsed runs   — a markdown soft break is a newline in the
  //                      source and a collapsed space on the page
  //   markup stripped  — a reviewer selecting `really` out of
  //                      `**really**`, or `the docs` out of
  //                      `[the docs](url)`, sends text the source does
  //                      not contain. Searching raw source refused
  //                      those (issue #113, PR #124 round 3 — the
  //                      round-2 BLOCKER NB2), on the most ordinary
  //                      selections there are.
  const blockPlain = foldSourcePlain(wholeRange.exact);
  const foldedHint = foldTypographyLoose(hint);
  // A needle with no resolvable form (a selection that is only
  // backticks, say) is a needle no plain text can contain. Refusing is
  // the honest answer; treating it as absent would store the block for
  // a selection we cannot read.
  if (foldedHint.length === 0) return { ok: false, reason: "hint-not-found", totalLines };
  const hit = findFolded(blockPlain, foldedHint);
  if (hit === null) return { ok: false, reason: "hint-not-found", totalLines };
  if (foldedHasHitFrom(blockPlain, foldedHint, hit.foldedAt + foldedHint.length)) {
    // Ambiguous — the reviewer selected text that occurs twice in the
    // block and the rendered hint cannot say which. Quote the whole
    // line range. This is the reviewer's OWN block: the anchor is
    // coarser than their selection, but every byte of it is source
    // text they commented on. Widening is right here and refused above,
    // and the difference is exactly whether the stored text comes from
    // inside the block the reviewer addressed.
    return { ok: true, quote: wholeRange };
  }
  // Map the hit back to source offsets and KEEP IT ONLY IF the mapped
  // span's own plain text is the selection. That is the precision test
  // (issue #113, PR #124 round 3): when markup sits inside the span,
  // the source between the two boundaries holds characters the rendered
  // page never showed — `**`, a link target — and quoting it would
  // store text the reviewer did not select, which is the failure this
  // whole path exists to prevent. When the span straddles markup, widen
  // to the block's full source range: honest and coarse beats precise
  // and wrong.
  const sourceStart = blockStart + hit.start;
  const sourceEnd = blockStart + hit.end;
  const mapped = lf.slice(sourceStart, sourceEnd);
  if (sourceEnd <= sourceStart || foldSourcePlain(mapped).text !== foldedHint) {
    return { ok: true, quote: wholeRange };
  }
  return { ok: true, quote: buildQuoteFromOffsets(lf, sourceStart, sourceEnd, options) };
}

/** Why `buildQuoteForComment` produced no quote. Carried to the caller so
 * the refusal can name the cause instead of reporting a generic failure. */
export type QuoteRefusal = "range-past-eof" | "empty-range" | "hint-not-found";

/** The outcome of `buildQuoteForComment`: a quote cut from the anchored
 * block, or a refusal that names its cause. `totalLines` is the number of
 * lines the source actually has, which is what a caller needs to tell a
 * reviewer how far off the anchor was. */
export type QuoteBuild =
  | { readonly ok: true; readonly quote: TextQuote }
  | {
      readonly ok: false;
      readonly reason: QuoteRefusal;
      readonly totalLines: number;
    };


/** Backwards-compat re-export — some earlier tests imported
 * `lineStartsOf` from this module. The reanchor engine's
 * `buildLineStartIndex` is the one to use going forward. */
export { buildLineStartIndex as lineStartsOf } from "./reanchor.ts";
