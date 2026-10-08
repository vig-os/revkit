import { expect, test } from "bun:test";
import { renderFixture } from "./fixtures/render-markdown.ts";

test("real renderer emits stable source endpoints and sparse substitution intervals", async () => {
  const source = '🎉 &quot;hi&quot; -- now......';
  const first = await renderFixture("/repo", "docs/probe.md", source);
  const second = await renderFixture("/repo", "docs/probe.md", source);
  const leaf = first.querySelector("p [data-revkit-leaf]");
  expect(leaf).not.toBeNull();
  expect(leaf!.getAttribute("data-revkit-leaf")).toBe(`v1-0-${source.length}`);
  expect(leaf!.outerHTML).toBe(second.querySelector("p [data-revkit-leaf]")!.outerHTML);
  const map = JSON.parse(leaf!.getAttribute("data-revkit-map")!);
  expect(map.start).toBe(0);
  expect(map.end).toBe(source.length);
  expect(map.length).toBe(leaf!.textContent!.length);
  expect(map.intervals.at(-1)).toEqual([13, 14, 24, 30]);
});

test("real renderer provenance uses LF UTF-16 offsets for CRLF and emoji", async () => {
  const document = await renderFixture("/repo", "docs/probe.md", "🎉 first\r\nsecond");
  const leaf = document.querySelector("p [data-revkit-leaf]");
  expect(leaf).not.toBeNull();
  expect(leaf!.getAttribute("data-revkit-leaf")).toBe("v1-0-15");
  expect(JSON.parse(leaf!.getAttribute("data-revkit-map")!)).toEqual({ start: 0, end: 15, length: 15 });
});

test("MDX leaves explicitly advertise unmapped instead of invented provenance", async () => {
  const document = await renderFixture("/repo", "docs/probe.mdx", "plain **bold**");
  const leaves = [...document.querySelectorAll("[data-revkit-leaf]")];
  expect(leaves).toHaveLength(2);
  for (const leaf of leaves) expect(leaf.getAttribute("data-revkit-map")).toBe("unmapped");
});
