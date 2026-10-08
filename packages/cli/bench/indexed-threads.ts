// Manual scaling probe for #115; deliberately outside bun test/CI.
// From the repository root: nix develop -c bun packages/cli/bench/indexed-threads.ts
// Copy this same script into an origin/dev scratch checkout for the baseline.
// Read probes exclude seeding/startup/warm-up. Cold-store opens and logical
// database bytes are measured separately below. No timing assertions.
import { Database } from "bun:sqlite";
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

function logicalBytes(db: Database): number {
  const pageSize = db.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
  const pageCount = db.query<{ page_count: number }, []>("PRAGMA page_count").get()!.page_count;
  return pageSize * pageCount;
}

function coldStoreProbe(root: string, eventCount: number): void {
  const filename = join(root, `cold-${eventCount}.sqlite`);
  const legacy = new Database(filename, { create: true });
  let beforeBytes: number;
  try {
    // origin/dev's schema, canonical log rows, no routing indexes. The first
    // open measures migration; subsequent fresh instances verify current rows.
    legacy.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE events (seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX events_ts ON events (ts);
      CREATE TABLE snapshots (revision TEXT PRIMARY KEY, source TEXT NOT NULL, bytes INTEGER NOT NULL, created_at TEXT NOT NULL);
    `);
    const insert = legacy.prepare("INSERT INTO events (seq, ts, payload) VALUES (?, ?, ?)");
    legacy.transaction(() => {
      for (const event of archive(eventCount).events) insert.run(event.seq, event.ts, JSON.stringify(event));
    })();
    beforeBytes = logicalBytes(legacy);
  } finally {
    legacy.close();
  }
  const opens: number[] = [];
  for (let i = 0; i < 4; i++) {
    const start = performance.now();
    const store = SqliteThreadStore.open({ filename });
    opens.push(performance.now() - start);
    store.close();
  }
  const measured = new Database(filename);
  try {
    report(`cold-store ${eventCount}: migration ${opens[0]!.toFixed(1)} ms; reopens ${opens.slice(1).map((value) => value.toFixed(1)).join(" / ")} ms; logical bytes ${beforeBytes} -> ${logicalBytes(measured)}`);
  } finally {
    measured.close();
  }
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
  // Fresh store instances; OS filesystem caches are warm. Logical size is
  // page_count * page_size, including pages currently residing in WAL.
  for (const eventCount of [5000, 50000]) coldStoreProbe(root, eventCount);
} finally {
  rmSync(root, { recursive: true, force: true });
}
