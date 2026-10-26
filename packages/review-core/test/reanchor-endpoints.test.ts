import { expect, test } from "bun:test";
import { alignMatchedText, prepareReanchor, reanchorWith, revisionOf, type Anchor } from "../src/index.ts";

const fixtures = [
  { name: "D1: appending at EOF cannot dissolve the paragraph boundary", old: "# Title\n\nThe quick brown fox is fine.", next: "# Title\n\nThe quick brown fox is wrong.\n\nAppended paragraph.", quote: "The quick brown fox is fine.", prefix: "# Title\n\n", suffix: "", expected: "The quick brown fox is wrong." },
  { name: "D2: an inserted following paragraph is outside an empty-context quote", old: "# Title\n\nWe should ship it now.\n\nTail.", next: "# Title\n\nWe should ship the release now.\n\nInserted para.\n\nTail.", quote: "We should ship it now.", prefix: "", suffix: "", expected: "We should ship the release now." },
  { name: "D3: a multi-word replacement cannot absorb a following list block", old: "H\n\nvalue data review here gamma beta comment word great it\n\n- tail item", next: "H\n\nvalue data review here gamma beta comment one two\n\n- tail item\n\nUnrelated paragraph 0.", quote: "value data review here gamma beta comment word great it", prefix: "H\n\n", suffix: "\n\n- tail item", expected: "value data review here gamma beta comment one two" },
  { name: "D4: brown to wrong includes the final g", old: "the word brown", next: "the word wrong", quote: "the word brown", prefix: "", suffix: "", expected: "the word wrong" },
  { name: "D5: of to fine includes the entire replacement", old: "a of", next: "a fine", quote: "a of", prefix: "", suffix: "", expected: "a fine" },
  { name: "D5: to to over includes the entire replacement", old: "It is to", next: "It is over", quote: "It is to", prefix: "", suffix: "", expected: "It is over" },
  { name: "D6: a short CJK heading anchors correctly or orphans", old: "## 这与", next: "## 这据\n\nAppended paragraph.", quote: "## 这与", prefix: "", suffix: "", expected: "## 这据" },
  { name: "reviewer: rewriting Tail paragraph cannot expand the Dots quote", old: "# Title\n\nDots.... here.... word.... fine\n\nTail paragraph.", next: "# Title\n\nDots.... here.... word.... wrong\n\nCompletely other text.", quote: "Dots.... here.... word.... fine", prefix: "", suffix: "", expected: "Dots.... here.... word.... wrong" },
] as const;

for (const fixture of fixtures) test(`#146-r1 ${fixture.name}`, async () => {
  const start = fixture.old.indexOf(fixture.quote);
  const line = fixture.old.slice(0, start).split("\n").length;
  const anchor: Anchor = { path: "docs/probe.md", startLine: line, endLine: line, revision: await revisionOf(fixture.old), quote: { exact: fixture.quote, prefix: fixture.prefix, suffix: fixture.suffix } };
  const result = await reanchorWith(await prepareReanchor(fixture.old, fixture.next), anchor);
  if (result.kind === "orphaned") return;
  expect(result.anchor.quote.exact).toBe(fixture.expected);
  expect(result.anchor.startLine).toBe(line);
  expect(result.anchor.endLine).toBe(line);
});

for (const [old, next] of [["the word brown", "the word wrong"], ["a of", "a fine"], ["It is to", "It is over"]] as const) {
  test(`#146-r1 D4/D5 walker includes the entire replacement: ${old} → ${next}`, () => {
    const result = alignMatchedText(old, next + "\n\nAppended paragraph.", 0);
    expect(result.matchedText).toBe(next);
    expect(result.endOffset).toBe(next.length);
  });
}

test("#146-r1 walker retains the final period after an edited word beside an earlier ellipsis", () => {
  const old = 'He said "hi" -- ok... and it\'s fine.';
  const next = old.replace("fine", "wrong");
  const result = alignMatchedText(old, next + "\n\nTail paragraph.\n\nUnrelated paragraph.", 0, { trailingContext: "\n\nTail paragraph.\n\nUnrelated par" });
  expect(result.matchedText).toBe(next);
  expect(result.endOffset).toBe(next.length);
});

test("#146-r1 context beyond the bounded block cannot steal the right to great replacement", () => {
  const old = "Dots.... here.... and.... a.... word.... right";
  const next = old.replace("right", "great");
  const result = alignMatchedText(old, next + "\n\nTail paragraph.\n\nUnrelated paragraph.", 0, { trailingContext: "\n\nTail paragraph.\n\nUnrelated par" });
  expect(result.matchedText).toBe(next);
  expect(result.endOffset).toBe(next.length);
});
