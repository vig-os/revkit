import { describe, expect, test } from "bun:test";
import { alignLeaf, sourceEndpoint } from "../src/text-provenance.ts";
import { renderProvenance, selectionAnchor } from "../src/serve/source-provenance.ts";
import { revisionOf } from "@revkit/review-core";

describe("finite per-leaf source substitutions", () => {
  for (const [source, rendered, code] of [
    ['He said "hi" -- ok... and it\'s fine.', 'He said “hi” — ok… and it’s fine.', false],
    ["one... two.... three......", "one… two… three…", false],
    ["&#46;&#46;&#46;", "…", false],
    ["\\.\\.\\.", "…", false],
    ["&quot;hi&quot; &amp;amp; &NotEqualTilde;", '“hi” &amp; ≂̸', false],
    ["` **kwargs `", "**kwargs", true],
    ["``a ` b``", "a ` b", true],
    ["` a\nb `", "a b", true],
    ["_id release/* *.md f(*args)", "_id release/* *.md f(*args)", false],
    ["&apos;&apos;hi''", "”hi”", false],
  ] as const) {
    test(JSON.stringify(source), () => {
      const map = alignLeaf(source, rendered, 7, code);
      expect(map).toBeDefined();
      for (let at = 0; at <= rendered.length; at++) {
        const start = sourceEndpoint(map!, at, "start")!;
        const end = sourceEndpoint(map!, at, "end")!;
        expect(start).toBeGreaterThanOrEqual(7);
        expect(end).toBeLessThanOrEqual(source.length + 7);
        expect(start).toBeLessThanOrEqual(end);
      }
    });
  }
  test("unknown transformations close the entire leaf", () => {
    expect(alignLeaf("hello", "goodbye", 0)).toBeUndefined();
    expect(alignLeaf("first\n> second", "first\nsecond", 0)).toBeUndefined();
  });
  test("interval endpoints include complete multi-character entities", () => {
    const map = alignLeaf("x &NotEqualTilde; y", "x ≂̸ y", 0)!;
    expect(sourceEndpoint(map, 3, "start")).toBe(2);
    expect(sourceEndpoint(map, 3, "end")).toBe(17);
    expect(sourceEndpoint(map, 4, "end")).toBe(17);
    expect(sourceEndpoint(map, -1, "start")).toBeUndefined();
    expect(sourceEndpoint(map, 1000, "end")).toBeUndefined();
  });
});

describe("real shared renderer differential", () => {
  for (const [source, selection, exact] of [
    ["A ***both*** and **_mix_** end", "both and mix", "both*** and **_mix"],
    ["Use `**kwargs` here", "**kwargs", "**kwargs"],
    ["writes to `release/*`. Then", "release/*", "release/*"],
    ["Use foo\\_bar or else foo_bar.", "foo_bar", "foo\\_bar"],
    ["A &amp; B, also A & B.", "A & B", "A &amp; B"],
    ["🎉 say &quot;hi&quot; -- now......", "“hi” — now…", "&quot;hi&quot; -- now......"],
    ["` padded ` and `a\nb`", "padded and a b", "padded ` and `a\nb"],
    ["first line\r\nsecond line 🎉", "line\nsecond", "line\nsecond"],
  ] as const) {
    test(JSON.stringify(source), async () => {
      const lf = source.replace(/\r\n?/g, "\n");
      const rendered = await renderProvenance("/repo", "docs/probe.md", source);
      const block = rendered.document.querySelector("p")!;
      const text = block.textContent!;
      const at = text.indexOf(selection);
      expect(at).toBeGreaterThanOrEqual(0);
      const leaves = [...block.querySelectorAll("[data-revkit-leaf]")];
      let length = 0;
      let start: { leaf: string; offset: number } | undefined;
      let end: { leaf: string; offset: number } | undefined;
      for (const leaf of leaves) {
        const size = leaf.textContent!.length;
        if (at >= length && at < length + size) start = { leaf: leaf.getAttribute("data-revkit-leaf")!, offset: at - length };
        if (at + selection.length > length && at + selection.length <= length + size) end = { leaf: leaf.getAttribute("data-revkit-leaf")!, offset: at + selection.length - length };
        length += size;
      }
      const revision = await revisionOf(lf);
      const anchor = selectionAnchor(rendered, lf, { path: "docs/probe.md", startLine: 1, endLine: lf.split("\n").length }, { kind: "range", version: 1, revision, start: start!, end: end! }, revision);
      expect(anchor?.quote.exact).toBe(exact);
      const expectedStart = lf.indexOf(exact);
      expect(anchor?.quote.prefix).toBe(lf.slice(Math.max(0, expectedStart - 32), expectedStart));
      expect(anchor?.quote.suffix).toBe(lf.slice(expectedStart + exact.length, expectedStart + exact.length + 32));
    });
  }
});

test("mapping geometric runs has linear output space and bounded latency", () => {
  for (const ch of ["*", "[", "."]) {
    const elapsed: number[] = [];
    for (const size of [10_000, 20_000, 40_000, 80_000]) {
      const source = ch.repeat(size) + " tail...";
      const value = (ch === "." ? "…" : ch.repeat(size)) + " tail…";
      const before = performance.now();
      const map = alignLeaf(source, value, 0);
      elapsed.push(performance.now() - before);
      expect(map).toBeDefined();
      expect(map!.intervals!.length).toBeLessThanOrEqual(2);
      expect(sourceEndpoint(map!, value.length, "end")).toBe(source.length);
    }
    console.info(`provenance ${ch} 10k/20k/40k/80k ms: ${elapsed.map((ms) => ms.toFixed(2)).join(" / ")}`);
    expect(Math.max(...elapsed)).toBeLessThan(200);
  }
});
