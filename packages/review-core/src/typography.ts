// Typography fold (ADR-0006 amendment, issue #113).
//
// **The problem.** Astro's markdown pipeline runs
// `remark-smartypants` by default (`@astrojs/internal-helpers/dist/
// markdown.js`: `smartypants: true`) and revkit's shared config
// (`site/src/lib/markdown-processor.ts`) never turns it off. So the
// RENDERED text of a block is not the SOURCE text of the same block:
// `"` renders as `“ ”`, `'` as `‘ ’`, `--` as `—`, `...` as `…`, and an
// inline-code span's rendered value carries no backticks. A comment
// created before the daemon took quote provenance captured the
// RENDERED form (`rail.tsx`'s `quoteFromBlock` → `block.textContent`)
// and the re-anchoring engine compares against the SOURCE — the two
// strings are never equal, so the comment orphaned on the first edit
// even when the commented paragraph was byte-identical. Measured over
// this repo's own `docs/**`, 43 % of rendered blocks outside code
// fences are affected (issue #113).
//
// **The rule.** `foldTypography` maps each rendered form back to the
// source form the pipeline consumed. The fold is applied
// SYMMETRICALLY: the recorded quote and the source slice are BOTH
// folded before they are compared, so a source quote folds to itself
// and keeps its exact byte comparison, and a rendered quote folds onto
// the source it was rendered from.
//
// **What the equivalence class is, and is not.** The class is exactly
// the substitutions `remark-smartypants` performs, and nothing else.
// That is the right granularity here: the quote identifies *which text
// a comment is about*, and text that renders identically identifies the
// same thing. A span that differs in a WORD is a different span and
// stays a different span — the fold is a per-character substitution
// with no cross-character context, so it cannot normalise a rewrite
// away. `test/typography.test.ts` asserts both directions of that
// claim, including a word-level edit that must NOT match.
//
// **One table, one helper.** The table below is the only place that
// knows which rendered forms exist; `foldTypography`, `foldSource`
// (the offset-tracking form the engine's searches use) and
// `foldedEquals` are all derived from it, so no caller can fold with a
// different rule than another. That is the property that keeps this
// from becoming a second smartypants: one table, measured.
//
// Runtime-neutral: no `node:*` / `bun:*` imports.

/**
 * The rendered → source substitution table. Keys are the forms
 * `remark-smartypants` EMITS; values are the source forms it consumed.
 * Every entry was measured against the real pipeline
 * (`createMarkdownProcessor` + `buildSharedMarkdownConfig`), not taken
 * from prose:
 *
 * | source | rendered |
 * |---|---|
 * | `He said "hi"` | `He said “hi”` |
 * | `it's` | `it’s` |
 * | `'single'` | `‘single’` |
 * | `a -- b` | `a — b` |
 * | `one... two` | `one… two` |
 * | `` `gh` `` | `<code>gh</code>` |
 *
 * The backtick entry maps to the EMPTY string: an inline-code span's
 * rendered text node carries no delimiter, so the fold removes it from
 * the source side rather than inventing one on the rendered side. The
 * asymmetry is deliberate and is what makes both directions agree —
 * source `` `gh` `` and rendered `gh` fold to the same string, and the
 * engine then slices the SOURCE span, so the stored quote grows the
 * backticks back. This is also what repairs the narrow variant issue
 * #113 measured (a `<code>` node's `position.start.offset` points at
 * the opening backtick): no offset nudge is needed, because the quote
 * is re-sliced from the source rather than patched.
 *
 * `---` is deliberately NOT in the table: measured, the pipeline
 * leaves a three-dash run alone (`a --- b` renders as `a --- b`), so
 * folding it would invent an equivalence the renderer does not have.
 * `„` and `–` are included defensively — this configuration does not
 * emit them, but a document may contain them literally, and folding a
 * literal character back is the same substitution in reverse.
 */
const FOLD: ReadonlyMap<string, string> = new Map([
  ["“", '"'],
  ["”", '"'],
  ["„", '"'],
  ["‘", "'"],
  ["’", "'"],
  ["—", "--"],
  ["–", "-"],
  ["…", "..."],
  ["`", ""],
]);

/** Matches exactly the characters `FOLD` has a key for. Driven off
 * the table rather than written out, so adding an entry to `FOLD`
 * cannot leave the scanner behind. */
const FOLD_PATTERN = new RegExp(
  `[${[...FOLD.keys()].map((c) => c.replace(/[.*+?^${}()|[\]\\\-]/g, "\\$&")).join("")}]`,
  "g",
);

/** Fold `text` to the form the SOURCE would have had. The result is
 * what a comparison must use on BOTH sides; see the module header for
 * why this is one shared helper rather than a per-caller fold. */
export function foldTypography(text: string): string {
  FOLD_PATTERN.lastIndex = 0;
  const first = FOLD_PATTERN.exec(text);
  if (first === null) return text;
  let out = text.slice(0, first.index);
  let copied = first.index + 1;
  out += FOLD.get(text.charAt(first.index)) ?? "";
  for (let m = FOLD_PATTERN.exec(text); m !== null; m = FOLD_PATTERN.exec(text)) {
    out += text.slice(copied, m.index) + (FOLD.get(text.charAt(m.index)) ?? "");
    copied = m.index + 1;
  }
  return out + text.slice(copied);
}

/** A folded `(old, new)` source pair, built once per re-anchor and
 * shared by every anchor on the file — the same reason
 * `prepareReanchor` builds the diff once.
 *
 * The placement is measured, not guessed. `foldSource` is O(source
 * length) with a small constant; a BOTH-sides pair costs, on this
 * machine, ~8–9 ms for the 800 KB / 20 k-line fixture the reanchor
 * perf guard uses, ~1.3 ms for the 200 k `a` fixture, and ~55 ms for a
 * 5 MiB source (the anchor-source cap) — three runs each, medians
 * quoted. Per-anchor that would be N× a cost the prepared context
 * exists to pay once; per file-pair it is one. Even the 55 ms is
 * small against the `Diff_Timeout` of 2 s the same call already
 * budgets for the diff itself. */
export function foldPair(oldSource: string, newSource: string): { old: FoldedSource; new: FoldedSource } {
  return { old: foldSource(oldSource), new: foldSource(newSource) };
}

/**
 * Find `needle` (already folded) in `folded` and return the SOURCE
 * offset range of the first hit, or `null`. Stops at the SECOND hit
 * rather than scanning to the end: the move path's ambiguity rule only
 * needs to know a second match exists, so stopping early keeps a
 * single-hit search linear in the haystack with no tail scan.
 */
export function findFolded(
  folded: FoldedSource,
  needle: string,
): { readonly foldedAt: number; readonly start: number; readonly end: number } | null {
  if (needle.length === 0) return null;
  const foldedAt = folded.text.indexOf(needle);
  if (foldedAt < 0) return null;
  const lastAt = foldedAt + needle.length - 1;
  return {
    foldedAt,
    start: folded.starts[foldedAt] ?? 0,
    end: folded.ends[lastAt] ?? folded.starts[lastAt] ?? 0,
  };
}

/**
 * The SOURCE offset of a sub-range of a folded match: the character
 * `foldedOffset` positions into the match came from. Used to cut a
 * quote's `exact` out of a `prefix + exact + suffix` match — the
 * prefix's length in FOLDED coordinates differs from its length in
 * source coordinates wherever it holds a backtick or an em dash, so
 * the boundary has to be resolved through the map rather than by
 * arithmetic on the source.
 *
 * The result is exact whenever the boundary falls between source
 * characters. When it falls INSIDE an expanding substitution (`…`
 * becomes three folded characters) the map names the single source
 * character that produced the run, so a boundary landing there reads
 * as that character's own offset; the returned span is then at most
 * one character short at the tail. That is bounded, self-consistent
 * (the span's text is whatever the source holds there), and only
 * reachable for a recorded quote that both moved AND ends on a
 * typographic character — a case that would previously have orphaned.
 */
export function sourceOffsetInFoldedMatch(
  folded: FoldedSource,
  foldedAt: number,
  offsetWithinMatch: number,
): number {
  const at = foldedAt + offsetWithinMatch;
  const last = folded.text.length - 1;
  if (last < 0) return 0;
  // A boundary PAST the last folded character — the END of a match
  // that runs to the end of the text — resolves through `ends`, since
  // `starts` has no entry there and `ends[last]` is exactly the offset
  // just past the source's last contributing character. This is the
  // shape of every quote on the last line of a file with no trailing
  // newline, which is why it is a first-class case rather than a
  // clamp.
  if (at >= folded.text.length) return folded.ends[last] ?? 0;
  if (at < 0) return 0;
  return folded.starts[at] ?? 0;
}

/** Whether `needle` (already folded) occurs in `folded` at a folded
 * offset at or after `from`. The move path's OLD-side uniqueness check
 * uses this to learn about a second occurrence without a full scan. */
export function foldedHasHitFrom(folded: FoldedSource, needle: string, from: number): boolean {
  if (needle.length === 0) return false;
  return folded.text.indexOf(needle, from) >= 0;
}

/** The folded offset whose SOURCE offset is the first one at or after
 * `sourceOffset` — the folded-space spelling of a source-space search
 * window. A caller that wants "find this needle at or after source
 * offset N" starts its `indexOf` here, so the window is expressed in
 * one coordinate system and the mapping stays in this module.
 *
 * `hi` is the last VALID folded index (`text.length - 1`), not the
 * length: `starts` holds no sentinel entry, so a search seeded at
 * `text.length` would be a valid index in a longer array and miss the
 * tail of the file. */
export function foldedOffsetFromSource(folded: FoldedSource, sourceOffset: number): number {
  let lo = 0;
  let hi = folded.text.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((folded.starts[mid] ?? 0) < sourceOffset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A folded source string plus the map back to SOURCE byte offsets.
 * `starts[i]` is the offset in the ORIGINAL string at which folded
 * character `i` begins; the trailing entry (`starts[text.length]`) is
 * the source offset just past the last contributing character, which
 * is what closes a match.
 *
 * `foldSource` exists because the fold is not length-preserving —
 * `—` expands to `--` and a backtick disappears — so a folded
 * `indexOf` hit cannot be used as a source offset directly. The engine
 * needs source offsets (the diff, the line index and `buildAnchor` are
 * all in source coordinates), so every folded search maps through this
 * table before returning.
 */
export interface FoldedSource {
  /** `source` with every `FOLD` substitution applied. */
  readonly text: string;
  /** Offset in `source` at which each character of `text` begins. */
  readonly starts: Int32Array;
  /** Offset in `source` just past the character that PRODUCED each
   * character of `text`. A match ending at folded offset `e` closes at
   * `ends[e - 1]`, never at `starts[e]`: when the next source
   * character was DELETED by the fold (a backtick), `starts[e]` has
   * already stepped over it, and using it as the end would splice a
   * stray delimiter into the sliced span. */
  readonly ends: Int32Array;
}

/** Fold `source` and record where each folded character came from.
 *
 * **The map's contract.** `starts[i]` is the source offset folded
 * character `i` begins at, and `ends[i]` the offset just past the
 * source character that PRODUCED it — so all three characters of a
 * folded `...` map back to the one source `…`, and a match closing at
 * folded offset `e` ends at `ends[e - 1]`.
 *
 * A DELETING substitution (a backtick) contributes nothing, so it
 * writes no entry and does not advance the folded cursor: the next
 * real character overwrites that slot with its own offsets. In `` `w` ``
 * the folded `w` therefore maps to source [1, 2) — the span that
 * carries the text, without the delimiters. That tightness is what
 * lets the engine's unchanged-path check stay a byte-for-byte
 * comparison; see the inline-code note in the module header. It is
 * also why a match's END reads `ends[e - 1]` rather than
 * `starts[e]`: after the closing backtick of `` `w` ``, `starts[e]`
 * has already stepped past it and would splice a stray delimiter into
 * the slice.
 *
 * Two passes: the first measures the folded LENGTH, the second fills
 * the map. The length pass is needed because the fold both expands
 * (`…` → `...`) and deletes, so the folded text can be longer or
 * shorter than the source and the map cannot be sized from
 * `source.length` up front. */
export function foldSource(source: string): FoldedSource {
  FOLD_PATTERN.lastIndex = 0;
  let foldedLength = source.length;
  for (let m = FOLD_PATTERN.exec(source); m !== null; m = FOLD_PATTERN.exec(source)) {
    foldedLength += (FOLD.get(source.charAt(m.index)) ?? "").length - 1;
  }

  const starts = new Int32Array(foldedLength);
  const ends = new Int32Array(foldedLength);
  let text = "";
  let out = 0;
  let copied = 0;
  /** Record one verbatim source character at `k` as folded character
   *  `out`. */
  const emitVerbatim = (k: number): void => {
    starts[out] = k;
    ends[out] = k + 1;
    out += 1;
  };
  FOLD_PATTERN.lastIndex = 0;
  for (let m = FOLD_PATTERN.exec(source); m !== null; m = FOLD_PATTERN.exec(source)) {
    const at = m.index;
    // Copy the run before the match verbatim; `starts` is the identity
    // map there, so the run loop only has to record the offsets.
    text += source.slice(copied, at);
    for (let k = copied; k < at; k += 1) emitVerbatim(k);
    const replacement = FOLD.get(source.charAt(at)) ?? "";
    if (replacement.length > 0) {
      // An EXPANDING substitution (`…` → `...`) fills every slot it
      // produces with the ONE source offset it came from, so a match
      // that starts or ends mid-substitution still maps to the source
      // character that produced the run.
      for (let k = 0; k < replacement.length; k += 1) {
        starts[out] = at;
        ends[out] = at + 1;
        out += 1;
      }
    }
    // A DELETING substitution (a backtick) emits nothing: `out` does
    // not advance, so the next real character overwrites that slot
    // with its own offsets. In `` `w` `` the folded `w` therefore maps
    // to source [1, 2) — the span that carries the text, without the
    // delimiters — which is what lets the engine's unchanged-path
    // check stay a byte-for-byte comparison.
    text += replacement;
    copied = at + 1;
  }
  text += source.slice(copied);
  for (let k = copied; k < source.length; k += 1) emitVerbatim(k);
  return { text, starts, ends };
}

/**
 * Whether two strings are the same span of text, allowing for the
 * typographic substitutions the renderer performs. Byte equality
 * short-circuits: a source quote folds to itself, so the common case
 * is the same exact comparison as before — this is what makes the fold
 * a compatibility shim for existing stored quotes and not a change to
 * how source quotes are matched.
 */
export function foldedEquals(a: string, b: string): boolean {
  return a === b || foldTypography(a) === foldTypography(b);
}
