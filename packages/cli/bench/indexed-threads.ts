// Manual scaling probe for #115; deliberately outside bun test/CI.
// From the repository root: nix develop -c bun packages/cli/bench/indexed-threads.ts
// Copy this same script into an origin/dev scratch checkout for the baseline.
// Seeding, startup and warm-up are excluded. No timing assertions.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION, revisionOf, type Anchor, type ReviewEvent, type ThreadArchive } from "@revkit/review-core";
import { startDaemon } from "../src/serve/daemon.ts";
import { SqliteThreadStore } from "../src/serve/sqlite-store.ts";

function report(line: string): void {
  process.stdout.write(`${line}\n`);
}

const PATH_COUNT = 40;
const PAGE_PATH_COUNT = 20;
const SAMPLES = 20;
const SOURCE = "# Probe\n\nThe anchored source line.\n";
const revision = await revisionOf(SOURCE);
const paths = Array.from({ length: PATH_COUNT }, (_, i) => `docs/probe-${i}.md`);
const statuses = ["open", "orphaned", "resolved"] as const;
const ts = "2026-10-08T00:00:00.000Z";
const actor = { kind: "local", id: "probe" } as const;
function anchor(path: string): Anchor {
  return { path, startLine: 3, endLine: 3, quote: { exact: "The anchored source line.", prefix: "", suffix: "" }, revision };
}
function archive(eventCount: number): ThreadArchive {
  const events: ReviewEvent[] = [];
  for (let i = 0; i < eventCount; i++) {
    const pathIndex = i % PATH_COUNT;
    const envelope = { seq: i + 1, ts, actor, threadId: `t-${pathIndex}`, commentId: `c-${i}` };
    events.push(i < PATH_COUNT
      ? { ...envelope, kind: "comment.created", anchor: anchor(paths[pathIndex]!), body: `comment ${i}` }
      : { ...envelope, kind: "comment.replied", parentId: `c-${pathIndex}`, body: `reply ${i}` });
  }
  return { schemaVersion: CURRENT_SCHEMA_VERSION, events };
}
async function mean(run: () => Promise<unknown>): Promise<number> {
  for (let i = 0; i < 5; i++) await run();
  const start = performance.now();
  for (let i = 0; i < SAMPLES; i++) await run();
  return (performance.now() - start) / SAMPLES;
}

report(`bun ${Bun.version}; ${process.platform}/${process.arch}; ${PATH_COUNT} threaded paths; mean of ${SAMPLES} warm calls`);
report("| events | filtered (ms) | unfiltered (ms) | ratio |");
report("| --- | --- | --- | --- |");
for (const eventCount of [40, 200, 1000, 5000]) {
  const store = SqliteThreadStore.open({ filename: ":memory:" });
  try {
    await store.import(archive(eventCount));
    const filtered = await mean(() => store.threads({ path: paths[0]!, status: [...statuses] }));
    const unfiltered = await mean(() => store.threads());
    report(`| ${eventCount} | ${filtered.toFixed(3)} | ${unfiltered.toFixed(3)} | ${(filtered / unfiltered).toFixed(3)}x |`);
  } finally {
    store.close();
  }
}

const root = mkdtempSync(join(tmpdir(), "revkit-index-probe-"));
try {
  mkdirSync(join(root, "docs"));
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist", "index.html"), "<h1>Scaling probe</h1>");
  for (const path of paths) writeFileSync(join(root, path), SOURCE);
  const sqlitePath = join(root, "threads.sqlite");
  const store = SqliteThreadStore.open({ filename: sqlitePath });
  try {
    await store.import(archive(5000));
    store.putSnapshot(revision, SOURCE);
  } finally {
    store.close();
  }
  const daemon = await startDaemon({
    dir: join(root, "dist"), repoRoot: root, sqlitePath, port: 0,
    version: "0.0.0-probe", localUserId: "probe", installSignalHandlers: false,
    enableBackgroundBuild: false, logSink: { write: () => {} },
  });
  try {
    // Match fetchThreads: 20 path-scoped requests issued with Promise.all,
    // all three statuses, parse every response. Auth uses this disposable
    // daemon's in-memory bearer; it is never printed or persisted by the probe.
    const headers = { authorization: `Bearer ${daemon.agentToken}`, accept: "application/json" };
    async function get(query: string): Promise<{ threads: { id: string }[] }> {
      const response = await fetch(`${daemon.url}/api/threads?${query}`, { headers });
      if (!response.ok) throw new Error(`probe GET failed: ${response.status}`);
      return response.json();
    }
    async function rail(): Promise<void> {
      const responses = await Promise.all(paths.slice(0, PAGE_PATH_COUNT).map((path) =>
        get(`path=${encodeURIComponent(path)}&status=${encodeURIComponent(statuses.join(","))}`)));
      const ids = new Set(responses.flatMap((response) => response.threads.map((thread) => thread.id)));
      if (ids.size !== PAGE_PATH_COUNT) throw new Error(`probe returned ${ids.size} threads`);
    }
    await rail();
    report("seeded 5000 events over 40 paths; 20 concurrent path-scoped GETs (rail fetchThreads shape)");
    const rounds: number[] = [];
    for (let round = 0; round < 3; round++) {
      const start = performance.now();
      await rail();
      const elapsed = performance.now() - start;
      rounds.push(elapsed);
      report(`round ${round}: ${elapsed.toFixed(1)} ms`);
    }
    report(`rail mean: ${(rounds.reduce((sum, value) => sum + value, 0) / rounds.length).toFixed(1)} ms`);
    const start = performance.now();
    await get("fields=id");
    report(`ids-only read: ${(performance.now() - start).toFixed(1)} ms`);
  } finally {
    await daemon.stop();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
