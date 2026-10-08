import { expect, test } from "bun:test";
import { blockCoverage, extractBlockMap, parseMarkdownBlocks, validateBlockMap, validateBlockSnapshot } from "../src/markdown-blocks.ts";

const source = "## Heading\nBody soft\nline.\n\n- first\n  continued\n\n  second\n  - nested\n- sibling\n\n> one\n> two\n>\n> three\n\n| a\\|b | `c\\|d` | |\n| --- | --- | --- |\n| x | y | |\n\n```md\n# fake\n\n- fake\n```\n\n$$\nx\n\ny\n$$\n\n<div>\n# fake\n</div>\n\n[^n]: note\n\n    second note\n\n---\n\n[ref]: /target\n";
test("positioned ownership: containers fence leaf units, atomic blocks keep internal blanks", async () => {
  const map = await parseMarkdownBlocks(source);
  const slices = map.units.map((unit) => source.slice(unit.start, unit.end));
  expect(slices).toContain("## Heading");
  expect(slices).toContain("Body soft\nline.");
  expect(slices).toContain("first\n  continued");
  expect(slices).toContain("second");
  expect(slices).toContain("nested");
  expect(slices).toContain("one\n> two");
  expect(slices).toContain("three");
  expect(slices).toContain("```md\n# fake\n\n- fake\n```");
  expect(slices).toContain("$$\nx\n\ny\n$$");
  expect(slices).toContain("<div>\n# fake\n</div>");
  expect(slices).toContain("note");
  expect(slices).toContain("second note");
  expect(map.units.filter((unit) => unit.kind === "tableCell").map((unit) => source.slice(unit.start, unit.end))).toEqual(["| a\\|b ", "| `c\\|d` ", "| |", "| x ", "| y ", "| |"]);
  expect(map.nodes.filter((node) => node.barrier).map((node) => node.kind)).toEqual(["thematicBreak", "definition"]);
  expect(Object.isFrozen(map.units[0])).toBe(true);
});
test("syntax envelopes authorize only the actually selected prefix", async () => {
  const text = "- first\n\n  second\n- sibling";
  const map = await parseMarkdownBlocks(text);
  expect(blockCoverage(map, 2, 7)?.envelopes).toEqual([]);
  const whole = blockCoverage(map, 0, 7)!;
  expect(whole.units).toHaveLength(1);
  expect(whole.envelopes).toEqual([{ container: 2, start: 0, end: 2 }]);
  expect(blockCoverage(map, 0, text.indexOf("second") + 6)?.units).toHaveLength(2);
  const quoted = await parseMarkdownBlocks("> one\n>\n> two");
  expect(blockCoverage(quoted, 0, 5)?.units).toHaveLength(1);
  expect(blockCoverage(quoted, 2, 5)?.envelopes).toEqual([]);
});
test("CRLF/lone CR maps use LF UTF-16 source and revision", async () => {
  const lf = "# 👩‍💻\n\nCafé.";
  const map = await parseMarkdownBlocks(lf.replaceAll("\n", "\r\n"));
  expect(map).toEqual(await parseMarkdownBlocks(lf));
  expect(map).toEqual(await parseMarkdownBlocks(lf.replaceAll("\n", "\r")));
  expect(map.units[0]!.end).toBe("# 👩‍💻".length);
  await expect(validateBlockSnapshot(map, lf + "x")).rejects.toThrow("mismatch");
});
test("unknown and missing structure are barriers; MDX is fail closed", async () => {
  const position = { start: { offset: 0 }, end: { offset: 5 } };
  const unknown = extractBlockMap({ type: "root", position, children: [{ type: "extension", position }] }, "abcde", "revision");
  expect(unknown.units).toHaveLength(0);
  expect(unknown.nodes[1]!.barrier).toBe(true);
  expect(blockCoverage(unknown, 0, 5)).toBeUndefined();
  const missing = extractBlockMap({ type: "root", position, children: [{ type: "paragraph" }] }, "abcde", "revision");
  expect(missing.nodes[0]!.barrier).toBe(true);
  expect(missing.units).toHaveLength(0);
  const inline = extractBlockMap({ type: "root", position, children: [{ type: "paragraph", position, children: [{ type: "mdxTextExpression", position }] }] }, "abcde", "revision");
  expect(inline.units).toHaveLength(0);
  expect(inline.nodes[1]!.barrier).toBe(true);
  await expect(parseMarkdownBlocks("<Component />", { format: "mdx" })).rejects.toThrow("unsupported");
});
test("validation rejects versions, revision, length, disorder, nesting, missing units and forged envelopes", async () => {
  const map = await parseMarkdownBlocks("- one\n- two");
  const expected = { revision: map.revision, sourceLength: map.sourceLength };
  for (const bad of [
    { ...map, version: 2 }, { ...map, grammarVersion: "other" }, { ...map, revision: "other" },
    { ...map, sourceLength: 1 }, { ...map, units: [...map.units].reverse() }, { ...map, units: [] },
    { ...map, nodes: map.nodes.map((node, index) => index === 3 ? { ...node, end: map.sourceLength + 1 } : node) },
    { ...map, units: map.units.map((unit, index) => index === 0 ? { ...unit, envelopes: [{ container: 0, start: 0, end: 2 }] } : unit) },
  ]) expect(() => validateBlockMap(bad, expected)).toThrow();
});
