// Tests for `verifyContentAgainstDiffHunk` (issue #46 items 1 & 2).
//
// - CRLF in the diff hunk must not defeat verification.
// - EVERY side-line in the hunk must match the blob, not just the last.
// - `hunk-empty` is refused (the schema says `diffHunk` is non-null).
//
// Every test below is designed to be RED against the round-5
// implementation and GREEN after the fix.

import { describe, expect, test } from "bun:test";
import { verifyContentAgainstDiffHunk } from "../src/index.ts";

describe("verifyContentAgainstDiffHunk — item 1: CRLF hunks are normalised", () => {
  const CONTENT = "keep a\nkeep b\ntarget\nkeep c\n";

  test("hunk with `\\r\\n` line endings on RIGHT still matches (was FAIL on 25d5608d)", () => {
    // GitHub keeps the raw `\r` in `diffHunk` for CRLF files; the
    // round-5 implementation LF-normalised the blob but not the
    // hunk, so `" line 3" === " line 3\r"` was always false and
    // every imported CRLF-file thread went unanchored (seen live
    // on microsoft/TypeScript#64381).
    const hunk = "@@ -1,3 +1,3 @@\r\n keep a\r\n keep b\r\n+target\r\n";
    const result = verifyContentAgainstDiffHunk({
      content: CONTENT,
      originalLine: 3,
      diffHunk: hunk,
      side: "RIGHT",
    });
    expect(result).toBe("matched");
  });

  test("hunk with `\\r\\n` on LEFT side is normalised too", () => {
    const old = "kept 1\ngone\n";
    const hunk = "@@ -1,2 +1,1 @@\r\n kept 1\r\n-gone\r\n";
    const result = verifyContentAgainstDiffHunk({
      content: old,
      originalLine: 2,
      diffHunk: hunk,
      side: "LEFT",
    });
    expect(result).toBe("matched");
  });
});

describe("verifyContentAgainstDiffHunk — item 2: verify every side-line, not just the last", () => {
  test("wrong start of a multi-line range → mismatched (was 'matched' on 25d5608d because only the LAST line was checked)", () => {
    // Content and hunk agree on the LAST added line (`third`) but
    // disagree on `first` — a wrong-base fetch that trivially
    // matches the last line (`}`, blank) would fool the round-5
    // checker. The round-6 checker walks every side-line, so this
    // mismatch is caught.
    const content = "one\ntwo\nthird\n";
    const hunk =
      "@@ -1,3 +1,3 @@\n" +
      "+different first\n" +
      "+different second\n" +
      "+third\n";
    const result = verifyContentAgainstDiffHunk({
      content,
      originalLine: 3,
      diffHunk: hunk,
      side: "RIGHT",
    });
    expect(result).toBe("mismatched");
  });

  test("all side-lines match → matched", () => {
    const content = "one\ntwo\nthird\n";
    const hunk = "@@ -1,3 +1,3 @@\n+one\n+two\n+third\n";
    const result = verifyContentAgainstDiffHunk({
      content,
      originalLine: 3,
      diffHunk: hunk,
      side: "RIGHT",
    });
    expect(result).toBe("matched");
  });

  test("context lines (space marker) participate in the check (a shifted-by-one fetch is caught)", () => {
    // The context line ` keep` should sit at line 1; if the blob
    // is shifted so line 1 is actually `wrong`, this test catches
    // it — the round-5 code only looked at the very last hunk
    // line, so a wrong context line would have slipped through.
    const wrongBlob = "wrong\ntarget\n";
    const hunk = "@@ -1,2 +1,2 @@\n keep\n+target\n";
    const result = verifyContentAgainstDiffHunk({
      content: wrongBlob,
      originalLine: 2,
      diffHunk: hunk,
      side: "RIGHT",
    });
    expect(result).toBe("mismatched");
  });

  test("mismatched on LEFT: an earlier -line disagrees with the base blob", () => {
    const base = "one\ntwo\nthree\n";
    const hunk = "@@ -1,3 +1,0 @@\n-alt one\n-alt two\n-three\n";
    const result = verifyContentAgainstDiffHunk({
      content: base,
      originalLine: 3,
      diffHunk: hunk,
      side: "LEFT",
    });
    expect(result).toBe("mismatched");
  });
});

describe("verifyContentAgainstDiffHunk — item 2: hunk-empty is refused, not passed", () => {
  test("null diffHunk → mismatched (schema forbids null; treat absence as failure)", () => {
    // Round-5 returned `hunk-empty` and the adapter took `hunk-empty`
    // to mean "cannot verify but trust the blob" — a wrong base
    // slipped through. The schema records `diffHunk` as
    // non-nullable, so absence is a mismatch: no evidence the
    // blob is right.
    const result = verifyContentAgainstDiffHunk({
      content: "anything\n",
      originalLine: 1,
      diffHunk: null,
      side: "RIGHT",
    });
    expect(result).toBe("mismatched");
  });

  test("hunk with only its header (no side-lines) → mismatched", () => {
    // A malformed / stripped hunk with no `+`/`-`/` ` lines gave
    // us `hunk-empty` under round-5, meaning the adapter trusted
    // the blob. Same fix: treat as evidence-absent → mismatched.
    const result = verifyContentAgainstDiffHunk({
      content: "content\n",
      originalLine: 1,
      diffHunk: "@@ -1,0 +1,0 @@",
      side: "RIGHT",
    });
    expect(result).toBe("mismatched");
  });
});

describe("verifyContentAgainstDiffHunk — line-missing (unchanged behaviour)", () => {
  test("originalLine beyond the blob's line count → line-missing", () => {
    const result = verifyContentAgainstDiffHunk({
      content: "one\n",
      originalLine: 5,
      diffHunk: "@@ -1,1 +1,1 @@\n+one\n",
      side: "RIGHT",
    });
    expect(result).toBe("line-missing");
  });

  test("originalLine < 1 → line-missing", () => {
    const result = verifyContentAgainstDiffHunk({
      content: "one\n",
      originalLine: 0,
      diffHunk: "@@ -1,1 +1,1 @@\n+one\n",
      side: "RIGHT",
    });
    expect(result).toBe("line-missing");
  });
});
