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
 * source `` `gh` `` and rendered `gh` fold to the same string, and a
 * search that hits then cuts the SOURCE span. This is also what repairs
 * the narrow variant issue #113 measured (a `<code>` node's
 * `position.start.offset` points at the opening backtick): no offset
 * nudge is needed, because the quote is re-sliced from the source
 * rather than patched.
 *
 * **Where the delimiters come back, and where they do not (issue #113,
 * PR #124 round 2).** Two paths cut a quote, and they differ:
 *
 * - RE-ANCHOR (`reanchor.ts`) re-slices the span the engine resolved, so
 *   the delimiters are back: a quote on `` `gh` `` rebuilds as `` `gh` ``.
 * - COMMENT CREATE (`quote.ts`) narrows by searching the FOLDED block and
 *   slicing what the search hit, and the hit for `gh` is the inner `gh` —
 *   the backtick deleted before the search, so it is not in the hit. The
 *   stored quote is therefore `gh`.
 *
 * That is not a defect and the two are equivalent for matching: both fold
 * to `gh`, so path 4a's comparison and the similarity gate see the same
 * string either way, and the provenance property (the stored quote is a
 * byte-exact slice of the source) holds for both. It is recorded here
 * because an earlier version of this note claimed the create path grew the
 * backticks back too, which it does not.
 *
 * `---` is deliberately NOT in the table: measured, the pipeline
 * leaves a three-dash run alone (`a --- b` renders as `a --- b`), so
 * folding it would invent an equivalence the renderer does not have.
 * `„` and `–` are included defensively — this configuration does not
 * emit them, but a document may contain them literally, and folding a
 * literal character back is the same substitution in reverse.
 *
 * **What this table does NOT claim, measured (ADR-0006 amendment,
 * issue #113, review of PR #124; tracked as #127).** It is not
 * "exactly what the renderer performs", in either direction:
 *
 * - A dot run of FOUR or more also collapses to a single `…`
 *   (`....`, `.....` all render `…`), so `… → ...` reverses only the
 *   three-dot case and a legacy quote on such a line still orphans at
 *   `locateOldSpan` — an under-fold.
 * - Three entries are not renders-identical: the backtick (adding or
 *   removing inline code leaves the words alone and changes the
 *   styling), `–` (a spaced hyphen is left alone, so a spaced en dash
 *   and a spaced hyphen render *differently*) and `„`. Measured
 *   consequences are bounded — the rebuilt anchor always carries the NEW
 *   source text — but an over-fold is an over-fold.
 *
 * The table is unchanged by that review on purpose: narrowing it is
 * #127's decision, and narrowing it here would re-orphan every legacy
 * quote the over-fold currently rescues.
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

/** ASCII whitespace — the characters HTML collapses to a single space
 * in a rendered text node. Not `\u00a0`: HTML does NOT collapse a
 * non-breaking space, so folding it would invent an equivalence the
 * renderer does not have (the same rule that keeps `---` out of
 * `FOLD`). */
const WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f", "\v"]);

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
  return foldScan(source, FoldMode.NONE);
}

/**
 * `foldSource`, plus every run of ASCII whitespace collapsed to ONE
 * space — what a browser's `textContent` reports for the same span.
 *
 * **Why this exists (issue #113, PR #124 round 2).** A markdown soft
 * break is a `\n` in the source and a COLLAPSED SPACE in the rendered
 * page, so a reviewer who selects across one sends a hint the source
 * does not contain. The quote builder used to read that as "no match"
 * and widened the quote to the whole block. Now that an unresolvable
 * hint is a refusal (a stale-build signal, not a hint), the matcher has
 * to see across the soft break first — otherwise every routine
 * two-line selection would come back as a 400.
 *
 * A collapsed run obeys the same map contract as an expanding
 * substitution: all of its folded characters carry the run's own
 * `starts` / `ends`, so a match that lands inside a run still cuts
 * source text (possibly with a boundary space, which is source text).
 *
 * Only the quote builder uses this. The re-anchoring engine's
 * comparisons must stay byte-exact, so `foldSource` is untouched by it.
 */
export function foldSourceLoose(source: string): FoldedSource {
  return foldScan(source, FoldMode.WHITESPACE);
}

/**
 * The range's source projected to the PLAIN TEXT a rendered page shows — the
 * typographic fold, collapsed whitespace, AND inline markup deleted.
 *
 * **Why (issue #113, PR #124 round 3).** The rail sends
 * `selection.toString()`, which is the browser's text for the rendered
 * DOM: markup is already stripped by the time the reviewer can select
 * it. A reviewer who selects `really` inside `**really**`, or `the docs`
 * inside `[the docs](https://…)`, therefore sends a hint that is NOT a
 * substring of the source. Matching the hint against raw source refused
 * those with a 400 telling the reviewer to reload a page that was
 * perfectly current — on a core path, for the most ordinary selections
 * there are.
 *
 * This is the projection that makes the hint comparable, so the comment
 * builder can search it and map a hit back to source offsets. When the
 * markup around a hit makes the mapping ambiguous, the caller widens to
 * the block's source range, which is honest and coarse; the alternative
 * is a span that claims to be the selection and is not.
 *
 * **Markup is stripped only here, never in `foldSource`.** The
 * re-anchoring engine compares a recorded quote against source bytes, so
 * it must see the markup — a quote that stored rendered text is the
 * defect #113 fixed. Only the comment builder needs to compare what the
 * REVIEWER selected, which is the page's text with no markup left in it.
 * The re-anchoring engine calls no function in this section.
 *
 * Markup handling is `markupDelimiterAt`'s, and its limits are named
 * there (fenced code is #120's, entities are #119's).
 */
export function foldSourcePlain(source: string): FoldedSource {
  return foldScan(source, FoldMode.WHITESPACE_PLAIN);
}

/** The needle-side counterpart of `foldSourceLoose`: fold the
 * typographic forms and collapse whitespace runs, with no offset map
 * (a needle is searched, never sliced).
 *
 * A needle needs no markup stripping: it came from `textContent`, which
 * has none left. Stripping it again would be harmless for well-formed
 * input and wrong for a selection that legitimately contains a bracket,
 * so it is deliberately not done. */
export function foldTypographyLoose(text: string): string {
  const folded = foldTypography(text);
  if (!/\s/.test(folded)) return folded;
  return folded.replace(/\s+/g, " ");
}

/** How `foldScan` treats the three things it can meet. The flags are
 * orthogonal and every combination is a total function — `foldSource`
 * is `NONE`, `foldSourceLoose` is `WHITESPACE`. */
const enum FoldMode {
  NONE = 0,
  /** Collapse every run of ASCII whitespace to one space. */
  WHITESPACE = 1,
  /** Also delete Markdown INLINE MARKUP: `**`, `*`, `_`, `[`, `](url)`,
   * a leading `> `, list markers. See `foldSourcePlain`. */
  PLAIN = 2,
  WHITESPACE_PLAIN = 3,
}

/** The one scanner behind every fold in this module. It is a
 * two-pass measure-then-fill over the same cases, and **both passes run
 * the identical walk** (`scanUnits`), so they cannot disagree about how
 * long the result is. That is not a nicety: the round-3 review of #124
 * measured a build where pass 1 subtracted collapsed whitespace but
 * never added substitution growth (`—` → `--`), so on any non-ASCII
 * source the maps were two characters short, out-of-range writes were
 * dropped, `findFolded` read `?? 0`, and a valid selection came back as
 * `exact: ""`. One walk, two passes over it, cannot have that bug. */
function foldScan(source: string, mode: FoldMode): FoldedSource {
  const collapseWhitespace = (mode & FoldMode.WHITESPACE) !== 0;
  const stripMarkup = (mode & FoldMode.PLAIN) !== 0;

  // Pass 1: the folded LENGTH. Same walk as pass 2, so it cannot drift.
  let foldedLength = 0;
  scanUnits(source, collapseWhitespace, stripMarkup, (unit) => {
    foldedLength += unit.length;
  });

  const starts = new Int32Array(foldedLength);
  const ends = new Int32Array(foldedLength);
  let text = "";
  let out = 0;
  /** Record one verbatim source character at `k` as folded character
   *  `out`. */
  const emitVerbatim = (k: number): void => {
    starts[out] = k;
    ends[out] = k + 1;
    out += 1;
  };
  /** Record an EXPANDING substitution: every character it produces
   *  carries the ONE source offset it came from, so a match that
   *  starts or ends mid-substitution maps to the source character that
   *  produced the run. */
  const emitSubstitution = (at: number, replacement: string): void => {
    for (let k = 0; k < replacement.length; k += 1) {
      starts[out] = at;
      ends[out] = at + 1;
      out += 1;
    }
    text += replacement;
  };
  /** Record a collapsed whitespace RUN as one space, spanning the run
   *  — same contract as `emitSubstitution`, with the run as the unit. */
  const emitSpace = (runStart: number, runEnd: number): void => {
    starts[out] = runStart;
    ends[out] = runEnd;
    out += 1;
    text += " ";
  };

  // Pass 2: the same walk again, this time recording where each emitted
  // character came from.
  scanUnits(source, collapseWhitespace, stripMarkup, (unit) => {
    switch (unit.kind) {
      case "verbatim":
        text += source.charAt(unit.sourceStart);
        emitVerbatim(unit.sourceStart);
        return;
      case "substitution":
        emitSubstitution(unit.sourceStart, unit.text);
        return;
      case "space":
        emitSpace(unit.sourceStart, unit.sourceEnd);
        return;
      case "markup":
        // Nothing to write: the folded cursor does not advance, so the
        // next real character overwrites this slot with its own offsets.
        return;
    }
  });
  return { text, starts, ends };
}

/** One unit of the fold: what to emit, and the source span it came
 * from. `length` is what pass 1 counts, so it is `text.length` for every
 * kind by construction. */
interface FoldUnit {
  /** `markup` is stripped markup: it emits nothing and covers the
   *  delimiter run. It is its own kind rather than a zero-length
   *  `verbatim` because pass 2 appends to the text for `verbatim` — a
   *  shared kind silently re-inserted the delimiter while leaving the
   *  map unadvanced, which is the round-3 review's NB1 all over again
   *  in a different costume. */
  readonly kind: "verbatim" | "substitution" | "space" | "markup";
  /** The emitted characters. Empty for a DELETING substitution (a
   *  backtick) and for stripped markup. */
  readonly text: string;
  readonly sourceStart: number;
  /** Past the last contributing source character. */
  readonly sourceEnd: number;
  /** How many folded characters this unit produces. */
  readonly length: number;
}

/**
 * Walk `source` once, handing every unit to `visit`.
 *
 * Three cases, in priority order at each position: a `FOLD`
 * substitution, a whitespace run (when collapsing), a Markdown markup
 * delimiter (when stripping), else the character verbatim. Splitting it
 * out is what makes pass 1 and pass 2 the same walk.
 */
function scanUnits(
  source: string,
  collapseWhitespace: boolean,
  stripMarkup: boolean,
  visit: (unit: FoldUnit) => void,
): void {
  for (let k = 0; k < source.length; ) {
    const replacement = FOLD.get(source.charAt(k));
    if (replacement !== undefined) {
      // A DELETING substitution (a backtick) emits nothing: the folded
      // cursor does not advance, so the next real character overwrites
      // that slot with its own offsets. In `` `w` `` the folded `w`
      // therefore maps to source [1, 2) — the span that carries the
      // text, without the delimiters.
      visit({ kind: "substitution", text: replacement, sourceStart: k, sourceEnd: k + 1, length: replacement.length });
      k += 1;
      continue;
    }
    if (collapseWhitespace && WHITESPACE.has(source.charAt(k))) {
      const runStart = k;
      while (k < source.length && WHITESPACE.has(source.charAt(k))) k += 1;
      visit({ kind: "space", text: " ", sourceStart: runStart, sourceEnd: k, length: 1 });
      continue;
    }
    if (stripMarkup) {
      const delimiter = markupDelimiterAt(source, k);
      if (delimiter !== undefined) {
        // Stripped markup emits NOTHING and covers the whole run, so a
        // hit that lands next to it maps back across it correctly.
        visit({ kind: "markup", text: "", sourceStart: k, sourceEnd: k + delimiter, length: 0 });
        k += delimiter;
        continue;
      }
    }
    visit({ kind: "verbatim", text: source.charAt(k), sourceStart: k, sourceEnd: k + 1, length: 1 });
    k += 1;
  }
}

/**
 * The length of the Markdown inline markup starting at `k`, or
 * `undefined` when there is none.
 *
 * What the RENDERED page shows, and therefore what a browser's
 * `selection.toString()` reports, for each construct (issue #113,
 * PR #124 round 3 — the reviewer selects `really` out of `**really**`
 * and the hint is `really`):
 *
 * | source | rendered text | stripped |
 * |---|---|---|
 * | `**really**` | `really` | `really` |
 * | `*really*` | `really` | `really` |
 * | `_really_` | `really` | `really` |
 * | `` `gh` `` | `gh` | `gh` (the `FOLD` backtick already does this) |
 * | `[the docs](https://x)` | `the docs` | `the docs` |
 * | `![alt text](src)` | `alt text` | `alt text` |
 * | `> quoted` | `quoted` | `quoted` |
 * | `- item` | `item` | `item` |
 * | `1. item` | `item` | `item` |
 * | `~~struck~~` | `struck` | `struck` |
 *
 * Deliberately NOT handled, and why: FENCED code (``` ``` ```), because
 * a fence is a block and issue #120 owns anchoring inside one;
 * HTML/entity references, because the daemon does not hold the rendered
 * HTML — `&amp;` stays literal, which is the #119 mapping; and
 * reference-style links `[text][ref]`, whose definition can live outside
 * the anchored range, so the `[`/`]` are stripped and the ref text stays
 * (a coarser match than ideal, never a wrong one).
 *
 * `_` is only a delimiter when it is not INTRA-WORD (`snake_case_name`),
 * matching the CommonMark rule this repo's renderer implements.
 */
function markupDelimiterAt(source: string, k: number): number | undefined {
  const ch = source.charAt(k);
  // Emphasis and strong, opening or closing: `**`, `__`, `*`, `_`.
  if (ch === "*" || ch === "_") {
    if (ch === "_" && isIntraWordUnderscore(source, k)) return undefined;
    let run = 0;
    while (source.charAt(k + run) === ch) run += 1;
    // A run of 3+ is not emphasis this renderer emits (`***` is literal).
    return run >= 3 ? undefined : run;
  }
  // `[text](url)`: the OPENING bracket and the CLOSING `](url)` are
  // delimiters; the label between them is content the page shows, so it
  // is scanned normally and can carry its own markup. Deleting the whole
  // construct here instead would drop the label — which is most of what
  // the reviewer selected.
  if (ch === "[") return 1;
  if (ch === "]" && source.charAt(k + 1) === "(") {
    const paren = source.indexOf(")", k + 2);
    return paren === -1 ? undefined : paren + 1 - k;
  }
  // `![alt](src)`: the `!` is part of the image syntax and never appears
  // in the rendered text (the `alt` does, as the image's text).
  if (ch === "!") return 1;
  // A line-leading block marker: `> `, `- `, `* `, `+ `, or `1. ` / `1) `.
  // The page shows a quote bar or a bullet from CSS, neither of which is
  // in `textContent`.
  if (ch === ">" || ch === "+" || (ch === "-" && isListMarkerAt(source, k))) {
    let run = 0;
    while (source.charAt(k + run) === ch) run += 1;
    // Only when the marker is followed by whitespace, and only for a
    // single marker character — `--` is an em dash's source form, and it
    // is handled by `FOLD` before this ever sees it.
    const after = source.charAt(k + run);
    if (after !== " " && after !== "\t") return undefined;
    let end = k + run;
    while (source.charAt(end) === " " || source.charAt(end) === "\t") end += 1;
    return end - k;
  }
  if (/[0-9]/.test(ch)) {
    const ordered = /^[0-9]{1,9}[.)]( |\t)/.exec(source.slice(k));
    if (ordered === null) return undefined;
    let end = k + ordered[0].length;
    while (source.charAt(end) === " " || source.charAt(end) === "\t") end += 1;
    return end - k;
  }
  // An ATX heading's leading `#` run, with its trailing space.
  if (ch === "#") {
    let run = 0;
    while (source.charAt(k + run) === "#") run += 1;
    if (run > 6) return undefined;
    const after = source.charAt(k + run);
    if (after !== " " && after !== "\t") return undefined;
    let end = k + run;
    while (source.charAt(end) === " " || source.charAt(end) === "\t") end += 1;
    return end - k;
  }
  // `~~struck~~`.
  if (ch === "~" && source.charAt(k + 1) === "~") return 2;
  return undefined;
}

/** Whether the `-` at `k` begins a bullet list item — which requires it
 * to be the first non-space character on its line. Elsewhere a `-` is
 * literal (a hyphen in prose, or the start of a `--` em dash, which
 * `FOLD` has already handled by the time this runs). */
function isListMarkerAt(source: string, k: number): boolean {
  for (let i = k - 1; i >= 0; i -= 1) {
    const ch = source.charAt(i);
    if (ch === "\n") return true;
    if (ch !== " " && ch !== "\t") return false;
  }
  return true;
}

/** Whether the `_` at `k` sits between two word characters, where
 * CommonMark says it is literal text rather than emphasis. */
function isIntraWordUnderscore(source: string, k: number): boolean {
  const before = source.charAt(k - 1);
  const after = source.charAt(k + 1);
  if (before === "" || after === "") return false;
  return /[\w]/.test(before) && /[\w]/.test(after);
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
