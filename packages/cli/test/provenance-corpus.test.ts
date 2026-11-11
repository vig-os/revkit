import { expect, test } from "bun:test";
import { revisionOf } from "@revkit/review-core";
import { renderProvenance, selectionAnchor } from "../src/serve/source-provenance.ts";
import { PROBE_ROWS } from "./fixtures/quote-probes.ts";

// Test-only selection oracle: normalize the browser's visual whitespace
// while retaining an independent DOM-node/UTF-16 position for each char.
// It never uses production sourceEndpoint/alignLeaf to compute expectations.
async function selectProbe(row: typeof PROBE_ROWS[number]) {
  const path = "site/src/content/docs/probe.md";
  const rendered = await renderProvenance("/repo", path, row.source);
  const block = rendered.document.querySelector("[data-src]")!;
  const chars: { char: string; leaf: string; offset: number }[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      const text = node as Text;
      const leaf = text.parentElement?.closest("[data-revkit-leaf]")?.getAttribute("data-revkit-leaf") ?? "unmapped";
      for (let offset = 0; offset < text.length; offset++) chars.push({ char: text.data[offset]!, leaf, offset });
    }
    for (const child of node.childNodes) walk(child);
  };
  walk(block);
  const normalized: typeof chars = [];
  for (const item of chars) {
    const char = /\s/.test(item.char) ? " " : item.char;
    if (char === " " && normalized.at(-1)?.char === " ") continue;
    normalized.push({ ...item, char });
  }
  const hint = row.hint.replace(/\s+/g, " ");
  const at = normalized.map((c) => c.char).join("").indexOf(hint);
  expect(at, `${row.name}: rendered selection is present`).toBeGreaterThanOrEqual(0);
  const a = normalized[at]!;
  const b = normalized[at + hint.length - 1]!;
  const revision = await revisionOf(row.source);
  return selectionAnchor(rendered, row.source, { path, startLine: 1, endLine: row.endLine ?? 1 }, {
    kind: "range", version: 1, revision,
    start: { leaf: a.leaf, offset: a.offset }, end: { leaf: b.leaf, offset: b.offset + 1 },
  }, revision);
}

for (const row of PROBE_ROWS) test(`parked corpus: ${row.name}`, async () => {
  const result = await selectProbe(row);
  if (row.exact === null) expect(result).toBeUndefined();
  else {
    expect(result?.quote.exact).toBe(row.exact);
    const start = row.source.indexOf(row.exact);
    expect(result?.quote.prefix).toBe(row.source.slice(Math.max(0, start - 32), start));
    expect(result?.quote.suffix).toBe(row.source.slice(start + row.exact.length, start + row.exact.length + 32));
    expect(result?.startLine).toBe(row.source.slice(0, start).split("\n").length);
    expect(result?.endLine).toBe(row.source.slice(0, start + row.exact.length - 1).split("\n").length);
  }
});

test("the salvaged corpus still has all 42 rows", () => expect(PROBE_ROWS).toHaveLength(42));

test("mutation: shifting a source occurrence is caught by the corpus oracle", async () => {
  const row = PROBE_ROWS.find((r) => r.name === "LIMIT: entity vs literal ampersand")!;
  const result = await selectProbe(row);
  expect(result?.quote.exact).toBe("A &amp; B");
  expect(() => expect(result?.quote.exact).toBe("A & B")).toThrow();
  expect(() => expect(result?.quote.prefix).toBe("A &amp; B, also ")).toThrow();
  expect(() => expect(result?.endLine).toBe(2)).toThrow();
});
