import { expect, test } from "bun:test";
import { alignLeaf, sourceEndpoint } from "../src/text-provenance.ts";
import { renderProvenance, selectionAnchor } from "../src/serve/source-provenance.ts";
import { revisionOf } from "@revkit/review-core";

for (const [source, rendered, exact] of [
  ["a.&#46;b", "a..b", "."],
  ["a-&#45;-b", "a---b", "-"],
  ["a&#39;''b", "a'''b", "&#39;"],
  ["a&#46;.b", "a..b", "&#46;"],
  ["a&#46;&#46;b", "a..b", "&#46;"],
] as const) test(`unchanged run retains each source atom: ${source}`, async () => {
  const map = alignLeaf(source, rendered, 0)!;
  expect(source.slice(sourceEndpoint(map, 1, "start"), sourceEndpoint(map, 2, "end"))).toBe(exact);
  const tree = await renderProvenance("/repo", "docs/probe.md", source);
  const leaf = tree.document.querySelector("[data-revkit-leaf]")!.getAttribute("data-revkit-leaf")!;
  const revision = await revisionOf(source);
  const anchor = selectionAnchor(tree, source, { path: "docs/probe.md", startLine: 1, endLine: 1 }, { kind: "range", version: 1, revision, start: { leaf, offset: 1 }, end: { leaf, offset: 2 } }, revision);
  expect(anchor?.quote).toEqual({ exact, prefix: "a", suffix: source.slice(1 + exact.length) });
  expect([anchor?.startLine, anchor?.endLine]).toEqual([1, 1]);
});
