// Tests for the unified-diff patch parser (M3 part 1).
//
// Focus on the shapes the GitHub adapter actually sees: the `patch`
// field on `pull_request_files` responses. Every hunk must map each
// context / added line to its correct `newLine`, deleted lines carry
// no `newLine`, `\ No newline at end of file` is preserved as a
// no-op marker, and a malformed patch fails loudly.

import { describe, expect, test } from "bun:test";
import {
  newSideLines,
  oldSideLines,
  parsePatch,
  rangeIsOnRightSide,
} from "../src/patch.ts";

const CRLF_PATCH_SAMPLE =
  "@@ -1,3 +1,3 @@\n" +
  " line one\r\n" +
  "-line two\r\n" +
  "+line two changed\r\n" +
  " line three\r\n";

describe("parsePatch", () => {
  test("returns null for the empty patch (binary or absent)", () => {
    expect(parsePatch("")).toBeNull();
  });

  test("returns null for a 'Binary files ... differ' body", () => {
    expect(parsePatch("Binary files a/logo.png and b/logo.png differ\n")).toBeNull();
    expect(parsePatch("GIT binary patch\nliteral 0\n")).toBeNull();
  });

  test("parses a single-hunk patch and assigns oldLine / newLine correctly", () => {
    const patch =
      "@@ -1,3 +1,4 @@\n" +
      " keep me\n" +
      "-removed\n" +
      "+added one\n" +
      "+added two\n" +
      " tail\n";
    const hunks = parsePatch(patch);
    expect(hunks).not.toBeNull();
    expect(hunks?.length).toBe(1);
    const hunk = hunks![0]!;
    expect(hunk.oldStart).toBe(1);
    expect(hunk.oldLines).toBe(3);
    expect(hunk.newStart).toBe(1);
    expect(hunk.newLines).toBe(4);
    expect(hunk.lines.map((l) => l.kind)).toEqual(["context", "del", "add", "add", "context"]);
    // Context line: appears on both sides.
    expect(hunk.lines[0]).toMatchObject({ kind: "context", oldLine: 1, newLine: 1, text: "keep me" });
    // Deleted line: no newLine.
    expect(hunk.lines[1]).toMatchObject({ kind: "del", oldLine: 2, text: "removed" });
    expect(hunk.lines[1]?.newLine).toBeUndefined();
    // Added lines: no oldLine, sequential newLine.
    expect(hunk.lines[2]).toMatchObject({ kind: "add", newLine: 2, text: "added one" });
    expect(hunk.lines[3]).toMatchObject({ kind: "add", newLine: 3, text: "added two" });
    // Tail context.
    expect(hunk.lines[4]).toMatchObject({ kind: "context", oldLine: 3, newLine: 4, text: "tail" });
  });

  test("parses a multi-hunk patch with independent old/new offsets", () => {
    // Two hunks: first shifts the file down by 1, the second's
    // header must reflect the new offset (10 old → 11 new).
    const patch =
      "@@ -1,3 +1,4 @@\n" +
      " a\n" +
      " b\n" +
      "+inserted\n" +
      " c\n" +
      "@@ -10,3 +11,3 @@\n" +
      " x\n" +
      "-y\n" +
      "+Y\n" +
      " z\n";
    const hunks = parsePatch(patch);
    expect(hunks?.length).toBe(2);
    // Second hunk's newLine numbers must be 11..13, not 10..12.
    const secondNewLines = hunks![1]!.lines
      .filter((l) => l.kind === "context" || l.kind === "add")
      .map((l) => l.newLine!);
    expect(secondNewLines).toEqual([11, 12, 13]);
  });

  test("handles the omitted-count form (a hunk that changes exactly 1 line)", () => {
    // `@@ -N +M @@` (no `,c`) is legal and means 1 line each.
    const patch = "@@ -5 +5 @@\n" + "-one\n" + "+ONE\n" + " neighbour\n";
    // But the count is 1 for BOTH sides, so this fragment
    // declares 1 old / 1 new, then walks 1 del + 1 add + 1 ctx.
    // That fails the count check — deliberately, because a
    // real one-line hunk emits exactly 1 line.
    expect(() => parsePatch(patch)).toThrow(/hunk header declared/);
  });

  test("handles the omitted-count form on both sides", () => {
    const patch = "@@ -5 +5 @@\n" + "-only\n" + "+ONLY\n";
    const hunks = parsePatch(patch);
    expect(hunks?.length).toBe(1);
    expect(hunks![0]!.oldLines).toBe(1);
    expect(hunks![0]!.newLines).toBe(1);
  });

  test("preserves \\ No newline at end of file as a noEol marker", () => {
    const patch =
      "@@ -1,2 +1,2 @@\n" +
      " kept\n" +
      "-old last\n" +
      "\\ No newline at end of file\n" +
      "+new last\n" +
      "\\ No newline at end of file\n";
    const hunks = parsePatch(patch);
    expect(hunks?.length).toBe(1);
    const kinds = hunks![0]!.lines.map((l) => l.kind);
    expect(kinds).toEqual(["context", "del", "noEol", "add", "noEol"]);
    // The noEol marker must NOT bump oldLine / newLine.
    expect(hunks![0]!.lines[1]?.oldLine).toBe(2);
    expect(hunks![0]!.lines[3]?.newLine).toBe(2);
  });

  test("keeps CRLF payload on the RIGHT-side text (patches carry file line endings)", () => {
    const hunks = parsePatch(CRLF_PATCH_SAMPLE);
    expect(hunks?.length).toBe(1);
    const added = hunks![0]!.lines.find((l) => l.kind === "add");
    expect(added?.text).toBe("line two changed\r");
  });

  test("throws on an unknown line prefix", () => {
    const patch = "@@ -1,1 +1,1 @@\n" + "?bad\n";
    expect(() => parsePatch(patch)).toThrow(/unrecognised line prefix/);
  });

  test("throws when the walked body doesn't match the declared counts", () => {
    // Header claims 2 old / 2 new, body only has 1 of each.
    const patch = "@@ -1,2 +1,2 @@\n" + "-x\n" + "+X\n";
    expect(() => parsePatch(patch)).toThrow(/hunk header declared/);
  });

  test("throws when the input is not a hunk header", () => {
    expect(() => parsePatch("--- a/file\n+++ b/file\n")).toThrow(/expected a hunk header/);
  });
});

describe("newSideLines / oldSideLines", () => {
  test("collects context and added lines on the RIGHT, context and deleted on the LEFT", () => {
    const patch =
      "@@ -10,3 +10,4 @@\n" +
      " keep\n" +
      "-drop\n" +
      "+add1\n" +
      "+add2\n" +
      " tail\n";
    const hunks = parsePatch(patch)!;
    // RIGHT-side newLine numbers: context 10, adds 11 & 12, context 13.
    expect([...newSideLines(hunks)].sort((a, b) => a - b)).toEqual([10, 11, 12, 13]);
    // LEFT-side oldLine numbers: context 10, del 11, context 12.
    expect([...oldSideLines(hunks)].sort((a, b) => a - b)).toEqual([10, 11, 12]);
  });
});

describe("rangeIsOnRightSide", () => {
  const patch =
    "@@ -1,2 +1,2 @@\n" +
    " keep\n" +
    "+added\n" +
    "-drop\n" +
    "@@ -20,1 +21,2 @@\n" +
    " tail1\n" +
    "+tail2\n";
  const hunks = parsePatch(patch)!;

  test("accepts a single line inside a hunk", () => {
    expect(rangeIsOnRightSide(hunks, 1, 1)).toBe(true);
    expect(rangeIsOnRightSide(hunks, 2, 2)).toBe(true);
    expect(rangeIsOnRightSide(hunks, 21, 22)).toBe(true);
  });

  test("rejects a line outside any hunk", () => {
    expect(rangeIsOnRightSide(hunks, 5, 5)).toBe(false);
    expect(rangeIsOnRightSide(hunks, 100, 100)).toBe(false);
  });

  test("rejects a range that crosses a hunk boundary", () => {
    // 2..21 spans a gap between the two hunks (lines 3..20 aren't
    // in any hunk); must be rejected.
    expect(rangeIsOnRightSide(hunks, 2, 21)).toBe(false);
  });

  test("rejects a range that starts inside a hunk and extends past it", () => {
    // 2..3: line 2 is inside, line 3 is outside.
    expect(rangeIsOnRightSide(hunks, 2, 3)).toBe(false);
  });

  test("rejects an inverted range", () => {
    expect(rangeIsOnRightSide(hunks, 3, 2)).toBe(false);
  });
});
