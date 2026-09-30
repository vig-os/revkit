// Tests for the anchor ↔ PR-comment mapping (M3 part 1).
//
// The mapping is the single biggest source of "silent wrong lines" if
// we get it wrong: a hunk that shifts by two lines and no test would
// notice because everything under the same file would still be
// addressable, just at the wrong line number. So every test uses
// deliberately mismatched old/new coordinates and checks the RESULT
// against the RIGHT-side line number, never the OLD-side one.

import { describe, expect, test } from "bun:test";
import {
  anchorToPrComment,
  fileFallbackPreamble,
  findFile,
  prCommentToAnchor,
  type PrFile,
} from "../src/anchor-map.ts";

/** Helper — build a `PrFile` with a patch. */
function file(filename: string, patch: string, extras: Partial<PrFile> = {}): PrFile {
  return { filename, patch, status: "modified", ...extras };
}

// A patch that shifts everything DOWN by 5 lines after line 20, so
// tests that mistakenly used old-side numbers would land on wrong
// content.
const SHIFTED_PATCH =
  "@@ -1,3 +1,3 @@\n" +
  " keep-1\n" +
  "-drop\n" +
  "+ADD\n" +
  " keep-2\n" +
  "@@ -20,3 +20,8 @@\n" +
  " keep-a\n" +
  "+ins-1\n" +
  "+ins-2\n" +
  "+ins-3\n" +
  "+ins-4\n" +
  "+ins-5\n" +
  " keep-b\n" +
  " keep-c\n";

describe("anchorToPrComment — happy paths", () => {
  const files = [file("docs/x.mdx", SHIFTED_PATCH)];

  test("single-line inside a hunk emits a line comment with `line` only", () => {
    const result = anchorToPrComment(
      { path: "docs/x.mdx", startLine: 2, endLine: 2 },
      files,
    );
    expect(result.kind).toBe("line");
    if (result.kind !== "line") throw new Error("unreachable");
    expect(result.target).toEqual({
      subjectType: "line",
      path: "docs/x.mdx",
      line: 2,
      side: "RIGHT",
    });
  });

  test("multi-line range inside a hunk emits start_line + line, both RIGHT", () => {
    // The second hunk's new-side lines are 20..27 (context 20,
    // 5 inserts 21..25, context 26, 27). A 21..25 range is a
    // clean multi-line range.
    const result = anchorToPrComment(
      { path: "docs/x.mdx", startLine: 21, endLine: 25 },
      files,
    );
    expect(result.kind).toBe("line");
    if (result.kind !== "line") throw new Error("unreachable");
    expect(result.target).toEqual({
      subjectType: "line",
      path: "docs/x.mdx",
      line: 25,
      side: "RIGHT",
      startLine: 21,
      startSide: "RIGHT",
    });
  });
});

describe("anchorToPrComment — rejects and fallbacks", () => {
  test("rejects an anchor whose path isn't in the PR file list", () => {
    const result = anchorToPrComment(
      { path: "docs/absent.mdx", startLine: 1, endLine: 1 },
      [file("docs/x.mdx", SHIFTED_PATCH)],
    );
    expect(result.kind).toBe("reject");
  });

  test("falls back to file-level for a range entirely outside any hunk", () => {
    const result = anchorToPrComment(
      { path: "docs/x.mdx", startLine: 100, endLine: 100 },
      [file("docs/x.mdx", SHIFTED_PATCH)],
    );
    expect(result.kind).toBe("file");
    if (result.kind !== "file") throw new Error("unreachable");
    expect(result.target).toEqual({ subjectType: "file", path: "docs/x.mdx" });
    expect(result.reason).toBe("range-outside-hunk");
  });

  test("falls back with `range-crosses-hunk-boundary` when the span crosses a gap", () => {
    // First hunk covers RIGHT lines 1..3; second hunk 20..27.
    // 3..20 has some lines inside (3, 20) and many lines outside.
    const result = anchorToPrComment(
      { path: "docs/x.mdx", startLine: 3, endLine: 20 },
      [file("docs/x.mdx", SHIFTED_PATCH)],
    );
    expect(result.kind).toBe("file");
    if (result.kind !== "file") throw new Error("unreachable");
    expect(result.reason).toBe("range-crosses-hunk-boundary");
  });

  test("refuses fallback when allowFileFallback is false", () => {
    const result = anchorToPrComment(
      { path: "docs/x.mdx", startLine: 100, endLine: 100 },
      [file("docs/x.mdx", SHIFTED_PATCH)],
      { allowFileFallback: false },
    );
    expect(result.kind).toBe("reject");
  });

  test("falls back to file-level on a deleted file (with previous name lookup)", () => {
    // Anchor names the OLD path; PR file entry is a deletion under
    // the current name (== old name for deletes).
    const files: PrFile[] = [
      { filename: "docs/gone.mdx", status: "removed" }, // no patch on delete
    ];
    const result = anchorToPrComment(
      { path: "docs/gone.mdx", startLine: 1, endLine: 1 },
      files,
    );
    expect(result.kind).toBe("file");
    if (result.kind !== "file") throw new Error("unreachable");
    expect(result.reason).toBe("deleted-file");
  });

  test("falls back to file-level on a binary file", () => {
    const files = [file("assets/logo.png", "Binary files a/assets/logo.png and b/assets/logo.png differ\n")];
    const result = anchorToPrComment(
      { path: "assets/logo.png", startLine: 1, endLine: 1 },
      files,
    );
    expect(result.kind).toBe("file");
    if (result.kind !== "file") throw new Error("unreachable");
    expect(result.reason).toBe("binary-file");
  });

  test("falls back to file-level when patch is absent (huge diff)", () => {
    const files: PrFile[] = [{ filename: "docs/huge.mdx", status: "modified" }];
    const result = anchorToPrComment(
      { path: "docs/huge.mdx", startLine: 1, endLine: 1 },
      files,
    );
    expect(result.kind).toBe("file");
    if (result.kind !== "file") throw new Error("unreachable");
    expect(result.reason).toBe("no-patch");
  });

  test("resolves an anchor made against the OLD path of a renamed file", () => {
    const files: PrFile[] = [
      {
        filename: "docs/new-name.mdx",
        previousFilename: "docs/old-name.mdx",
        status: "renamed",
        patch: "@@ -1,1 +1,1 @@\n" + "-was old\n" + "+is new\n",
      },
    ];
    const result = anchorToPrComment(
      { path: "docs/old-name.mdx", startLine: 1, endLine: 1 },
      files,
    );
    expect(result.kind).toBe("line");
    if (result.kind !== "line") throw new Error("unreachable");
    // Comment must reference the RESOLVED (new) filename, not the old.
    expect(result.target.path).toBe("docs/new-name.mdx");
    expect(result.target.line).toBe(1);
  });

  test("surfaces a malformed patch as a reject, not a silent file fallback", () => {
    const files = [file("docs/broken.mdx", "@@ -1,2 +1,2 @@\n" + "-x\n" + "+X\n")];
    const result = anchorToPrComment(
      { path: "docs/broken.mdx", startLine: 1, endLine: 1 },
      files,
    );
    expect(result.kind).toBe("reject");
    if (result.kind !== "reject") throw new Error("unreachable");
    expect(result.reason).toMatch(/failed to parse patch/);
  });
});

describe("findFile", () => {
  const files: PrFile[] = [
    file("docs/a.mdx", ""),
    { filename: "docs/renamed.mdx", previousFilename: "docs/old.mdx", status: "renamed", patch: "" },
  ];

  test("finds a file by its current name", () => {
    expect(findFile(files, "docs/a.mdx")?.filename).toBe("docs/a.mdx");
  });

  test("finds a renamed file by its old name", () => {
    expect(findFile(files, "docs/old.mdx")?.filename).toBe("docs/renamed.mdx");
  });

  test("prefers a current-name match over a previous-name match on a collision", () => {
    // If a rename target collides with another file's old name, the
    // current name wins — otherwise a renamed file's neighbour
    // would silently shadow the rename.
    const collision: PrFile[] = [
      { filename: "docs/shared.mdx", status: "modified", patch: "" },
      { filename: "docs/renamed.mdx", previousFilename: "docs/shared.mdx", status: "renamed", patch: "" },
    ];
    expect(findFile(collision, "docs/shared.mdx")?.filename).toBe("docs/shared.mdx");
  });
});

describe("prCommentToAnchor", () => {
  test("maps a RIGHT-side line comment to a line-anchor result", () => {
    const result = prCommentToAnchor({
      path: "docs/x.mdx",
      line: 42,
      startLine: 40,
      side: "RIGHT",
    });
    expect(result).toEqual({ kind: "line", path: "docs/x.mdx", startLine: 40, endLine: 42 });
  });

  test("collapses a single-line comment to startLine == endLine", () => {
    const result = prCommentToAnchor({
      path: "docs/x.mdx",
      line: 7,
      side: "RIGHT",
    });
    expect(result).toEqual({ kind: "line", path: "docs/x.mdx", startLine: 7, endLine: 7 });
  });

  test("orphans a LEFT-side comment (old file side)", () => {
    const result = prCommentToAnchor({
      path: "docs/x.mdx",
      line: 5,
      side: "LEFT",
    });
    expect(result).toEqual({ kind: "orphan", path: "docs/x.mdx", reason: "left-side" });
  });

  test("orphans an outdated comment", () => {
    const result = prCommentToAnchor({
      path: "docs/x.mdx",
      line: null,
      originalLine: 3,
      side: "RIGHT",
      isOutdated: true,
    });
    expect(result).toEqual({ kind: "orphan", path: "docs/x.mdx", reason: "outdated" });
  });

  test("orphans a file-subject comment", () => {
    const result = prCommentToAnchor({ path: "docs/x.mdx", subjectType: "file" });
    expect(result).toEqual({ kind: "orphan", path: "docs/x.mdx", reason: "file-level" });
  });

  test("orphans a comment with no resolvable line and no outdated flag", () => {
    const result = prCommentToAnchor({ path: "docs/x.mdx", side: "RIGHT" });
    expect(result).toEqual({ kind: "orphan", path: "docs/x.mdx", reason: "unresolved-line" });
  });

  test("falls back to diffSide when side is absent (GraphQL naming)", () => {
    const result = prCommentToAnchor({ path: "docs/x.mdx", line: 3, diffSide: "LEFT" });
    expect(result).toEqual({ kind: "orphan", path: "docs/x.mdx", reason: "left-side" });
  });
});

describe("fileFallbackPreamble", () => {
  test("includes the range and reason in a stable format", () => {
    const preamble = fileFallbackPreamble(
      { path: "docs/x.mdx", startLine: 3, endLine: 8 },
      "range-outside-hunk",
    );
    expect(preamble).toContain("L3-L8");
    expect(preamble).toContain("range-outside-hunk");
    expect(preamble).toContain("docs/x.mdx");
  });

  test("uses a single L<n> for a single-line range", () => {
    const preamble = fileFallbackPreamble(
      { path: "docs/x.mdx", startLine: 5, endLine: 5 },
      "no-patch",
    );
    expect(preamble).toContain("L5");
    expect(preamble).not.toContain("L5-L5");
  });
});
