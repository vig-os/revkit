// Tests for `buildQuoteFromLines` / `buildQuoteFromOffsets` — the
// one-source-of-truth quote builder for anchors (ADR-0006).

import { describe, expect, test } from "bun:test";
import {
  buildQuoteFromLines,
  buildQuoteFromOffsets,
  DEFAULT_QUOTE_CONTEXT_CHARS,
  lineStartsOf,
} from "../src/quote.ts";

describe("lineStartsOf", () => {
  test("empty source has one line starting at 0 and a sentinel at 0", () => {
    expect(lineStartsOf("")).toEqual([0]);
  });

  test("no terminator counts as one line", () => {
    const s = "hello";
    // starts[0]=0 (line 1), sentinel=5.
    expect(lineStartsOf(s)).toEqual([0, 5]);
  });

  test("LF terminates lines; each start is past its terminator", () => {
    const s = "a\nb\nc\n";
    expect(lineStartsOf(s)).toEqual([0, 2, 4, 6]);
  });

  test("CRLF is a single terminator", () => {
    const s = "a\r\nb\r\n";
    expect(lineStartsOf(s)).toEqual([0, 3, 6]);
  });

  test("lone CR terminates a line", () => {
    const s = "a\rb\r";
    expect(lineStartsOf(s)).toEqual([0, 2, 4]);
  });
});

describe("buildQuoteFromLines", () => {
  const SOURCE = "alpha\nbeta\ngamma\ndelta\nepsilon\n";

  test("single-line range: exact is the line body without terminator", () => {
    const q = buildQuoteFromLines(SOURCE, 2, 2);
    expect(q.exact).toBe("beta");
    // Prefix ends at start of line 2: "alpha\n" (all of line 1
    // fits in the default 40-char context).
    expect(q.prefix).toBe("alpha\n");
    expect(q.suffix.startsWith("\ngamma")).toBe(true);
  });

  test("multi-line range: exact spans body + inner terminators, no trailing terminator", () => {
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

  test("CRLF source: exact does not include trailing \\r\\n", () => {
    const s = "one\r\ntwo\r\nthree\r\n";
    const q = buildQuoteFromLines(s, 2, 2);
    expect(q.exact).toBe("two");
    expect(q.prefix).toBe("one\r\n");
    expect(q.suffix.startsWith("\r\nthree")).toBe(true);
  });

  test("contextChars can be tuned", () => {
    const q = buildQuoteFromLines(SOURCE, 3, 3, { contextChars: 3 });
    expect(q.exact).toBe("gamma");
    // 3-char prefix and 3-char suffix.
    expect(q.prefix.length).toBe(3);
    expect(q.suffix.length).toBe(3);
    expect(q.prefix).toBe("ta\n");
    expect(q.suffix).toBe("\nde");
  });

  test("default context matches DEFAULT_QUOTE_CONTEXT_CHARS at file interior", () => {
    // Use a source with plenty of context on both sides.
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
    // Behaviour: clamp end up to start.
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
