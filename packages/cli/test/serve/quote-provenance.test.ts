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

// ---------- F1 (review of #124): the modified path must align on SOURCE text ----------
//
// A whole-paragraph selection is the common legacy shape: the pre-fix
// `quoteFromBlock` cut `exact` as the whole rendered paragraph and
// left `prefix` / `suffix` EMPTY. Nothing about that quote is source-
// shaped, and on a line where the renderer collapses runs the two
// lengths are far apart — every `...` renders as a single `…`, so the
// rendered paragraph is a third of the source line's length.
//
// That matters on the MODIFIED path (`reanchor.ts` 4b), where
// `alignMatchedText` is given the recorded quote as its alignment
// target. The walker returns SOURCE offsets, so a target that is not
// source-shaped overruns its window and lands on the wrong span. The
// reviewer measured the consequence: `lines 3-5`, ending mid-word and
// swallowing the next paragraph, persisted through `thread.reanchored`
// — where the rail then looks for a `[data-src="…:3-5"]` no page
// carries, so the thread's anchor button is a silent no-op. A silent
// wrong anchor is worse than the honest orphan this PR set out to
// remove, which is why it is fixed here rather than filed alone.
//
// The source-quote path never had the problem: its quote IS source
// text. These fixtures pin that the two paths now agree byte for byte.

/** A line of SEVEN collapsing runs: each `...` renders as one `…`, so
 * the rendered paragraph is 22 characters shorter than the source. */
const COLLAPSE_OLD = `# T

Wait... what... really... ok... fine... yes... done...

Tail paragraph.
`;

const COLLAPSE_NEW = COLLAPSE_OLD.replace("fine", "wrong");

const COLLAPSE_SOURCE_LINE_3 = COLLAPSE_OLD.split("\n")[2] ?? "";

/** The rendered text of the line-3 block, i.e. the whole-paragraph
 * legacy quote: rendered text, empty prefix, empty suffix. */
async function renderedCollapseParagraph(): Promise<string> {
  const html = await render(COLLAPSE_OLD);
  const m = html.match(/<p data-src="docs\/x\.md:3-3">([\s\S]*?)<\/p>/);
  if (m === null || m[1] === undefined) {
    throw new Error(`fixture broke: no docs/x.md:3-3 block in:\n${html}`);
  }
  return m[1].replace(/<[^>]+>/g, "");
}

/** The source-quote anchor for line 3 of the collapse fixture. */
async function collapseSourceQuoteAnchor(): Promise<Anchor> {
  return {
    path: "docs/x.md",
    startLine: 3,
    endLine: 3,
    quote: { exact: COLLAPSE_SOURCE_LINE_3, prefix: "# T\n\n", suffix: "\n\nTail paragraph." },
    revision: await revisionOf(COLLAPSE_OLD),
  };
}

/** The LEGACY whole-block anchor: rendered paragraph, no context. */
async function collapseLegacyRenderedQuoteAnchor(): Promise<Anchor> {
  return {
    path: "docs/x.md",
    startLine: 3,
    endLine: 3,
    quote: { exact: await renderedCollapseParagraph(), prefix: "", suffix: "" },
    revision: await revisionOf(COLLAPSE_OLD),
  };
}

describe("issue #113 F1 — a legacy whole-block quote aligns on the source span it was resolved to", () => {
  test("the fixture's rendered paragraph is far shorter than its source line", async () => {
    // The premise. Without it these fixtures would be vacuous.
    const rendered = await renderedCollapseParagraph();
    expect(rendered).toBe("Wait… what… really… ok… fine… yes… done…");
    expect(COLLAPSE_SOURCE_LINE_3).toBe("Wait... what... really... ok... fine... yes... done...");
    expect(rendered.length).toBe(COLLAPSE_SOURCE_LINE_3.length - 14);
  });

  test("the SOURCE-quote path anchors to line 3 and carries the edited sentence", async () => {
    const result = await reanchor(await collapseSourceQuoteAnchor(), COLLAPSE_OLD, COLLAPSE_NEW);
    if (result.kind === "orphaned") {
      throw new Error(`expected the source-quote path to re-anchor, got orphaned: ${result.reason}`);
    }
    expect(result.anchor.startLine).toBe(3);
    expect(result.anchor.endLine).toBe(3);
    expect(result.anchor.quote.exact).toBe(COLLAPSE_NEW.split("\n")[2]);
  });

  test("the LEGACY rendered quote lands on the SAME line range as the source-quote path", async () => {
    // THE repro. On the unfixed head this returns `lines 3-5` with
    // `exact` ending mid-word and swallowing the next paragraph: a
    // silent wrong anchor, persisted through `thread.reanchored`.
    const legacy = await reanchor(
      await collapseLegacyRenderedQuoteAnchor(),
      COLLAPSE_OLD,
      COLLAPSE_NEW,
    );
    if (legacy.kind === "orphaned") {
      throw new Error(`expected the legacy quote to re-anchor, got orphaned: ${legacy.reason}`);
    }
    expect(legacy.anchor.startLine).toBe(3);
    expect(legacy.anchor.endLine).toBe(3);
  });

  test("the LEGACY path's result is byte-identical to the SOURCE path's", async () => {
    // Not just "both anchored": the same anchor. The alignment input
    // must be the SOURCE span `locateOldSpan` already resolved, so
    // which quote happens to be recorded cannot move the result.
    const legacy = await reanchor(
      await collapseLegacyRenderedQuoteAnchor(),
      COLLAPSE_OLD,
      COLLAPSE_NEW,
    );
    const source = await reanchor(await collapseSourceQuoteAnchor(), COLLAPSE_OLD, COLLAPSE_NEW);
    if (legacy.kind === "orphaned" || source.kind === "orphaned") {
      throw new Error(`expected both paths to re-anchor; got ${legacy.kind} / ${source.kind}`);
    }
    expect(legacy.anchor).toEqual(source.anchor);
    expect(legacy.anchor.quote.exact).toBe(COLLAPSE_NEW.split("\n")[2]);
  });

  test("the edited sentence is in the quote — the edit is not silently dropped", async () => {
    // The milder variant the reviewer saw on other shapes: a truncated
    // span that omits the edit entirely. Asserting the edited words
    // are present catches that as well as the overrun.
    const legacy = await reanchor(
      await collapseLegacyRenderedQuoteAnchor(),
      COLLAPSE_OLD,
      COLLAPSE_NEW,
    );
    if (legacy.kind === "orphaned") {
      throw new Error(`expected the legacy quote to re-anchor, got orphaned: ${legacy.reason}`);
    }
    expect(legacy.anchor.quote.exact).toContain("ok... wrong... yes...");
  });
});
