// Unit tests for `rehype-drop-repo-doc-title`.
//
// The plugin drops the first `<h1>` from the hast tree for repo-doc
// pages so `rehype-data-src` sees the ORIGINAL source-line positions
// on every downstream block. The regression it kills: the loader's
// old source-side strip shifted every anchor by 2 lines (PR #38
// blocker 1).

import { describe, expect, test } from "bun:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import type { Root } from "hast";
import { rehypeDropRepoDocTitle, dropLeadingH1 } from "../src/rehype-drop-repo-doc-title.ts";
import { rehypeDataSrc } from "../src/rehype-data-src.ts";

async function render(
  source: string,
  options: { repoRoot: string; filePath: string; withStrip: boolean; withStamp?: boolean },
): Promise<string> {
  let processor = unified().use(remarkParse).use(remarkRehype);
  if (options.withStrip) {
    processor = processor.use(rehypeDropRepoDocTitle, { repoRoot: options.repoRoot }) as typeof processor;
  }
  if (options.withStamp !== false) {
    processor = processor.use(rehypeDataSrc, { repoRoot: options.repoRoot }) as typeof processor;
  }
  const out = await processor.use(rehypeStringify).process({ value: source, path: options.filePath });
  return String(out);
}

describe("rehype-drop-repo-doc-title", () => {
  const repoRoot = "/repo";

  test("drops the leading h1 for a docs/*.md file", async () => {
    const source = "# Title\n\nHello body.\n";
    const html = await render(source, {
      repoRoot,
      filePath: "/repo/docs/adr/0001-x.md",
      withStrip: true,
    });
    expect(html).not.toContain("<h1>Title</h1>");
    expect(html).toContain(">Hello body.<");
  });

  test("REGRESSION: paragraph stamps at its ORIGINAL source line after the h1 is dropped", async () => {
    // Body: line 1 = `# Title`, line 2 = blank, line 3 = paragraph.
    // Before the fix, stripLeadingHeading in source shifted the
    // paragraph to line 1 → stamped `:1-1`. The blocker test.
    const source = "# Title\n\nHello body.\n";
    const stamped = await render(source, {
      repoRoot,
      filePath: "/repo/docs/adr/0001-x.md",
      withStrip: true,
    });
    expect(stamped).toContain(`data-src="docs/adr/0001-x.md:3-3"`);
    expect(stamped).not.toContain(`data-src="docs/adr/0001-x.md:1-1"`);
  });

  test("does NOT drop the h1 for a site MDX file (outside docs/)", async () => {
    const source = "# MDX Title\n\nMDX body.\n";
    const html = await render(source, {
      repoRoot,
      filePath: "/repo/site/src/content/docs/index.mdx",
      withStrip: true,
    });
    // h1 present (with the stamped anchor, which is fine — the
    // predicate rejected this file so the drop skipped).
    expect(html).toMatch(/<h1[^>]*>MDX Title<\/h1>/);
  });

  test("does NOT touch the tree when the first element is not h1 (h2, p, …)", async () => {
    const source = "## Sub\n\nHello.\n";
    const html = await render(source, {
      repoRoot,
      filePath: "/repo/docs/adr/x.md",
      withStrip: true,
    });
    expect(html).toMatch(/<h2[^>]*>Sub<\/h2>/);
    expect(html).toContain("Hello.");
  });

  test("MUTATION: comparing with plugin vs without plugin makes the shift visible", async () => {
    // A file with `# Title` at line 1 and body at line 3 — without
    // the plugin (source-side strip disabled too) the anchors are
    // correct anyway (because source strip is now a no-op). This
    // test asserts the plugin doesn't break other anchor values.
    const source = "# T\n\nA.\n\nB.\n";
    const withStrip = await render(source, {
      repoRoot,
      filePath: "/repo/docs/adr/z.md",
      withStrip: true,
    });
    const withoutStrip = await render(source, {
      repoRoot,
      filePath: "/repo/docs/adr/z.md",
      withStrip: false,
    });
    // Only the h1 line differs: `#T` is gone with the plugin,
    // present without.
    expect(withStrip).not.toContain("<h1");
    expect(withoutStrip).toContain("<h1");
    // Paragraph anchors are the SAME in both — the plugin does not
    // change positions.
    expect(withStrip).toContain(`data-src="docs/adr/z.md:3-3"`);
    expect(withoutStrip).toContain(`data-src="docs/adr/z.md:3-3"`);
    expect(withStrip).toContain(`data-src="docs/adr/z.md:5-5"`);
    expect(withoutStrip).toContain(`data-src="docs/adr/z.md:5-5"`);
  });
});

describe("dropLeadingH1 — direct tree API", () => {
  test("returns true and removes the h1 + flanking whitespace text", () => {
    const tree: Root = {
      type: "root",
      children: [
        { type: "text", value: "\n" },
        {
          type: "element",
          tagName: "h1",
          properties: {},
          children: [{ type: "text", value: "Title" }],
          position: { start: { line: 1, column: 1 }, end: { line: 1, column: 8 } },
        },
        { type: "text", value: "\n" },
        {
          type: "element",
          tagName: "p",
          properties: {},
          children: [{ type: "text", value: "Body" }],
          position: { start: { line: 3, column: 1 }, end: { line: 3, column: 5 } },
        },
      ],
    };
    expect(dropLeadingH1(tree)).toBe(true);
    expect(tree.children.length).toBe(1);
    expect((tree.children[0] as { tagName: string }).tagName).toBe("p");
    // The paragraph's position was NOT modified — this is what
    // keeps data-src correct on the downstream stamp.
    const pos = (tree.children[0] as { position?: { start: { line: number } } }).position;
    expect(pos?.start.line).toBe(3);
  });

  test("returns false when the first element is not h1", () => {
    const tree: Root = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "h2",
          properties: {},
          children: [],
        },
      ],
    };
    expect(dropLeadingH1(tree)).toBe(false);
    expect(tree.children.length).toBe(1);
  });
});
