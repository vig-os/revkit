// Issue #113 — quote provenance (RED).
//
// The rail used to build `anchor.quote` from the RENDERED DOM
// (`quoteFromBlock` → `block.textContent`) and the daemon stored it
// verbatim, but Astro's markdown pipeline runs `remark-smartypants`
// by default: `"` renders as `“ ”`, `--` as `—`, `...` as `…`, `'` as
// `’`. The stored quote therefore never equals the source the
// re-anchoring engine compares it against, so ~43 % of rendered
// blocks (measured over this repo's own `docs/**`) orphaned on the
// first edit even when the commented text was byte-identical.
//
// These tests drive the REAL pipeline (`createMarkdownProcessor`,
// the same call `publish-render.ts` makes) and assert both halves of
// the fix:
//
//   1. A NEW comment gets a SOURCE quote — the daemon slices the
//      quote out of the file it just read, byte-equal to the source
//      slice (see `anchor-quote-source.test.ts` for the daemon-side
//      half; here we assert the engine accepts it).
//   2. An EXISTING (legacy) comment that carries a RENDERED quote
//      still re-anchors, through ONE shared typography-fold
//      normalisation used symmetrically on both sides.
//   3. A genuinely edited sentence is still detected as changed —
//      the fold must never make a changed span match.
//
// Every fixture here asserts the OUTCOME (anchored / not anchored),
// not the internal stage, so a mutation of any of the three must
// turn at least one red.

import { describe, expect, test } from "bun:test";
import { createMarkdownProcessor } from "@astrojs/markdown-remark";
import { pathToFileURL } from "node:url";
import { buildSharedMarkdownConfig } from "../../../../site/src/lib/markdown-processor.ts";
import { reanchor, revisionOf, type Anchor } from "@revkit/review-core";

const REPO_ROOT = "/tmp/revkit-113-pipeline";

/** The source under test. Line 5 is the smart-punctuation paragraph;
 * every other line is deliberately plain so a fixture that anchors
 * can only be anchoring on the right text. */
const OLD_SOURCE = `# T

Intro paragraph.

He said "hi" -- ok... (c) 2026 and it's fine.

Tail paragraph.
`;

/** An unrelated paragraph APPENDED at the end of the file. The
 * commented paragraph is byte-identical across the two revisions, so
 * `classifySpan` is right that it did not change. */
const NEW_SOURCE = `${OLD_SOURCE}\nAppended paragraph that is unrelated to the anchor.\n`;

let processorPromise: Promise<Awaited<ReturnType<typeof createMarkdownProcessor>>> | undefined;
function processor() {
  processorPromise ??= createMarkdownProcessor({
    ...buildSharedMarkdownConfig(REPO_ROOT),
    syntaxHighlight: false,
  } as Parameters<typeof createMarkdownProcessor>[0]);
  return processorPromise;
}

async function render(source: string): Promise<string> {
  const p = await processor();
  const { code } = await p.render(source, { fileURL: pathToFileURL(`${REPO_ROOT}/docs/x.md`) });
  return code;
}

/** The RENDERED text of the `docs/x.md:5-5` block, exactly as the
 * browser's `textContent` would report it. This is what the rail
 * captured before the fix, and what a legacy stored quote carries. */
async function renderedParagraph5(): Promise<string> {
  const html = await render(OLD_SOURCE);
  const m = html.match(/<p data-src="docs\/x\.md:5-5">([\s\S]*?)<\/p>/);
  if (m === null || m[1] === undefined) {
    throw new Error(`fixture broke: no docs/x.md:5-5 block in:\n${html}`);
  }
  return m[1].replace(/<[^>]+>/g, "");
}

/** The SOURCE text of line 5 — the byte sequence the daemon stores as
 * the quote after the fix, and what every "not the old text"
 * assertion below compares against. */
const SOURCE_LINE_5 = OLD_SOURCE.split("\n")[4] ?? "";

/** An anchor whose quote is the SOURCE slice of line 5 — what the
 * daemon stores after the fix. `revisionOf(OLD_SOURCE)` so the
 * pipeline's snapshot check passes. */
async function sourceQuoteAnchor(): Promise<Anchor> {
  return {
    path: "docs/x.md",
    startLine: 5,
    endLine: 5,
    quote: {
      exact: SOURCE_LINE_5,
      prefix: "Intro paragraph.\n\n",
      suffix: "\n\nTail paragraph.",
    },
    revision: await revisionOf(OLD_SOURCE),
  };
}

/** A LEGACY anchor: the same block, but `quote` is the RENDERED text
 * the rail captured. This is what every comment created before the
 * fix carries — the log is append-only, so they cannot be rewritten. */
async function legacyRenderedQuoteAnchor(): Promise<Anchor> {
  return {
    path: "docs/x.md",
    startLine: 5,
    endLine: 5,
    quote: { exact: await renderedParagraph5(), prefix: "", suffix: "" },
    revision: await revisionOf(OLD_SOURCE),
  };
}

describe("issue #113 — a comment on a smart-quoted paragraph does not orphan", () => {
  test("the fixture really does render differently from its source (the defect's premise)", async () => {
    // Without this, every assertion below would be vacuous: if the
    // pipeline stopped running smartypants, the legacy-quote fixture
    // would pass for the wrong reason.
    const rendered = await renderedParagraph5();
    expect(rendered).toBe("He said “hi” — ok… (c) 2026 and it’s fine.");
    expect(SOURCE_LINE_5).toBe('He said "hi" -- ok... (c) 2026 and it\'s fine.');
    expect(rendered).not.toBe(SOURCE_LINE_5);
  });

  test("a SOURCE quote on that paragraph stays anchored across an unrelated append", async () => {
    const result = await reanchor(await sourceQuoteAnchor(), OLD_SOURCE, NEW_SOURCE);
    expect(result.kind).not.toBe("orphaned");
  });

  test("a LEGACY rendered quote on that paragraph stays anchored across an unrelated append", async () => {
    // THE repro. Before the fix this orphans with the (also wrong)
    // reason "diff reports unchanged, but the block's surroundings
    // differ (substring accident) and no move detected." — the text
    // did not change and nothing was a substring accident; the
    // browser had merely reported typographic punctuation.
    const result = await reanchor(await legacyRenderedQuoteAnchor(), OLD_SOURCE, NEW_SOURCE);
    expect(result.kind).not.toBe("orphaned");
  });

  test("a LEGACY rendered quote re-anchors to the SOURCE text, so the next rebuild compares like with like", async () => {
    // The rebuilt anchor must carry the NEW SOURCE text, not the old
    // rendered text. If it carried the rendered text forward, the
    // comment would survive this one edit and orphan on the next.
    const result = await reanchor(await legacyRenderedQuoteAnchor(), OLD_SOURCE, NEW_SOURCE);
    if (result.kind === "orphaned") {
      throw new Error(`expected the comment to re-anchor, got orphaned: ${result.reason}`);
    }
    expect(result.anchor.quote.exact).toBe(SOURCE_LINE_5);
  });

  test("a genuinely edited sentence on that paragraph is NOT folded into a match", async () => {
    // The other half of the promise: the fold must not make a real
    // change look like an unchanged span. The word "fine" becomes
    // "wrong" — a real edit, not punctuation.
    const edited = OLD_SOURCE.replace("and it's fine.", "and it's wrong.");
    const result = await reanchor(await legacyRenderedQuoteAnchor(), OLD_SOURCE, edited);
    // It may re-anchor (a modified span is allowed to fuzzy-match)
    // or orphan, but it must NOT come back claiming the OLD text
    // survived verbatim — that is the false match the fold must not
    // produce.
    if (result.kind !== "orphaned") {
      expect(result.anchor.quote.exact).not.toBe(SOURCE_LINE_5);
      expect(result.anchor.quote.exact).toContain("and it's wrong.");
    }
  });

  test("a genuinely edited sentence under a SOURCE quote is detected as changed", async () => {
    const edited = OLD_SOURCE.replace("and it's fine.", "and it's wrong.");
    const result = await reanchor(await sourceQuoteAnchor(), OLD_SOURCE, edited);
    if (result.kind !== "orphaned") {
      expect(result.anchor.quote.exact).toContain("and it's wrong.");
      expect(result.anchor.quote.exact).not.toBe(SOURCE_LINE_5);
    }
  });

  test("a legacy rendered quote whose text is GONE still orphans (the fold is not a blanket pass)", async () => {
    // The control: the whole paragraph is replaced with different
    // words. Nothing about punctuation is being folded here, so the
    // fold must not rescue it.
    const rewritten = OLD_SOURCE.replace(
      'He said "hi" -- ok... (c) 2026 and it\'s fine.',
      "Nothing in this paragraph resembles the commented one at all.",
    );
    const result = await reanchor(await legacyRenderedQuoteAnchor(), OLD_SOURCE, rewritten);
    expect(result.kind).toBe("orphaned");
  });
});
