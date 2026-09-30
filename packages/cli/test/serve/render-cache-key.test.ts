// Regression test for the fast-path render cache's key shape
// (PR-56 round-2 blocker 3).
//
// The round-1 daemon keyed its render cache on `revision` alone.
// Two docs with byte-identical sources — a common case for
// stub / template ADRs during their first edits — collided:
// requesting `/adr/foo/` served the HTML rendered for
// `/adr/bar/`, because `revisionOf(foo.md) === revisionOf(bar.md)`
// and the cache returned bar's entry first. A live probe showed
// `data-src` attributes pointing at bar's source path served in
// foo's page.
//
// The fix (in `packages/cli/src/serve/daemon.ts`) is to key the
// cache on `(route, revision)`. This test exercises the daemon
// end-to-end: two byte-identical source files at two different
// routes, request each, assert each carries its OWN route's
// `data-src`.
//
// **RED on 1b66011e**: cacheGet(revision) returned the same entry
// for both routes; the second request served the first render.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";
import type { LineSink } from "../../src/serve/logger.ts";
import { ARTICLE_OPEN_MARKER } from "../../src/serve/publish.ts";

const SHELL_FOR = (route: string): string => `<!doctype html>
<html lang="en"><head><title>ADR</title></head>
<body>
<header class="sl-header">${route}</header>
<div class="content-panel"><div class="sl-container">${ARTICLE_OPEN_MARKER}<p>PRE-FAST-PATH</p></div></div>
<footer>© 2026</footer>
</body></html>
`;

// Byte-identical source at TWO different routes. The rendered
// HTML's `data-src` stamps encode the source path, so the two
// article bodies would DIFFER even though the sources have
// identical bytes — one carries `data-src="docs/adr/9991-foo.md"`,
// the other carries `data-src="docs/adr/9992-bar.md"`. Sharing a
// cache entry would serve one page's data-src on the other.
const IDENTICAL_BODY = `Placeholder body.

A second paragraph so the fast-path emits at least two
\`data-src\` stamps.
`;

const FOO_REL = "docs/adr/9991-cache-key-foo.md";
const BAR_REL = "docs/adr/9992-cache-key-bar.md";

interface Ctx {
  handle: DaemonHandle;
  root: string;
}

async function startCtx(): Promise<Ctx> {
  const root = mkdtempSync(join(tmpdir(), "revkit-cache-key-"));
  const dist = join(root, "dist");
  const distFoo = join(dist, "adr", "9991-cache-key-foo");
  const distBar = join(dist, "adr", "9992-cache-key-bar");
  mkdirSync(distFoo, { recursive: true });
  mkdirSync(distBar, { recursive: true });
  writeFileSync(join(distFoo, "index.html"), SHELL_FOR("foo"));
  writeFileSync(join(distBar, "index.html"), SHELL_FOR("bar"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><h1>root</h1>");
  mkdirSync(join(root, "docs", "adr"), { recursive: true });
  writeFileSync(join(root, FOO_REL), IDENTICAL_BODY);
  writeFileSync(join(root, BAR_REL), IDENTICAL_BODY);
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

test("byte-identical sources at different routes DO NOT share a cache entry (round-2 blocker 3)", async () => {
  const base = ctx.handle.url;
  // Request FOO first — this populates the cache under (foo, rev).
  const fooRes = await fetch(`${base}/adr/9991-cache-key-foo/`);
  expect(fooRes.status).toBe(200);
  const fooHtml = await fooRes.text();
  // Then request BAR — the OLD cache would serve foo's HTML here.
  const barRes = await fetch(`${base}/adr/9992-cache-key-bar/`);
  expect(barRes.status).toBe(200);
  const barHtml = await barRes.text();
  // Every `data-src` on the FOO page must point at foo's source.
  expect(fooHtml).toContain(`data-src="${FOO_REL}`);
  expect(fooHtml).not.toContain(`data-src="${BAR_REL}`);
  expect(barHtml).toContain(`data-src="${BAR_REL}`);
  expect(barHtml).not.toContain(`data-src="${FOO_REL}`);
});

test("re-request for the same route returns the SAME bytes (cache hit)", async () => {
  const base = ctx.handle.url;
  const first = await (await fetch(`${base}/adr/9991-cache-key-foo/`)).text();
  const second = await (await fetch(`${base}/adr/9991-cache-key-foo/`)).text();
  expect(second).toBe(first);
});
