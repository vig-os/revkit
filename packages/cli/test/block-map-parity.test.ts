import { expect, test } from "bun:test";
import { parseMarkdownBlocks } from "@revkit/review-core/markdown-blocks";
import { capturedMarkdownMap } from "../src/remark-block-map.ts";
import { renderProvenance } from "../src/serve/source-provenance.ts";
import { renderDocFragment } from "../src/serve/publish-render.ts";

const fixtures = [
  "paragraph with **bold**, $x$, `code` and\nsoft break.",
  "# Title\nBody immediately.\n\nSetext\n======\nBody immediately.",
  "- first\n- second\n\n- loose\n\n  child\n  - nested\n    - deeper",
  "> one\n> two\n>\n> three\n> - child",
  "| a\\|b | `c\\|d` | |\n| --- | --- | --- |\n| | empty | |",
  "| `a|b` | c |\n| --- | --- |\n| x | y |",
  "```md\n# fake\n\n- fake\n```",
  "$$\nx + y\n\n= z\n$$",
  "<div>\n# fake\n\n</div>",
  "Text[^n].\n\n[^n]: first\n\n    second\n\n[ref]: /target",
  "---\ntitle: Frontmatter\n---\n\n# Body",
  "# 👩‍💻\r\n\r\nText\rnext.",
];
for (const [index, source] of fixtures.entries()) test(`renderer-captured mdast == standalone grammar ${index}`, async () => {
  const rendered = await renderProvenance("/repo", "docs/parity.md", source);
  expect(rendered.blockMap).toEqual(await parseMarkdownBlocks(source));
});
test("publish hands off captured maps by source revision without a second render", async () => {
  const source = "# Title\n\nPublished paragraph.";
  const result = await renderDocFragment({ repoRoot: "/repo", path: "docs/publish.md", source });
  expect("html" in result).toBe(true);
  const expected = await parseMarkdownBlocks(source);
  expect(capturedMarkdownMap(expected.revision)).toEqual(expected);
});
test("MDX renderer capture stays unavailable", async () => {
  const rendered = await renderProvenance("/repo", "docs/parity.mdx", "ordinary prose");
  expect(rendered.blockMap).toBeUndefined();
});
