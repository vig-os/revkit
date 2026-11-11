import { expect, test } from "bun:test";
import { recoverLegacyAnchor, renderProvenance } from "../../src/serve/source-provenance.ts";
import { revisionOf } from "@revkit/review-core";

for (const size of [10_000, 20_000, 40_000, 80_000]) test(`legacy recovery bounds repeated matches before validation: ${size}`, async () => {
  const source = "x\n".repeat(size / 2);
  // Scale the identity leaf from a real renderer fixture. The recovery
  // metric excludes Markdown rendering (also excluded by the falsifier).
  // Full-size real rendering remains in the manual scaling script.
  const rendered = await renderProvenance("/repo", "docs/probe.md", "x\nx");
  const [id, record] = [...rendered.leaves][0]!;
  record.element.textContent = source.slice(0, -1);
  const stamp = `docs/probe.md:1-${size / 2}`;
  rendered.document.querySelector("p")!.setAttribute("data-src", stamp);
  const scaled = { ...rendered, blocks: new Set([stamp]), leaves: new Map([[id, { element: record.element, map: { start: 0, end: source.length - 1, length: source.length - 1 } }]]) };
  const anchor = { path: "docs/probe.md", startLine: 1, endLine: 1, revision: await revisionOf(source), quote: { exact: "x", prefix: "", suffix: "" } };
  const before = performance.now();
  const recovered = recoverLegacyAnchor(scaled, source, anchor);
  const elapsed = performance.now() - before;
  console.info(`legacy provenance ${size}: ${elapsed.toFixed(2)} ms`);
  expect(recovered?.quote.exact).toBe("x");
  expect([recovered?.startLine, recovered?.endLine]).toEqual([1, 1]);
  expect(elapsed).toBeLessThan(200);
});
