// Child process for the `.revkit/repo-id` single-mint race test
// (`repo-id-atomic.test.ts`, issue #63).
//
// Starts a REAL daemon on a shared repo root, exactly the way
// `revkit serve` does, and prints one JSON line describing what
// happened:
//
//   {"kind":"ok","repoId":"…"}      — this child won the daemon lock
//   {"kind":"err","message":"…"}   — refused (or failed to start)
//
// The parent releases every child from a filesystem barrier so their
// startups overlap; a pre-fix build has each of them mint its own
// `repo-id` on the way to the lock, and the parent observes more than
// one distinct payload on disk.
//
// Usage: bun repo-id-race-child.ts <repoRoot> <distDir> <barrierFile> <readyFile>
// Prints the JSON line, holds the daemon lock briefly so the losers
// still find it held, then exits 0.

import { writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { startDaemon } from "../../../src/serve/daemon.ts";

const [repoRoot, distDir, barrierFile, readyFile] = process.argv.slice(2);
if (repoRoot === undefined || distDir === undefined || barrierFile === undefined || readyFile === undefined) {
  throw new Error("repo-id-race-child: expected <repoRoot> <distDir> <barrierFile> <readyFile>");
}

// Announce that we are running, then block until the parent says go.
// The parent waits for EVERY ready flag before releasing, so the
// order matters: ready first, then the wait.
writeFileSync(readyFile, "ready");
while (!existsSync(barrierFile)) await Bun.sleep(1);

try {
  const handle = await startDaemon({
    dir: distDir,
    repoRoot,
    port: 0,
    sqlitePath: ":memory:",
    version: "0.0.0-test",
    localUserId: "local-test",
    installSignalHandlers: false,
    enableBackgroundBuild: false,
    logSink: { write: () => {} },
  });
  const response = await fetch(`${handle.url}/-/health`, {
    headers: { host: `127.0.0.1:${handle.port}` },
  });
  const body = (await response.json()) as { repoId?: string };
  process.stdout.write(`${JSON.stringify({ kind: "ok", repoId: body.repoId })}\n`);
  // Hold the lock long enough for every sibling to be refused.
  await Bun.sleep(1500);
  await handle.stop();
} catch (error) {
  process.stdout.write(`${JSON.stringify({ kind: "err", message: (error as Error).message })}\n`);
}
