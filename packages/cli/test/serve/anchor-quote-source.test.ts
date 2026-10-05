// Issue #113, deliverable 1 — a comment created through the daemon
// carries a SOURCE quote.
//
// The rail could only offer the RENDERED text (it reads the DOM), so
// it used to post that as `anchor.quote` and the daemon stored it
// verbatim. Those quotes are the ones that orphan on the first edit,
// because the re-anchoring engine compares them against source bytes.
// The daemon now derives the quote from the file it already reads for
// the anchor's revision, using the client's selection only to decide
// WHICH source span to quote.
//
// What is asserted here is the provenance property itself: the stored
// quote is a byte-equal slice of the file. Every case runs through the
// real `POST /api/threads` route, because the property belongs to the
// daemon's comment-create path, not to a helper.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revisionOf, type AnchorRequest } from "@revkit/review-core";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";

let daemon: DaemonHandle;
let root: string;
let cookie: string;

// The commented line carries every punctuation shape `remark-smartypants`
// rewrites, so the rendered text a browser would report differs from the
// source on this ONE line and on no other.
const SOURCE =
  "# T\n" +
  "\n" +
  "Intro paragraph.\n" +
  "\n" +
  'He said "hi" -- ok... (c) 2026 and it\'s fine. Use `gh` here.\n' +
  "\n" +
  "Tail paragraph.\n";
const REL_PATH = "docs/adr/0013-smart.md";
/** What the DOM would hold for the line-5 block: every smartypants
 * substitution applied, and the inline code's backticks gone. */
const RENDERED_LINE_5 = "He said “hi” — ok… (c) 2026 and it’s fine. Use gh here.";
const SOURCE_LINE_5 = 'He said "hi" -- ok... (c) 2026 and it\'s fine. Use `gh` here.';

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "revkit-113-quote-"));
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "index.html"), "<h1>x</h1>");
  mkdirSync(join(root, "docs", "adr"), { recursive: true });
  writeFileSync(join(root, REL_PATH), SOURCE);
  daemon = await startDaemon({
    dir: join(root, "dist"),
    repoRoot: root,
    port: 0,
    sqlitePath: ":memory:",
    version: "0.0.0-test",
    localUserId: "local-test",
    installSignalHandlers: false,
    logSink: { write: () => {} },
  });
  const response = await fetch(daemon.launchUrl, { redirect: "manual" });
  const raw = response.headers.get("set-cookie") ?? "";
  const semi = raw.indexOf(";");
  cookie = raw.slice(0, semi === -1 ? undefined : semi).trim();
});
afterEach(async () => {
  await daemon.stop();
  rmSync(root, { recursive: true, force: true });
});

interface CreatedAnchor {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly quote: { readonly exact: string; readonly prefix: string; readonly suffix: string };
  readonly revision: string;
}

/** POST a comment the way the rail does and return the anchor the
 * daemon STORED. `selectionHint` is the rendered text the reviewer's
 * DOM selection produced; pass `undefined` for a client that sends none. */
async function postComment(selectionHint?: string): Promise<CreatedAnchor> {
  const anchor: AnchorRequest = {
    path: REL_PATH,
    startLine: 5,
    endLine: 5,
    // The revision a client cannot know: the daemon overrides it.
    revision: "0".repeat(64),
    ...(selectionHint === undefined
      ? {}
      : {
          // A legacy rail still posts its rendered quote. The daemon
          // must not store this text; asserting it does not is the
          // point of the next test, so it is sent here too.
          quote: { exact: selectionHint, prefix: "", suffix: "" },
        }),
  };
  const response = await fetch(`${daemon.url}/api/threads`, {
    method: "POST",
    headers: {
      cookie,
      host: `127.0.0.1:${daemon.port}`,
      origin: daemon.url,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      anchor,
      ...(selectionHint === undefined ? {} : { selectionHint }),
      body: "what does this line mean?",
    }),
  });
  expect(response.status).toBe(201);
  const parsed = (await response.json()) as { event: { anchor: CreatedAnchor } };
  return parsed.event.anchor;
}

describe("POST /api/threads — the stored quote is a SOURCE slice (issue #113)", () => {
  test("the fixture's rendered text really differs from its source", () => {
    // Without this the whole suite would be vacuous: if the rendered
    // text equalled the source, every assertion below would hold for
    // the wrong reason.
    expect(RENDERED_LINE_5).not.toBe(SOURCE_LINE_5);
    expect(SOURCE.split("\n")[4]).toBe(SOURCE_LINE_5);
  });

  test("a comment on the whole smart-quoted line stores the SOURCE line, not the rendered text", async () => {
    const stored = await postComment(RENDERED_LINE_5);
    expect(stored.quote.exact).toBe(SOURCE_LINE_5);
    expect(stored.quote.exact).not.toBe(RENDERED_LINE_5);
    expect(SOURCE).toContain(stored.quote.exact);
  });

  test("a comment on a SELECTION inside the line stores that source span", async () => {
    // The reviewer selected `ok... (c) 2026` in the browser, where it
    // reads `ok… (c) 2026`. The stored quote is the source span.
    const stored = await postComment("ok… (c) 2026");
    expect(stored.quote.exact).toBe("ok... (c) 2026");
    expect(stored.quote.exact).not.toBe("ok… (c) 2026");
  });

  test("a selection inside inline code stores a source span, not the rendered text", async () => {
    // Issue #113's narrower variant: a `<code>` node's
    // `position.start.offset` points at the OPENING backtick, so
    // slicing source at that offset yields `` `gh `` against a
    // rendered `gh` — and `gh` alone scored 0.00 against the 0.4 gate.
    //
    // This fix never uses a node offset: it folds the hint onto the
    // source slice and cuts the span the fold maps it to, which for
    // `` `gh` `` is the inner `gh` (the delimiters fold away, so they
    // are not part of what the rendered text carried). The stored
    // quote is therefore the source text the reviewer saw, and it
    // byte-matches the source — which is the property that matters,
    // because that is what the re-anchoring engine compares.
    const stored = await postComment("gh");
    expect(stored.quote.exact).toBe("gh");
    expect(SOURCE_LINE_5).toContain(stored.quote.exact);
    expect(stored.quote.exact).not.toBe("`gh`");
  });

  test("a client that sends NO quote gets the source line range", async () => {
    // The API stays usable by a client that cannot send a quote at all.
    const stored = await postComment(undefined);
    expect(stored.quote.exact).toBe(SOURCE_LINE_5);
    expect(stored.startLine).toBe(5);
    expect(stored.endLine).toBe(5);
  });

  test("a LEGACY client posting a rendered quote and no hint still stores source text", async () => {
    // The backwards-compatibility half: an already-deployed rail
    // bundle sends `anchor.quote` with RENDERED text and no
    // `selectionHint`. Before this change the daemon stored that
    // rendered text verbatim, which is the defect. Now the quote is
    // resolved against the source, so the stored quote is the source
    // line — the same answer the new rail gets.
    const anchor: AnchorRequest = {
      path: REL_PATH,
      startLine: 5,
      endLine: 5,
      revision: "0".repeat(64),
      quote: { exact: RENDERED_LINE_5, prefix: "", suffix: "" },
    };
    const response = await fetch(`${daemon.url}/api/threads`, {
      method: "POST",
      headers: {
        cookie,
        host: `127.0.0.1:${daemon.port}`,
        origin: daemon.url,
        "content-type": "application/json",
      },
      body: JSON.stringify({ anchor, body: "legacy client" }),
    });
    expect(response.status).toBe(201);
    const parsed = (await response.json()) as { event: { anchor: CreatedAnchor } };
    const stored = parsed.event.anchor;
    expect(stored.quote.exact).toBe(SOURCE_LINE_5);
    expect(stored.quote.exact).not.toBe(RENDERED_LINE_5);
  });

  test("the prefix and suffix are source text too, and sit around the quote", async () => {
    const stored = await postComment("ok… (c) 2026");
    const lineStart = SOURCE.indexOf(SOURCE_LINE_5);
    const exactAt = SOURCE.indexOf(stored.quote.exact, lineStart);
    expect(exactAt).toBeGreaterThanOrEqual(0);
    // `prefix` is the source text immediately before the quote and
    // `suffix` the text immediately after, both within the context
    // window — not rendered text, and not contiguous with a newline
    // that the fold skipped over.
    expect(SOURCE.slice(exactAt - stored.quote.prefix.length, exactAt)).toBe(stored.quote.prefix);
    expect(SOURCE.slice(exactAt + stored.quote.exact.length, exactAt + stored.quote.exact.length + stored.quote.suffix.length)).toBe(
      stored.quote.suffix,
    );
  });

  test("the stored revision is still the source's own hash", async () => {
    // The claim that quote derivation did not weaken the existing
    // server-side revision authority (PR #38).
    const stored = await postComment(RENDERED_LINE_5);
    expect(stored.revision).toBe(await revisionOf(SOURCE));
    expect(stored.revision).not.toBe("0".repeat(64));
  });

  test("a selection hint that matches nothing in the line range falls back to the line range", async () => {
    // A hint the source does not contain must NOT become the quote —
    // that would be the client dictating quote text again.
    const stored = await postComment("this text is nowhere in the file");
    expect(stored.quote.exact).toBe(SOURCE_LINE_5);
  });

  test("an ambiguous selection hint falls back to the line range rather than guessing", async () => {
    // The SAME selected text occurs twice on the anchored line, so the
    // rendered hint cannot say which span the reviewer picked. The
    // quote widens to the whole line: still correct source text, just
    // a coarser anchor. A wrong span would be worse than a wide one.
    const ambiguous =
      "# T\n\nintro paragraph.\n\nrepeated phrase here and repeated phrase here.\n\ntail.\n";
    writeFileSync(join(root, REL_PATH), ambiguous);
    const stored = await postComment("repeated phrase");
    expect(stored.quote.exact).toBe("repeated phrase here and repeated phrase here.");
  });

  test("a selection that spans lines still stores source text only", async () => {
    const twoLines = "# T\n\nfirst line of the pair\nsecond line of the pair\n\ntail\n";
    writeFileSync(join(root, REL_PATH), twoLines);
    const anchor: AnchorRequest = {
      path: REL_PATH,
      startLine: 3,
      endLine: 4,
      revision: "0".repeat(64),
    };
    const response = await fetch(`${daemon.url}/api/threads`, {
      method: "POST",
      headers: {
        cookie,
        host: `127.0.0.1:${daemon.port}`,
        origin: daemon.url,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        anchor,
        // The rendered text of a two-line selection joins the lines
        // with a space; the source holds a newline, so this hint
        // cannot be resolved to a source span and must not become one.
        selectionHint: "first line of the pair second line of the pair",
        body: "both lines",
      }),
    });
    expect(response.status).toBe(201);
    const parsed = (await response.json()) as { event: { anchor: CreatedAnchor } };
    const stored = parsed.event.anchor;
    expect(twoLines).toContain(stored.quote.exact);
    expect(stored.quote.exact).not.toContain("first line of the pair second line");
  });
});
