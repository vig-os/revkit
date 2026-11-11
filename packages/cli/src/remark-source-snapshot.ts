// Parse source coordinates before any Markdown transforms (A2, ADR-0006).
// Astro's Markdown loader removes frontmatter before rendering.
// request-time renderers instead supply an authoritative in-memory snapshot.
import { readFileSync } from "node:fs";
import { parseFrontmatter } from "@astrojs/internal-helpers/frontmatter";
import type { Processor } from "unified";
import { filePathOf } from "./rehype-vfile.ts";

export function remarkSourceSnapshot(this: Processor, options: { readSource: boolean }) {
  const processor = this;
  const parse = processor.parser!;
  processor.parser = (document, file) => {
    const path = filePathOf(file);
    const raw = options.readSource && path !== undefined ? readFileSync(path, "utf8") : document;
    // Rehype consumers hash and align against the same unmodified snapshot.
    file.value = raw;
    // Match Astro MDX's frontmatter handling for every renderer. Spaces
    // preserve both line coordinates and UTF-16 offsets before parsing.
    const input = parseFrontmatter(raw, { frontmatter: "empty-with-spaces" }).content;
    return parse(input, file);
  };
}
