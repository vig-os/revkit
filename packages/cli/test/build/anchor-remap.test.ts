// Anchor-remap tests (issue #57 blocker). The `data-src` anchor on
// every rendered block must point at the source path a reviewer
// edits — for a consumer build, that's `<consumer>/docs/*`, NOT
// `<consumer>/.revkit/build/src/content/docs/*` (the throwaway
// staging copy `revkit build` populates). Without the pathMap
// remap:
//
//   1. Every comment on the rendered page anchors on a
//      `.revkit/build/…` path (a) the reviewer never sees in git,
//      (b) an agent editing the docs never touches, and (c) a
//      GitHub review would target a non-diff path.
//   2. `rehype-drop-repo-doc-title` never fires because the staged
//      path fails its `docs/**/*.md` predicate, so a leading
//      `# Title` in the body duplicates the frontmatter title.
//
// **RED on b3832661**: yes — before the pathMap option was added,
// `rehypeDataSrc` had no way to remap and would stamp the staging
// path. The tests below invoke the plugin directly with a VFile
// whose path is the staged copy and assert the anchor points at
// the source. That call would emit a `.revkit/build/…` prefix on
// b3832661.

import { describe, expect, test } from "bun:test";
import { applyPathMap, rehypeDataSrc } from "../../src/rehype-data-src.ts";
import { rehypeDropRepoDocTitle } from "../../src/rehype-drop-repo-doc-title.ts";
import type { Root, Element } from "hast";

describe("applyPathMap", () => {
  test("returns the input path when no map is provided", () => {
    expect(applyPathMap("/a/b/c.mdx", undefined)).toBe("/a/b/c.mdx");
  });
  test("rewrites a matching prefix at a directory boundary", () => {
    const map = [{ from: "/a/staging", to: "/a/source" }];
    expect(applyPathMap("/a/staging/docs/x.mdx", map)).toBe("/a/source/docs/x.mdx");
  });
  test("rewrites an exact match too", () => {
    const map = [{ from: "/a/staging", to: "/a/source" }];
    expect(applyPathMap("/a/staging", map)).toBe("/a/source");
  });
  test("does NOT rewrite a substring match that is not a full segment", () => {
    const map = [{ from: "/a/stag", to: "/a/other" }];
    // `/a/staging/x` starts with `/a/stag` textually but not at a
    // directory boundary — leave alone.
    expect(applyPathMap("/a/staging/x", map)).toBe("/a/staging/x");
  });
  test("first-match-wins over later entries", () => {
    const map = [
      { from: "/a/staging/docs", to: "/a/source-docs" },
      { from: "/a/staging", to: "/a/source" },
    ];
    expect(applyPathMap("/a/staging/docs/x.mdx", map)).toBe("/a/source-docs/x.mdx");
  });
});

describe("rehypeDataSrc respects pathMap — the consumer anchor points at the source", () => {
  function makeTree(): Root {
    // A single `<p>` element with a hast position field so the
    // plugin stamps it. Kept minimal.
    const p: Element = {
      type: "element",
      tagName: "p",
      properties: {},
      children: [{ type: "text", value: "hello" }],
      position: { start: { line: 3, column: 1 }, end: { line: 3, column: 6 } },
    };
    return { type: "root", children: [p] };
  }

  test("without pathMap, the anchor stamps the STAGING path (the bug shape)", () => {
    const tree = makeTree();
    const consumer = "/tmp/c";
    const staged = "/tmp/c/.revkit/build/src/content/docs/index.mdx";
    const plugin = rehypeDataSrc({ repoRoot: consumer });
    plugin(tree, { path: staged });
    const p = tree.children[0] as Element;
    expect(String(p.properties?.dataSrc ?? "")).toContain(".revkit/build/src/content/docs/index.mdx");
  });

  test("with pathMap, the anchor is rewritten to the SOURCE `docs/*` path", () => {
    const tree = makeTree();
    const consumer = "/tmp/c";
    const staged = "/tmp/c/.revkit/build/src/content/docs/index.mdx";
    const plugin = rehypeDataSrc({
      repoRoot: consumer,
      pathMap: [
        { from: "/tmp/c/.revkit/build/src/content/docs", to: "/tmp/c/docs" },
      ],
    });
    plugin(tree, { path: staged });
    const p = tree.children[0] as Element;
    const dataSrc = String(p.properties?.dataSrc ?? "");
    expect(dataSrc).toContain("docs/index.mdx");
    expect(dataSrc).not.toContain(".revkit/build/");
  });

  test("with pathMap, an OUT-OF-STAGING file is untouched (own-repo behaviour preserved)", () => {
    const tree = makeTree();
    const consumer = "/tmp/c";
    const own = "/tmp/c/docs/adr/0001.md";
    const plugin = rehypeDataSrc({
      repoRoot: consumer,
      pathMap: [
        { from: "/tmp/c/.revkit/build/src/content/docs", to: "/tmp/c/docs" },
      ],
    });
    plugin(tree, { path: own });
    const p = tree.children[0] as Element;
    expect(String(p.properties?.dataSrc ?? "")).toContain("docs/adr/0001.md");
  });
});

describe("rehypeDropRepoDocTitle respects pathMap — leading H1 drops for consumer docs too", () => {
  function makeTreeWithH1(): Root {
    const h1: Element = {
      type: "element",
      tagName: "h1",
      properties: {},
      children: [{ type: "text", value: "Title" }],
    };
    const p: Element = {
      type: "element",
      tagName: "p",
      properties: {},
      children: [{ type: "text", value: "body" }],
    };
    return { type: "root", children: [h1, p] };
  }

  test("without pathMap, the drop is SKIPPED for a staged consumer doc (default `matches` predicate wants `docs/`)", () => {
    const tree = makeTreeWithH1();
    const consumer = "/tmp/c";
    const staged = "/tmp/c/.revkit/build/src/content/docs/index.md";
    const plugin = rehypeDropRepoDocTitle({ repoRoot: consumer });
    plugin(tree, { path: staged });
    // The h1 is still there — the default predicate is
    // `docs/**/*.md` and the staged path is
    // `.revkit/build/src/content/docs/index.md`.
    const first = tree.children[0] as Element;
    expect(first.tagName).toBe("h1");
  });

  test("with pathMap, the drop fires on a staged consumer doc — mapped back to `docs/`", () => {
    const tree = makeTreeWithH1();
    const consumer = "/tmp/c";
    const staged = "/tmp/c/.revkit/build/src/content/docs/index.md";
    const plugin = rehypeDropRepoDocTitle({
      repoRoot: consumer,
      pathMap: [
        { from: "/tmp/c/.revkit/build/src/content/docs", to: "/tmp/c/docs" },
      ],
    });
    plugin(tree, { path: staged });
    // h1 dropped; first non-whitespace child is now the paragraph.
    const surviving = tree.children.filter(
      (c) => c.type === "element",
    ) as Element[];
    expect(surviving.length).toBe(1);
    expect(surviving[0]!.tagName).toBe("p");
  });
});
