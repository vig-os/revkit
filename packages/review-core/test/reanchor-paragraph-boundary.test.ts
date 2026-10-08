import { expect, test } from "bun:test";
import { reanchor, revisionOf, type Anchor } from "../src/index.ts";
import { alignMatchedText } from "../src/reanchor.ts";

test("#127: replacement at an equal endpoint includes the rest of the edited word", () => {
  const quote = "Dots.... here.... and.... a.... word.... wrong";
  const trailingContext = "\n\nTail paragraph.";
  const edited = quote.replace("wrong", "right");
  const result = alignMatchedText(quote, edited + trailingContext + "\n\nAppended paragraph.", 0, { trailingContext });
  expect(result.startOffset).toBe(0);
  expect(result.endOffset).toBe(edited.length);
  expect(result.matchedText).toBe(edited);
});

test("#146: empty recorded context cannot swallow the following paragraphs", async () => {
  const line = "Dots...... here...... and...... a...... word...... fine";
  const old = `# Title\n\n${line}\n\nTail paragraph.`;
  const next = old.replace("fine", "wrong") + "\n\nUnrelated paragraph.";
  const anchor: Anchor = { path: "docs/probe.md", startLine: 3, endLine: 3, revision: await revisionOf(old), quote: { exact: line, prefix: "", suffix: "" } };
  const result = await reanchor(anchor, old, next);
  expect(result.kind).toBe("fuzzy");
  if (result.kind === "fuzzy") {
    expect(result.anchor.startLine).toBe(3);
    expect(result.anchor.endLine).toBe(3);
    expect(result.anchor.quote.exact).toBe(line.replace("fine", "wrong"));
  }
});

test("#146 property: word edits plus append never extend beyond the edited paragraph", async () => {
  const seed = 146;
  let random = seed;
  const nextInt = (): number => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random; };
  for (let i = 0; i < 500; i++) {
    const words = Array.from({ length: 5 + nextInt() % 8 }, (_, index) => `word${index}${".".repeat(nextInt() % 7)}`);
    const line = words.join(" ");
    const old = `# Title\n\n${line}\n\nTail paragraph ${i}.`;
    const edited = words.slice();
    edited[nextInt() % words.length] = `changed${nextInt() % 100}`;
    const newLine = edited.join(" ");
    const source = `# Title\n\n${newLine}\n\nTail paragraph ${i}.\n\nAppended unrelated paragraph ${nextInt()}.`;
    const anchor: Anchor = { path: "docs/probe.md", startLine: 3, endLine: 3, revision: await revisionOf(old), quote: { exact: line, prefix: "", suffix: "" } };
    const result = await reanchor(anchor, old, source);
    if (result.kind !== "orphaned") {
      try {
        expect(result.anchor.startLine).toBe(3);
        expect(result.anchor.endLine).toBe(3);
        expect(newLine).toContain(result.anchor.quote.exact);
      } catch (error) {
        throw new Error(`#146 property failed: seed=${seed}, case=${i}, old=${JSON.stringify(old)}, new=${JSON.stringify(source)}`, { cause: error });
      }
    }
  }
});
