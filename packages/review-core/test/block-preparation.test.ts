import { expect, test } from "bun:test";
import { parseMarkdownBlocks } from "../src/markdown-blocks.ts";
import { prepareBlockPair, prepareBlockSnapshot, prepareSegmentation, safePreparedEndpoints, correspondingRun } from "../src/block-preparation.ts";
import { prepareReanchor, reanchorWith, type ReanchorContext } from "../src/reanchor.ts";
import { DiffMatchPatch } from "../src/vendor/dmp.ts";

async function prepare(old: string, next: string) {
  const a = await prepareBlockSnapshot(old, await parseMarkdownBlocks(old));
  const b = await prepareBlockSnapshot(next, await parseMarkdownBlocks(next));
  const context = await prepareReanchor(old, next);
  return prepareBlockPair(a, b, context.diffs);
}
const fixtures = [
  // R1/R2 literal old/new strings from the re-falsification report.
  { name: "R1 heading without blank", old: "## Install the build tool v2\n\nBody text.", next: "## Install the build tool v3\nBody text.", pairs: [[0, 0], [1, 1]] },
  { name: "R2 inserted tight sibling", old: "- install the old deps now\n- run tests", next: "- install the old deps later\n- check it\n- run tests", pairs: [[0, 0], [1, 2]] },
  { name: "tight to loose", old: "- first item\n- second item", next: "- first item\n\n- second item", pairs: [[0, 0], [1, 1]] },
  { name: "loose to tight", old: "- first item\n\n- second item", next: "- first item\n- second item", pairs: [[0, 0], [1, 1]] },
  { name: "split", old: "alpha beta gamma delta\n\nStable.", next: "alpha beta\n\ngamma delta\n\nStable.", pairs: [[1, 2]], splits: 1 },
  { name: "merge", old: "alpha beta\n\ngamma delta\n\nStable.", next: "alpha beta\ngamma delta\n\nStable.", pairs: [[2, 1]], merges: 1 },
  { name: "reflow", old: "alpha beta gamma delta", next: "alpha beta\ngamma delta", pairs: [[0, 0]] },
  { name: "intact move is separate policy", old: "First unique block.\n\nSecond unique block.", next: "Second unique block.\n\nFirst unique block.", pairs: [] },
  { name: "duplicate move unresolved", old: "Same.\n\nSame.\n\nEnd.", next: "Same.\n\nEnd.\n\nSame.", pairs: [[0, 0]] },
  { name: "inserted identical block ambiguous", old: "Same.\n\nEnd.", next: "Same.\n\nSame.\n\nEnd.", pairs: [[1, 2]] },
  { name: "stable multi block", old: "alpha beta\n\ngamma delta", next: "alpha BETA\n\ngamma DELTA", pairs: [[0, 0], [1, 1]] },
  { name: "R6 inner blank removed plus appended paragraph", old: "alpha beta\n\ngamma delta", next: "alpha beta\ngamma delta\n\nAppended unrelated paragraph.", pairs: [], merges: 1 },
  { name: "marker and depth changes", old: "## Heading\n\n- first item", next: "### Heading\n\n* first item", pairs: [[0, 0], [1, 1]] },
  { name: "enclosure conversion refused", old: "alpha beta", next: "> alpha beta", pairs: [] },
  { name: "one/one complete rewrite nomination", old: "abc", next: "XYZ", pairs: [[0, 0]] },
  { name: "barrier cannot nominate rewrite", old: "abc\n\n---", next: "XYZ\n\n---", pairs: [] },
] as const;
for (const fixture of fixtures) test(`correspondence: ${fixture.name}`, async () => {
  const pair = await prepare(fixture.old, fixture.next);
  const expected = fixture.pairs.map(([a, b]): [number, number] => [pair.old.map.units[a]!.id, pair.next.map.units[b]!.id]);
  expect([...pair.correspondence.pairs].sort((a, b) => a[0] - b[0])).toEqual(expected);
  if ("splits" in fixture) expect(pair.correspondence.splits.size).toBe(fixture.splits);
  if ("merges" in fixture) expect(pair.correspondence.merges.size).toBe(fixture.merges);
  for (const [old, edges] of pair.correspondence.forward) for (const edge of edges) {
    expect(edge.oldUnit).toBe(old);
    expect(pair.correspondence.reverse.get(edge.newUnit)).toContain(edge);
  }
});
test("contiguous coverage survives; unmatched inner insertion and merge refuse the run", async () => {
  const old = "alpha beta\n\ngamma delta";
  const stable = await prepare(old, "alpha BETA\n\ngamma DELTA");
  expect(correspondingRun(stable.old.map, stable.next.map, stable.correspondence, 2, old.length - 2)).toHaveLength(2);
  for (const next of ["alpha beta\n\nInserted.\n\ngamma delta", "alpha beta\ngamma delta\n\nAppended unrelated paragraph."]) {
    const pair = await prepare(old, next);
    expect(correspondingRun(pair.old.map, pair.next.map, pair.correspondence, 0, old.length)).toBeUndefined();
  }
});
test("prepared segmentation probes original Unicode context", () => {
  for (const text of ["café", "👩‍💻", "🇨🇭", "👍🏽", "शब्द", "слово", "كلمة"]) {
    const tables = prepareSegmentation(text);
    expect(safePreparedEndpoints(tables, 0, text.length)).toBe(true);
    for (let end = 1; end < text.length; end++) expect(safePreparedEndpoints(tables, 0, end)).toBe(false);
  }
  const tables = prepareSegmentation("alpha beta");
  expect(tables.wordEnd[5]).toBe(1);
  expect(tables.wordInterior[2]).toBe(1);
  expect(safePreparedEndpoints(tables, 2, 5)).toBe(false);
});
test("R3: bytes segmented scale with snapshots, independently of edits and distinct anchors", async () => {
  for (const size of [5_000, 16_500]) for (const edits of [125, 250]) for (const anchors of [50, 100]) {
    const old = Array.from({ length: size }, () => "alpha").join(" ");
    const tokens = old.split(" ");
    for (let i = 0; i < edits; i++) tokens[i * 20] = "bravo";
    const next = tokens.join(" ");
    const counter = { bytesSegmented: 0, snapshotsSegmented: 0 };
    const a = await prepareBlockSnapshot(old, await parseMarkdownBlocks(old), counter);
    const b = await prepareBlockSnapshot(next, await parseMarkdownBlocks(next), counter);
    const pair = prepareBlockPair(a, b, new DiffMatchPatch().diff_main(old, next));
    for (let i = 0; i < anchors; i++) {
      const start = 6 * (i * 7);
      expect(safePreparedEndpoints(a.segmentation, start, start + 5)).toBe(true);
      expect(pair.localAlignment(a.map.units[0]!.id)).toBe(pair.localAlignment(a.map.units[0]!.id));
    }
    expect(counter).toEqual({ bytesSegmented: 2 * (old.length + next.length), snapshotsSegmented: 2 });
    expect(pair.alignmentStats().pairsAligned).toBe(1);
  }
});
test("cached raw alignment and aggregate budget fail closed", async () => {
  const pair = await prepare("the word brown", "the word wrong");
  const id = pair.old.map.units[0]!.id;
  const raw = pair.localAlignment(id)!;
  expect(raw).toEqual(new DiffMatchPatch().diff_main("the word brown", "the word wrong"));
  expect(pair.localAlignment(id)).toBe(raw);
  const blocked = prepareBlockPair(pair.old, pair.next, new DiffMatchPatch().diff_main(pair.old.source, pair.next.source), { maxSourceUnits: 1, maxPairs: 1, timeoutSeconds: 0.05 });
  expect(blocked.localAlignment(id)).toBeUndefined();
});
test("preparation is evidence only: existing acceptance is byte-identical with or without blocks", async () => {
  for (const fixture of fixtures) {
    const bare = await prepareReanchor(fixture.old, fixture.next);
    const pair = await prepare(fixture.old, fixture.next);
    const context: ReanchorContext = { ...bare, blocks: pair };
    const anchor = { path: "docs/test.md", startLine: 1, endLine: fixture.old.split("\n").length, revision: bare.oldRevision, quote: { exact: fixture.old, prefix: "", suffix: "" } };
    expect(await reanchorWith(context, anchor)).toEqual(await reanchorWith(bare, anchor));
  }
});
