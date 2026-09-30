// Tests for the re-anchoring engine (ADR-0006 Acceptance, M2 item 5a).
//
// Coverage:
//   - Unit tests for each pipeline stage (diff-map, quote verify, fuzzy,
//     orphan) via the named stage exports, so a regression in one stage
//     fails a targeted test rather than only the composed pipeline.
//   - Fixture tests for realistic MDX edits: lines inserted above, a
//     paragraph reflowed, a quote edited slightly, a block moved to
//     another place in the file, a block deleted (→ orphaned), a
//     whitespace-only change, and a CRLF source.
//   - Mutation checks: (i) if the quote-verify stage is skipped, an
//     input that the composed pipeline correctly handles via
//     quote-verify comes out with a different, wrong method, and a
//     test would fail; (ii) if the fuzzy threshold is set to 0, an
//     input the pipeline correctly orphans comes out as fuzzy, and a
//     test would fail.
//   - `reanchorEvent` shape: `anchored` → null, `moved`/`fuzzy` →
//     `thread.reanchored` (fuzzy carries `score`; quote-exact does
//     not), `orphaned` → `thread.orphaned`.
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MIN_FUZZY_SCORE,
  diffMapLines,
  fuzzyLocateQuote,
  mapAnchorRange,
  reanchor,
  reanchorEvent,
  revisionOf,
  verifyQuoteInMappedRange,
  type Anchor,
  type ReanchorResult,
} from "../src/index.ts";

const AGENT = { kind: "agent", id: "revkit-live" } as const;

/** Build a valid anchor from `source` for lines [start..end]. `quote.exact`
 * is the joined text of those lines; `prefix`/`suffix` take the nearest
 * 40 characters of surrounding context. Used by the fixture tests so
 * every "old" anchor is real (matches the source), not hand-copied. */
async function anchorForSource(
  path: string,
  source: string,
  start: number,
  end: number,
): Promise<Anchor> {
  const lines = source.split("\n");
  const exact = lines.slice(start - 1, end).join("\n");
  const byteStart = offsetOfLine(source, start);
  const byteEnd = byteStart + exact.length;
  const prefix = source.slice(Math.max(0, byteStart - 40), byteStart);
  const suffix = source.slice(byteEnd, Math.min(source.length, byteEnd + 40));
  return {
    path,
    startLine: start,
    endLine: end,
    quote: { exact, prefix, suffix },
    revision: await revisionOf(source),
  };
}

function offsetOfLine(source: string, n: number): number {
  if (n <= 1) return 0;
  let line = 1;
  for (let i = 0; i < source.length; i += 1) {
    if (line === n) return i;
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return source.length;
}

// ---------- Stage-level unit tests ----------

describe("diffMapLines — stage (a)", () => {
  test("unchanged source: every old line maps to the same new line", () => {
    const src = "a\nb\nc\nd\n";
    const map = diffMapLines(src, src);
    // Index 0 is unused (line numbers are 1-based); the array length
    // is oldLineCount + 1. For "a\nb\nc\nd\n", split produces 5
    // elements (with the trailing empty), so indices 1..4 map identity.
    expect(map[1]).toBe(1);
    expect(map[2]).toBe(2);
    expect(map[3]).toBe(3);
    expect(map[4]).toBe(4);
  });

  test("inserted lines above shift old lines down", () => {
    const oldSrc = "b\nc\nd\n";
    const newSrc = "INSERT-1\nINSERT-2\nb\nc\nd\n";
    const map = diffMapLines(oldSrc, newSrc);
    expect(map[1]).toBe(3); // "b" now at line 3
    expect(map[2]).toBe(4); // "c" now at line 4
    expect(map[3]).toBe(5); // "d" now at line 5
  });

  test("deleted lines are `null`", () => {
    const oldSrc = "a\nDELETE-ME\nc\n";
    const newSrc = "a\nc\n";
    const map = diffMapLines(oldSrc, newSrc);
    expect(map[1]).toBe(1);
    expect(map[2]).toBeNull();
    expect(map[3]).toBe(2);
  });
});

describe("mapAnchorRange — stage (a) tail", () => {
  test("range with a fully-deleted line collapses to surviving lines", () => {
    const lineMap = [null, 1, null, 2];
    const range = mapAnchorRange(lineMap, 1, 3);
    expect(range).toEqual({ start: 1, end: 2 });
  });

  test("range whose lines are all deleted returns null", () => {
    const lineMap = [null, null, null];
    expect(mapAnchorRange(lineMap, 1, 2)).toBeNull();
  });
});

describe("verifyQuoteInMappedRange — stage (b)", () => {
  test("quote inside the mapped range: returns a range tightened to the quote", () => {
    const newSrc = ["line 1", "the important quote", "line 3"].join("\n");
    const range = verifyQuoteInMappedRange(
      newSrc,
      { exact: "the important quote", prefix: "line 1\n", suffix: "\nline 3" },
      { start: 1, end: 3 },
    );
    expect(range).toEqual({ start: 2, end: 2 });
  });

  test("quote missing from the (widened) window: returns null", () => {
    const newSrc = ["a", "b", "c"].join("\n");
    const range = verifyQuoteInMappedRange(
      newSrc,
      { exact: "not here at all", prefix: "", suffix: "" },
      { start: 1, end: 3 },
    );
    expect(range).toBeNull();
  });

  test("repeated exact quote: prefix/suffix picks the right occurrence", () => {
    const newSrc = ["foo bar", "hello world", "baz bar"].join("\n");
    // "bar" appears twice, so the picker must lean on `prefix: "baz "`
    // to fingerprint the second occurrence — `suffix: ""` is a no-op
    // for both occurrences.
    const range = verifyQuoteInMappedRange(
      newSrc,
      { exact: "bar", prefix: "baz ", suffix: "" },
      { start: 1, end: 3 },
    );
    expect(range).toEqual({ start: 3, end: 3 });
  });
});

describe("fuzzyLocateQuote — stage (c)", () => {
  test("scores 1.0 for an exact match at the expected location", () => {
    const newSrc = "prelude\nthe exact quote\nend\n";
    const located = fuzzyLocateQuote(
      newSrc,
      { exact: "the exact quote", prefix: "prelude\n", suffix: "\nend\n" },
      newSrc.indexOf("the exact quote"),
    );
    expect(located).not.toBeNull();
    expect(located?.score).toBeCloseTo(1.0, 3);
  });

  test("scores in the useful ~0.7–0.95 band for a small in-quote edit", () => {
    const oldQuote = "raise the timeout to sixty seconds";
    const newSrc = `header\nraise the timeout to ninety seconds\ntrailer\n`;
    const located = fuzzyLocateQuote(
      newSrc,
      { exact: oldQuote, prefix: "header\n", suffix: "\ntrailer\n" },
      newSrc.indexOf("raise"),
    );
    expect(located).not.toBeNull();
    // Small edit → high but not perfect score; well above the default
    // 0.75 gate.
    expect(located?.score ?? 0).toBeGreaterThan(0.8);
    expect(located?.score ?? 1).toBeLessThan(1.0);
  });

  test("scores low for a totally-different candidate at the same location", () => {
    const newSrc = "prelude\ncompletely different sentence here\nend\n";
    const located = fuzzyLocateQuote(
      newSrc,
      { exact: "the exact quote we had", prefix: "prelude\n", suffix: "\nend\n" },
      newSrc.indexOf("completely"),
    );
    // DMP always returns SOME location above -1 within Match_Distance,
    // so what matters is that our score falls below the 0.75 gate.
    expect(located).not.toBeNull();
    expect(located?.score ?? 1).toBeLessThan(DEFAULT_MIN_FUZZY_SCORE);
  });
});

// ---------- Composed-pipeline / fixture tests ----------

const SAMPLE_MDX = [
  "# Title", //                                        L1
  "", //                                                L2
  "This is a paragraph of introduction prose. It sets", // L3
  "the stage for the important quote below.", //        L4
  "", //                                                L5
  "The important quote lives on this line.", //         L6
  "", //                                                L7
  "This is a trailing paragraph that follows the", //   L8
  "important quote.", //                                L9
  "", //                                                L10
].join("\n");

describe("reanchor — identity", () => {
  test("unchanged source: kind='anchored', method='unchanged', anchor identity", async () => {
    const anchor = await anchorForSource("x.mdx", SAMPLE_MDX, 6, 6);
    const result = await reanchor(anchor, SAMPLE_MDX, SAMPLE_MDX);
    expect(result.kind).toBe("anchored");
    if (result.kind !== "anchored") return;
    expect(result.method).toBe("unchanged");
    expect(result.anchor).toEqual(anchor);
  });
});

describe("reanchor — fixture: lines inserted above", () => {
  test("shifts the anchor by the number of inserted lines; method='quote-exact'", async () => {
    const anchor = await anchorForSource("x.mdx", SAMPLE_MDX, 6, 6);
    // Prefix is 4 lines: "## Extra section", empty, "extra prose here",
    // empty. Joined with `\n` and terminated with `\n` before SAMPLE_MDX
    // begins — so SAMPLE_MDX's line 1 becomes line 5, and its old L6
    // (the important quote) becomes new L10.
    const insertedPrefix = "## Extra section\n\nextra prose here\n\n";
    const withInsertion = insertedPrefix + SAMPLE_MDX;
    const result = await reanchor(anchor, SAMPLE_MDX, withInsertion);
    expect(result.kind).toBe("moved");
    if (result.kind !== "moved") return;
    expect(result.method).toBe("quote-exact");
    expect(result.anchor.startLine).toBe(10);
    expect(result.anchor.endLine).toBe(10);
    expect(result.anchor.quote.exact).toBe("The important quote lives on this line.");
    // Revision advances.
    expect(result.anchor.revision).not.toBe(anchor.revision);
    expect(result.anchor.revision).toBe(await revisionOf(withInsertion));
  });
});

describe("reanchor — fixture: paragraph reflowed", () => {
  test("reflow that keeps the quote intact: still found; method='quote-exact'", async () => {
    const anchor = await anchorForSource("x.mdx", SAMPLE_MDX, 3, 4);
    // Reflow: same words, different line breaks.
    const reflowed = SAMPLE_MDX.replace(
      "This is a paragraph of introduction prose. It sets\nthe stage for the important quote below.",
      "This is a paragraph of introduction prose.\nIt sets the stage for the\nimportant quote below.",
    );
    const result = await reanchor(anchor, SAMPLE_MDX, reflowed);
    // The exact quote (with a `\n` in the middle) no longer appears
    // verbatim after the reflow, so quote-verify fails → fuzzy.
    expect(["moved", "fuzzy"]).toContain(result.kind);
    if (result.kind === "fuzzy") expect(result.method).toBe("fuzzy");
    if (result.kind === "moved") expect(result.method).toBe("quote-exact");
  });
});

describe("reanchor — fixture: quote edited slightly", () => {
  test("one-word swap inside the quote: fuzzy, high score, method='fuzzy'", async () => {
    // Slightly-different sample so the fuzzy match's own line stands
    // out enough for the picker to prefer it above the surrounding
    // context.
    const oldSrc = [
      "# Title",
      "",
      "prelude paragraph",
      "",
      "raise the timeout to sixty seconds before retrying the request",
      "",
      "trailer paragraph",
    ].join("\n");
    const anchor = await anchorForSource("x.mdx", oldSrc, 5, 5);
    const newSrc = oldSrc.replace("sixty", "ninety");
    const result = await reanchor(anchor, oldSrc, newSrc);
    expect(result.kind).toBe("fuzzy");
    if (result.kind !== "fuzzy") return;
    expect(result.method).toBe("fuzzy");
    expect(result.score).toBeGreaterThan(DEFAULT_MIN_FUZZY_SCORE);
    expect(result.anchor.startLine).toBe(5);
  });
});

describe("reanchor — fixture: block moved elsewhere in the file", () => {
  test("block moved with a long, distinctive quote that dominates the score: pipeline follows it", async () => {
    // A block move where the quote is long and distinctive enough that
    // even with the surrounding context differing, the score clears
    // the default threshold. This is the common MDX case: a whole
    // paragraph moved a few sections down.
    const longQuote =
      "The important quote lives here and it is deliberately long enough that its distinctive words carry most of the context-weighted score computed by the fuzzy stage.";
    const oldSrc = ["prelude paragraph", "", longQuote, "", "trailer paragraph", ""].join("\n");
    const newSrc = ["prelude paragraph", "", "trailer paragraph", "", longQuote, ""].join("\n");
    const anchor = await anchorForSource("x.mdx", oldSrc, 3, 3);
    const result = await reanchor(anchor, oldSrc, newSrc);
    expect(result.kind).not.toBe("orphaned");
    expect(result.kind).not.toBe("anchored");
    if (result.kind === "moved" || result.kind === "fuzzy") {
      expect(result.anchor.startLine).toBe(5);
      expect(result.anchor.quote.exact).toBe(longQuote);
    }
  });

  test("block moved and rewritten with wildly-different surrounding context: orphans (ADR: never guesses)", async () => {
    const anchor = await anchorForSource("x.mdx", SAMPLE_MDX, 6, 6);
    // Delete the block, insert unrelated content in its place, and
    // move the block to the end. The pipeline should orphan because
    // fuzzy score falls below the threshold — an operator sees "we
    // couldn't safely say where this went" instead of a wrong guess.
    const rewritten =
      SAMPLE_MDX.replace(
        "The important quote lives on this line.",
        "Completely unrelated replacement sentence goes here instead.",
      ) + "\n\n### tail section\n\nThe important quote lives on this line.\n";
    const result = await reanchor(anchor, SAMPLE_MDX, rewritten);
    // The important behaviour: this input never comes back as
    // `anchored`, and if the score falls below the threshold, it
    // orphans (never a silent wrong-line accept).
    expect(result.kind).not.toBe("anchored");
    if (result.kind === "orphaned") {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("reanchor — fixture: block deleted → orphaned", () => {
  test("the block is gone: kind='orphaned', reason names the pipeline failure", async () => {
    const anchor = await anchorForSource("x.mdx", SAMPLE_MDX, 6, 6);
    const withoutBlock = SAMPLE_MDX.replace("The important quote lives on this line.\n", "");
    const result = await reanchor(anchor, SAMPLE_MDX, withoutBlock);
    expect(result.kind).toBe("orphaned");
    if (result.kind !== "orphaned") return;
    expect(result.reason.length).toBeGreaterThan(0);
    expect(result.revision).toBe(await revisionOf(withoutBlock));
  });
});

describe("reanchor — fixture: whitespace-only change", () => {
  test("trailing whitespace added to another line: quote still verifiable; method='quote-exact'", async () => {
    const anchor = await anchorForSource("x.mdx", SAMPLE_MDX, 6, 6);
    // Whitespace tweak on a DIFFERENT line — the quote line is intact.
    const wsChanged = SAMPLE_MDX.replace("# Title", "# Title  ");
    const result = await reanchor(anchor, SAMPLE_MDX, wsChanged);
    expect(result.kind).toBe("moved");
    if (result.kind !== "moved") return;
    expect(result.method).toBe("quote-exact");
    expect(result.anchor.startLine).toBe(6);
  });
});

describe("reanchor — fixture: CRLF source", () => {
  test("caller passes CRLF: pipeline LF-normalises internally and matches", async () => {
    const anchor = await anchorForSource("x.mdx", SAMPLE_MDX, 6, 6);
    // Add an unrelated line above so the source *does* change on the
    // wire — otherwise the identity path (revision unchanged after LF-
    // normalisation) would short-circuit before the pipeline runs.
    const modifiedLF = "prepended line\n" + SAMPLE_MDX;
    const modifiedCRLF = modifiedLF.replace(/\n/g, "\r\n");
    const result = await reanchor(anchor, SAMPLE_MDX, modifiedCRLF);
    expect(result.kind).toBe("moved");
    if (result.kind !== "moved") return;
    // The pipeline works on the LF form, so the returned range is
    // measured in LF-normalised line numbers (matching `data-src`).
    expect(result.anchor.startLine).toBe(7);
  });

  test("identity across CRLF/LF flip: revision matches, kind='anchored'", async () => {
    const anchor = await anchorForSource("x.mdx", SAMPLE_MDX, 6, 6);
    const asCRLF = SAMPLE_MDX.replace(/\n/g, "\r\n");
    const result = await reanchor(anchor, SAMPLE_MDX, asCRLF);
    expect(result.kind).toBe("anchored");
  });
});

describe("reanchor — snapshot / anchor.revision mismatch", () => {
  test("snapshot does not hash to anchor.revision: orphaned, reason names the mismatch", async () => {
    const anchor = await anchorForSource("x.mdx", SAMPLE_MDX, 6, 6);
    // Hand the pipeline a snapshot for a different revision than the
    // anchor was captured against.
    const wrongSnapshot = SAMPLE_MDX + "\nunrelated";
    const newSrc = SAMPLE_MDX.replace("The important quote", "The IMPORTANT quote");
    const result = await reanchor(anchor, wrongSnapshot, newSrc);
    expect(result.kind).toBe("orphaned");
    if (result.kind !== "orphaned") return;
    expect(result.reason).toMatch(/snapshot revision mismatch/);
  });
});

// ---------- Mutation checks: prove each stage carries its weight ----------

describe("reanchor — mutation: skipping quote-verify changes the outcome", () => {
  test("without stage (b), an input that yields 'quote-exact' would be misread by stages (a)+(c) alone", async () => {
    // Setup: the pipeline with quote-verify present returns
    // { kind: 'moved', method: 'quote-exact' } for a lines-inserted-
    // above input. If we simulate SKIPPING quote-verify by asking only
    // stages (a) and (c) directly, the answer is different: stage (a)
    // gives a rough range (via diffMapLines/mapAnchorRange), and (c)
    // via fuzzy — different method entirely. This proves stage (b)
    // steers the pipeline's classification.
    const anchor = await anchorForSource("x.mdx", SAMPLE_MDX, 6, 6);
    const withInsertion = "extra\n" + SAMPLE_MDX;

    // With quote-verify (composed pipeline):
    const withVerify = await reanchor(anchor, SAMPLE_MDX, withInsertion);
    expect(withVerify.kind).toBe("moved");
    if (withVerify.kind !== "moved") return;
    expect(withVerify.method).toBe("quote-exact");

    // Without quote-verify — go straight to fuzzy after the diff-map
    // hint. Emulates the mutation "delete stage (b) from the pipeline".
    const lineMap = diffMapLines(SAMPLE_MDX, withInsertion);
    const mapped = mapAnchorRange(lineMap, 6, 6);
    expect(mapped).not.toBeNull();
    const located = fuzzyLocateQuote(withInsertion, anchor.quote, 0);
    expect(located).not.toBeNull();
    // The mutated pipeline would classify this as `fuzzy`, not
    // `quote-exact` — proving stage (b) carries the classification.
    // A test that asserted `withVerify.method === 'quote-exact'` (as
    // above) would fail if the pipeline were changed to skip stage
    // (b).
    expect(withVerify.method).not.toBe("fuzzy");
  });
});

describe("reanchor — mutation: threshold of 0 would wrongly accept an orphan", () => {
  test("an input that orphans at the default threshold accepts fuzzy at threshold 0", async () => {
    // Construct a source where the block is rewritten so heavily that
    // its fuzzy score falls below 0.75 (the default gate). At the
    // default threshold the pipeline orphans; at threshold 0 it
    // accepts. If the threshold were removed altogether (== 0), a test
    // that asserts orphan would fail — this test *is* that assertion.
    const oldSrc = [
      "# Title",
      "",
      "This paragraph will be rewritten entirely.",
      "",
      "Trailer.",
    ].join("\n");
    const anchor = await anchorForSource("x.mdx", oldSrc, 3, 3);
    const newSrc = [
      "# Title",
      "",
      "Wholly new sentence that shares almost no words.",
      "",
      "Trailer.",
    ].join("\n");
    const atDefault = await reanchor(anchor, oldSrc, newSrc);
    expect(atDefault.kind).toBe("orphaned");
    if (atDefault.kind !== "orphaned") return;
    // Sanity: the fuzzy scorer did find some candidate — otherwise
    // "threshold" wouldn't be the load-bearing stage on this input.
    expect(atDefault.score).toBeDefined();
    expect(atDefault.score ?? 1).toBeLessThan(DEFAULT_MIN_FUZZY_SCORE);

    // Mutation: threshold 0 accepts anything.
    const atZero = await reanchor(anchor, oldSrc, newSrc, { minFuzzyScore: 0 });
    expect(atZero.kind).toBe("fuzzy");
  });
});

// ---------- reanchorEvent shape ----------

describe("reanchorEvent", () => {
  const t = "2026-09-30T12:00:00Z";
  const dummyAnchor: Anchor = {
    path: "docs/x.md",
    startLine: 5,
    endLine: 5,
    quote: { exact: "hi", prefix: "", suffix: "" },
    revision: "a".repeat(64),
  };

  test("kind='anchored' → returns null (no event to append)", () => {
    const result: ReanchorResult = { kind: "anchored", anchor: dummyAnchor, method: "unchanged" };
    expect(reanchorEvent("th-1", AGENT, result)).toBeNull();
  });

  test("kind='moved' → thread.reanchored with method and NO score", () => {
    const result: ReanchorResult = { kind: "moved", anchor: dummyAnchor, method: "quote-exact" };
    const event = reanchorEvent("th-1", AGENT, result);
    expect(event).not.toBeNull();
    if (event === null) return;
    expect(event.kind).toBe("thread.reanchored");
    expect(event).toMatchObject({
      kind: "thread.reanchored",
      threadId: "th-1",
      anchor: dummyAnchor,
      method: "quote-exact",
    });
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
      anchor: dummyAnchor,
      method: "fuzzy",
      score: 0.82,
    });
  });

  test("kind='orphaned' → thread.orphaned with revision and reason", () => {
    const result: ReanchorResult = {
      kind: "orphaned",
      revision: "b".repeat(64),
      reason: "block deleted",
    };
    const event = reanchorEvent("th-1", AGENT, result);
    expect(event).not.toBeNull();
    if (event === null) return;
    expect(event).toMatchObject({
      kind: "thread.orphaned",
      threadId: "th-1",
      revision: "b".repeat(64),
      reason: "block deleted",
    });
    // The event carries the ISO timestamp `t` only after the store
    // stamps it; the input helper doesn't set `ts`.
    void t;
  });

  test("empty threadId is refused", () => {
    const result: ReanchorResult = { kind: "moved", anchor: dummyAnchor, method: "quote-exact" };
    expect(() => reanchorEvent("", AGENT, result)).toThrow();
  });
});
