// Issue #67: a rail mount must not pay a full `refreshAll()` sweep
// for a read that cannot observe an anchor.
//
// The bug, as measured (see the PR body): `GET /api/threads` without
// a `path` filter fired `refreshAll()` — one `doRefresh` per threaded
// path, each doing its own `store.threads({ path })`, which is
// `since(0)` + a full reduce PER PATH. At 40 threaded paths that read
// measured 9–26 ms server-side against 1 ms for the path-scoped read
// the rail actually renders from, and a mount ran TWO full sweeps
// (the unscoped read plus the `/events` prime), 81 file reads for a
// page the reviewer sees in 1 ms.
//
// Two changes, two tests each:
//
//   1. `GET /api/threads?fields=id` projects the response to ids and
//      GATES the lazy trigger — an ids-only body carries no anchor, so
//      there is nothing to re-anchor *for*. Test 1 is the regression:
//      zero file reads on an unchanged store.
//   2. `refreshAll` hands each `doRefresh` the per-path thread list it
//      already read, instead of re-querying it per path. Test 2 pins
//      that ONE log read happens per sweep, at any path count.
//
// And the guarantee itself, which must survive both:
//
//   3. an UNPROJECTED unscoped read still re-anchors every threaded
//      path (test 3), and still returns a RE-ANCHORED thread after a
//      real source edit (test 4) — the point of ADR-0006's lazy
//      trigger.
//   4. the `/events` prime still sweeps (test 5) — the server-side
//      trigger the issue's correction comment names. It is the one
//      that catches a file edited while the daemon was down, so it is
//      NOT gated by the projection, only made cheap by change 2.
//   5. `fields` is validated, so a typo cannot silently buy back the
//      full sweep (test 6).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";
import { EventBus } from "../../src/serve/event-bus.ts";
import { makeLogger } from "../../src/serve/logger.ts";
import { SqliteThreadStore } from "../../src/serve/sqlite-store.ts";
import { startReanchorDaemon, type ReanchorDaemonHandle } from "../../src/serve/reanchor-daemon.ts";
import {
  isLineAnchor,
  revisionOf,
  type Anchor,
  type ReviewEventInput,
  type Thread,
} from "@revkit/review-core";

const PATHS = 40;

/** A source with enough context on either side of the anchored line
 *  that the re-anchor pipeline has real prefix/suffix to work with. */
function sourceFor(i: number): string {
  return (
    `# Doc ${i}\n\n` +
    `Intro paragraph for doc ${i}, unchanged.\n\n` +
    `The target phrase for ${i} lives here and reviewers pick it.\n\n` +
    `Third paragraph for ${i}.\n\n` +
    `Fourth paragraph for ${i}.\n`
  );
}

/** Same document with two filler paragraphs inserted at the top, so
 *  the anchored line MOVES when the file is edited — an anchor that
 *  has to move is a visible proof the pipeline ran. */
function editedSourceFor(i: number): string {
  return (
    `# Doc ${i}\n\n` +
    `Inserted filler paragraph.\n\n` +
    `Second inserted filler paragraph.\n\n` +
    `Intro paragraph for doc ${i}, unchanged.\n\n` +
    `The target phrase for ${i} lives here and reviewers pick it.\n\n` +
    `Third paragraph for ${i}.\n\n` +
    `Fourth paragraph for ${i}.\n`
  );
}

const QUOTE_PREFIX = "The target phrase for ";

interface Ctx {
  daemon: DaemonHandle;
  root: string;
  cookie: string;
}

const booted: Array<{ daemon?: DaemonHandle; root?: string; store?: SqliteThreadStore; rd?: ReanchorDaemonHandle }> = [];

async function boot(paths: number): Promise<Ctx> {
  const root = mkdtempSync(join(tmpdir(), "revkit-b67-"));
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "index.html"), "<h1>x</h1>");
  mkdirSync(join(root, "docs"), { recursive: true });
  for (let i = 0; i < paths; i += 1) writeFileSync(join(root, `docs/f${i}.md`), sourceFor(i));
  const daemon = await startDaemon({
    dir: join(root, "dist"),
    repoRoot: root,
    port: 0,
    sqlitePath: ":memory:",
    version: "0.0.0-test",
    localUserId: "local-test",
    installSignalHandlers: false,
    enableBackgroundBuild: false,
    logSink: { write: () => {} },
    // Long debounces: these tests drive the LAZY trigger deliberately,
    // so a watcher firing on its own would blur what is being counted.
    // The only edits are synchronous and the reads follow immediately.
    reanchor: { fileDebounceMs: 60_000, buildDebounceMs: 60_000 },
  });
  const entry: { daemon?: DaemonHandle; root?: string } = { daemon, root };
  booted.push(entry);
  // Launch flow — the session cookie the API accepts.
  const launch = await fetch(daemon.launchUrl, { redirect: "manual" });
  const raw = launch.headers.get("set-cookie") ?? "";
  const semi = raw.indexOf(";");
  return { daemon, root, cookie: raw.slice(0, semi === -1 ? undefined : semi).trim() };
}

async function api(ctx: Ctx, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cookie", ctx.cookie);
  headers.set("host", `127.0.0.1:${ctx.daemon.port}`);
  headers.set("origin", ctx.daemon.url);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return fetch(ctx.daemon.url + path, { ...init, headers });
}

interface WireThread {
  readonly id: string;
  readonly status: string;
  readonly anchor: unknown;
}

/** Seed one thread per path through the public API, so the events, the
 *  snapshots and the anchor revisions are exactly what production
 *  writes (the daemon overrides the client revision with the server's
 *  own hash of the source). */
async function seed(ctx: Ctx, paths: number): Promise<void> {
  for (let i = 0; i < paths; i += 1) {
    const source = sourceFor(i);
    const lines = source.split("\n");
    const quote = lines[4]!;
    const anchor: Anchor = {
      path: `docs/f${i}.md`,
      startLine: 5,
      endLine: 5,
      quote: { exact: quote, prefix: lines[3]!, suffix: lines[5]! },
      // Overridden server-side; the schema demands a well-formed one.
      revision: "0".repeat(64),
    };
    const res = await api(ctx, "/api/threads", {
      method: "POST",
      body: JSON.stringify({ threadId: `thread-${i}`, commentId: `comment-${i}`, anchor, body: `Comment ${i}.` }),
    });
    expect(res.status).toBe(201);
  }
}

function reads(ctx: Ctx): number {
  return ctx.daemon.reanchorDiagnostics.fileReadCount();
}

function pipelines(ctx: Ctx): number {
  return ctx.daemon.reanchorDiagnostics.pipelineRunCount();
}

/** Read one thread out of the store, failing the test if it is gone. */
async function threadOf(store: SqliteThreadStore, id: string): Promise<Thread> {
  const all = await store.threads();
  const found = all.find((t) => t.id === id);
  if (found === undefined) throw new Error(`thread ${id} not found`);
  return found;
}

/** The line a thread's line anchor currently points at. Fails the test
 *  if the anchor is not a line anchor — a sweep that orphaned the
 *  thread would otherwise satisfy a `status` assertion and hide it. */
function lineStartOf(thread: Thread): number {
  if (!isLineAnchor(thread.anchor)) throw new Error(`expected a line anchor, got ${JSON.stringify(thread.anchor)}`);
  return thread.anchor.startLine;
}

afterEach(async () => {
  while (booted.length > 0) {
    const entry = booted.pop()!;
    if (entry.rd !== undefined) await entry.rd.stop();
    if (entry.store !== undefined) entry.store.close();
    if (entry.daemon !== undefined) await entry.daemon.stop();
    if (entry.root !== undefined) rmSync(entry.root, { recursive: true, force: true });
  }
});

describe("issue #67 — the unscoped read", () => {
  test("1. REGRESSION: `fields=id` re-anchors nothing (old code: one read per threaded path)", async () => {
    const ctx = await boot(PATHS);
    await seed(ctx, PATHS);
    // Warm the baseline: seeding installs watchers and the first POST
    // may leave a run in flight. The debounce is 60 s, so a settle
    // window is only about not racing a POST's own bookkeeping.
    await Bun.sleep(250);
    const readsBefore = reads(ctx);
    const pipelinesBefore = pipelines(ctx);

    const res = await api(ctx, "/api/threads?fields=id&status=open,resolved,orphaned");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { threads: ReadonlyArray<{ id: string }>; head: number };
    expect(body.threads).toHaveLength(PATHS);
    // Every id is present — the projection is a projection, not a
    // narrower filter.
    expect(body.threads.map((t) => t.id).sort()).toEqual(
      Array.from({ length: PATHS }, (_, i) => `thread-${i}`).sort(),
    );

    // THE REGRESSION ASSERTION. On origin/dev this read called
    // `refreshAll()`, which read every one of the 40 sources.
    expect(reads(ctx) - readsBefore).toBe(0);
    // No `pipelineRunCount` assertion here, and the reason is worth
    // recording: on an UNCHANGED store the state-derived skip returns
    // before the pipeline counter is ever touched, so "0 pipeline runs"
    // is what a read that DID sweep also reports (measured on
    // origin/dev: an unscoped GET on an unchanged 5-path store, 5 file
    // reads and 0 pipeline runs). It would pass on the old code and
    // prove nothing. Test 4 is where the pipeline counter is
    // load-bearing, because there a file really did change.
    expect(pipelines(ctx)).toBe(pipelinesBefore);
  });

  test("2. REGRESSION: a sweep reads the log ONCE, whatever the path count", async () => {
    // The per-path `store.threads({ path })` this replaces was
    // `since(0)` + a full reduce PER PATH, so a sweep cost O(P x
    // events). Counting the queries pins the multiplier away.
    for (const paths of [1, 8, PATHS]) {
      const root = mkdtempSync(join(tmpdir(), "revkit-b67q-"));
      mkdirSync(join(root, "docs"), { recursive: true });
      const store = SqliteThreadStore.open({ filename: ":memory:" });
      for (let i = 0; i < paths; i += 1) {
        const source = sourceFor(i);
        writeFileSync(join(root, `docs/f${i}.md`), source);
        const anchor: Anchor = {
          path: `docs/f${i}.md`,
          startLine: 5,
          endLine: 5,
          quote: { exact: source.split("\n")[4]!, prefix: source.split("\n")[3]!, suffix: source.split("\n")[5]! },
          revision: await revisionOf(source),
        };
        store.putSnapshot(anchor.revision, source);
        const input: ReviewEventInput = {
          kind: "comment.created",
          actor: { kind: "local", id: "u" },
          threadId: `t-${i}`,
          commentId: `c-${i}`,
          anchor,
          body: "x",
        };
        await store.append(input);
      }
      let threadsQueries = 0;
      // Every other member is re-bound to the TARGET: a proxy receiver
      // loses the store's private-field brand, so `head()` reached
      // through the proxy throws `Cannot access invalid private field`.
      const counting = new Proxy(store, {
        get(target, prop): unknown {
          if (prop === "threads") {
            return async (filter?: { path?: string }): Promise<unknown> => {
              threadsQueries += 1;
              return target.threads(filter);
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const rd = startReanchorDaemon({
        store: counting as unknown as SqliteThreadStore,
        bus: new EventBus(),
        repoRoot: root,
        logger: makeLogger({ sink: { write: () => {} } }),
        fileDebounceMs: 60_000,
        buildDebounceMs: 60_000,
      });
      booted.push({ rd, store, root });
      // `startReanchorDaemon` fires a startup `reconcileWatchers()`
      // (also a `store.threads()`) without awaiting it. Let that land
      // before counting, or the startup read is counted as the sweep's.
      await Bun.sleep(50);
      threadsQueries = 0;

      await rd.refreshAll();

      // ONE query: the sweep's own unfiltered read, which it also
      // groups by path. Old code: 1 + P.
      expect(threadsQueries).toBe(1);
      // The sweep still visited every path — this is a cost fix, not a
      // scope fix.
      expect(rd.fileReadCount()).toBe(paths);
    }
  });

  test("3. an UNPROJECTED unscoped read still re-anchors every threaded path", async () => {
    const ctx = await boot(PATHS);
    await seed(ctx, PATHS);
    await Bun.sleep(250);
    const readsBefore = reads(ctx);

    const res = await api(ctx, "/api/threads?status=open,orphaned,resolved");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { threads: WireThread[] };
    expect(body.threads).toHaveLength(PATHS);

    // ADR-0006's lazy trigger is intact: a read that can return an
    // anchor re-anchors every threaded path before serving.
    expect(reads(ctx) - readsBefore).toBe(PATHS);
  });

  test("4. CORRECTNESS: after a real source edit, the unscoped read returns a RE-ANCHORED thread", async () => {
    const ctx = await boot(4);
    await seed(ctx, 4);
    // An edit BEFORE any read has refreshed this path, so the ONLY
    // thing that can bring the anchors up to date is the read's own
    // trigger.
    const pipelinesBefore = pipelines(ctx);
    const edited = editedSourceFor(2);
    writeFileSync(join(ctx.root, "docs/f2.md"), edited);

    const res = await api(ctx, "/api/threads?path=docs%2Ff2.md&status=open,orphaned,resolved");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { threads: WireThread[] };
    expect(body.threads).toHaveLength(1);
    const thread = body.threads[0]!;
    expect(thread.status).toBe("open");
    const anchor = thread.anchor as Anchor;
    expect(isLineAnchor(thread.anchor as never)).toBe(true);
    // The seeded anchor was line 5; the edit inserts two filler
    // paragraphs above the quote, so a re-anchored thread reports 9. A
    // reader that got the OLD anchor back would see the thread two lines
    // above where its quote now lives.
    expect(anchor.startLine).toBe(9);
    expect(anchor.startLine).not.toBe(5);
    expect(edited.split("\n")[anchor.startLine - 1]).toContain(QUOTE_PREFIX + "2");
    // The anchor the reader receives is the ONE the pipeline wrote, not
    // the seed's: the revision moved with the source.
    expect(anchor.revision).toBe(await revisionOf(edited));
    // And the pipeline really ran — the counter test 1 cannot use,
    // because here the source DID change, so the state-derived skip
    // cannot fire.
    expect(pipelines(ctx)).toBeGreaterThan(pipelinesBefore);
  });

  test("5. the /events prime still sweeps — it is what catches a daemon-down edit", async () => {
    const ctx = await boot(PATHS);
    await seed(ctx, PATHS);
    await Bun.sleep(250);
    // Edited while nothing was watching: the only remaining trigger is
    // the SSE prime.
    for (let i = 0; i < PATHS; i += 1) writeFileSync(join(ctx.root, `docs/f${i}.md`), editedSourceFor(i));
    const readsBefore = reads(ctx);

    const controller = new AbortController();
    const res = await fetch(`${ctx.daemon.url}/events?since=0`, {
      headers: { cookie: ctx.cookie, host: `127.0.0.1:${ctx.daemon.port}`, origin: ctx.daemon.url },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const seen: string[] = [];
    let buf = "";
    // Read until the re-anchor events the prime produced have landed.
    for (let i = 0; i < 200 && !seen.includes("thread.reanchored"); i += 1) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf("\n\n");
      while (idx !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          seen.push((JSON.parse(line.slice(5).trim()) as { kind: string }).kind);
        }
        idx = buf.indexOf("\n\n");
      }
    }
    controller.abort();

    // The prime swept every threaded path...
    expect(reads(ctx) - readsBefore).toBe(PATHS);
    // ...and the re-anchors it performed are on the wire.
    expect(seen).toContain("thread.reanchored");
  });

  test("7. B2 REGRESSION: a thread that becomes TRACKED mid-sweep is still re-anchored by that sweep", async () => {
    // `refreshAll` reads the log ONCE and groups it by path, so a sweep
    // tracks the threads that existed at its own read. If a write lands
    // while the sweep is running, a thread can BECOME tracked — and
    // nothing else covers the reopen: `POST /api/threads/:id/reopen`
    // fires no refresh. Before the grouping, each `doRefresh` asked the
    // store at its own time and saw the write; with a bucket frozen at
    // sweep start it would not.
    //
    // The seam is `postReadHook`, which runs after the file is read +
    // hashed and before anything consults the thread set. Holding EVERY
    // path in that barrier guarantees, on any implementation, that the
    // reopen lands after each path's read and before each path's
    // decision — so a per-path query MUST see it and a frozen bucket
    // must not.
    const root = mkdtempSync(join(tmpdir(), "revkit-b67reopen-"));
    mkdirSync(join(root, "docs"), { recursive: true });
    const store = SqliteThreadStore.open({ filename: ":memory:" });
    const paths = ["docs/f0.md", "docs/f1.md"];
    for (let i = 0; i < paths.length; i += 1) writeFileSync(join(root, paths[i]!), sourceFor(i));
    const seedLocal = async (path: string, threadId: string, index: number): Promise<void> => {
      const source = sourceFor(index);
      const anchor: Anchor = {
        path,
        startLine: 5,
        endLine: 5,
        quote: { exact: source.split("\n")[4]!, prefix: source.split("\n")[3]!, suffix: source.split("\n")[5]! },
        revision: await revisionOf(source),
      };
      store.putSnapshot(anchor.revision, source);
      await store.append({
        kind: "comment.created",
        actor: { kind: "local", id: "u" },
        threadId,
        commentId: `${threadId}-c`,
        anchor,
        body: "x",
      });
    };
    await seedLocal(paths[0]!, "t-0", 0);
    await seedLocal(paths[1]!, "t-1", 1);
    // Resolve `t-1` so it is NOT tracked: a resolved thread is never
    // re-anchored, so the sweep's tracked set excludes it.
    await store.append({ kind: "thread.resolved", actor: { kind: "local", id: "u" }, threadId: "t-1" });
    expect((await threadOf(store, "t-1")).status).toBe("resolved");

    // Both files edited, so the quote moves from line 5 to line 9. A
    // re-anchor is the only thing that can move `t-1`'s anchor.
    for (let i = 0; i < paths.length; i += 1) writeFileSync(join(root, paths[i]!), editedSourceFor(i));

    let held = 0;
    let allHeld = (): void => {};
    const allPathsHeld = new Promise<void>((resolve) => {
      allHeld = resolve;
    });
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rd = startReanchorDaemon({
      store,
      bus: new EventBus(),
      repoRoot: root,
      logger: makeLogger({ sink: { write: () => {} } }),
      fileDebounceMs: 60_000,
      buildDebounceMs: 60_000,
      postReadHook: async () => {
        held += 1;
        if (held >= paths.length) allHeld();
        await gate;
      },
    });
    booted.push({ rd, store, root });
    // The startup `reconcileWatchers()` is fire-and-forget; let it land
    // so the barrier counts only the sweep's own reads.
    await Bun.sleep(50);

    const sweep = rd.refreshAll();
    await allPathsHeld;
    // The reopen lands while every path is held.
    await store.append({ kind: "thread.reopened", actor: { kind: "local", id: "u" }, threadId: "t-1" });
    release();
    await sweep;

    const reopened = await threadOf(store, "t-1");
    expect(reopened.status).toBe("open");
    // Line 9 is where the quote lives in `editedSourceFor`; line 5 is
    // where it was seeded. A sweep that skipped `t-1` leaves it at 5.
    expect(lineStartOf(reopened)).toBe(9);
  });

  test("8. an OVERLAPPING pair of sweeps does not fall back to the per-path query", async () => {
    // A rail mount overlaps two `refreshAll()`s: the `/events` prime
    // and the attach refetch's thread read. Each path then joins the
    // in-flight run and marks it dirty, so every path reruns after the
    // first run finishes.
    //
    // If that rerun dropped the sweep's bucket it would fall back to
    // `store.threads({ path })` for EVERY path — reintroducing exactly
    // the O(P x events) cost the grouping removes, as a cliff on the
    // mounts where the two sweeps happen to overlap. Measured at
    // P = 400 on the branch before the rerun carried the bucket: 13 ms
    // of fan-out on a clean sweep against 741 ms on an overlapping
    // one, on roughly 1 mount in 5.
    const paths = 8;
    const root = mkdtempSync(join(tmpdir(), "revkit-b67overlap-"));
    mkdirSync(join(root, "docs"), { recursive: true });
    const store = SqliteThreadStore.open({ filename: ":memory:" });
    for (let i = 0; i < paths; i += 1) {
      const source = sourceFor(i);
      writeFileSync(join(root, `docs/f${i}.md`), source);
      const anchor: Anchor = {
        path: `docs/f${i}.md`,
        startLine: 5,
        endLine: 5,
        quote: { exact: source.split("\n")[4]!, prefix: source.split("\n")[3]!, suffix: source.split("\n")[5]! },
        revision: await revisionOf(source),
      };
      store.putSnapshot(anchor.revision, source);
      await store.append({
        kind: "comment.created",
        actor: { kind: "local", id: "u" },
        threadId: `t-${i}`,
        commentId: `c-${i}`,
        anchor,
        body: "x",
      });
    }
    let threadsQueries = 0;
    const counting = new Proxy(store, {
      get(target, prop): unknown {
        if (prop === "threads") {
          return async (filter?: { path?: string }): Promise<unknown> => {
            threadsQueries += 1;
            return target.threads(filter);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let held = 0;
    let allHeld = (): void => {};
    const allPathsHeld = new Promise<void>((resolve) => {
      allHeld = resolve;
    });
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rd = startReanchorDaemon({
      store: counting as unknown as SqliteThreadStore,
      bus: new EventBus(),
      repoRoot: root,
      logger: makeLogger({ sink: { write: () => {} } }),
      fileDebounceMs: 60_000,
      buildDebounceMs: 60_000,
      postReadHook: async () => {
        held += 1;
        if (held >= paths) allHeld();
        await gate;
      },
    });
    booted.push({ rd, store, root });
    // The startup `reconcileWatchers()` is fire-and-forget and reads the
    // log once; let it land and count only the two sweeps below.
    await Bun.sleep(50);
    threadsQueries = 0;

    const first = rd.refreshAll();
    await allPathsHeld;
    // Every path of the first sweep is now held mid-run, so every path
    // of the second sweep takes the JOIN path and marks its run dirty.
    const second = rd.refreshAll();
    release();
    await Promise.all([first, second]);

    // ONE query per sweep — the sweep's own read. Not `2 + paths`, which
    // is what a rerun without a bucket costs.
    expect(threadsQueries).toBe(2);
    // And the coalescing itself is untouched: every path ran once for
    // the first sweep and once for the rerun, never more.
    expect(rd.fileReadCount()).toBe(2 * paths);
  });

  test("6. an unrecognised or REPEATED `fields` is a 400, not a silent read", async () => {
    const ctx = await boot(PATHS);
    await seed(ctx, PATHS);
    await Bun.sleep(250);
    for (const fields of ["ids", "anchor", "", "id,status"]) {
      const res = await api(ctx, `/api/threads?fields=${encodeURIComponent(fields)}`);
      expect(res.status).toBe(400);
    }
    // A REPEATED parameter is the hazard `searchParams.get` cannot see:
    // first-wins would answer ids-only and skip the trigger while
    // silently discarding the `fields=anchor` the caller also wrote.
    // Both orders must be refused.
    for (const query of [
      "/api/threads?fields=id&fields=anchor",
      "/api/threads?fields=anchor&fields=id",
      "/api/threads?fields=id&fields=id",
    ]) {
      const res = await api(ctx, query);
      expect(res.status).toBe(400);
    }
    // The refusals cost nothing either — a 400 is answered before the
    // trigger, so a caller that fat-fingers the parameter cannot also
    // buy a full sweep.
    const readsBefore = reads(ctx);
    await api(ctx, "/api/threads?fields=ids");
    await api(ctx, "/api/threads?fields=id&fields=anchor");
    expect(reads(ctx)).toBe(readsBefore);
  });
});
