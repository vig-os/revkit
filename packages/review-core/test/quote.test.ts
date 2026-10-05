// Tests for `buildQuoteFromLines` / `buildQuoteFromOffsets` — the
// one-source-of-truth quote builder for anchors (ADR-0006).
//
// PR-43 round-4 fix: quote.ts now uses the reanchor engine's
// `buildLineStartIndex` (LF-only) and its 32-char context, so
// producers and the reanchor engine cut identical windows and
// CRLF sources round-trip without spurious orphaning.

import { describe, expect, test } from "bun:test";
import {
  buildQuoteForComment,
  buildQuoteFromLines,
  buildQuoteFromOffsets,
  DEFAULT_QUOTE_CONTEXT_CHARS,
  lineStartsOf,
  type QuoteBuild,
  type QuoteRefusal,
} from "../src/quote.ts";
import { foldSourcePlain, foldTypographyLoose } from "../src/typography.ts";
import {
  anchorSchema,
  DEFAULT_ANCHOR_CONTEXT_CHARS,
  prepareReanchor,
  reanchorWith,
  revisionOf,
} from "../src/index.ts";

describe("lineStartsOf (re-export of buildLineStartIndex — LF only)", () => {
  test("empty source has one start at 0", () => {
    // `buildLineStartIndex("")` returns `[0]` — one line starting at
    // 0, no sentinel. The reanchor engine's O(log n) `offsetToLine`
    // reads this shape.
    expect(lineStartsOf("")).toEqual([0]);
  });

  test("no terminator counts as one line (no sentinel)", () => {
    expect(lineStartsOf("hello")).toEqual([0]);
  });

  test("LF terminates lines; each start is past its \\n", () => {
    expect(lineStartsOf("a\nb\nc\n")).toEqual([0, 2, 4, 6]);
  });
});

describe("buildQuoteFromLines (LF-normalised)", () => {
  const SOURCE = "alpha\nbeta\ngamma\ndelta\nepsilon\n";

  test("single-line range: exact is the line body without terminator", () => {
    const q = buildQuoteFromLines(SOURCE, 2, 2);
    expect(q.exact).toBe("beta");
    // Prefix ends at start of line 2; default context 32 chars, so
    // "alpha\n" fits comfortably.
    expect(q.prefix).toBe("alpha\n");
    expect(q.suffix.startsWith("\ngamma")).toBe(true);
  });

  test("multi-line range: exact spans body + inner LF, no trailing terminator", () => {
    const q = buildQuoteFromLines(SOURCE, 2, 4);
    expect(q.exact).toBe("beta\ngamma\ndelta");
    expect(q.prefix).toBe("alpha\n");
    expect(q.suffix).toBe("\nepsilon\n");
  });

  test("first line: prefix is empty", () => {
    const q = buildQuoteFromLines(SOURCE, 1, 1);
    expect(q.prefix).toBe("");
    expect(q.exact).toBe("alpha");
  });

  test("last line with no trailing newline: exact runs to EOF", () => {
    const s = "a\nb\nc";
    const q = buildQuoteFromLines(s, 3, 3);
    expect(q.exact).toBe("c");
    expect(q.suffix).toBe("");
  });

  test("CRLF source is LF-normalised; exact contains no \\r", () => {
    // PR-43 round-4 nit: a CRLF fixture used to keep `\r` in `exact`,
    // and the reanchor engine (LF-only) would then fail to find it.
    // The producer now LF-normalises, so `exact` is `two\nthree`
    // and matches head content when the engine looks for it.
    const s = "one\r\ntwo\r\nthree\r\n";
    const q = buildQuoteFromLines(s, 2, 3);
    expect(q.exact).toBe("two\nthree");
    expect(q.exact).not.toContain("\r");
    expect(q.prefix).toBe("one\n");
    expect(q.prefix).not.toContain("\r");
    expect(q.suffix).not.toContain("\r");
  });

  test("CRLF multi-line quote re-anchors unchanged through the engine", async () => {
    // A CRLF fixture ends up as an LF quote. If the head source is
    // unchanged, the pipeline's identity short-circuit accepts it
    // (revisionOf both is the same LF-normalised hash).
    const source = "keep 1\r\nkeep 2\r\ntarget line\r\nkeep 3\r\nkeep 4\r\n";
    const quote = buildQuoteFromLines(source, 3, 3);
    const revision = await revisionOf(source);
    const anchor = anchorSchema.parse({
      path: "docs/x.mdx",
      startLine: 3,
      endLine: 3,
      quote,
      revision,
    });
    // Same source → identity short-circuit; result must be
    // `anchored` with method `unchanged` and the returned anchor
    // unchanged.
    const ctx = await prepareReanchor(source, source);
    const result = await reanchorWith(ctx, anchor);
    expect(result.kind).toBe("anchored");
    if (result.kind !== "anchored") throw new Error("unreachable");
    expect(result.method).toBe("unchanged");
    expect(result.anchor.quote.exact).toBe(quote.exact);
  });

  test("contextChars can be tuned", () => {
    const q = buildQuoteFromLines(SOURCE, 3, 3, { contextChars: 3 });
    expect(q.exact).toBe("gamma");
    expect(q.prefix.length).toBe(3);
    expect(q.suffix.length).toBe(3);
    expect(q.prefix).toBe("ta\n");
    expect(q.suffix).toBe("\nde");
  });

  test("default context is DEFAULT_QUOTE_CONTEXT_CHARS (matches the reanchor engine's 32)", () => {
    expect(DEFAULT_QUOTE_CONTEXT_CHARS).toBe(DEFAULT_ANCHOR_CONTEXT_CHARS);
    expect(DEFAULT_QUOTE_CONTEXT_CHARS).toBe(32);
    const filler = "x".repeat(200);
    const s = `${filler}\ntarget\n${filler}\n`;
    const q = buildQuoteFromLines(s, 2, 2);
    expect(q.exact).toBe("target");
    expect(q.prefix.length).toBe(DEFAULT_QUOTE_CONTEXT_CHARS);
    expect(q.suffix.length).toBe(DEFAULT_QUOTE_CONTEXT_CHARS);
  });

  test("out-of-range end clamps to file end (no throw)", () => {
    const q = buildQuoteFromLines(SOURCE, 3, 999);
    expect(q.exact).toBe("gamma\ndelta\nepsilon");
  });

  test("inverted range is normalised (end < start becomes start..start)", () => {
    const q = buildQuoteFromLines(SOURCE, 3, 2);
    expect(q.exact).toBe("gamma");
  });
});

describe("buildQuoteFromOffsets", () => {
  test("returns prefix/exact/suffix at the given char offsets", () => {
    const s = "0123456789abcdef";
    const q = buildQuoteFromOffsets(s, 5, 10, { contextChars: 3 });
    expect(q.exact).toBe("56789");
    expect(q.prefix).toBe("234");
    expect(q.suffix).toBe("abc");
  });

  test("clamps offsets to source bounds", () => {
    const s = "abc";
    const q = buildQuoteFromOffsets(s, -5, 999);
    expect(q.prefix).toBe("");
    expect(q.exact).toBe("abc");
    expect(q.suffix).toBe("");
  });
});

// ---------------------------------------------------------------------------
// PR #124 round 2, review BLOCKER B1: `buildQuoteForComment` CLAMPED a line
// range past EOF and stored the last paragraph's text as the comment's quote.
//
// The falsifier's probe: a 19-line source with no trailing newline, an anchor
// of L40-41, and the quote comes back as line 19's paragraph. An unrelated edit
// later makes the engine report `moved` onto that paragraph — a silent wrong
// anchor where the pre-#113 code reported `orphaned` honestly. The same root
// also widened a hint that matched nothing to the whole range, storing text the
// reviewer never selected.
//
// Both are refusals now. A quote is either source text from the anchored block,
// or there is no quote.
// ---------------------------------------------------------------------------

/** Assert a refusal and its reason. `toEqual` on the whole result widens
 * `reason` to `string`, which no longer matches the union — and checking
 * `ok` and `reason` separately states the property anyway: a refusal
 * carries no quote. */
function expectRefusal(result: QuoteBuild, reason: QuoteRefusal): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a refusal, got a quote");
  expect(result.reason).toBe(reason);
}

describe("buildQuoteForComment — refuses rather than inventing a quote (B1)", () => {
  const para = (n: number): string => `Paragraph ${n}: the quick brown fox jumps over the lazy dog.`;
  /** 19 lines, NO trailing newline — the falsifier's exact shape. */
  const NO_TRAILING_NL = Array.from({ length: 19 }, (_, i) => para(i + 1)).join("\n");
  /** The same 19 lines WITH a trailing newline, which adds an empty 20th. */
  const TRAILING_NL = `${NO_TRAILING_NL}\n`;

  test("the fixture is the falsifier's: 19 lines, and a clamped L40-41 reads line 19", () => {
    // The premise, asserted so the refusal below cannot pass vacuously.
    expect(NO_TRAILING_NL.split("\n")).toHaveLength(19);
    expect(buildQuoteFromLines(NO_TRAILING_NL, 40, 41).exact).toBe(para(19));
  });

  test("a range past EOF is REFUSED, never clamped to the last paragraph", () => {
    const result = buildQuoteForComment(NO_TRAILING_NL, 40, 41);
    expectRefusal(result, "range-past-eof");
    // The harm, named: there is no quote at all, so no paragraph's text
    // can reach the log from a range that does not exist.
    expect("quote" in result).toBe(false);
  });

  test("the SAME range on a file WITH a trailing newline is refused identically", () => {
    // The two shapes disagreed: with a trailing newline the clamp produced an
    // EMPTY exact, which sent the daemon down its client-quote fallback, so the
    // same stale build stored two different wrong things depending on the last
    // byte of the file.
    const result = buildQuoteForComment(TRAILING_NL, 40, 41);
    expectRefusal(result, "range-past-eof");
  });

  test("an endLine past EOF is refused too", () => {
    expectRefusal(buildQuoteForComment(NO_TRAILING_NL, 18, 40), "range-past-eof");
  });

  test("the last real line is still quoted — the refusal is not over-broad", () => {
    const result = buildQuoteForComment(NO_TRAILING_NL, 19, 19);
    if (!result.ok) throw new Error(`expected the last line to quote, got ${result.reason}`);
    expect(result.quote.exact).toBe(para(19));
  });

  test("a range that is IN bounds but holds no text is `empty-range`, not a clamp", () => {
    // Line 20 of the trailing-newline file exists and is empty. That is a
    // different fact from "line 40 does not exist", and it must read
    // differently in the reason.
    const result = buildQuoteForComment(TRAILING_NL, 20, 20);
    expectRefusal(result, "empty-range");
  });

  test("a hint that matches NOTHING in the range is a stale-build signal, not a widened quote", () => {
    const result = buildQuoteForComment(NO_TRAILING_NL, 1, 1, "text that is not on line one");
    expectRefusal(result, "hint-not-found");
  });

  test("a refusal carries no quote at all — nothing can be stored from it", () => {
    // Structural, so a future refactor cannot smuggle a quote through a
    // refusal by adding the field.
    const result = buildQuoteForComment(NO_TRAILING_NL, 1, 1, "nowhere in the file");
    expect("quote" in result).toBe(false);
  });

  test("a hint that FOLDS to nothing is refused rather than treated as absent", () => {
    // A needle that survives folding is a needle the source should contain.
    // A backtick is deleted by the fold, so this hint has no resolvable form
    // at all — and widening would store the whole block for a selection whose
    // text nobody can read.
    const result = buildQuoteForComment(NO_TRAILING_NL, 1, 1, "`");
    expectRefusal(result, "hint-not-found");
  });

  test("a selection spanning a SOFT BREAK resolves to its own span, not the whole block", () => {
    // The rendered text of a two-line selection inside one paragraph joins the
    // lines with a space (CSS collapses the soft break); the source holds a
    // newline. Before the whitespace-tolerant fold this hint matched nothing
    // and widened to all three lines — which, once an unresolvable hint became
    // a refusal, would have turned a routine selection into a 400.
    const block = "first line of the pair\nsecond line of the pair\nthird line of the block";
    const result = buildQuoteForComment(block, 1, 3, "first line of the pair second line of the pair");
    if (!result.ok) throw new Error(`expected the soft-break hint to resolve, got ${result.reason}`);
    expect(result.quote.exact).toBe("first line of the pair\nsecond line of the pair");
    expect(result.quote.exact).not.toBe(block);
  });

  test("a hint with a trailing newline (what the DOM actually reports) resolves", () => {
    const block = "alpha line\nbeta line\ngamma line";
    const result = buildQuoteForComment(block, 1, 3, "alpha line\nbeta line");
    if (!result.ok) throw new Error(`expected the hint to resolve, got ${result.reason}`);
    expect(result.quote.exact).toBe("alpha line\nbeta line");
  });

  test("an AMBIGUOUS hint still widens to the block — the reviewer's own block", () => {
    // Deliberately different from an unresolvable hint: we know WHICH block the
    // reviewer commented on and cannot tell which of two identical spans they
    // picked, so the anchor is coarse but truthful. Nothing outside the block
    // is ever stored.
    const block = "repeated phrase here and repeated phrase here";
    const result = buildQuoteForComment(block, 1, 1, "repeated phrase");
    if (!result.ok) throw new Error(`expected a wide quote, got ${result.reason}`);
    expect(result.quote.exact).toBe(block);
  });

  test("no hint at all still quotes the whole range", () => {
    const result = buildQuoteForComment(NO_TRAILING_NL, 3, 3);
    if (!result.ok) throw new Error(`expected the range to quote, got ${result.reason}`);
    expect(result.quote.exact).toBe(para(3));
  });
});

// ---------------------------------------------------------------------------
// PR #124 round 3 — the two new blockers.
//
// NB1: `foldScan`'s loose-mode length pass subtracted collapsed whitespace but
// never added substitution GROWTH, so on any source holding `—` or `…` the
// offset maps came out short, out-of-range writes were dropped, `findFolded`
// read `?? 0`, and a valid selection came back as `exact: ""` — then a 400
// with a misleading cause. ASCII-only fixtures cannot see it.
//
// NB2: the rail sends `selection.toString()`, which is the RENDERED text. A
// reviewer selecting `really` out of `**really**` sends a hint that is not a
// substring of the source, so matching against raw source refused the most
// ordinary selections there are with "reload the page".
// ---------------------------------------------------------------------------

describe("buildQuoteForComment — non-ASCII source (NB1)", () => {
  // The falsifier's exact fixture: two em dashes, each of which EXPANDS to
  // `--` under the fold, so the map is two characters short when pass 1
  // forgets the growth.
  const DASHES = "We decided — after much debate — to ship the release tomorrow.\n";
  const ELLIPSIS = "Wait… we agreed to ship the release tomorrow.\n";

  test("the fixture really does expand: the fold is LONGER than its source", () => {
    // Without this the fixtures below would be vacuous — an implementation
    // that ignored the substitutions entirely would pass them.
    const folded = foldSourcePlain(DASHES);
    expect(folded.text.length).toBeGreaterThan(DASHES.length);
    expect(folded.text).toContain("We decided -- after much debate --");
  });

  test("the offset maps are as long as the folded text — the NB1 invariant", () => {
    // The shape of the bug: `starts` / `ends` sized by one pass and filled
    // by another. Asserting the lengths agree catches any drift, whatever
    // caused it.
    for (const source of [DASHES, ELLIPSIS, "plain ascii line\n"]) {
      const folded = foldSourcePlain(source);
      expect(folded.starts.length).toBe(folded.text.length);
      expect(folded.ends.length).toBe(folded.text.length);
    }
  });

  test("a selection on a dash-bearing line resolves to its own span", () => {
    // THE repro. On the pre-fix head this returned `exact: ""`.
    const result = buildQuoteForComment(DASHES, 1, 1, "release tomorrow");
    if (!result.ok) throw new Error(`expected a quote, got ${result.reason}`);
    expect(result.quote.exact).toBe("release tomorrow");
  });

  test("a selection on an ellipsis-bearing line resolves too", () => {
    const result = buildQuoteForComment(ELLIPSIS, 1, 1, "release tomorrow");
    if (!result.ok) throw new Error(`expected a quote, got ${result.reason}`);
    expect(result.quote.exact).toBe("release tomorrow");
  });

  test("every character of a folded hit maps to a real source offset", () => {
    // The falsifier's `ends[lastAt] ?? 0` fallback: an out-of-range map read
    // as offset 0, which is how a valid hit became an empty span. Asserting
    // the whole map is in range is the general form.
    const folded = foldSourcePlain(DASHES);
    for (let i = 0; i < folded.text.length; i += 1) {
      expect(folded.starts[i]).toBeGreaterThanOrEqual(0);
      expect(folded.starts[i]).toBeLessThanOrEqual(DASHES.length);
      expect(folded.ends[i]).toBeGreaterThanOrEqual(0);
      expect(folded.ends[i]).toBeLessThanOrEqual(DASHES.length);
    }
  });

  test("a dash-bearing line still refuses a hint that is genuinely absent", () => {
    // The fix must not turn every non-ASCII block into a match.
    expectRefusal(buildQuoteForComment(DASHES, 1, 1, "not in this line"), "hint-not-found");
  });
});

describe("buildQuoteForComment — hints over inline markup (NB2)", () => {
  /** Assert the hint resolves, and that the stored `exact` is source text
   * whose PLAIN projection is the hint — the property that says the anchor
   * is the selection without claiming to be byte-identical to the rendered
   * text. */
  function expectSelectionOn(source: string, hint: string, expected: string): void {
    const lines = source.split("\n").length - 1;
    const result = buildQuoteForComment(source, 1, lines, hint);
    if (!result.ok) throw new Error(`expected "${hint}" to resolve, got ${result.reason}`);
    expect(result.quote.exact).toBe(expected);
    expect(foldSourcePlain(result.quote.exact).text.trim()).toBe(
      foldTypographyLoose(hint).trim(),
    );
    // The provenance property from ADR-0006: source bytes, always.
    expect(source).toContain(result.quote.exact);
  }

  // The hints below are PHRASES a reviewer dragged across, not words that
  // happen to sit inside the delimiters: `really` alone is a substring of
  // `**really**`, so it resolves on raw source by luck, while `were really
  // happy` — what a drag actually reports — is not.
  test("BOLD: a selection crossing **really** anchors the source span", () => {
    expectSelectionOn(
      "We were **really** happy about it.\n",
      "were really happy",
      "were **really** happy",
    );
  });

  test("ITALIC: a selection crossing *really* anchors the source span", () => {
    expectSelectionOn("We were *really* happy about it.\n", "were really happy", "were *really* happy");
  });

  test("a LINK: a selection crossing the label anchors source, not just the label", () => {
    expectSelectionOn(
      "Read [the docs](https://example.com/x) today.\n",
      "Read the docs today",
      "Read [the docs](https://example.com/x) today",
    );
  });

  test("a LINK: selecting only the label still anchors just the label", () => {
    // The narrow case: the label alone is a substring of the source, so it
    // resolved before NB2 was fixed. Asserted so the plain-text path does
    // not start over-widening where a tight span was available.
    expectSelectionOn("Read [the docs](https://example.com/x) today.\n", "the docs", "the docs");
  });

  test("INLINE CODE: a selection crossing `gh pr list` anchors the source span", () => {
    // The backtick was already in `FOLD` from round 1, so this one resolved
    // before NB2 — measured, not assumed, and kept so a change to the table
    // that broke it would show here.
    expectSelectionOn("Run `gh pr list` now.\n", "Run gh pr list now", "Run `gh pr list` now");
  });

  test("a LIST: a selection spanning two items anchors both items' source", () => {
    // Rendered as two bullets; `textContent` has no `- `, so the hint is
    // `alpha item beta item` across a soft break.
    expectSelectionOn("- alpha item\n- beta item\n", "alpha item beta item", "alpha item\n- beta item");
  });

  test("a LIST: a selection of one item anchors just that item", () => {
    expectSelectionOn("- alpha item\n- beta item\n", "alpha item", "alpha item");
  });

  test("a SOFT BREAK: a two-line selection still resolves (round 2's case)", () => {
    expectSelectionOn(
      "first line of the pair\nsecond line of the pair\n",
      "first line of the pair second line of the pair",
      "first line of the pair\nsecond line of the pair",
    );
  });

  test("SMART PUNCTUATION: a selection inside a rendered quote anchors the source span", () => {
    // `“hi”` in the page, `"hi"` in the source.
    expectSelectionOn('He said "hi" -- ok... (c) 2026\n', "hi", "hi");
  });

  test("a BLOCKQUOTE: the `>` marker is not part of the selection", () => {
    expectSelectionOn("> quoted words here\n", "quoted words here", "quoted words here");
  });

  test("an ORDERED list item: the `1.` marker is not part of the selection", () => {
    expectSelectionOn("1. first thing\n", "first thing", "first thing");
  });

  test("an IMAGE: the `!` is stripped but the alt text is kept", () => {
    expectSelectionOn("Look ![a diagram](d.png) here\n", "a diagram", "a diagram");
  });

  test("a heading: the `#` run is not part of the selection", () => {
    expectSelectionOn("## A heading\n", "A heading", "A heading");
  });

  test("intra-word underscores are NOT markup — snake_case stays whole", () => {
    // CommonMark: `_` between word characters is literal. Stripping it would
    // invent an equivalence the renderer does not have — the same rule that
    // keeps `---` out of `FOLD`.
    expectSelectionOn("The snake_case_name stays.\n", "snake_case_name", "snake_case_name");
  });

  test("a hyphen in prose is NOT a list marker", () => {
    expectSelectionOn("A well-known fact -- truly.\n", "well-known fact", "well-known fact");
  });

  test("a selection that STRADDLES markup anchors a real slice, boundaries mid-markup", () => {
    // CORRECTED in round 4. This test previously said "widens to the block",
    // and round 3's code did try to do that — by re-projecting the mapped
    // span and widening when the projection differed. That check was wrong:
    // projecting a span in isolation loses what makes markup recognisable
    // (the `]` of `[the docs](url)` is a link close in the block and a bare
    // bracket in the slice), so it widened on hits that mapped perfectly
    // well. It is gone, and the outcome is a real source slice whose
    // boundaries fall inside the markup.
    const result = buildQuoteForComment(
      "Read [the docs](https://example.com/x) today.\n",
      1,
      1,
      "Read the docs",
    );
    if (!result.ok) throw new Error(`expected a quote, got ${result.reason}`);
    expect(result.quote.exact).toBe("Read [the docs");
    expect("Read [the docs](https://example.com/x) today.\n").toContain(result.quote.exact);
    // Coarse, but honest: source text, inside the block the reviewer
    // addressed, and therefore matchable by the engine — which compares
    // quotes against SOURCE bytes through the typographic fold, so the
    // stray `[` costs it nothing.
    expect("Read [the docs](https://example.com/x) today.\n").toContain(result.quote.exact);
    // Note what is deliberately NOT asserted: that this slice projects back to
    // the selection. It does not — projecting `Read [the docs` in isolation
    // leaves the `[`, because a bracket only reads as a link when a target
    // follows it. That is the whole reason the round-3 re-projection check
    // was removed: it widened on hits that map correctly.
  });

  test("the stale-build refusal SURVIVES markup stripping", () => {
    // NB2's fix must not become a way to store anything: a hint that is in
    // neither the source nor the range's rendered text is still a 400.
    expectRefusal(
      buildQuoteForComment("We were **really** happy.\n", 1, 1, "text from a different page"),
      "hint-not-found",
    );
  });

  test("markup does not make a hint matchable that spans OUTSIDE the range", () => {
    // The strip is per-range, so text from another block cannot leak in.
    const source = "First **block** here.\n\nSecond *block* there.\n";
    expectRefusal(buildQuoteForComment(source, 1, 1, "Second"), "hint-not-found");
  });
});

// ---------------------------------------------------------------------------
// PR #124 round 4 — the full probe table from the review, every row a test.
//
// BLOCKER: round 3's `markupDelimiterAt` stripped markers ANYWHERE in a line,
// so ordinary prose lost its `!`, `>`, `+`, `.` and brackets. "Ship it!",
// "x > 0", "1 + 1 = 2", "shipped in 2024. Then" and "[sic]" all became
// `hint-not-found` — a regression against round 2, which matched them against
// raw source. The fix gates each marker on where it can be markup:
// `!` only before `[`, block markers only at the start of a line.
//
// Expected outcomes below are the review's own classification:
//   `precise`      — anchors a source slice for the selection
//   `slice`        — a real source slice whose boundaries fall inside markup
//   `widened`      — the documented ambiguity rule (the text occurs twice)
//   `400`          — refused; the rows the review marks acceptable, plus the
//                    two constructs a delimiter scanner does not model
// Every row asserts the STORED text, not merely that it did not 400, so a
// change that starts returning a DIFFERENT wrong slice fails here.
// ---------------------------------------------------------------------------

type Outcome =
  | { readonly kind: "precise" | "slice"; readonly exact: string }
  | { readonly kind: "widened" }
  | { readonly kind: "refused"; readonly reason: QuoteRefusal };

interface ProbeRow {
  readonly name: string;
  readonly source: string;
  readonly hint: string;
  readonly endLine?: number;
  readonly outcome: Outcome;
}

/** `precise`/`slice`: the stored span. `widened`: the block's whole range.
 * `refused`: the reason, so a change that 400s for a different cause fails. */
function assertOutcome(row: ProbeRow): void {
  const result = buildQuoteForComment(row.source, 1, row.endLine ?? 1, row.hint);
  if (row.outcome.kind === "refused") {
    expectRefusal(result, row.outcome.reason);
    return;
  }
  if (!result.ok) {
    throw new Error(`${row.name}: expected ${row.outcome.kind}, got 400 ${result.reason}`);
  }
  if (row.outcome.kind === "widened") {
    expect(result.quote.exact).toBe(row.source.replace(/\n$/, ""));
    return;
  }
  expect(result.quote.exact).toBe(row.outcome.exact);
  // The provenance invariant for every accepted row: source bytes, inside the
  // block the reviewer commented on.
  expect(row.source).toContain(result.quote.exact);
}

/** The review's probe table, verbatim fixtures. Grouped by outcome so a
 * regression points at the class that broke rather than at a line. */
const PROBE_ROWS: readonly ProbeRow[] = [
  // --- NB1's regressions stay closed, including the non-ASCII fixtures the
  // --- round-3 fix was built for. -------------------------------------
  { name: "NB1 falsifier", source: "We decided — after much debate — to ship the release tomorrow.", hint: "release tomorrow", outcome: { kind: "precise", exact: "release tomorrow" } },
  { name: "NB1 ellipsis", source: "Wait… then — finally — “ship” the release tomorrow…", hint: "release tomorrow", outcome: { kind: "precise", exact: "release tomorrow" } },
  { name: "NB1 emoji + CJK", source: "日本語 🎉 — the café’s release tomorrow — done", hint: "café’s release", outcome: { kind: "precise", exact: "café’s release" } },
  { name: "NB1 hint spans a dash", source: "A — B — release tomorrow", hint: "B — release", outcome: { kind: "precise", exact: "B — release" } },

  // --- ordinary markup: a real source slice ----------------------------
  { name: "bold", source: "We were **really** happy today.", hint: "were really happy", outcome: { kind: "precise", exact: "were **really** happy" } },
  { name: "bold inner word", source: "We were **really** happy today.", hint: "really", outcome: { kind: "precise", exact: "really" } },
  // A selection that runs past the closing `*`: the slice ends mid-markup.
  { name: "emphasis, boundary inside the closing star", source: "An *important* point here.", hint: "important point", outcome: { kind: "slice", exact: "important* point" } },
  { name: "inline code", source: "Run `gh pr view` now.", hint: "gh pr view", outcome: { kind: "precise", exact: "gh pr view" } },
  // Boundaries land inside the link's brackets and target.
  { name: "link, boundary inside the closing bracket", source: "See [the docs](https://x.io/a) for more.", hint: "the docs for", outcome: { kind: "slice", exact: "the docs](https://x.io/a) for" } },
  { name: "link label alone", source: "See [the docs](https://x.io/a) for more.", hint: "the docs", outcome: { kind: "precise", exact: "the docs" } },
  { name: "nested emphasis", source: "A **bold *em* bold** end", hint: "bold em bold", outcome: { kind: "slice", exact: "bold *em* bold" } },

  // --- block-level constructs ------------------------------------------
  { name: "list, two items, rendered spaces", source: "- first item\n- second item", hint: "first item second item", endLine: 2, outcome: { kind: "precise", exact: "first item\n- second item" } },
  { name: "list, two items, rendered newline", source: "- first item\n- second item", hint: "first item\nsecond item", endLine: 2, outcome: { kind: "precise", exact: "first item\n- second item" } },
  { name: "soft break", source: "line one ends\nline two starts", hint: "ends line two", endLine: 2, outcome: { kind: "precise", exact: "ends\nline two" } },
  { name: "block quote", source: "> quoted text here", hint: "quoted text", outcome: { kind: "precise", exact: "quoted text" } },
  { name: "ATX heading", source: "# Heading here", hint: "Heading", outcome: { kind: "precise", exact: "Heading" } },
  { name: "ordered list item", source: "1. first thing", hint: "first thing", outcome: { kind: "precise", exact: "first thing" } },

  // --- the review's "precise" cases that are not markup at all ---------
  { name: "link whose label IS the url", source: "Go [https://a.io](https://a.io) now", hint: "https://a.io", outcome: { kind: "precise", exact: "https://a.io" } },
  { name: "snake_case is not emphasis", source: "Call snake_case_name here.", hint: "snake_case_name", outcome: { kind: "precise", exact: "snake_case_name" } },
  { name: "arithmetic asterisks are not emphasis", source: "Compute 2 * 3 * 4 now.", hint: "2 * 3 * 4", outcome: { kind: "precise", exact: "2 * 3 * 4" } },
  { name: "arithmetic, a single factor", source: "Compute 2 * 3 * 4 now.", hint: "3", outcome: { kind: "precise", exact: "3" } },

  // --- THE BLOCKER: prose the round-3 scanner ate ---------------------
  // Each of these was a 400 on round 3 and must be a precise slice now.
  { name: "PROSE: trailing exclamation", source: "Ship it! Then rest.", hint: "Ship it!", outcome: { kind: "precise", exact: "Ship it!" } },
  { name: "PROSE: exclamation mid-sentence", source: "Hello world!", hint: "world!", outcome: { kind: "precise", exact: "world!" } },
  { name: "PROSE: greater-than in a comparison", source: "Ensure x > 0 holds.", hint: "x > 0", outcome: { kind: "precise", exact: "x > 0" } },
  { name: "PROSE: plus in arithmetic", source: "So 1 + 1 = 2 here.", hint: "1 + 1 = 2", outcome: { kind: "precise", exact: "1 + 1 = 2" } },
  { name: "PROSE: sentence-ending number and period", source: "We shipped in 2024. Then we rested.", hint: "2024. Then", outcome: { kind: "precise", exact: "2024. Then" } },
  { name: "PROSE: mid-sentence ordinal", source: "See step 2. Then go.", hint: "step 2. Then", outcome: { kind: "precise", exact: "step 2. Then" } },
  { name: "PROSE: a bracketed aside", source: "He said [sic] it.", hint: "[sic] it", outcome: { kind: "precise", exact: "[sic] it" } },
  { name: "PROSE: exclamation then a repeated phrase", source: "Wow! nice and Wow nice", hint: "Wow nice", outcome: { kind: "slice", exact: "Wow nice" } },

  // --- ambiguity: the text really does occur twice in the block ---------
  { name: "AMBIGUOUS: code span and a literal copy", source: "Run `snake_case` then see snake_case.", hint: "snake_case", outcome: { kind: "widened" } },
  { name: "AMBIGUOUS: code span and a literal kwargs", source: "Use `**kwargs` and kwargs.", hint: "kwargs", outcome: { kind: "widened" } },
  { name: "AMBIGUOUS: an html tag and a bare copy", source: "Press <kbd>x</kbd> or x", hint: "x", outcome: { kind: "widened" } },

  // --- refused: the rows the review marks acceptable, and the two
  // --- constructs a delimiter scanner does not model --------------------
  { name: "REFUSED: triple-star (review-acceptable)", source: "A ***both*** and **_mix_** end", hint: "both and mix", outcome: { kind: "refused", reason: "hint-not-found" } },
  { name: "REFUSED: backslash-escaped asterisks (review-acceptable)", source: "Say \\*not em\\* ok", hint: "*not em*", outcome: { kind: "refused", reason: "hint-not-found" } },
  { name: "REFUSED: escaped text WITHOUT the escapes still resolves", source: "Say \\*not em\\* ok", hint: "not em", outcome: { kind: "precise", exact: "not em" } },
  { name: "REFUSED: raw html tags (review-acceptable)", source: "Press <kbd>Ctrl</kbd> now", hint: "Press Ctrl now", outcome: { kind: "refused", reason: "hint-not-found" } },
  { name: "REFUSED: text inside a raw html tag still resolves", source: "Press <kbd>Ctrl</kbd> now", hint: "Ctrl", outcome: { kind: "precise", exact: "Ctrl" } },
  { name: "REFUSED: stars inside an inline code span", source: "Use `**kwargs` here", hint: "**kwargs", outcome: { kind: "refused", reason: "hint-not-found" } },

  // --- the escape / entity duplicates: a known limit, asserted so it is
  // --- pinned rather than discovered. See the PR body's open items. ------
  { name: "LIMIT: escaped copy vs literal copy", source: "Use foo\\_bar or else foo_bar.", hint: "foo_bar", outcome: { kind: "precise", exact: "foo_bar" } },
  { name: "LIMIT: entity vs literal ampersand", source: "A &amp; B, also A & B.", hint: "A & B", outcome: { kind: "precise", exact: "A & B" } },
  { name: "LIMIT: a link whose target holds a comma", source: "x[0](a, b) then a, b", hint: "a, b", outcome: { kind: "precise", exact: "a, b" } },
  { name: "LIMIT: comparison inside a code span", source: "Note: `a > b` and a b.", hint: "a b", outcome: { kind: "slice", exact: "a b" } },
];

describe("buildQuoteForComment — the review's full probe table (round 4)", () => {
  for (const row of PROBE_ROWS) {
    test(`${row.outcome.kind.toUpperCase()}: ${row.name}`, () => {
      assertOutcome(row);
    });
  }

  test("every probe row is covered — the table cannot shrink unnoticed", () => {
    // A row deleted from the array would quietly remove a guarantee, so the
    // count is pinned. If a row is added, this fails and asks for a new number.
    expect(PROBE_ROWS).toHaveLength(42);
  });

  test("the prose rows are the ones that regressed in round 3", () => {
    // Named explicitly because they are the BLOCKER: if this list and the
    // `PROSE:`-prefixed rows ever disagree, one of them is lying.
    const prose = PROBE_ROWS.filter((r) => r.name.startsWith("PROSE:")).map((r) => r.name);
    expect(prose).toEqual([
      "PROSE: trailing exclamation",
      "PROSE: exclamation mid-sentence",
      "PROSE: greater-than in a comparison",
      "PROSE: plus in arithmetic",
      "PROSE: sentence-ending number and period",
      "PROSE: mid-sentence ordinal",
      "PROSE: a bracketed aside",
      "PROSE: exclamation then a repeated phrase",
    ]);
    // And none of them is a refusal: prose that 400s is the bug.
    for (const row of PROBE_ROWS.filter((r) => r.name.startsWith("PROSE:"))) {
      expect(row.outcome.kind).not.toBe("refused");
    }
  });
});

describe("foldSourcePlain — markers are markup only where they can be (round 4)", () => {
  /** The rendered text of `source`, as the projection reports it. */
  const plain = (source: string): string => foldSourcePlain(source).text.trim();

  test("`!` is kept unless it precedes a `[`", () => {
    expect(plain("Ship it! Then rest.")).toBe("Ship it! Then rest.");
    expect(plain("Wow! nice")).toBe("Wow! nice");
    expect(plain("![alt](src)")).toBe("alt");
  });

  test("`>` `+` `-` are kept mid-line and stripped at the start of one", () => {
    expect(plain("x > 0")).toBe("x > 0");
    expect(plain("1 + 1 = 2")).toBe("1 + 1 = 2");
    expect(plain("a - b")).toBe("a - b");
    expect(plain("> quote")).toBe("quote");
    expect(plain("+ plus item")).toBe("plus item");
    expect(plain("- bullet")).toBe("bullet");
    // Indented markers still count: the page renders them too.
    expect(plain("   - indented bullet")).toBe("indented bullet");
  });

  test("`N.` is kept mid-line and stripped at the start of one", () => {
    expect(plain("shipped in 2024. Then")).toBe("shipped in 2024. Then");
    expect(plain("See step 2. Then go.")).toBe("See step 2. Then go.");
    expect(plain("1. item")).toBe("item");
    expect(plain("12) item")).toBe("item");
  });

  test("brackets are kept unless a link follows", () => {
    expect(plain("He said [sic] it.")).toBe("He said [sic] it.");
    expect(plain("see [the docs](https://x.io) now")).toBe("see the docs now");
  });

  test("asterisks need a word on one side to be emphasis", () => {
    expect(plain("2 * 3 * 4")).toBe("2 * 3 * 4");
    expect(plain("a*b*c")).toBe("a*b*c");
    expect(plain("An *important* point")).toBe("An important point");
    // The `- ` opens the list item; the `*` that follows is then mid-line
    // with spaces on both sides, so it is prose — which is what the page
    // shows (`• * bullet`).
    expect(plain("- * bullet")).toBe("* bullet");
  });

  test("a `#` run is a heading only at the start of a line", () => {
    expect(plain("## A heading")).toBe("A heading");
    expect(plain("C# 12 is fine")).toBe("C# 12 is fine");
  });

  test("the map stays consistent on the prose that used to break it", () => {
    // NB1's invariant, re-asserted on the fixtures that made it matter: a
    // marker that is NOT markup must not shift the map either.
    for (const source of ["Ship it! Then rest.", "x > 0 holds", "So 1 + 1 = 2", "See step 2. Then"]) {
      const folded = foldSourcePlain(source);
      expect(folded.starts.length).toBe(folded.text.length);
      expect(folded.ends.length).toBe(folded.text.length);
    }
  });
});
