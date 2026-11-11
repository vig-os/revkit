import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createMarkdownProcessor } from "@astrojs/markdown-remark";
import { buildSharedMarkdownConfig } from "../../../site/src/lib/markdown-processor.ts";
import { extractDocRevision } from "../src/rehype-stamp-revision.ts";

for (const extension of ["md", "mdx"]) test(`${extension}: build and snapshot parsers share raw provenance`, async () => {
  const root = mkdtempSync(join(tmpdir(), "source-snapshot-"));
  const source = "---\ntitle: Snapshot\n---\n\nParagraph with **words**.\n\n```js\nconst x = 1;\n```\n";
  const path = join(root, `page.${extension}`);
  try {
    writeFileSync(path, source);
    const render = async (input: string, readSource: boolean) => {
      const processor = await createMarkdownProcessor({ ...buildSharedMarkdownConfig(root, { readSource }), syntaxHighlight: false } as Parameters<typeof createMarkdownProcessor>[0]);
      return (await processor.render(input, { fileURL: pathToFileURL(path) })).code;
    };
    const built = await render("Paragraph with **words**.\n\n```js\nconst x = 1;\n```", true);
    expect(built).toContain(`data-src="page.${extension}:5-5"`);
    expect(built).toContain(`data-src="page.${extension}:7-9"`);
    expect(extractDocRevision(built)).toBe(createHash("sha256").update(source).digest("hex"));
    // Requests can render a previous or unpublished snapshot. Disk must
    // never override that source when recovering authoritative anchors.
    writeFileSync(path, "different disk content");
    expect(await render(source, false)).toBe(built);
    expect(built).not.toContain("title: Snapshot");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
