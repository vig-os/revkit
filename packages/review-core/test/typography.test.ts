// Typography-fold unit tests (ADR-0006 amendment, issue #113).
//
// The fold is a compatibility shim for quotes stored before the daemon
// took quote provenance: those carry the RENDERED text, this repo's
// markdown pipeline renders with `remark-smartypants`, and the engine
// compares against the SOURCE. These tests pin BOTH directions of the
// promise the module header makes —
//
//   1. every substitution the real pipeline performs folds (a legacy
//      rendered quote matches its source), and
//   2. nothing else does (a genuinely changed span does NOT match).
//
// (2) is the one that matters for trust: a fold that normalised
// rewrites away would attach comments to text the reviewer never
// commented on. The engine-level no-false-match fixtures live in
// `packages/cli/test/serve/quote-provenance.test.ts`, driven through
// the real pipeline; these are the unit-level pins.

import { describe, expect, test } from "bun:test";
import {
  findFolded,
  foldSource,
  foldedEquals,
  foldTypography,
  sourceOffsetInFoldedMatch,
} from "../src/typography.ts";

describe("foldTypography — the substitutions the pipeline performs", () => {
  test("double quotes fold both ways", () => {
    expect(foldTypography('He said "hi"')).toBe("He said \"hi\"");
    expect(foldTypography("He said “hi”")).toBe('He said "hi"');
    expect(foldTypography("He said “hi”")).toBe('He said "hi"');
  });

  test("single quotes and apostrophes fold both ways", () => {
    expect(foldTypography("it's fine")).toBe("it's fine");
    expect(foldTypography("it’s fine")).toBe("it's fine");
    expect(foldTypography("‘single’")).toBe("'single'");
  });

  test("em dash, en dash and ellipsis fold to their source forms", () => {
    expect(foldTypography("a -- b")).toBe("a -- b");
    expect(foldTypography("a — b")).toBe("a -- b");
    expect(foldTypography("1990–1995")).toBe("1990-1995");
    expect(foldTypography("one… two")).toBe("one... two");
    expect(foldTypography("one... two")).toBe("one... two");
  });

  test("an inline-code span folds to its rendered value on BOTH sides", () => {
    // The source carries delimiters, the rendered text node does not.
    // This is the narrow variant issue #113 measured: the `<code>`
    // node's `position.start.offset` points at the opening backtick.
    expect(foldTypography("use `gh` here")).toBe("use gh here");
    expect(foldTypography("use gh here")).toBe("use gh here");
  });

  test("a three-dash run is NOT folded — the pipeline leaves it alone", () => {
    // Measured against `createMarkdownProcessor`: `a --- b` renders as
    // `a --- b`. Folding it would invent an equivalence the renderer
    // does not have, and would make a real `---` edit look unchanged.
    expect(foldTypography("a --- b")).toBe("a --- b");
  });

  test("text with no typographic characters is returned unchanged (identity)", () => {
    const plain = "one - item in a templated bullet list\n";
    expect(foldTypography(plain)).toBe(plain);
  });

  test("folding is idempotent", () => {
    for (const sample of [
      'He said "hi" -- ok... (c) 2026 and it\'s fine.',
      "He said “hi” — ok… (c) 2026 and it’s fine.",
      "use `gh` and `ts`",
    ]) {
      const once = foldTypography(sample);
      expect(foldTypography(once)).toBe(once);
    }
  });
});

describe("foldedEquals — a genuinely changed span must NOT match", () => {
  test("a word-level edit does not match", () => {
    const source = 'He said "hi" -- ok... and it\'s fine.';
    const rendered = "He said “hi” — ok… and it’s fine.";
    expect(foldedEquals(rendered, source)).toBe(true);
    expect(foldedEquals(rendered, source.replace("fine", "wrong"))).toBe(false);
  });

  test("an inserted or deleted word does not match", () => {
    const source = "The target phrase lives on this line.";
    const rendered = "The target phrase lives on this line.";
    expect(foldedEquals(rendered, source)).toBe(true);
    expect(foldedEquals(rendered, `${source} And more.`)).toBe(false);
    expect(foldedEquals(rendered, "The target phrase lives.")).toBe(false);
  });

  test("a rewritten sentence that happens to share punctuation does not match", () => {
    // The adversarial shape: same punctuation, different words. A fold
    // that compared only the folded PUNCTUATION would call these
    // equal; a per-character substitution does not.
    expect(foldedEquals("He said “hi” — ok…", "She said “no” — fine…")).toBe(false);
  });

  test("reordered text does not match", () => {
    expect(foldedEquals("“a” and ‘b’", "‘b’ and “a”")).toBe(false);
  });

  test("a source-only comparison is still exact", () => {
    // Both sides source, no typographic characters: byte equality.
    const a = "seed body line 3";
    expect(foldedEquals(a, a)).toBe(true);
    expect(foldedEquals(a, `${a} `)).toBe(false);
  });
});

describe("foldSource — the offset map back to source coordinates", () => {
  test("an all-plain source folds to itself and maps identically", () => {
    const source = "one - item\ntwo - item\n";
    const folded = foldSource(source);
    expect(folded.text).toBe(source);
    expect(folded.starts.length).toBe(source.length);
    for (let i = 0; i < source.length; i += 1) {
      expect(folded.starts[i]).toBe(i);
      expect(folded.ends[i]).toBe(i + 1);
    }
  });

  test("an expanding substitution maps every folded char back to its source char", () => {
    // `…` is one source char and three folded chars; all three must
    // map back to the same source offset, or the engine would slice a
    // three-character span out of a one-character source range.
    const source = "a…b";
    const folded = foldSource(source);
    expect(folded.text).toBe("a...b");
    expect(folded.starts.length).toBe(folded.text.length);
    for (const at of [1, 2, 3]) {
      expect(folded.starts[at]).toBe(1);
      expect(folded.ends[at]).toBe(2);
    }
    // The char AFTER the substitution maps past it.
    expect(folded.starts[4]).toBe(2);
    expect(folded.ends[4]).toBe(3);
  });

  test("a DELETING substitution (backtick) maps the rendered span onto the inner source span", () => {
    // The source `` `w` `` folds to `w`, and the folded `w` maps to
    // source [1, 2) — the `w`, without either delimiter.
    //
    // This is the narrow variant issue #113 measured, and mapping the
    // span TIGHTLY is what repairs it: the engine's path-4a check
    // stays a byte-for-byte comparison of `w` against `w` and passes,
    // where an offset that included a backtick would compare `w`
    // against `` `w` `` and fail. No offset nudge is needed anywhere,
    // because the comparison is a slice, not a hand-patched offset.
    //
    // `ends` is what makes the END correct: `starts[1]` (one past the
    // folded text) would be 3 — over the closing backtick — and
    // slicing `source[1..3]` would store `` w` ``, a string the source
    // does not contain.
    const source = "`w`";
    const folded = foldSource(source);
    expect(folded.text).toBe("w");
    expect(folded.starts.length).toBe(1);
    expect(folded.starts[0]).toBe(1);
    expect(folded.ends[0]).toBe(2);
    const hit = findFolded(folded, "w");
    expect(hit).not.toBeNull();
    expect(source.slice(hit?.start ?? -1, hit?.end ?? -1)).toBe("w");
  });

  test("a match closing at a deleting substitution does not pick up the delimiter", () => {
    // `Use \`gh\` here` — the rendered text is `Use gh here`. A folded
    // match of `gh here` must slice source [4, 13): `gh` here`, never
    // reaching over the closing backtick.
    const source = "Use `gh` here";
    const folded = foldSource(source);
    const hit = findFolded(folded, "gh here");
    expect(source.slice(hit?.start ?? -1, hit?.end ?? -1)).toBe("gh` here");
  });

  test("the map is monotone and covers the whole source", () => {
    const source = 'He said "hi" -- ok... (c) 2026 and it\'s fine. Use `gh` -- now.\n';
    const folded = foldSource(source);
    expect(folded.text).toBe(foldTypography(source));
    expect(folded.starts.length).toBe(folded.text.length);
    expect(folded.ends.length).toBe(folded.text.length);
    for (let i = 1; i < folded.starts.length; i += 1) {
      expect(folded.starts[i]).toBeGreaterThanOrEqual(folded.starts[i - 1] as number);
      expect(folded.ends[i]).toBeGreaterThanOrEqual(folded.starts[i] as number);
      expect(folded.ends[i]).toBeLessThanOrEqual(source.length);
    }
    // Every folded character maps into the source, and the union of the
    // spans is bounded by it.
    expect(folded.starts[folded.text.length - 1]).toBeLessThan(source.length);
    expect(folded.ends[folded.text.length - 1]).toBeLessThanOrEqual(source.length);
  });

  test("an empty source folds to empty maps", () => {
    const folded = foldSource("");
    expect(folded.text).toBe("");
    expect(folded.starts.length).toBe(0);
    expect(folded.ends.length).toBe(0);
  });

  test("a source that is only deletions folds to empty maps", () => {
    const folded = foldSource("``");
    expect(folded.text).toBe("");
    expect(folded.starts.length).toBe(0);
  });

  test("a boundary at the end of the folded text resolves past the last source character", () => {
    // The shape of every quote on the last line of a file with no
    // trailing newline: a match that runs to EOF has no `starts` entry
    // for its end, so the end must come from `ends` of the last folded
    // character. Before this was handled the span came back one
    // character short and the quote lost its last letter.
    const source = "last line without trailing newline";
    const folded = foldSource(source);
    expect(sourceOffsetInFoldedMatch(folded, 0, 0)).toBe(0);
    expect(sourceOffsetInFoldedMatch(folded, 0, folded.text.length)).toBe(source.length);
    const hit = findFolded(folded, source);
    expect(source.slice(hit?.start ?? -1, hit?.end ?? -1)).toBe(source);
  });

  test("an offset before the match clamps to the start of the source", () => {
    const folded = foldSource("alpha beta");
    expect(sourceOffsetInFoldedMatch(folded, 0, -5)).toBe(0);
  });
});

describe("findFolded — mapping a folded match back to a source span", () => {
  test("a plain needle maps to the identical source span", () => {
    const source = "alpha beta gamma";
    const hit = findFolded(foldSource(source), "beta");
    expect(hit).not.toBeNull();
    expect(hit?.foldedAt).toBe(6);
    expect(source.slice(hit?.start ?? -1, hit?.end ?? -1)).toBe("beta");
  });

  test("a rendered needle maps onto its source counterpart", () => {
    const source = 'He said "hi" -- ok... fine.';
    const hit = findFolded(foldSource(source), foldTypography("He said “hi” — ok… fine."));
    expect(hit).not.toBeNull();
    expect(source.slice(hit?.start ?? -1, hit?.end ?? -1)).toBe('He said "hi" -- ok... fine.');
  });

  test("an empty needle never matches", () => {
    expect(findFolded(foldSource("anything"), "")).toBeNull();
  });

  test("a needle that only differs in words does not match", () => {
    expect(findFolded(foldSource('He said "hi" ok...'), foldTypography('She said “no” ok…'))).toBeNull();
  });
});
