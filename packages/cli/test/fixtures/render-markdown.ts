import { pathToFileURL } from "node:url";
import { createMarkdownProcessor } from "@astrojs/markdown-remark";
import { parseHTML } from "linkedom";
import { buildSharedMarkdownConfig } from "../../../../site/src/lib/markdown-processor.ts";

// Uses APIs present on dev too, so browser RED runs exercise the old
// renderer and rail without copying any new production implementation.
export async function renderFixture(root: string, path: string, source: string): Promise<Document> {
  const processor = await createMarkdownProcessor({
    ...buildSharedMarkdownConfig(root), syntaxHighlight: false,
  } as Parameters<typeof createMarkdownProcessor>[0]);
  const { code } = await processor.render(source, { fileURL: pathToFileURL(`${root}/${path}`) });
  return parseHTML(`<html><body>${code}</body></html>`).document;
}
