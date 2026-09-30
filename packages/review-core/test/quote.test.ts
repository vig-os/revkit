// Tests for `buildQuoteFromLines` / `buildQuoteFromOffsets` — the
// one-source-of-truth quote builder for anchors (ADR-0006).
//
// PR-43 round-4 fix: quote.ts now uses the reanchor engine's
// `buildLineStartIndex` (LF-only) and its 32-char context, so
// producers and the reanchor engine cut identical windows and
// CRLF sources round-trip without spurious orphaning.

import { describe, expect, test } from "bun:test";
import {
  buildQuoteFromLines,
  buildQuoteFromOffsets,
  DEFAULT_QUOTE_CONTEXT_CHARS,
  lineStartsOf,
} from "../src/quote.ts";
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
