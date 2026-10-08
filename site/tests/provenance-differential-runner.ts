import type { Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revisionOf } from "@revkit/review-core";
import { renderProvenance, selectionAnchor } from "../../packages/cli/src/serve/source-provenance.ts";
import { parseDataSrc } from "../../packages/cli/src/data-src-format.ts";
import { oracleDocuments } from "../../packages/cli/test/fixtures/provenance-oracle.ts";
import type {} from "./provenance-differential-browser.ts";

export function differentialBrowserScript(): string {
  const dir = mkdtempSync(join(tmpdir(), "revkit-differential-bundle-"));
  try {
    const outfile = join(dir, "browser.js");
    const built = spawnSync("bun", ["build", join(import.meta.dirname, "provenance-differential-browser.ts"), "--target=browser", "--format=iife", "--outfile", outfile], { encoding: "utf8" });
    if (built.status !== 0) throw new Error(`Browser differential bundle failed: ${built.stderr}`);
    return readFileSync(outfile, "utf8");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function runDifferential(page: Page, seed: number, documents: number, ranges = 70) {
  const script = differentialBrowserScript();
  const counts = { agree: 0, refused: 0, WRONG: 0 };
  const examples: unknown[] = [];
  for (const doc of oracleDocuments(seed, documents, ranges)) {
    const rendered = await renderProvenance("/repo", "docs/x.md", doc.raw);
    const revision = await revisionOf(doc.source);
    await page.setContent(`<main>${rendered.document.body.innerHTML}</main>`);
    await page.addScriptTag({ content: script });
    const results = await page.evaluate(({ visible, ranges, revision }) => {
      const block = [...document.querySelectorAll("[data-src]")].filter((b) => b.textContent!.trim() === visible).at(-1);
      if (!block) throw new Error(`Oracle/render mismatch: ${JSON.stringify(visible)} / ${[...document.querySelectorAll("[data-src]")].map((b) => b.textContent)}`);
      const nodes: { node: Text; start: number }[] = [];
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let length = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        nodes.push({ node: node as Text, start: length });
        length += (node as Text).length;
      }
      const shift = block.textContent!.indexOf(visible);
      return ranges.map(([a, b]) => {
        a += shift;
        b += shift;
        const start = nodes.find((x) => a >= x.start && a < x.start + x.node.length)!;
        const end = nodes.find((x) => b > x.start && b <= x.start + x.node.length)!;
        const range = document.createRange();
        range.setStart(start.node, a - start.start);
        range.setEnd(end.node, b - end.start);
        const target = window.rangeBlock(range);
        return { selection: target && window.rangeSelection(range, target, revision), stamp: target?.getAttribute("data-src"), selected: range.toString() };
      });
    }, { visible: doc.visible, ranges: doc.ranges, revision });
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const bounds = result.stamp ? parseDataSrc(result.stamp) : undefined;
      const actual = bounds && result.selection ? selectionAnchor(rendered, doc.source, bounds, result.selection, revision) : undefined;
      if (!actual) { counts.refused++; continue; }
      const [a, b] = doc.ranges[i]!;
      const [s] = doc.expected[a]!;
      const [, e] = doc.expected[b - 1]!;
      const want = { exact: doc.source.slice(s, e), prefix: doc.source.slice(Math.max(0, s - 32), s), suffix: doc.source.slice(e, e + 32) };
      const startLine = doc.source.slice(0, s).split("\n").length;
      const endLine = doc.source.slice(0, e - 1).split("\n").length;
      if (actual.quote.exact !== want.exact || actual.quote.prefix !== want.prefix || actual.quote.suffix !== want.suffix || actual.startLine !== startLine || actual.endLine !== endLine) {
        counts.WRONG++;
        if (examples.length < 5) examples.push({ source: doc.source, selected: result.selected, want, startLine, endLine, actual });
      } else counts.agree++;
    }
  }
  return { seed, documents, ranges: documents * ranges, ...counts, examples };
}
