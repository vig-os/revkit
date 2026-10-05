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

/** POST an arbitrary body and return the status plus the first issue
 * message, so a refusal can be asserted by its REASON and not only by its
 * code. */
async function postRaw(body: unknown): Promise<{ status: number; message: string }> {
  const response = await fetch(`${daemon.url}/api/threads`, {
    method: "POST",
    headers: {
      cookie,
      host: `127.0.0.1:${daemon.port}`,
      origin: daemon.url,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let message = "";
  try {
    const parsed = JSON.parse(text) as {
      issues?: { message: string }[];
      detail?: { issues?: { message: string }[] };
    };
    message = parsed.issues?.[0]?.message ?? parsed.detail?.issues?.[0]?.message ?? text;
  } catch {
    message = text;
  }
  return { status: response.status, message };
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

  test("a selection hint that matches nothing in the line range is REFUSED (round 2)", async () => {
    // Round 1 widened here. That is the BLOCKER's second half: the hint is
    // the reviewer's rendered selection, so a hint the source does not
    // contain means the page is not describing the file the daemon just
    // read — a stale build. Storing the whole line anyway stored text the
    // reviewer never selected, on an anchor they can no longer trust.
    // Refused with a reason instead; see `postRaw` for the response shape.
    const response = await postRaw({
      anchor: { path: REL_PATH, startLine: 5, endLine: 5, revision: "0".repeat(64) },
      selectionHint: "this text is nowhere in the file",
      body: "stale page",
    });
    expect(response.status).toBe(400);
    expect(response.message).toBe(
      "stale-anchor: selection not found in source range; reload the page",
    );
  });

  test("a hint that matches nothing is refused even when the client ALSO sent a quote", async () => {
    // The fallback this replaces would have kept the client's own text for an
    // empty slice. It cannot fire for the new rail (which sends no quote), and
    // for a legacy client it would store rendered text — so it is gone, and
    // the outcome no longer depends on what the client volunteered.
    const response = await postRaw({
      anchor: {
        path: REL_PATH,
        startLine: 5,
        endLine: 5,
        revision: "0".repeat(64),
        quote: { exact: RENDERED_LINE_5, prefix: "", suffix: "" },
      },
      selectionHint: "this text is nowhere in the file",
      body: "legacy client, stale page",
    });
    expect(response.status).toBe(400);
    expect(response.message).toBe(
      "stale-anchor: selection not found in source range; reload the page",
    );
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

  test("a selection that spans a soft break stores that two-line SPAN (round 2)", async () => {
    // Round 1 widened this to the whole range, because the rendered text of a
    // two-line selection joins the lines with a space while the source holds a
    // newline, so the hint matched nothing. Round 2 makes an unresolvable hint
    // a refusal — so the matcher had to learn the soft break first, or every
    // routine two-line selection would have become a 400.
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
        // The rendered text of a two-line selection: the soft break
        // collapses to a space in the DOM.
        selectionHint: "first line of the pair second line of the pair",
        body: "both lines",
      }),
    });
    expect(response.status).toBe(201);
    const parsed = (await response.json()) as { event: { anchor: CreatedAnchor } };
    const stored = parsed.event.anchor;
    expect(stored.quote.exact).toBe("first line of the pair\nsecond line of the pair");
    expect(twoLines).toContain(stored.quote.exact);
    expect(stored.quote.exact).not.toContain("first line of the pair second line");
  });
});

// ---------------------------------------------------------------------------
// PR #124 round 2, review BLOCKER B1 — the daemon must not STORE a quote it
// had to invent.
//
// `buildQuoteFromLines` clamped an out-of-range line range to EOF. On a file
// with no trailing newline, an anchor of L40-41 against a 19-line source
// therefore stored line 19's paragraph as the comment's quote, and a later
// unrelated edit made the engine report `moved` onto that paragraph: a silent
// wrong anchor, where the pre-#113 code reported `orphaned` honestly.
//
// These go through the real POST because the property is the daemon's: a
// stored comment's quote is source text from the block the reviewer
// commented on, or the create is refused with a reason.
// ---------------------------------------------------------------------------

describe("POST /api/threads — a stale anchor is refused, not clamped (round 2, B1)", () => {
  /** 19 lines, NO trailing newline: the shape the falsifier measured. */
  const STALE_NO_NL = Array.from(
    { length: 19 },
    (_, i) => `Paragraph ${i + 1}: the quick brown fox jumps over the lazy dog.`,
  ).join("\n");

  test("a range past EOF is REFUSED, and the file's last paragraph is NOT stored", async () => {
    writeFileSync(join(root, REL_PATH), STALE_NO_NL);
    const response = await postRaw({
      anchor: { path: REL_PATH, startLine: 40, endLine: 41, revision: "0".repeat(64) },
      body: "commenting on lines 40-41 of a 19-line file",
    });
    expect(response.status).toBe(400);
    expect(response.message).toBe(
      "stale-anchor: anchor.startLine..endLine (40-41) is past the end of docs/adr/0013-smart.md (19 lines); reload the page",
    );
  });

  test("the SAME stale anchor on a file WITH a trailing newline is refused identically", async () => {
    // Round 1 clamped this to the empty 20th line, which handed the request to
    // the client-quote fallback — so the last byte of the file decided whether
    // the reviewer got a wrong quote or a silent no-op.
    writeFileSync(join(root, REL_PATH), `${STALE_NO_NL}\n`);
    const response = await postRaw({
      anchor: { path: REL_PATH, startLine: 40, endLine: 41, revision: "0".repeat(64) },
      body: "commenting on lines 40-41 of a 19-line file",
    });
    expect(response.status).toBe(400);
    expect(response.message).toBe(
      "stale-anchor: anchor.startLine..endLine (40-41) is past the end of docs/adr/0013-smart.md (20 lines); reload the page",
    );
  });

  test("a stale anchor is refused even when the client sent a quote to fall back on", async () => {
    // This is the falsifier's exact harm: the clamped quote WAS stored, so the
    // comment existed and looked healthy, pointing at a paragraph the reviewer
    // never read.
    writeFileSync(join(root, REL_PATH), STALE_NO_NL);
    const response = await postRaw({
      anchor: {
        path: REL_PATH,
        startLine: 40,
        endLine: 41,
        revision: "0".repeat(64),
        quote: { exact: "Paragraph 19: the quick brown fox jumps over the lazy dog.", prefix: "", suffix: "" },
      },
      body: "legacy client with a stale anchor",
    });
    expect(response.status).toBe(400);
  });

  test("nothing was stored: the refused create leaves no thread behind", async () => {
    // A 400 that still wrote a thread would be a lie about the outcome, and
    // the reviewer would see their comment with an anchor they never chose.
    writeFileSync(join(root, REL_PATH), STALE_NO_NL);
    await postRaw({
      anchor: { path: REL_PATH, startLine: 40, endLine: 41, revision: "0".repeat(64) },
      body: "this comment must not exist",
    });
    const threads = await (await fetch(`${daemon.url}/api/threads`, {
      headers: { cookie, host: `127.0.0.1:${daemon.port}`, origin: daemon.url },
    })).json() as { threads: { body: string }[] };
    expect(threads.threads).toHaveLength(0);
  });

  test("a range that is IN bounds but empty is refused with the empty-slice reason", async () => {
    // The trailing newline makes line 20 an existing, empty line — a different
    // fact from "line 40 does not exist", so it must read differently.
    writeFileSync(join(root, REL_PATH), `${STALE_NO_NL}\n`);
    const response = await postRaw({
      anchor: { path: REL_PATH, startLine: 20, endLine: 20, revision: "0".repeat(64) },
      body: "commenting on the empty line the trailing newline creates",
    });
    expect(response.status).toBe(400);
    expect(response.message).toBe(
      "anchor.startLine..endLine resolves to no text in the source file",
    );
  });

  test("the refusal keeps the rail's composer usable — a 400, not a dead POST", async () => {
    // Why 400 and not "store it, orphan it": the rail's `submitNewThread`
    // catches the failure, shows the message and leaves the composer open with
    // the reviewer's text in it (`setComposerAnchor(undefined)` runs only on
    // success). A refusal is recoverable — reload and re-select. A stored
    // comment with an invented anchor is not recoverable at all: it is
    // permanently unanchorable and the reviewer is never told why.
    writeFileSync(join(root, REL_PATH), STALE_NO_NL);
    const refused = await postRaw({
      anchor: { path: REL_PATH, startLine: 40, endLine: 41, revision: "0".repeat(64) },
      body: "the reviewer's text survives the refusal",
    });
    expect(refused.status).toBe(400);
    // And the same request with an in-range anchor succeeds, so the route
    // itself is not what refuses.
    const accepted = await postRaw({
      anchor: { path: REL_PATH, startLine: 19, endLine: 19, revision: "0".repeat(64) },
      body: "the reviewer's text survives the refusal",
    });
    expect(accepted.status).toBe(201);
  });
});
