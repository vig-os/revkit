import { expect, test } from "bun:test";
import { revisionOf, type Anchor } from "@revkit/review-core";
import { recoverLegacyAnchor, renderProvenance } from "../../src/serve/source-provenance.ts";

for (const replacement of ["changed **deep** text", "different length **deep** text"]) test(`a cached renderer refuses a different source claiming its revision: ${replacement}`, async () => {
  const source = "before **deep** after";
  const rendered = await renderProvenance("/repo", "docs/probe.md", source);
  const anchor: Anchor = { path: "docs/probe.md", startLine: 1, endLine: 1, revision: await revisionOf(source), quote: { exact: "deep", prefix: "", suffix: "" } };
  expect(recoverLegacyAnchor(rendered, source, anchor)?.quote.exact).toBe("deep");
  expect(() => recoverLegacyAnchor(rendered, replacement, anchor)).toThrow("Rendered snapshot source or revision mismatch");
});

test("a cached renderer refuses a changed revision even when source text matches", async () => {
  const source = "before **deep** after";
  const rendered = await renderProvenance("/repo", "docs/probe.md", source);
  const anchor: Anchor = { path: "docs/probe.md", startLine: 1, endLine: 1, revision: await revisionOf(source), quote: { exact: "deep", prefix: "", suffix: "" } };
  expect(recoverLegacyAnchor(rendered, source, anchor)?.quote.exact).toBe("deep");
  expect(() => recoverLegacyAnchor(rendered, source, { ...anchor, revision: "0".repeat(64) })).toThrow("Rendered snapshot source or revision mismatch");
});
