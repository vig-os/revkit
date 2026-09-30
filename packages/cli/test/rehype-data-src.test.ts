// Unit tests for the `rehype-data-src` plugin.
//
// The rehype pipeline is: remark-parse → remark-rehype → the plugin →
// hast-util-to-html. We stitch that pipeline together with `unified`
// and assert on the emitted HTML: the assertions are on the shape the
// browser actually sees (attribute strings), not on hast internals
// that a downstream change could quietly reshape.
//
// Non-tautology stance:
//   - The "removing the plugin drops the attribute" test proves the
//     assertion actually depends on the plugin, not on some accident of
//     the fixture.
//   - The parseDataSrc round-trip test proves the value the browser
//     parses back matches what the plugin emitted.

import { describe, expect, test } from "bun:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  formatDataSrc,
  parseDataSrc,
  rehypeDataSrc,
  repoRelativePosix,
  stampTree,
} from "../src/rehype-data-src.ts";

/** Render `source` through the pipeline with the plugin enabled.
 * `repoRoot` and `filePath` are threaded to the plugin as a VFile
 * would. */
async function renderWithPlugin(
  source: string,
  options: { repoRoot: string; filePath: string; withPlugin?: boolean },
): Promise<string> {
  let processor = unified().use(remarkParse).use(remarkRehype);
  if (options.withPlugin !== false) {
    processor = processor.use(rehypeDataSrc, { repoRoot: options.repoRoot }) as typeof processor;
  }
  const result = await processor.use(rehypeStringify).process({ value: source, path: options.filePath });
  return String(result);
}

describe("rehype-data-src — output HTML", () => {
  const repoRoot = "/repo";
  const filePath = "/repo/docs/example.md";

  test("stamps a top-level paragraph with its file:startLine-endLine", async () => {
    const html = await renderWithPlugin("A paragraph.\n", { repoRoot, filePath });
    expect(html).toContain(`data-src="docs/example.md:1-1"`);
  });

  test("stamps every heading level with the right range", async () => {
    const html = await renderWithPlugin("# H1\n\n## H2\n\n### H3\n", { repoRoot, filePath });
    // Lines are 1-indexed: H1@1, H2@3, H3@5.
    expect(html).toContain(`<h1 data-src="docs/example.md:1-1">`);
    expect(html).toContain(`<h2 data-src="docs/example.md:3-3">`);
    expect(html).toContain(`<h3 data-src="docs/example.md:5-5">`);
  });

  test("stamps a code block using the enclosing pre", async () => {
    const html = await renderWithPlugin(
      "```ts\nconst a = 1;\n```\n",
      { repoRoot, filePath },
    );
    // <pre> should carry the anchor; <code> inside does not.
    expect(html).toMatch(/<pre[^>]*data-src="docs\/example\.md:1-3"/);
    // The inner <code> must NOT carry an anchor (matches BLOCK_TAGS
    // set — `code` is inline).
    expect(html).not.toMatch(/<code[^>]*data-src="/);
  });

  test("stamps ordered / unordered lists AND each list item", async () => {
    const html = await renderWithPlugin("- one\n- two\n", { repoRoot, filePath });
    expect(html).toMatch(/<ul[^>]*data-src="docs\/example\.md:1-2"/);
    expect(html).toMatch(/<li[^>]*data-src="docs\/example\.md:1-1"/);
    expect(html).toMatch(/<li[^>]*data-src="docs\/example\.md:2-2"/);
  });

  test("stamps a blockquote", async () => {
    const html = await renderWithPlugin("> quoted\n", { repoRoot, filePath });
    expect(html).toMatch(/<blockquote[^>]*data-src="docs\/example\.md:1-1"/);
  });

  test("skips inline emphasis (em / a / strong)", async () => {
    const html = await renderWithPlugin("Text *emph* and [link](https://x.io).\n", { repoRoot, filePath });
    // Paragraph gets stamped, inline em / a do not.
    expect(html).toContain(`data-src="docs/example.md:1-1"`);
    expect(html).not.toMatch(/<em[^>]*data-src/);
    expect(html).not.toMatch(/<a[^>]*data-src/);
  });

  test("does not stamp when repoRoot escape (file above root)", async () => {
    const html = await renderWithPlugin("Hi.\n", {
      repoRoot: "/repo/sub",
      filePath: "/repo/other.md",
    });
    expect(html).not.toContain("data-src");
  });

  test("stamped attribute survives multi-block nesting (li inside ul inside root)", async () => {
    const html = await renderWithPlugin("- outer\n- another\n", { repoRoot, filePath });
    // At least one li has its own line-scoped range.
    expect(html).toMatch(/<li[^>]*data-src="docs\/example\.md:2-2"/);
  });
});

describe("rehype-data-src — negative control", () => {
  test("removing the plugin removes every data-src the plugin would have added", async () => {
    const repoRoot = "/repo";
    const filePath = "/repo/docs/example.md";
    const withPlugin = await renderWithPlugin("# Heading\n\nBody.\n", { repoRoot, filePath });
    const withoutPlugin = await renderWithPlugin("# Heading\n\nBody.\n", { repoRoot, filePath, withPlugin: false });
    expect(withPlugin).toContain("data-src=");
    expect(withoutPlugin).not.toContain("data-src=");
  });
});

describe("rehype-data-src — helpers", () => {
  test("formatDataSrc / parseDataSrc round-trip", () => {
    const value = formatDataSrc("docs/adr/0003.md", 40, 44);
    expect(value).toBe("docs/adr/0003.md:40-44");
    const parsed = parseDataSrc(value);
    expect(parsed).toEqual({ path: "docs/adr/0003.md", startLine: 40, endLine: 44 });
  });

  test("parseDataSrc rejects malformed values", () => {
    expect(parseDataSrc("no-colon")).toBeUndefined();
    expect(parseDataSrc("foo:")).toBeUndefined();
    expect(parseDataSrc("foo:bar")).toBeUndefined();
    expect(parseDataSrc("foo:1-")).toBeUndefined();
    expect(parseDataSrc("foo:1-abc")).toBeUndefined();
    // endLine < startLine is invalid — the anchor must be forward.
    expect(parseDataSrc("foo:5-3")).toBeUndefined();
    // 0-indexed startLine rejected (1-based is the invariant).
    expect(parseDataSrc("foo:0-1")).toBeUndefined();
  });

  test("repoRelativePosix returns POSIX-style paths and undefined on escape", () => {
    expect(repoRelativePosix("/repo", "/repo/a/b.md")).toBe("a/b.md");
    expect(repoRelativePosix("/repo", "/other/a.md")).toBeUndefined();
    expect(repoRelativePosix("/repo/", "/repo/x.md")).toBe("x.md");
  });
});

describe("rehype-data-src — stampTree fixture", () => {
  test("stampTree returns the number of nodes it stamped", () => {
    const tree = {
      type: "root" as const,
      children: [
        {
          type: "element" as const,
          tagName: "p",
          properties: {},
          children: [{ type: "text" as const, value: "hi" }],
          position: { start: { line: 1, column: 1 }, end: { line: 1, column: 3 } },
        },
        {
          type: "element" as const,
          tagName: "em",
          properties: {},
          children: [{ type: "text" as const, value: "x" }],
          position: { start: { line: 2, column: 1 }, end: { line: 2, column: 2 } },
        },
      ],
    };
    const stamped = stampTree(tree as never, {
      repoRelPath: "a.md",
      overwriteExisting: false,
    });
    // Only the <p> (a block tag) was stamped; the <em> (inline) was not.
    expect(stamped).toBe(1);
  });

  test("stampTree honours overwriteExisting=false by default", () => {
    const tree = {
      type: "root" as const,
      children: [
        {
          type: "element" as const,
          tagName: "p",
          properties: { dataSrc: "existing:1-1" },
          children: [],
          position: { start: { line: 1 }, end: { line: 1 } },
        },
      ],
    };
    stampTree(tree as never, { repoRelPath: "a.md", overwriteExisting: false });
    // @ts-expect-error touch child for assertion
    expect(tree.children[0].properties.dataSrc).toBe("existing:1-1");

    stampTree(tree as never, { repoRelPath: "a.md", overwriteExisting: true });
    // @ts-expect-error touch child for assertion
    expect(tree.children[0].properties.dataSrc).toBe("a.md:1-1");
  });
});

describe("rehype-data-src — real MDX-ish content", () => {
  // A minimal fixture drop simulating a repo doc: write a temp file
  // so the plugin resolves the repo-relative path against a real path
  // on disk. Verifies the plugin's file-path branch (not just an
  // in-memory tree).
  const scratch = mkdtempSync(join(tmpdir(), "revkit-rehype-"));
  const repoRoot = scratch;
  const relDocPath = "docs/example.md";
  const filePath = join(repoRoot, relDocPath);

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, "# Heading\n\nBody\n", "utf8");

  test("real file → relative path AND correct line numbers", async () => {
    const html = await renderWithPlugin("# Heading\n\nBody\n", { repoRoot, filePath });
    expect(html).toContain(`data-src="${relDocPath}:1-1"`);
    expect(html).toContain(`data-src="${relDocPath}:3-3"`);
    rmSync(scratch, { recursive: true, force: true });
  });
});
