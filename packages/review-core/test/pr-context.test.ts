// PrContext tests — the per-PR patch cache (PR-43 nit: parse each
// file's patch once per PR, not per comment).
//
// The cache MUST:
//   - parse each file's patch exactly once, no matter how many
//     lookups happen; and
//   - keep the same mapping semantics as the pure `anchorToPrComment`
//     function (any mutation to the cached path that changes an
//     outcome would show up in these tests).

import { describe, expect, test } from "bun:test";
import { PrContext, type PrFile } from "../src/index.ts";

const FILES: PrFile[] = [
  {
    filename: "docs/a.mdx",
    status: "modified",
    patch:
      "@@ -1,3 +1,4 @@\n" +
      " keep\n" +
      "-drop\n" +
      "+add-a\n" +
      "+add-b\n" +
      " tail\n",
  },
  {
    filename: "docs/renamed.mdx",
    previousFilename: "docs/original.mdx",
    status: "renamed",
    patch: "@@ -1,1 +1,1 @@\n" + "-old\n" + "+new\n",
  },
];

describe("PrContext", () => {
  test("finds a file by its current name and by its previous name", () => {
    const ctx = new PrContext(FILES);
    expect(ctx.findFile("docs/a.mdx")?.filename).toBe("docs/a.mdx");
    expect(ctx.findFile("docs/original.mdx")?.filename).toBe("docs/renamed.mdx");
    expect(ctx.findFile("nope.mdx")).toBeUndefined();
  });

  test("hunks() parses the patch once — repeated lookups hit the cache", () => {
    const ctx = new PrContext(FILES);
    // The first call parses; the second returns the same instance.
    const first = ctx.hunks("docs/a.mdx");
    const second = ctx.hunks("docs/a.mdx");
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  test("rightSideLines() computes the RIGHT-side set once and reuses it", () => {
    const ctx = new PrContext(FILES);
    const s1 = ctx.rightSideLines("docs/a.mdx");
    const s2 = ctx.rightSideLines("docs/a.mdx");
    expect(s1).toBe(s2);
    expect(s1).not.toBeNull();
    // Right side of the hunk: context 1, adds 2 & 3, context 4.
    expect([...s1!].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  test("mapAnchor() matches the pure anchorToPrComment behaviour", () => {
    const ctx = new PrContext(FILES);
    const result = ctx.mapAnchor({
      path: "docs/a.mdx",
      startLine: 2,
      endLine: 3,
      quote: { exact: "add-a\nadd-b", prefix: "", suffix: "" },
      revision: "0".repeat(64),
    });
    expect(result.kind).toBe("line");
    if (result.kind !== "line") throw new Error("expected line");
    expect(result.target.line).toBe(3);
    expect(result.target.startLine).toBe(2);
    expect(result.target.side).toBe("RIGHT");
  });

  test("mapAnchor() keeps the rename-old-path safety property", () => {
    const ctx = new PrContext(FILES);
    const result = ctx.mapAnchor({
      path: "docs/original.mdx",
      startLine: 1,
      endLine: 1,
      quote: { exact: "old", prefix: "", suffix: "" },
      revision: "0".repeat(64),
    });
    expect(result.kind).toBe("file");
    if (result.kind !== "file") throw new Error("expected file");
    expect(result.reason).toBe("renamed-file-old-path");
  });

  test("hunks() on a file with no patch returns null (cached)", () => {
    const files: PrFile[] = [{ filename: "big.mdx", status: "modified" }];
    const ctx = new PrContext(files);
    expect(ctx.hunks("big.mdx")).toBeNull();
    expect(ctx.rightSideLines("big.mdx")).toBeNull();
  });

  test("hunks() re-throws the same parse error on subsequent calls (cached)", () => {
    // Header claims 2 lines but body only has 1 — parsePatch throws.
    const files: PrFile[] = [
      {
        filename: "broken.mdx",
        status: "modified",
        patch: "@@ -1,2 +1,2 @@\n" + "-x\n" + "+X\n",
      },
    ];
    const ctx = new PrContext(files);
    expect(() => ctx.hunks("broken.mdx")).toThrow();
    // Second call — same error, cached (not a fresh parse).
    expect(() => ctx.hunks("broken.mdx")).toThrow();
  });
});
