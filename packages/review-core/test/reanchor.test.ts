// Tests for the re-anchoring engine (ADR-0006 Acceptance, PR-40
// review round 2).
//
// Principle: every fixture calls `reanchor(anchor, old, new)` with
// **defaults**. No test passes `minQuoteScore`, `minMargin`, or any
// other option to prove behaviour. This means a mutation of any
// DEFAULT CONSTANT or STAGE in `reanchor.ts` (removing the margin,
// dropping the quote gate, adding a global fuzzy fallback, letting a
// lone bare-quote copy anchor, dropping the move-context check,
// removing the snapshot check) MUST turn at least one fixture red.
//
// See the PR body for the mutation → red-test mapping.
//
// Coverage:
//   1. Stage exports (`buildLineStartIndex`, `offsetToLine`,
//      `lineToOffset`, `classifySpan`, `findHunkWindow`,
//      `alignMatchedText`, `tryMove`).
//   2. Positive fixtures — anchor lands at the right place with
//      defaults.
//   3. MUST-orphan fixtures — the 7 reviewer repros + the templated
//      sweep (5 templates × 16 rows) + substring-of-longer-sentence
//      + 1 MB templated file + insufficient-context move + lone
//      bare-quote copy.
//   4. Coherent-anchor invariant across every non-orphan result.
//   5. Two-step round-trip.
//   6. Performance guards — < 200 ms on 20 k `- item` lines; < 200
//      ms on the 200 k `a` case with quote `aaaaaaaa`.
//   7. `reanchorEvent` shape.

import { describe, expect, test } from "bun:test";
import {
  alignMatchedText,
  buildLineStartIndex,
  classifySpan,
  DEFAULT_MIN_MOVE_CONTEXT,
  findHunkWindow,
  lineToOffset,
  offsetToLine,
  prepareReanchor,
  reanchor,
  reanchorEvent,
  reanchorWith,
  revisionOf,
  tryMove,
  type Anchor,
  type ReanchorResult,
} from "../src/index.ts";

const AGENT = { kind: "agent", id: "revkit-live" } as const;

/** Build a valid anchor from `source` for lines [start..end], with
 * `contextLen` chars of surrounding text captured verbatim. */
async function anchorForSource(
  path: string,
  source: string,
  start: number,
  end: number,
  contextLen = 40,
): Promise<Anchor> {
  const idx = buildLineStartIndex(source);
  const byteStart = lineToOffset(idx, start);
  const lines = source.split("\n");
  const exact = lines.slice(start - 1, end).join("\n");
  const byteEnd = byteStart + exact.length;
  const prefix = source.slice(Math.max(0, byteStart - contextLen), byteStart);
  const suffix = source.slice(byteEnd, Math.min(source.length, byteEnd + contextLen));
  return {
    path,
    startLine: start,
    endLine: end,
    quote: { exact, prefix, suffix },
    revision: await revisionOf(source),
  };
}

/** Build a partial-line anchor: `contextLen` chars on either side of
 * a substring at `[byteStart, byteEnd)` inside a single line. */
async function partialAnchorForSource(
  path: string,
  source: string,
  byteStart: number,
  byteEnd: number,
  contextLen = 40,
): Promise<Anchor> {
  const idx = buildLineStartIndex(source);
  const exact = source.slice(byteStart, byteEnd);
  const prefix = source.slice(Math.max(0, byteStart - contextLen), byteStart);
  const suffix = source.slice(byteEnd, Math.min(source.length, byteEnd + contextLen));
  return {
    path,
    startLine: offsetToLine(idx, byteStart),
    endLine: offsetToLine(idx, Math.max(byteStart, byteEnd - 1)),
    quote: { exact, prefix, suffix },
    revision: await revisionOf(source),
  };
}

/** Assert the coherent-anchor invariant on a non-orphan result: the
 * recorded quote is at the recorded line range, and prefix+exact+
 * suffix appears in the new source. */
function expectCoherent(result: ReanchorResult, newSource: string): void {
  if (result.kind === "orphaned") return;
  const { anchor } = result;
  const lines = newSource.split("\n");
  const rangeText = lines.slice(anchor.startLine - 1, anchor.endLine).join("\n");
  if (!rangeText.includes(anchor.quote.exact)) {
    throw new Error(
      `coherent-anchor: range L${anchor.startLine}-L${anchor.endLine} does not contain quote.\n` +
        `  quote: ${JSON.stringify(anchor.quote.exact)}\n  range: ${JSON.stringify(rangeText)}`,
    );
  }
  if (!newSource.includes(anchor.quote.prefix + anchor.quote.exact + anchor.quote.suffix)) {
    throw new Error(
      `coherent-anchor: prefix+exact+suffix not found in newSource.\n` +
        `  prefix: ${JSON.stringify(anchor.quote.prefix)}\n  exact:  ${JSON.stringify(anchor.quote.exact)}\n  suffix: ${JSON.stringify(anchor.quote.suffix)}`,
    );
  }
}

// ---------- Stage tests ----------

describe("buildLineStartIndex / offsetToLine / lineToOffset", () => {
  test("empty source: one line, offsets clamp", () => {
    const idx = buildLineStartIndex("");
    expect(idx).toEqual([0]);
    expect(offsetToLine(idx, 0)).toBe(1);
    expect(lineToOffset(idx, 1)).toBe(0);
  });

  test("multi-line source: line starts recorded", () => {
    const src = "a\nb\nc\n";
    const idx = buildLineStartIndex(src);
    expect(idx).toEqual([0, 2, 4, 6]);
    expect(offsetToLine(idx, 0)).toBe(1);
    expect(offsetToLine(idx, 2)).toBe(2);
    expect(offsetToLine(idx, 3)).toBe(2);
    expect(offsetToLine(idx, 4)).toBe(3);
    expect(lineToOffset(idx, 2)).toBe(2);
    expect(lineToOffset(idx, 3)).toBe(4);
  });

  test("no-trailing-LF source: last line indexed too", () => {
    const src = "a\nb\nc";
    const idx = buildLineStartIndex(src);
    expect(idx).toEqual([0, 2, 4]);
    expect(offsetToLine(idx, 4)).toBe(3);
  });
});

describe("classifySpan", () => {
  test("unchanged span: entirely EQUAL segments", () => {
    // diffs: EQUAL "abcdef" (spans 0..6)
    const diffs = [[0 as const, "abcdef"] as const];
    expect(classifySpan(diffs, 1, 4).kind).toBe("unchanged");
  });
  test("deleted span: entirely DELETE", () => {
    const diffs = [
      [0 as const, "abc"] as const,
      [-1 as const, "XYZ"] as const,
      [0 as const, "def"] as const,
    ];
    expect(classifySpan(diffs, 3, 6).kind).toBe("deleted");
  });
  test("modified span: mixed EQUAL and DELETE", () => {
    const diffs = [
      [0 as const, "abc"] as const,
      [-1 as const, "XY"] as const,
      [0 as const, "d"] as const,
    ];
    // Span [2, 5) covers 'c', 'X', 'Y': 1 EQUAL + 2 DELETE.
    const cls = classifySpan(diffs, 2, 5);
    expect(cls.kind).toBe("modified");
    if (cls.kind === "modified") {
      expect(cls.equalChars).toBe(1);
      expect(cls.deletedChars).toBe(2);
    }
  });
});

describe("findHunkWindow", () => {
  test("captures nearby modified hunk with slack", () => {
    // old: "abcXYZdef", new: "abcQQQdef" (DELETE XYZ INSERT QQQ)
    const diffs = [
      [0 as const, "abc"] as const,
      [-1 as const, "XYZ"] as const,
      [1 as const, "QQQ"] as const,
      [0 as const, "def"] as const,
    ];
    const w = findHunkWindow(diffs, 3, 6, 9, 2);
    expect(w.start).toBeLessThanOrEqual(3);
    expect(w.end).toBeGreaterThanOrEqual(6);
  });
});

describe("alignMatchedText — Blocker 2 fix", () => {
  test("trims leading whitespace the old quote did not have", () => {
    // Old quote starts with a letter; the "candidate" start position
    // is one byte before, on a leading `\n`. Alignment must trim it.
    const oldQuote = "hello";
    const newSrc = "\nhello\n";
    const { startOffset, matchedText } = alignMatchedText(oldQuote, newSrc, 0);
    expect(startOffset).toBe(1);
    expect(matchedText).toBe("hello");
  });

  test("does NOT trim leading whitespace when the old quote begins with it", () => {
    const oldQuote = "\nhello";
    const newSrc = "\nhello world";
    const { matchedText } = alignMatchedText(oldQuote, newSrc, 0);
    expect(matchedText).toBe("\nhello");
  });

  test("does not spill into a following table row (trailing trim)", () => {
    const oldQuote = "| 5 | eve | open |";
    const newSrc = "| 5 | eve | open |\n| 6 | fred | open |";
    const { matchedText } = alignMatchedText(oldQuote, newSrc, 0);
    expect(matchedText).toBe("| 5 | eve | open |");
  });
});

describe("tryMove — deleted spans", () => {
  test("exactly one match in both old and new with sufficient context: returns the location", () => {
    const oldSrc = "before context here\n\nthe target phrase\n\nafter context here";
    const newSrc = "before context here\n\nthe target phrase\n\nafter context here";
    const quote = {
      exact: "the target phrase",
      prefix: "before context here\n\n",
      suffix: "\n\nafter context here",
    };
    const r = tryMove(oldSrc, newSrc, quote);
    expect(r).not.toBeNull();
    if (r === null) return;
    expect(r.start).toBe(newSrc.indexOf("the target phrase"));
  });

  test("insufficient context: refuses even a lone match", () => {
    const quote = { exact: "hi", prefix: "", suffix: "" };
    const r = tryMove("hi", "hi", quote);
    expect(r).not.toBeNull();
    if (r === null) return;
    expect(r.start).toBe(-1);
    expect(r.reason).toContain("insufficient context");
  });

  test("multiple exact-context matches in new: refuses (ambiguous new)", () => {
    const block = "prefix line abcdef\n\ntarget phrase content\n\nsuffix line ghijkl";
    const oldSrc = block;
    const newSrc = block + "\n\n\n" + block;
    const quote = {
      exact: "target phrase content",
      prefix: "prefix line abcdef\n\n",
      suffix: "\n\nsuffix line ghijkl",
    };
    const r = tryMove(oldSrc, newSrc, quote);
    expect(r).not.toBeNull();
    if (r === null) return;
    expect(r.start).toBe(-1);
    expect(r.reason).toContain("ambiguous");
  });

  test("multiple exact-context matches in OLD (copy-pasted block): refuses (round-3 blocker fix)", () => {
    const block = "prefix line abcdef\n\ntarget phrase content\n\nsuffix line ghijkl";
    // Two copies in old, one copy left in new.
    const oldSrc = block + "\n\n\n" + block;
    const newSrc = block;
    const quote = {
      exact: "target phrase content",
      prefix: "prefix line abcdef\n\n",
      suffix: "\n\nsuffix line ghijkl",
    };
    const r = tryMove(oldSrc, newSrc, quote);
    expect(r).not.toBeNull();
    if (r === null) return;
    expect(r.start).toBe(-1);
    expect(r.reason).toContain("not unique in the old snapshot");
  });

  test("pattern unique in old but absent in new: returns null (block deleted, no move)", () => {
    const quote = {
      exact: "the unique block",
      prefix: "leading context prose\n",
      suffix: "\ntrailing context prose",
    };
    const oldSrc = "leading context prose\nthe unique block\ntrailing context prose\n";
    const newSrc = "completely different content everywhere else in this file\n";
    expect(tryMove(oldSrc, newSrc, quote)).toBeNull();
  });
});

// ---------- Positive fixtures (must anchor correctly with defaults) ----------

describe("reanchor — positive: identity", () => {
  test("unchanged source: kind='anchored', method='unchanged'", async () => {
    const src = "hello\nworld\n";
    const anchor = await anchorForSource("x.mdx", src, 1, 1);
    const result = await reanchor(anchor, src, src);
    expect(result.kind).toBe("anchored");
  });
});

describe("reanchor — positive fixtures", () => {
  const SAMPLE = [
    "# Title", //                                                             L1
    "", //                                                                    L2
    "Introductory paragraph that sets up the important quote below.", //      L3
    "", //                                                                    L4
    "The important quote lives on this line and is uniquely worded.", //      L5
    "", //                                                                    L6
    "Trailing paragraph that follows the important quote.", //                L7
    "", //                                                                    L8
  ].join("\n");

  test("lines inserted above: quote-exact via diff-map, correct new range", async () => {
    const anchor = await anchorForSource("x.mdx", SAMPLE, 5, 5);
    const prefixed = "## Extra section\n\nextra prose here\n\n" + SAMPLE;
    const result = await reanchor(anchor, SAMPLE, prefixed);
    expect(result.kind).toBe("moved");
    if (result.kind !== "moved") return;
    expect(result.anchor.quote.exact).toBe(
      "The important quote lives on this line and is uniquely worded.",
    );
    expectCoherent(result, prefixed);
  });

  test("unique block moved far in a large file: quote-exact via move detection", async () => {
    const filler = Array.from({ length: 200 }, (_, i) => `filler line ${i}`).join("\n");
    const oldSrc = SAMPLE + "\n" + filler + "\n";
    const newSrc = filler + "\n" + SAMPLE;
    const anchor = await anchorForSource("x.mdx", oldSrc, 5, 5);
    const result = await reanchor(anchor, oldSrc, newSrc);
    expect(result.kind).toBe("moved");
    if (result.kind !== "moved") return;
    expectCoherent(result, newSrc);
  });

  test("one-word edit inside a unique quote: fuzzy at the right place", async () => {
    const anchor = await anchorForSource("x.mdx", SAMPLE, 5, 5);
    const newSrc = SAMPLE.replace("uniquely", "distinctively");
    const result = await reanchor(anchor, SAMPLE, newSrc);
    expect(result.kind).toBe("fuzzy");
    if (result.kind !== "fuzzy") return;
    expect(result.anchor.quote.exact).toContain("distinctively");
    expect(newSrc).toContain(result.anchor.quote.exact);
    expectCoherent(result, newSrc);
  });

  test("edited-in-place quote while an unedited COPY exists elsewhere: lands on the edited place", async () => {
    // The reviewer's key case. The quote is edited at L5; an
    // unedited copy exists at L15. The pipeline must land on L5 via
    // the modified-hunk path, NOT jump to the L15 copy.
    const oldSrc = [
      "# Title",
      "",
      "prelude paragraph",
      "",
      "the target phrase lives here",
      "",
      "middle paragraph",
      "",
      "more middle content",
      "",
      "another paragraph in the middle",
      "",
      "yet more filler content",
      "",
      "the target phrase lives here",
      "",
      "trailer paragraph",
    ].join("\n");
    const newSrc = oldSrc.replace(
      "the target phrase lives here\n\nmiddle paragraph",
      "the modified phrase lives here\n\nmiddle paragraph",
    );
    const anchor = await anchorForSource("x.mdx", oldSrc, 5, 5);
    const result = await reanchor(anchor, oldSrc, newSrc);
    expect(result.kind).toBe("fuzzy");
    if (result.kind !== "fuzzy") return;
    expect(result.anchor.startLine).toBe(5);
    expect(result.anchor.quote.exact).toBe("the modified phrase lives here");
    expectCoherent(result, newSrc);
  });

  test("partial-line quote with a one-word edit: fuzzy at the right chars", async () => {
    const oldSrc = "prelude paragraph\n\nthe quick brown fox jumps over the fence\n\ntrailer";
    // Anchor JUST on the "brown fox" substring inside L3.
    const foxStart = oldSrc.indexOf("brown fox");
    const anchor = await partialAnchorForSource("x.mdx", oldSrc, foxStart, foxStart + "brown fox".length);
    const newSrc = oldSrc.replace("brown fox", "brown cat");
    const result = await reanchor(anchor, oldSrc, newSrc);
    expect(result.kind).toBe("fuzzy");
    if (result.kind !== "fuzzy") return;
    expect(result.anchor.quote.exact).toBe("brown cat");
    expectCoherent(result, newSrc);
  });

  test("CRLF new source: pipeline LF-normalises and anchors", async () => {
    const anchor = await anchorForSource("x.mdx", SAMPLE, 5, 5);
    const asCRLF = ("prepended\n" + SAMPLE).replace(/\n/g, "\r\n");
    const result = await reanchor(anchor, SAMPLE, asCRLF);
    expect(result.kind).toBe("moved");
  });

  test("CRLF/LF identity across a line-ending flip: anchored", async () => {
    const anchor = await anchorForSource("x.mdx", SAMPLE, 5, 5);
    const asCRLF = SAMPLE.replace(/\n/g, "\r\n");
    const result = await reanchor(anchor, SAMPLE, asCRLF);
    expect(result.kind).toBe("anchored");
  });

  test("no-trailing-LF source: last-line anchor still lands correctly", async () => {
    const oldSrc = "line one\nline two\nlast line without LF";
    const anchor = await anchorForSource("x.mdx", oldSrc, 3, 3);
    // Add a line above; the last line's content is unchanged.
    const newSrc = "prepended\n" + oldSrc;
    const result = await reanchor(anchor, oldSrc, newSrc);
    expect(result.kind).toBe("moved");
    if (result.kind !== "moved") return;
    expect(result.anchor.quote.exact).toBe("last line without LF");
    expectCoherent(result, newSrc);
  });

  test("two-step round trip: reanchor onto edit 1, edit again, reanchor onto edit 2", async () => {
    const src0 = [
      "# Title",
      "",
      "prelude paragraph goes first",
      "",
      "the distinctive block content that we anchor onto here",
      "",
      "middle body content follows next after the anchor",
      "",
      "trailer paragraph at the very end here",
    ].join("\n");
    const anchor0 = await anchorForSource("x.mdx", src0, 5, 5);

    const src1 = src0.replace("distinctive", "SLIGHTLY-different");
    const step1 = await reanchor(anchor0, src0, src1);
    expect(step1.kind === "fuzzy" || step1.kind === "moved").toBe(true);
    if (step1.kind === "orphaned" || step1.kind === "anchored") return;
    expectCoherent(step1, src1);

    const src2 = src1.replace("SLIGHTLY-different", "another-slight-change");
    const step2 = await reanchor(step1.anchor, src1, src2);
    expect(step2.kind === "fuzzy" || step2.kind === "moved").toBe(true);
    if (step2.kind === "orphaned" || step2.kind === "anchored") return;
    expectCoherent(step2, src2);
  });
});

// ---------- MUST-orphan fixtures ----------

describe("reanchor — MUST-orphan: reviewer's 7 repros", () => {
  const oldRepro = [
    "prelude paragraph one",
    "",
    "the deleted sentence goes here",
    "",
    "middle paragraph two",
    "",
    "even more middle content three",
    "",
    "the deleted sentence goes here",
    "",
    "trailer paragraph four",
  ].join("\n");

  test("(1) sentence deleted with a copy elsewhere: orphaned (does NOT jump to copy)", async () => {
    const anchor = await anchorForSource("x.mdx", oldRepro, 3, 3);
    // Delete L3; the copy at L9 (now L7) survives.
    const newSrc = oldRepro.split("\n").filter((_, i) => i !== 2 && i !== 3).join("\n");
    const result = await reanchor(anchor, oldRepro, newSrc);
    expect(result.kind).toBe("orphaned");
  });

  test("(2) 'Note:' style deleted with an unrelated 'Note:' elsewhere: orphaned", async () => {
    const oldSrc = [
      "intro paragraph",
      "",
      "Note: the original meaningful note",
      "",
      "middle body content follows",
      "",
      "Note: an unrelated later note about something else entirely",
      "",
      "trailer",
    ].join("\n");
    const anchor = await anchorForSource("x.mdx", oldSrc, 3, 3);
    const newSrc = oldSrc.split("\n").filter((_, i) => i !== 2 && i !== 3).join("\n");
    const result = await reanchor(anchor, oldSrc, newSrc);
    expect(result.kind).toBe("orphaned");
  });

  test("(3) 'deprecated' line deleted with another 'deprecated' elsewhere: orphaned", async () => {
    const oldSrc = [
      "release notes intro",
      "",
      "this feature is deprecated in v2 and will be removed",
      "",
      "middle content body prose here",
      "",
      "this feature is deprecated in v3 and reason differs entirely",
      "",
      "trailer content here",
    ].join("\n");
    const anchor = await anchorForSource("x.mdx", oldSrc, 3, 3);
    const newSrc = oldSrc.split("\n").filter((_, i) => i !== 2 && i !== 3).join("\n");
    const result = await reanchor(anchor, oldSrc, newSrc);
    expect(result.kind).toBe("orphaned");
  });

  test("(4) 'ship it' deleted with another 'ship it' elsewhere: orphaned", async () => {
    const oldSrc = [
      "release checklist",
      "",
      "do not ship it yet — waiting on the review",
      "",
      "checklist item two body prose",
      "",
      "do not ship it yet — this is a different reason",
      "",
      "trailer content here for size",
    ].join("\n");
    const anchor = await anchorForSource("x.mdx", oldSrc, 3, 3);
    const newSrc = oldSrc.split("\n").filter((_, i) => i !== 2 && i !== 3).join("\n");
    const result = await reanchor(anchor, oldSrc, newSrc);
    expect(result.kind).toBe("orphaned");
  });

  test("(5) copy-pasted section with the ORIGINAL deleted: orphaned (moves to copy would be wrong)", async () => {
    const commonBlock = "the original block of prose content that we anchor upon";
    const oldSrc = [
      "prelude here for sure",
      "",
      commonBlock,
      "",
      "middle body content prose",
      "",
      "later on things happen",
      "",
      commonBlock,
      "",
      "trailer content prose here",
    ].join("\n");
    const anchor = await anchorForSource("x.mdx", oldSrc, 3, 3);
    // Delete the original at L3; L9's copy remains.
    const newSrc = oldSrc.split("\n").filter((_, i) => i !== 2 && i !== 3).join("\n");
    const result = await reanchor(anchor, oldSrc, newSrc);
    expect(result.kind).toBe("orphaned");
  });

  test("(6) short-context bare-quote copy: refused even though a lone match exists", async () => {
    // Deleted a short quote; a copy of the bare `exact` exists
    // elsewhere but with different surrounding text.
    const oldSrc = "prelude\n\ndone\n\nmiddle body content\n\ndone\n\ntrailer";
    const anchor = await anchorForSource("x.mdx", oldSrc, 3, 3);
    // Delete L3 "done". L7 has another "done" but different context.
    const newSrc = "prelude\n\nmiddle body content\n\ndone\n\ntrailer";
    const result = await reanchor(anchor, oldSrc, newSrc);
    expect(result.kind).toBe("orphaned");
  });

  test("(7) quote is only present as SUBSTRING of a longer new sentence: does not fuzzy-jump", async () => {
    const oldSrc = "prelude paragraph one\n\nthe magic phrase we care about\n\ntrailer content";
    const anchor = await anchorForSource("x.mdx", oldSrc, 3, 3);
    // The old L3 is deleted; a new sentence in a different place
    // CONTAINS it as a substring.
    const newSrc =
      "prelude paragraph one\n\nunrelated new content sentence goes here\n\nas noted, the magic phrase we care about is no longer canonical\n\ntrailer content";
    const result = await reanchor(anchor, oldSrc, newSrc);
    // The `prefix + exact + suffix` won't match here because context
    // differs, and no other stage should jump to the substring.
    expect(result.kind).toBe("orphaned");
  });
});

describe("reanchor — MUST-orphan: templated sweep (5 templates × 16 rows, 0 of 80 misanchored)", () => {
  const templates: Array<(row: string, ordinal: string) => string> = [
    (r) => `- \`--${r}\`: enables the ${r} mode for the build`,
    (r, o) => `| ${o} | ${r} | active | production |`,
    (r) => `${r}:\n  enabled: true\n  mode: production`,
    (r) => `sum += arr[${r}]; // process ${r}`,
    (r) => `- [${r}](https://example.com/${r}) — the ${r} reference`,
  ];
  const rows = [
    "alpha",
    "bravo",
    "charlie",
    "delta",
    "echo",
    "foxtrot",
    "golf",
    "hotel",
    "india",
    "juliet",
    "kilo",
    "lima",
    "mike",
    "november",
    "oscar",
    "papa",
  ];

  test("every (template, row) combination orphans when its own row is deleted", async () => {
    let misanchored = 0;
    for (const [tIdx, template] of templates.entries()) {
      const built = rows.map((r, i) => template(r, String(i + 1)));
      const oldSrc = built.join("\n") + "\n";
      for (const [rIdx, row] of rows.entries()) {
        // The target row is 1-indexed lineNumber for anchor. In YAML
        // template, each entry spans 3 lines; in others, one line.
        const targetLine = tIdx === 2 ? rIdx * 3 + 1 : rIdx + 1;
        const anchor = await anchorForSource("x.mdx", oldSrc, targetLine, targetLine);
        const withoutRow = rows.filter((_, i) => i !== rIdx);
        const newSrc = withoutRow.map((r, i) => template(r, String(i + 1))).join("\n") + "\n";
        const result = await reanchor(anchor, oldSrc, newSrc);
        if (result.kind !== "orphaned") misanchored += 1;
        void row;
      }
    }
    expect(misanchored).toBe(0);
  }, 30_000);
});

describe("reanchor — MUST-orphan: pathological cases", () => {
  test("1 MB templated file with the anchored line deleted: orphaned quickly", async () => {
    const template = (i: number) =>
      `- item ${i}: this is a very repetitive templated entry that repeats the same phrasing for uniformity`;
    const N = 10_000;
    const lines: string[] = [];
    for (let i = 0; i < N; i += 1) lines.push(template(i));
    const oldSrc = lines.join("\n") + "\n";
    const anchor = await anchorForSource("x.mdx", oldSrc, 5001, 5001);
    const newSrc = lines.slice(0, 5000).concat(lines.slice(5001)).join("\n") + "\n";
    const result = await reanchor(anchor, oldSrc, newSrc);
    expect(result.kind).toBe("orphaned");
  }, 30_000);
});

// ---------- Coherent-anchor invariant matrix ----------

describe("reanchor — coherent-anchor invariant across all non-orphan results", () => {
  test("every non-orphan result satisfies the invariant on every fixture", async () => {
    const cases: Array<{ old: string; neu: string; startLine: number }> = [
      { old: "hello\nworld\nfoo\n", neu: "hello\nworld\nfoo\n", startLine: 2 },
      { old: "hello\nworld\nfoo\n", neu: "prefix\nhello\nworld\nfoo\n", startLine: 2 },
      { old: "one line only", neu: "one line only", startLine: 1 },
      { old: "a\nquote here longer\nb\n", neu: "a\nquote here longer\nb\n", startLine: 2 },
    ];
    for (const c of cases) {
      const anchor = await anchorForSource("x.mdx", c.old, c.startLine, c.startLine);
      const result = await reanchor(anchor, c.old, c.neu);
      expectCoherent(result, c.neu);
    }
  });
});

// ---------- Performance guards ----------

describe("reanchor — performance", () => {
  // Bounds tightened after the round-3 rewrite: measured medians on
  // both fixtures are single-digit milliseconds; 200 ms leaves ~20x
  // headroom for a busy CI runner.
  const PERF_LIMIT_MS = 200;

  test("< 200 ms on 20k templated `- item N` lines with anchor deleted", async () => {
    const N = 20_000;
    const lines: string[] = [];
    for (let i = 0; i < N; i += 1) lines.push(`- item ${i} in a templated bullet list`);
    const oldSrc = lines.join("\n") + "\n";
    const anchor = await anchorForSource("x.mdx", oldSrc, 10_001, 10_001);
    const newSrc = lines.slice(0, 10_000).concat(lines.slice(10_001)).join("\n") + "\n";
    const t0 = performance.now();
    await reanchor(anchor, oldSrc, newSrc);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(PERF_LIMIT_MS);
  }, 30_000);

  test("< 200 ms on the pathological 200 k `a` case with quote `aaaaaaaa`", async () => {
    const oldSrc = "a".repeat(200_000);
    const anchor: Anchor = {
      path: "x.mdx",
      startLine: 1,
      endLine: 1,
      quote: {
        exact: "aaaaaaaa",
        prefix: "aaaaaaaa",
        suffix: "aaaaaaaa",
      },
      revision: await revisionOf(oldSrc),
    };
    const newSrc = oldSrc.slice(0, 100_000) + oldSrc.slice(100_008); // delete 8 chars
    const t0 = performance.now();
    const result = await reanchor(anchor, oldSrc, newSrc);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(PERF_LIMIT_MS);
    void result;
  }, 30_000);
});

// ---------- Round-3 review: K1 / K3 / J7b (copy-pasted blocks) ----------

describe("reanchor — MUST-orphan: copy-pasted blocks (K1 / K3 / J7b)", () => {
  const blk =
    "### Step\n\nPlease read this carefully first.\nRun the installer and restart.\nThen continue with the setup guide.\n\n";

  test("K1: two identical sections; Linux copy deleted → orphaned (does not move to macOS copy)", async () => {
    const oldSrc = "# Linux\n\n" + blk + "# macOS\n\n" + blk;
    // Anchor on the Linux copy (first occurrence).
    const anchor = await anchorForSource("x.mdx", oldSrc, 3, 3);
    // Delete the Linux block, keep macOS block.
    const newSrc = "# Linux\n\n\n# macOS\n\n" + blk;
    const result = await reanchor(anchor, oldSrc, newSrc);
    expect(result.kind).toBe("orphaned");
  });

  test("K3: Linux copy rewritten in place while macOS copy is untouched → does NOT jump onto the macOS copy", async () => {
    const oldSrc = "# Linux\n\n" + blk + "# macOS\n\n" + blk;
    const anchor = await anchorForSource("x.mdx", oldSrc, 3, 3);
    // Rewrite the first (Linux) block; the second (macOS) is intact.
    const newSrc =
      "# Linux\n\n### Step\n\nUse apt; no reboot.\n\n" + "# macOS\n\n" + blk;
    const result = await reanchor(anchor, oldSrc, newSrc);
    // The Linux header (`### Step`) is intact in place, and its
    // surrounding boundary class is preserved (still a line-anchored
    // header). Anchoring back to L3 is CORRECT — the reader sees
    // the header + the rewritten body (which is likely the answer
    // to the comment). What the pipeline must never do is jump to
    // the untouched macOS copy of `### Step`.
    if (result.kind === "moved" || result.kind === "fuzzy") {
      // The macOS `### Step` sits well below line 3; the Linux one
      // stays at line 3.
      expect(result.anchor.startLine).toBeLessThan(6);
    }
  });

  test("J7b: a paragraph plus its copy, quoted phrase heavily rewritten in the first → orphaned", async () => {
    const oldSrc = [
      "# Alpha section",
      "",
      "The distinctive paragraph we anchor on.",
      "",
      "Later in the doc:",
      "",
      "# Beta section",
      "",
      "The distinctive paragraph we anchor on.",
      "",
      "trailer content here",
    ].join("\n");
    // Anchor on the first copy.
    const anchor = await anchorForSource("x.mdx", oldSrc, 3, 3);
    // Heavily rewrite the first copy; leave the second copy intact.
    const newSrc = oldSrc.replace(
      "The distinctive paragraph we anchor on.\n\nLater in the doc:",
      "A completely rewritten sentence about something else.\n\nLater in the doc:",
    );
    const result = await reanchor(anchor, oldSrc, newSrc);
    expect(result.kind).toBe("orphaned");
  });
});

// ---------- Prepared-context (diff-once) ----------

describe("prepareReanchor + reanchorWith — one diff for N anchors", () => {
  test("N anchors on one big (old, new) pair share the diff", async () => {
    // ~200 KB base to make the diff cost measurable.
    const base = "line ".repeat(40_000); // 200 000 chars
    const oldSrc = base + "\nline A\nline B\nline C\n";
    const newSrc = base + "\nline A\nline B changed\nline C\n";
    const N = 8;
    const anchor: Anchor = {
      path: "x.mdx",
      startLine: 1,
      endLine: 1,
      quote: {
        exact: "line B",
        prefix: base.slice(-40) + "\nline A\n",
        suffix: "\nline C\n",
      },
      revision: await revisionOf(oldSrc),
    };

    // Prepared: one diff, N alignments.
    const t0 = performance.now();
    const ctx = await prepareReanchor(oldSrc, newSrc);
    for (let i = 0; i < N; i += 1) await reanchorWith(ctx, anchor);
    const dtPrepared = performance.now() - t0;

    // Naive: N diffs, N alignments.
    const t1 = performance.now();
    for (let i = 0; i < N; i += 1) await reanchor(anchor, oldSrc, newSrc);
    const dtNaive = performance.now() - t1;

    // The naive path should be substantially more expensive because
    // it repeats the diff. Require at least a 2x savings — small
    // enough not to flake on a busy runner, large enough that the
    // amortisation is measurable.
    expect(dtPrepared * 2).toBeLessThan(dtNaive);
  }, 30_000);
});

// ---------- Mutation-guarding fixtures with DEFAULTS ----------
//
// The reviewer's round-3 concern: several surviving mutations have
// no default-settings test. Each test below is designed to fail if
// the named default is dropped or the named stage is removed. All
// call `reanchor(anchor, old, new)` with no options.

describe("reanchor — mutation guards (default settings)", () => {
  test("snapshot revision check: wrong old source orphans with a 'revision mismatch' reason", async () => {
    const oldSrc = "A\n\nB\n\nC\n";
    const anchor = await anchorForSource("x.mdx", oldSrc, 3, 3);
    const wrongSnapshot = "completely different content\n";
    const newSrc = "A\n\nB modified\n\nC\n";
    const result = await reanchor(anchor, wrongSnapshot, newSrc);
    expect(result.kind).toBe("orphaned");
    if (result.kind !== "orphaned") return;
    // The snapshot check produces the specific `revision mismatch`
    // reason with hash prefixes. If the check is removed, the
    // pipeline runs the diff on the wrong text and orphans with a
    // different reason (e.g. `old anchor span not found`), so the
    // exact-substring assertion trips.
    expect(result.reason).toContain("revision mismatch");
  });

  test("exact-text check on unchanged spans: INSERT inside the mapped range falls through to orphan", async () => {
    // Anchor on "abc" (no context — a bare quote). New source
    // inserts an "X" between the "a" and "bc"; diff sees this as
    // EQUAL "a", INSERT "X", EQUAL "bcdef", so classifySpan says
    // UNCHANGED. Without the `mapped === anchor.quote.exact` check
    // the pipeline would return a `moved` result with a wrong new
    // range; with the check, we fall through to tryMove which
    // orphans because the anchor's context is empty.
    const oldSrc = "abcdef\n";
    const newSrc = "aXbcdef\n";
    const anchor: Anchor = {
      path: "x.mdx",
      startLine: 1,
      endLine: 1,
      quote: { exact: "abc", prefix: "", suffix: "" },
      revision: await revisionOf(oldSrc),
    };
    const result = await reanchor(anchor, oldSrc, newSrc);
    expect(result.kind).toBe("orphaned");
  });

  test("MIN_MOVE_CONTEXT gate: a short-context anchor refuses a move even to a unique lone copy", async () => {
    // The `abcfoo12` pattern is unique in BOTH old and new (a shift
    // to a different line), so old-uniqueness and new-uniqueness
    // both PASS. The only thing keeping this from anchoring is the
    // context-length gate — 2 mid-line non-whitespace chars, well
    // under DEFAULT_MIN_MOVE_CONTEXT = 16. With the gate at 0 the
    // pipeline would move onto the shifted line.
    const oldSrc = "abcfoo12 first place\nother content lines\n";
    const newSrc = "other content lines\ninterstitial paragraph\nabcfoo12 shifted place\n";
    const anchor: Anchor = {
      path: "x.mdx",
      startLine: 1,
      endLine: 1,
      quote: { exact: "cfoo", prefix: "ab", suffix: "12" },
      revision: await revisionOf(oldSrc),
    };
    const result = await reanchor(anchor, oldSrc, newSrc);
    expect(result.kind).toBe("orphaned");
  });

  test("modified-path quote gate: a 50%-preserved-plus-big-INSERT edit orphans", async () => {
    // Construct a span where EQUAL preservation is ≥ 0.5 (so the
    // demotion does NOT fire), but the aligned text has a huge
    // trailing INSERT that pushes similarity below the gate.
    //
    // Old span (line 3) is 10 chars "abcdefghij"; the new source
    // keeps the first 5 chars ("abcde") and replaces the last 5
    // ("fghij") with a much longer inserted string.
    const oldSrc = "prelude paragraph\n\nabcdefghij\n\ntrailer\n";
    const newSrc =
      "prelude paragraph\n\nabcdeQQQQQQQQQQQQQQQQQQQQ\n\ntrailer\n";
    const anchor = await anchorForSource("x.mdx", oldSrc, 3, 3);
    const result = await reanchor(anchor, oldSrc, newSrc);
    // If the modified-path quote gate is removed, the aligned text
    // "abcdeQQQQQQQQQQQQQQQQQQQQ" would be accepted (its similarity
    // to "abcdefghij" is well under 0.4).
    expect(result.kind).toBe("orphaned");
  });

  test("old-uniqueness in tryMove: identical-surroundings copies + first deletion orphans (round-3 blocker)", async () => {
    // Both copies of the block have the SAME 40-char surroundings, so
    // the full `prefix + exact + suffix` pattern is IDENTICAL for
    // both copies. Without the OLD-uniqueness check, the pipeline
    // would move onto the surviving copy after the first is
    // deleted.
    const commonSurroundings =
      "filler line one to fill the anchor prefix and suffix contexts fully so both copies present the same 40-char pattern to tryMove\n" +
      "filler line two also filling the context so both copies present the same 40-char pattern to tryMove\n";
    const commonBlock =
      commonSurroundings +
      "the distinct block content that we anchor onto here for the K1 style test\n" +
      commonSurroundings;
    // Anchor the first copy's distinct line.
    const oldSrc = commonBlock + "\ninterstitial content\n\n" + commonBlock + "\nfile tail content\n";
    // The distinct line is at line 3 of `oldSrc`.
    const anchor = await anchorForSource("x.mdx", oldSrc, 3, 3);
    // Delete the FIRST copy of commonBlock.
    const newSrc = "\ninterstitial content\n\n" + commonBlock + "\nfile tail content\n";
    const result = await reanchor(anchor, oldSrc, newSrc);
    expect(result.kind).toBe("orphaned");
    if (result.kind !== "orphaned") return;
    // Sanity: the orphan reason names the old-side ambiguity — proof
    // that the round-3 check is what caught it.
    expect(result.reason).toContain("not unique in the old snapshot");
  });
});

// ---------- Round-5: B1–B15 (nearby edits) ----------
//
// The round-4 8-byte context check was too strict: any edit within
// 8 chars of an unchanged quote orphaned the comment. These are
// exactly the edits a comment causes. The round-5 unchanged path
// keeps only the line-boundary-class boundary check, so an
// unchanged quote that stayed in the same class of surrounding
// (mid-line vs line-boundary) re-anchors to the right chars while
// a class change (E3 substring accident) still orphans.

describe("reanchor — round-5 nearby-edit fixtures (must re-anchor with defaults)", () => {
  /** Assert that `result` re-anchored at the given new-source offset
   * with the given exact text. */
  function expectAnchoredAt(
    result: ReanchorResult,
    newSource: string,
    expectedStart: number,
    expectedExact: string,
  ): void {
    expect(result.kind === "moved" || result.kind === "fuzzy").toBe(true);
    if (result.kind !== "moved" && result.kind !== "fuzzy") return;
    expect(result.anchor.quote.exact).toBe(expectedExact);
    const actualStart = newSource.indexOf(result.anchor.quote.exact);
    expect(actualStart).toBe(expectedStart);
  }

  test("B1: previous word edited (`must`→`should`) — anchor stays on `validate`", async () => {
    const oldSrc = "You must validate every input on the site.";
    const newSrc = "You should validate every input on the site.";
    const start = oldSrc.indexOf("validate");
    const anchor = await partialAnchorForSource(
      "x.mdx",
      oldSrc,
      start,
      start + "validate".length,
    );
    const result = await reanchor(anchor, oldSrc, newSrc);
    expectAnchoredAt(result, newSrc, newSrc.indexOf("validate"), "validate");
  });

  test("B2: next word edited (`every`→`all`) — anchor stays on `validate`", async () => {
    const oldSrc = "You must validate every input on the site.";
    const newSrc = "You must validate all input on the site.";
    const start = oldSrc.indexOf("validate");
    const anchor = await partialAnchorForSource(
      "x.mdx",
      oldSrc,
      start,
      start + "validate".length,
    );
    const result = await reanchor(anchor, oldSrc, newSrc);
    expectAnchoredAt(result, newSrc, newSrc.indexOf("validate"), "validate");
  });

  test("B3: word two away edited (`input`→`field`) — anchor stays on `validate`", async () => {
    const oldSrc = "You must validate every input on the site.";
    const newSrc = "You must validate every field on the site.";
    const start = oldSrc.indexOf("validate");
    const anchor = await partialAnchorForSource(
      "x.mdx",
      oldSrc,
      start,
      start + "validate".length,
    );
    const result = await reanchor(anchor, oldSrc, newSrc);
    expectAnchoredAt(result, newSrc, newSrc.indexOf("validate"), "validate");
  });

  test("B4: punctuation after (`site.` → `site!`) — anchor stays on `validate`", async () => {
    const oldSrc = "You must validate every input on the site.";
    const newSrc = "You must validate every input on the site!";
    const start = oldSrc.indexOf("validate");
    const anchor = await partialAnchorForSource(
      "x.mdx",
      oldSrc,
      start,
      start + "validate".length,
    );
    const result = await reanchor(anchor, oldSrc, newSrc);
    expectAnchoredAt(result, newSrc, newSrc.indexOf("validate"), "validate");
  });

  test("B5: typo fix before (`teh`→`the`) — anchor stays on `validate`", async () => {
    const oldSrc = "On teh site you validate every input.";
    const newSrc = "On the site you validate every input.";
    const start = oldSrc.indexOf("validate");
    const anchor = await partialAnchorForSource(
      "x.mdx",
      oldSrc,
      start,
      start + "validate".length,
    );
    const result = await reanchor(anchor, oldSrc, newSrc);
    expectAnchoredAt(result, newSrc, newSrc.indexOf("validate"), "validate");
  });

  test("B7: start of file, next word edited — anchor stays on `validate`", async () => {
    const oldSrc = "validate all inputs at the start.";
    const newSrc = "validate every input at the start.";
    const start = 0;
    const anchor = await partialAnchorForSource(
      "x.mdx",
      oldSrc,
      start,
      start + "validate".length,
    );
    const result = await reanchor(anchor, oldSrc, newSrc);
    expectAnchoredAt(result, newSrc, 0, "validate");
  });

  test("B9: end of file, previous word edited — anchor stays on `validate`", async () => {
    const oldSrc = "at the end, must validate";
    const newSrc = "at the end, should validate";
    const start = oldSrc.indexOf("validate");
    const anchor = await partialAnchorForSource(
      "x.mdx",
      oldSrc,
      start,
      start + "validate".length,
    );
    const result = await reanchor(anchor, oldSrc, newSrc);
    expectAnchoredAt(result, newSrc, newSrc.indexOf("validate"), "validate");
  });

  test("B10: double space collapsed adjacent to the quote — anchor stays on `validate`", async () => {
    const oldSrc = "must  validate  every input on the site.";
    const newSrc = "must validate every input on the site.";
    const start = oldSrc.indexOf("validate");
    const anchor = await partialAnchorForSource(
      "x.mdx",
      oldSrc,
      start,
      start + "validate".length,
    );
    const result = await reanchor(anchor, oldSrc, newSrc);
    expectAnchoredAt(result, newSrc, newSrc.indexOf("validate"), "validate");
  });

  test("B12: CRLF file with a neighbour word edited — anchor stays on `validate`", async () => {
    const oldSrc = "line one\nYou must validate every input\nline three\n";
    const newSrc = "line one\r\nYou should validate every input\r\nline three\r\n";
    const start = oldSrc.indexOf("validate");
    const anchor = await partialAnchorForSource(
      "x.mdx",
      oldSrc,
      start,
      start + "validate".length,
    );
    const result = await reanchor(anchor, oldSrc, newSrc);
    // The pipeline LF-normalises internally, so `validate` still
    // lives at the same LF offset as if the file were LF-only.
    const newLF = newSrc.replace(/\r\n?/g, "\n");
    expectAnchoredAt(result, newLF, newLF.indexOf("validate"), "validate");
  });

  test("B15: `**validate**` emphasis added around the quote — anchor stays on `validate`", async () => {
    const oldSrc = "You must validate every input on the site.";
    const newSrc = "You must **validate** every input on the site.";
    const start = oldSrc.indexOf("validate");
    const anchor = await partialAnchorForSource(
      "x.mdx",
      oldSrc,
      start,
      start + "validate".length,
    );
    const result = await reanchor(anchor, oldSrc, newSrc);
    expectAnchoredAt(result, newSrc, newSrc.indexOf("validate"), "validate");
  });
});

// ---------- Round-5: mutation guards for the boundary-class check ----------

describe("reanchor — round-5 mutation: boundary-class check earns its place", () => {
  // The line-boundary-class check on the unchanged path is
  // load-bearing: it distinguishes the E3 substring accident (line-
  // anchored old, mid-sentence in new) from a nearby edit like B1
  // (mid-line both sides). Mutating the check to always-pass makes
  // E3 wrongly quote-exact; mutating it to always-fail sends B1 to
  // move detection where the changed prefix fails the exact-context
  // check and orphans.
  //
  // These tests do NOT flip the check themselves; they document
  // that the two fixtures below are the ones a mutation of the
  // check would turn red. See the PR body for the verified-
  // mutation mapping.
  test("E3 substring accident stays orphan under the boundary-class check", async () => {
    const oldSrc = "prelude paragraph one\n\nthe magic phrase\n\ntrailer content";
    const anchor = await anchorForSource("x.mdx", oldSrc, 3, 3);
    const newSrc =
      "prelude paragraph one\n\nas noted, the magic phrase is no longer canonical\n\ntrailer content";
    const result = await reanchor(anchor, oldSrc, newSrc);
    expect(result.kind).toBe("orphaned");
  });

  test("B1 nearby edit anchors correctly under the boundary-class check", async () => {
    const oldSrc = "You must validate every input on the site.";
    const newSrc = "You should validate every input on the site.";
    const start = oldSrc.indexOf("validate");
    const anchor = await partialAnchorForSource(
      "x.mdx",
      oldSrc,
      start,
      start + "validate".length,
    );
    const result = await reanchor(anchor, oldSrc, newSrc);
    expect(result.kind === "moved" || result.kind === "fuzzy").toBe(true);
  });
});

// ---------- reanchorEvent shape ----------

describe("reanchorEvent", () => {
  const dummyAnchor: Anchor = {
    path: "docs/x.md",
    startLine: 5,
    endLine: 5,
    quote: { exact: "hi", prefix: "", suffix: "" },
    revision: "a".repeat(64),
  };

  test("kind='anchored' → null (no event)", () => {
    const result: ReanchorResult = { kind: "anchored", anchor: dummyAnchor, method: "unchanged" };
    expect(reanchorEvent("th-1", AGENT, result)).toBeNull();
  });

  test("kind='moved' → thread.reanchored with quote-exact, no score", () => {
    const result: ReanchorResult = { kind: "moved", anchor: dummyAnchor, method: "quote-exact" };
    const event = reanchorEvent("th-1", AGENT, result);
    expect(event).not.toBeNull();
    if (event === null) return;
    expect(event.kind).toBe("thread.reanchored");
    expect((event as { score?: number }).score).toBeUndefined();
  });

  test("kind='fuzzy' → thread.reanchored with method='fuzzy' and score", () => {
    const result: ReanchorResult = {
      kind: "fuzzy",
      anchor: dummyAnchor,
      method: "fuzzy",
      score: 0.82,
    };
    const event = reanchorEvent("th-1", AGENT, result);
    expect(event).not.toBeNull();
    if (event === null) return;
    expect(event).toMatchObject({
      kind: "thread.reanchored",
      threadId: "th-1",
      method: "fuzzy",
      score: 0.82,
    });
  });

  test("empty threadId is refused", () => {
    const result: ReanchorResult = { kind: "moved", anchor: dummyAnchor, method: "quote-exact" };
    expect(() => reanchorEvent("", AGENT, result)).toThrow();
  });
});

// Keep the DEFAULT_MIN_MOVE_CONTEXT export exercised so removing it
// fails at compile time, not only at runtime.
void DEFAULT_MIN_MOVE_CONTEXT;
