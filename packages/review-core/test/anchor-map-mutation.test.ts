// Mutation-check tests for anchor mapping (M3 part 1, ADR-0025).
//
// PR-40 review lesson: tests must be structured so a specific
// mutation of the code they cover turns them red. The mapping is
// the single biggest risk area — a `side: RIGHT → LEFT`, a hunk-
// header off-by-one, a pagination `next` that never advances, all
// silent under naive tests.
//
// Each test below pins a property that dies under a NAMED mutation:
//
//   M1. flip `side: "RIGHT"` → `"LEFT"` in `anchorToPrComment`
//       → `emits side=RIGHT on a line comment` goes red.
//   M2. drop the `startLine` when start==end === false in
//       `anchorToPrComment`
//       → `multi-line preserves startLine` goes red.
//   M3. flip hunk-header regex to allow a shifted new-start
//       (e.g. remove the `\+(\d+)` group and hard-code 0)
//       → `newLine is computed from the header, not the LHS`
//         goes red.
//   M4. always return `newLine` from parsePatch by copying `oldPos`
//       → `deleted line has no newLine on the RIGHT` goes red.
//   M5. clamp an out-of-hunk range to the nearest hunk instead of
//       falling back to file-level
//       → `out-of-hunk falls back to file-level, never clamps` goes
//         red.
//   M6. drop the previous_filename lookup in findFile
//       → `renamed file: anchor by old path resolves to new` goes
//         red.
//   M7. flip `nextPageUrl` to return the current URL instead of
//       parsing rel="next"
//       → `Link parsing extracts only the rel="next" URL` goes red.

import { describe, expect, test } from "bun:test";
import {
  anchorToPrComment,
  nextPageUrl,
  parsePatch,
  type PrFile,
} from "../src/index.ts";

// A patch that inserts 3 lines at line 20 of the new file: adds
// shift lines 20..22 to lines 20..22 (context), lines 21..23 to
// 24..26 (added). We assert on NEW-side numbers.
const SHIFT_PATCH =
  "@@ -1,3 +1,3 @@\n" +
  " one\n" +
  "-two\n" +
  "+TWO\n" +
  " three\n" +
  "@@ -20,3 +20,6 @@\n" +
  " ctx-a\n" +
  "+ins-1\n" +
  "+ins-2\n" +
  "+ins-3\n" +
  " ctx-b\n" +
  " ctx-c\n";

const F: PrFile[] = [{ filename: "docs/x.mdx", status: "modified", patch: SHIFT_PATCH }];

describe("mutation guards — anchor → PR line", () => {
  test("M1: emits side=RIGHT on a line comment (never LEFT)", () => {
    // Every RIGHT-side hunk maps to side=RIGHT. Flipping the constant
    // to LEFT would mean the reviewer's comment targets the pre-PR
    // file — silently wrong.
    const single = anchorToPrComment({ path: "docs/x.mdx", startLine: 21, endLine: 21 }, F);
    if (single.kind !== "line") throw new Error("expected line");
    expect(single.target.side).toBe("RIGHT");
    const multi = anchorToPrComment({ path: "docs/x.mdx", startLine: 21, endLine: 22 }, F);
    if (multi.kind !== "line") throw new Error("expected line");
    expect(multi.target.side).toBe("RIGHT");
    expect(multi.target.startSide).toBe("RIGHT");
  });

  test("M2: multi-line preserves startLine (and skips it for single-line)", () => {
    const single = anchorToPrComment({ path: "docs/x.mdx", startLine: 20, endLine: 20 }, F);
    if (single.kind !== "line") throw new Error("expected line");
    expect(single.target.startLine).toBeUndefined();
    expect(single.target.line).toBe(20);
    const multi = anchorToPrComment({ path: "docs/x.mdx", startLine: 20, endLine: 22 }, F);
    if (multi.kind !== "line") throw new Error("expected line");
    expect(multi.target.startLine).toBe(20);
    expect(multi.target.line).toBe(22);
  });

  test("M3: newLine is computed from the header, not the LHS (shifted second hunk)", () => {
    // Second hunk's header is `-20,3 +20,6` — the new side spans
    // NEW-lines 20..25. `ctx-a` sits at 20, three inserts at 21..23,
    // `ctx-b` at 24, `ctx-c` at 25.
    const hunks = parsePatch(SHIFT_PATCH)!;
    const second = hunks[1]!;
    const insertOne = second.lines.find((l) => l.kind === "add" && l.text === "ins-1");
    expect(insertOne?.newLine).toBe(21);
    const ctxB = second.lines.find((l) => l.kind === "context" && l.text === "ctx-b");
    expect(ctxB?.newLine).toBe(24);
    expect(ctxB?.oldLine).toBe(21); // OLD side unchanged from header
  });

  test("M4: deleted line has no newLine on the RIGHT (never both)", () => {
    const patch = "@@ -1,2 +1,1 @@\n" + " keep\n" + "-gone\n";
    const hunks = parsePatch(patch)!;
    const deleted = hunks[0]!.lines.find((l) => l.kind === "del");
    expect(deleted?.newLine).toBeUndefined();
    expect(deleted?.oldLine).toBe(2);
  });

  test("M5: out-of-hunk falls back to file-level, never clamps to a nearby hunk", () => {
    // Line 100 is far outside every hunk. A "helpful" clamp would
    // land on line 22 (the last hunk's last line) — that would be
    // wrong; the fallback must be file-level.
    const result = anchorToPrComment({ path: "docs/x.mdx", startLine: 100, endLine: 100 }, F);
    expect(result.kind).toBe("file");
    if (result.kind !== "file") throw new Error("expected file");
    expect(result.target.path).toBe("docs/x.mdx");
    // path only — no line number sneaks onto a file-subject target.
    expect((result.target as { line?: number }).line).toBeUndefined();
  });

  test("M6: renamed file — anchor by old path resolves to the new path", () => {
    const files: PrFile[] = [
      {
        filename: "docs/renamed.mdx",
        previousFilename: "docs/original.mdx",
        status: "renamed",
        patch: "@@ -1,1 +1,1 @@\n" + "-was\n" + "+is\n",
      },
    ];
    const result = anchorToPrComment({ path: "docs/original.mdx", startLine: 1, endLine: 1 }, files);
    expect(result.kind).toBe("line");
    if (result.kind !== "line") throw new Error("expected line");
    // The comment must target the NEW name, not the old — GitHub
    // returns 422 on a comment targeting `previous_filename`.
    expect(result.target.path).toBe("docs/renamed.mdx");
  });

  test("M7: Link parsing extracts only the rel=\"next\" URL, and returns null when absent", () => {
    // A `rel="prev"` in front of `rel="next"` used to cause a
    // sloppy first-match implementation to return the prev URL.
    expect(
      nextPageUrl(
        '<https://api.github.com/x?page=1>; rel="prev", <https://api.github.com/x?page=3>; rel="next"',
      ),
    ).toBe("https://api.github.com/x?page=3");
    // Only `rel="last"` — no next → null.
    expect(nextPageUrl('<https://api.github.com/x?page=5>; rel="last"')).toBeNull();
    // Empty and null are safe.
    expect(nextPageUrl("")).toBeNull();
    expect(nextPageUrl(null)).toBeNull();
  });
});
