// Restart-resilience test for the fast-path derive-from-files
// serving (PR-56 round-2 nit).
//
// The round-1 daemon held publish overrides in an in-memory map.
// A restart forgot every override — a doc the agent published
// five seconds ago would show its old dist content again.
//
// The round-1 fix derived serving from source revision + a
// content-addressed cache, so restarts are correct: the cache
// warms on first request, but the derived comparison
// (`revisionOf(source)` vs. `distStamp`) is what decides what
// to serve, and it survives a restart.
//
// This test exercises the invariant end-to-end: publish, stop
// the daemon, start a NEW daemon against the same repo, request
// the same route, assert the fresh source's content lands on
// the wire.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";
import type { LineSink } from "../../src/serve/logger.ts";
import { ARTICLE_OPEN_MARKER } from "../../src/serve/publish.ts";

const SHELL = `<!doctype html>
<html lang="en"><head><title>ADR</title></head>
<body>
<div class="content-panel"><div class="sl-container">${ARTICLE_OPEN_MARKER}<p>STALE-DIST</p></div></div>
</body></html>
`;

interface Ctx {
  root: string;
  handle: DaemonHandle | undefined;
}

async function boot(root: string): Promise<DaemonHandle> {
  const logs: string[] = [];
  const sink: LineSink = { write: (line) => logs.push(line) };
  return await startDaemon({
    dir: join(root, "dist"),
    repoRoot: root,
    port: 0,
    sqlitePath: ":memory:",
    version: "0.0.0-test",
    localUserId: "local-test",
    installSignalHandlers: false,
    logSink: sink,
    reanchor: { pollIntervalMs: 60_000, buildDebounceMs: 60_000, fileDebounceMs: 60_000 },
  });
}

let ctx: Ctx;
beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "revkit-publish-restart-"));
  const distAdr = join(root, "dist", "adr", "9994-restart");
  mkdirSync(distAdr, { recursive: true });
  writeFileSync(join(distAdr, "index.html"), SHELL);
  writeFileSync(join(root, "dist", "index.html"), "<!doctype html><h1>root</h1>");
  mkdirSync(join(root, "docs", "adr"), { recursive: true });
  mkdirSync(join(root, "vocab"), { recursive: true });
  writeFileSync(
    join(root, "vocab", "terms.yaml"),
    `schemaVersion: 1\nentries:\n  - id: placeholder\n    term: placeholder\n    definition: A placeholder term for tests.\n`,
  );
  ctx = { root, handle: await boot(root) };
});
afterEach(async () => {
  if (ctx.handle !== undefined) await ctx.handle.stop();
  rmSync(ctx.root, { recursive: true, force: true });
});

test("published content survives a daemon restart (round-2 nit)", async () => {
  const source = "# ADR-9994\n\n- Status: Proposed\n- Date: 2026-09-30\n\n## Context\n\nAfter-publish content that must survive a restart.\n";
  writeFileSync(join(ctx.root, "docs", "adr", "9994-restart.md"), source);
  // Warm the cache with a first request under the OLD handle.
  const before = await (await fetch(`${ctx.handle!.url}/adr/9994-restart/`)).text();
  expect(before).toContain("After-publish content");
  expect(before).not.toContain("STALE-DIST");
  // Stop the daemon, boot a fresh one on the SAME repo.
  await ctx.handle!.stop();
  ctx.handle = await boot(ctx.root);
  const after = await (await fetch(`${ctx.handle.url}/adr/9994-restart/`)).text();
  // The fresh daemon's in-memory cache is empty; the derive-from-
  // files logic reads the on-disk source, compares to dist's stamp,
  // and renders the CURRENT source. Content survives.
  expect(after).toContain("After-publish content");
  expect(after).not.toContain("STALE-DIST");
});
