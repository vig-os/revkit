// Regression test for the fast-path check gate
// (PR-56 round-2 NEW finding).
//
// The round-1 daemon fast-rendered any `.md` on disk without
// consulting `revkit check`. A file edited outside `publish`
// with a hand-rolled `<div onclick>` was served straight to
// the reviewer's browser — the same shape `revkit check`
// blocks on the write side, but the read side skipped the
// gate.
//
// The fix: the fast path calls `runCheck` on the current
// source (cached by revision). Passing → render. Failing →
// serve dist unchanged plus a visible "source changed —
// failing check" banner spliced into the article body so
// the reviewer knows dist is stale AND why.
//
// **RED on 1b66011e**: no check-gate; the hand-rolled `<div
// onclick>` reaches the reviewer.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";
import type { LineSink } from "../../src/serve/logger.ts";
import { ARTICLE_OPEN_MARKER } from "../../src/serve/publish.ts";

const SHELL = `<!doctype html>
<html lang="en"><head><title>ADR</title></head>
<body>
<header class="sl-header">nav</header>
<div class="content-panel"><div class="sl-container">${ARTICLE_OPEN_MARKER}<p>PRE-EDIT</p></div></div>
<footer>© 2026</footer>
</body></html>
`;

interface Ctx {
  handle: DaemonHandle;
  root: string;
}

async function startCtx(): Promise<Ctx> {
  const root = mkdtempSync(join(tmpdir(), "revkit-check-gate-"));
  const dist = join(root, "dist");
  const distAdr = join(dist, "adr", "9993-check-gate");
  mkdirSync(distAdr, { recursive: true });
  writeFileSync(join(distAdr, "index.html"), SHELL);
  writeFileSync(join(dist, "index.html"), "<!doctype html><h1>root</h1>");
  mkdirSync(join(root, "docs", "adr"), { recursive: true });
  mkdirSync(join(root, "vocab"), { recursive: true });
  writeFileSync(
    join(root, "vocab", "terms.yaml"),
    `schemaVersion: 1\nentries:\n  - id: placeholder\n    term: placeholder\n    definition: A placeholder term for tests.\n`,
  );
  const logs: string[] = [];
  const sink: LineSink = { write: (line) => logs.push(line) };
  const handle = await startDaemon({
    dir: dist,
    repoRoot: root,
    port: 0,
    sqlitePath: ":memory:",
    version: "0.0.0-test",
    localUserId: "local-test",
    installSignalHandlers: false,
    logSink: sink,
    reanchor: { pollIntervalMs: 60_000, buildDebounceMs: 60_000, fileDebounceMs: 60_000 },
  });
  return { handle, root };
}

async function stopCtx(ctx: Ctx): Promise<void> {
  await ctx.handle.stop();
  rmSync(ctx.root, { recursive: true, force: true });
}

let ctx: Ctx;
beforeEach(async () => {
  ctx = await startCtx();
});
afterEach(async () => {
  await stopCtx(ctx);
});

test("a source with a hand-rolled `<div onclick>` is NOT fast-rendered — banner appears", async () => {
  // Write a source that passes `revkit check` for content shape
  // (extension, path, existence) but FAILS the `no-hand-rolled-ui`
  // rule (raw `<div>` in an `.md` file).
  const badSource =
    "# ADR-9993\n\n- Status: Proposed\n- Date: 2026-09-30\n\n## Context\n\n<div onclick=\"alert(1)\">Naughty.</div>\n";
  writeFileSync(join(ctx.root, "docs", "adr", "9993-check-gate.md"), badSource);
  const res = await fetch(`${ctx.handle.url}/adr/9993-check-gate/`);
  expect(res.status).toBe(200);
  const html = await res.text();
  // The naughty `<div onclick>` MUST NOT reach the reviewer.
  expect(html).not.toContain('<div onclick="alert(1)">Naughty.</div>');
  // A visible banner MUST tell the reviewer that dist is stale
  // and why.
  expect(html).toContain('data-revkit-banner="stale-check"');
  expect(html).toContain("failing");
  expect(html).toContain("docs/adr/9993-check-gate.md");
});

test("a source that passes check IS fast-rendered", async () => {
  const goodSource =
    "# ADR-9993\n\n- Status: Proposed\n- Date: 2026-09-30\n\n## Context\n\nNice, plain markdown that check accepts.\n";
  writeFileSync(join(ctx.root, "docs", "adr", "9993-check-gate.md"), goodSource);
  const res = await fetch(`${ctx.handle.url}/adr/9993-check-gate/`);
  expect(res.status).toBe(200);
  const html = await res.text();
  // No banner.
  expect(html).not.toContain('data-revkit-banner="stale-check"');
  // Fast-render replaced dist's placeholder.
  expect(html).not.toContain("<p>PRE-EDIT</p>");
  expect(html).toContain("Nice, plain markdown that check accepts.");
});
