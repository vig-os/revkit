// Syntax-only parser entry: no renderer, DOM, MDX evaluation or host imports.
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mathFromMarkdown } from "mdast-util-math";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";
import { extractBlockMap, type BlockMap } from "./block-map.ts";
import { revisionOf } from "./revision.ts";
export * from "./block-map.ts";

export async function parseMarkdownBlocks(source: string, options: { readonly format?: "markdown" | "mdx" } = {}): Promise<BlockMap> {
  if (options.format === "mdx") throw new Error("MDX block maps are unsupported");
  const lf = source.replace(/\r\n?/g, "\n");
  const tree = fromMarkdown(lf, { extensions: [gfm(), math()], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()] });
  return extractBlockMap(tree, lf, await revisionOf(lf));
}
