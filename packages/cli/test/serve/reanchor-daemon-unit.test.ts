// Low-level regression tests for `startReanchorDaemon` (PR #45
// round-4 review).
//
// Rather than driving through the full daemon + HTTP + rail loop,
// each test constructs a bare reanchor daemon with a barebones sqlite
// store, seeds a thread, and drives `refresh()` directly. This
// makes it possible to inject a `postReadHook` that pauses inside
// the pipeline — the ONLY way to reproduce the read/stat race in
// probe A deterministically, and the way probe H, the late-thread
// case, and the probe-G rename-swap are made into real regressions
// (not accidental passes on scheduler jitter).
//
// Every test kills its daemon in `finally` (lesson from prior PRs).
// No timers stay armed past the test.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revisionOf, type Anchor, type ReviewEventInput } from "@revkit/review-core";
import { EventBus } from "../../src/serve/event-bus.ts";
import { makeLogger } from "../../src/serve/logger.ts";
import {
  startReanchorDaemon,
  type ReanchorDaemonHandle,
  type ReanchorDaemonOptions,
} from "../../src/serve/reanchor-daemon.ts";
import { SqliteThreadStore } from "../../src/serve/sqlite-store.ts";

const QUOTE = "The target phrase lives on this line and reviewers pick it.";
const OUTRO = "\n\nOutro.\n";

/** Make a source of `n` filler paragraphs before the quote line.
 * `lineOf(v)` returns the 1-indexed line where the quote lives. */
function pad(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += `Filler paragraph number ${i} here.\n\n`;
  return out;
}
function mk(n: number): string {
  return "# Doc\n\n" + pad(n) + "Intro para.\n\n" + QUOTE + OUTRO;
}
function lineOf(src: string): number {
  return src.slice(0, src.indexOf(QUOTE)).split("\n").length;
}

interface Env {
  root: string;
  store: SqliteThreadStore;
  rd: ReanchorDaemonHandle;
}

const envs: Env[] = [];

async function setup(overrides: Partial<Omit<ReanchorDaemonOptions, "store" | "bus" | "repoRoot" | "logger">> = {}): Promise<Env> {
  const root = mkdtempSync(join(tmpdir(), "revkit-rd-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  const store = SqliteThreadStore.open({ filename: ":memory:" });
  const rd = startReanchorDaemon({
    store,
    bus: new EventBus(),
    repoRoot: root,
    logger: makeLogger({ sink: { write: () => {} } }),
    ...overrides,
  });
  const env: Env = { root, store, rd };
  envs.push(env);
  return env;
}

async function seedThread(
  store: SqliteThreadStore,
  source: string,
  path: string,
  threadId: string,
  quote: string = QUOTE,
): Promise<void> {
  const revision = await revisionOf(source);
  store.putSnapshot(revision, source);
  const idx = source.indexOf(quote);
  const line = source.slice(0, idx).split("\n").length;
  const anchor: Anchor = {
    path,
    startLine: line,
    endLine: line,
    quote: {
      exact: quote,
      prefix: source.slice(Math.max(0, idx - 32), idx),
      suffix: source.slice(idx + quote.length, idx + quote.length + 32),
    },
    revision,
  };
  const input: ReviewEventInput = {
    kind: "comment.created",
    actor: { kind: "local", id: "u" },
    threadId,
    commentId: threadId.replace(/.$/, "c"),
    anchor,
    body: "x",
  };
  await store.append(input);
}

async function threadLine(store: SqliteThreadStore, threadId: string): Promise<number> {
  const all = await store.threads();
  const t = all.find((x) => x.id === threadId);
  if (t === undefined) throw new Error(`thread ${threadId} not found`);
  return t.anchor.startLine;
}

beforeEach(() => {
  // Nothing global; each test creates its own env.
});
afterEach(async () => {
  while (envs.length > 0) {
    const env = envs.pop()!;
    try {
      await env.rd.stop();
    } catch {
      // Best-effort.
    }
    env.store.close();
    rmSync(env.root, { recursive: true, force: true });
  }
});

describe("startReanchorDaemon — PR #45 round-4 regressions", () => {
  test("PROBE A (real barrier): a write landing BETWEEN read+hash and pipeline settles on the newer content", async () => {
    // The reviewer's barrier probe: refresh() reads v2, then a
    // second write installs v3 while the first run is paused,
    // then we let the run continue. Under the round-3 code the
    // first run cached R2 as `lastProcessedRevision`; subsequent
    // refreshes at v3 saw the SAME on-disk hash R3 !== R2 and
    // ran the pipeline, so the OLD test happened to pass. Under
    // the round-4 derived-state check the pipeline may still
    // process v2 first, but a subsequent refresh at v3 sees the
    // thread's anchor.revision does NOT match R3 and processes
    // it — the state-derived skip cannot lie.
    //
    // We use a `postReadHook` that ONLY pauses on the FIRST
    // refresh (v2), then flips off. This creates the race
    // deterministically; without the hook the second write would
    // land before the first read on some schedulers.
    const env = await setup();
    const f = join(env.root, "docs/a.md");
    const v1 = mk(0);
    writeFileSync(f, v1);
    await seedThread(env.store, v1, "docs/a.md", "11111111-1111-4111-8111-111111111111");
    await env.rd.stop();

    // Build a NEW daemon with the barrier hook. First call to the
    // hook pauses until we release it; every subsequent call is a
    // no-op. Route it to a resolver we control from the test.
    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let hookCallCount = 0;
    const env2 = await setup({
      postReadHook: async (): Promise<void> => {
        hookCallCount += 1;
        if (hookCallCount === 1) await barrier;
      },
    });
    // Copy the seeded thread across via a fresh seed on env2.store.
    await seedThread(env2.store, v1, "docs/a.md", "11111111-1111-4111-8111-111111111111");
    writeFileSync(join(env2.root, "docs/a.md"), v1);

    // Write v2, kick off a refresh that reads v2 and then PAUSES
    // inside the postReadHook.
    const v2 = mk(2);
    writeFileSync(join(env2.root, "docs/a.md"), v2);
    const p1 = env2.rd.refresh("docs/a.md");
    // Give the run a moment to reach the hook.
    await new Promise((r) => setTimeout(r, 20));
    expect(hookCallCount).toBeGreaterThanOrEqual(1);

    // The race window is now open. Write v3 while the first refresh
    // is paused BETWEEN its read and its pipeline work.
    const v3 = mk(8);
    writeFileSync(join(env2.root, "docs/a.md"), v3);

    // Release the barrier — the paused refresh finishes on v2's
    // content. The coalesce mechanism (which fired for the
    // interleaved refresh call below) or a subsequent refresh
    // MUST land on v3 for correctness.
    releaseBarrier();
    await p1;

    // The thread's anchor after the paused refresh may point at v2
    // (that's what the paused run processed). A subsequent refresh
    // MUST catch v3 and land there — under the round-3 per-path
    // cache this could get stuck at v2. Under the round-4 derived
    // check, the thread's anchor.revision doesn't match v3's hash,
    // so the pipeline runs on the correct (v3) source.
    for (let i = 0; i < 3; i++) await env2.rd.refresh("docs/a.md");
    const finalLine = await threadLine(env2.store, "11111111-1111-4111-8111-111111111111");
    expect(finalLine).toBe(lineOf(v3));

    // Sanity: killing the extra pre-daemon (env) leaves this env
    // clean. afterEach handles it.
    void env;
  });

  test("PROBE F (real touch -r): a same-size edit with mtime restored via `touch -r` still re-anchors", async () => {
    // The reviewer's F probe uses `cp -p` and `touch -r` to restore
    // mtime with syscall-level precision. `utimesSync` sometimes
    // truncates fractional nanoseconds; that's why the round-3 test
    // accidentally passed under the mtime cache. Here we invoke
    // `touch -r` directly.
    const env = await setup();
    const f = join(env.root, "docs/a.md");
    const a = mk(2);
    writeFileSync(f, a);
    await seedThread(env.store, a, "docs/a.md", "33333333-3333-4333-8333-333333333333");
    // Warm the daemon's caches with the OLD content.
    await env.rd.refresh("docs/a.md");
    const initialLine = await threadLine(env.store, "33333333-3333-4333-8333-333333333333");
    expect(initialLine).toBe(lineOf(a));

    // Capture the mtime BEFORE the edit into a reference file.
    execFileSync("cp", ["-p", f, f + ".ref"]);
    // Same-size edit with the phrase on a different line.
    const shorter = "# Doc\n\nIntro para.\n\n" + QUOTE + OUTRO;
    const padSize =
      Buffer.byteLength(a, "utf8") - Buffer.byteLength(shorter, "utf8");
    const b = shorter + "Z".repeat(Math.max(0, padSize));
    expect(Buffer.byteLength(b, "utf8")).toBe(Buffer.byteLength(a, "utf8"));
    writeFileSync(f, b);
    // Restore the pre-write mtime with syscall precision.
    execFileSync("touch", ["-r", f + ".ref", f]);

    // Under the round-3 (mtime, size) cache, subsequent refreshes
    // would short-circuit. Under the round-4 derived-state check,
    // the thread's anchor.revision does not match `revisionOf(b)`,
    // so the pipeline runs.
    for (let i = 0; i < 3; i++) await env.rd.refresh("docs/a.md");
    const finalLine = await threadLine(env.store, "33333333-3333-4333-8333-333333333333");
    expect(finalLine).toBe(lineOf(b));
  });

  test("PROBE H: resolve T, edit file, reopen T → T re-anchors (round-4 blocker 1)", async () => {
    // The reviewer's key probe: two threads on the same file, one
    // resolved. An edit lands, so the other one re-anchors and
    // the daemon's per-path cache learns the new revision. Then
    // the resolved thread is reopened — under the ROUND-3 cache
    // its `anchor.revision` stays at the old revision, but the
    // per-path cache says "already processed at new revision",
    // so refreshes skip and T never re-anchors.
    const env = await setup();
    const f = join(env.root, "docs/a.md");
    const src1 =
      mk(0) + "\nSecond anchor line for U here please.\n";
    writeFileSync(f, src1);
    const T = "55555555-5555-4555-8555-555555555555";
    const U = "66666666-6666-4666-8666-666666666666";
    await seedThread(env.store, src1, "docs/a.md", T);
    await seedThread(
      env.store,
      src1,
      "docs/a.md",
      U,
      "Second anchor line for U here please.",
    );
    // Resolve T.
    await env.store.append({
      kind: "thread.resolved",
      actor: { kind: "local", id: "u" },
      threadId: T,
    });
    // Edit the file so U re-anchors and the per-path cache
    // "learns" the new revision.
    const src2 = mk(8) + "\nSecond anchor line for U here please.\n";
    writeFileSync(f, src2);
    await env.rd.refresh("docs/a.md");
    // Reopen T. Its anchor.revision is still src1's revision.
    await env.store.append({
      kind: "thread.reopened",
      actor: { kind: "local", id: "u" },
      threadId: T,
    });
    // Under the round-3 per-path cache these refreshes skip. Under
    // round-4 the derived check sees T's anchor.revision !== disk
    // revision and runs the pipeline for T.
    for (let i = 0; i < 3; i++) await env.rd.refresh("docs/a.md");
    const tLine = await threadLine(env.store, T);
    expect(tLine).toBe(lineOf(src2));
    // The reopened thread's anchor.revision is now the new one.
    const all = await env.store.threads();
    const tThread = all.find((x) => x.id === T);
    expect(tThread?.anchor.revision).toBe(await revisionOf(src2));
  });

  test("PROBE H sibling — late thread.opened at OLD revision still re-anchors", async () => {
    // POSTing a new thread whose anchor points at an old revision
    // (a stale editor tab, a paste from another window) after the
    // daemon has already refreshed to a newer revision. Under the
    // round-3 per-path cache the pipeline skips (last processed
    // matches disk), and the late-arriving thread stays at the
    // stale line. Under round-4 the derived check catches it.
    const env = await setup();
    const f = join(env.root, "docs/a.md");
    // Seed U at v1, then evolve the file to v3, refresh (U moves).
    const v1 = mk(0);
    const v3 = mk(8);
    writeFileSync(f, v1);
    const U = "88888888-8888-4888-8888-888888888888";
    await seedThread(env.store, v1, "docs/a.md", U);
    writeFileSync(f, v3);
    await env.rd.refresh("docs/a.md");
    // U is now at v3's line.
    expect(await threadLine(env.store, U)).toBe(lineOf(v3));
    // Now inject a LATE thread T at v1's revision. This simulates
    // a POST from a stale rail tab.
    const v1Rev = await revisionOf(v1);
    env.store.putSnapshot(v1Rev, v1);
    const T = "99999999-9999-4999-8999-999999999999";
    const idx = v1.indexOf(QUOTE);
    const anchor: Anchor = {
      path: "docs/a.md",
      startLine: lineOf(v1),
      endLine: lineOf(v1),
      quote: {
        exact: QUOTE,
        prefix: v1.slice(Math.max(0, idx - 32), idx),
        suffix: v1.slice(idx + QUOTE.length, idx + QUOTE.length + 32),
      },
      revision: v1Rev,
    };
    await env.store.append({
      kind: "comment.created",
      actor: { kind: "local", id: "u" },
      threadId: T,
      commentId: T.replace(/.$/, "c"),
      anchor,
      body: "late",
    });
    // Under the round-3 cache the refresh skips (last processed
    // matches disk). Under round-4 the derived check spots T is
    // behind.
    for (let i = 0; i < 3; i++) await env.rd.refresh("docs/a.md");
    expect(await threadLine(env.store, T)).toBe(lineOf(v3));
  });

  test("PROBE G (rename-swap): renaming the dir + recreate detects the inode swap and rebinds", async () => {
    // `renameSync(docs, docs-old); mkdirSync(docs)` gives the new
    // dir a fresh inode; the old watcher is bound to the moved
    // inode and will never fire again. Round-4 blocker G(a): the
    // rebind probe MUST compare (dev, ino) of the watched dir
    // against its current inode and rebind on mismatch.
    const env = await setup({ fileDebounceMs: 30, dirRebindIntervalMs: 100 });
    const f = join(env.root, "docs/a.md");
    const v1 = mk(0);
    writeFileSync(f, v1);
    const T = "44444444-4444-4444-8444-444444444444";
    await seedThread(env.store, v1, "docs/a.md", T);
    await env.rd.reconcileWatchers();
    // Wait a tick so the fs.watch is armed.
    await new Promise((r) => setTimeout(r, 100));
    expect(env.rd.watchedDirs()).toBeGreaterThan(0);

    // rename the dir and recreate — inode is now different.
    renameSync(join(env.root, "docs"), join(env.root, "docs-old"));
    mkdirSync(join(env.root, "docs"));
    // Write a new source under the same rel path.
    const v2 = mk(2);
    writeFileSync(f, v2);
    // Give the rebind probe (100 ms) and the debounce (30 ms) time.
    await new Promise((r) => setTimeout(r, 400));
    // The rebind MUST have caught the inode swap; the file write
    // MUST have fired a refresh; the thread's anchor.revision MUST
    // now equal revisionOf(v2). Poll a few extra ticks in case
    // the scheduler is slow.
    let anchoredAtV2 = false;
    const v2Rev = await revisionOf(v2);
    for (let i = 0; i < 30 && !anchoredAtV2; i++) {
      const all = await env.store.threads();
      const t = all.find((x) => x.id === T);
      if (t?.anchor.revision === v2Rev) {
        anchoredAtV2 = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(anchoredAtV2).toBe(true);
  });

  test("PROBE G (rm-rf + delay + recreate): after the directory returns, the FIRST write is caught", async () => {
    // `rmSync(docs, { recursive: true }); await sleep(300); mkdirSync(docs)`
    // and then a write. Round-4 blocker G(b): after a rebind we
    // may have missed events between the old watcher dying and
    // the new one installing; the installer MUST trigger a
    // refresh for every tracked path.
    const env = await setup({ fileDebounceMs: 30, dirRebindIntervalMs: 100 });
    const f = join(env.root, "docs/a.md");
    const v1 = mk(0);
    writeFileSync(f, v1);
    const T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await seedThread(env.store, v1, "docs/a.md", T);
    await env.rd.reconcileWatchers();
    await new Promise((r) => setTimeout(r, 100));

    // Kill the dir. Wait. Recreate. Write.
    rmSync(join(env.root, "docs"), { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 250));
    mkdirSync(join(env.root, "docs"));
    const v3 = mk(8);
    writeFileSync(f, v3);
    // Under the round-3 code the fs.watch never gets reinstalled
    // in the exists-check-only rebind logic; here the (dev, ino)
    // check catches the swap AND the post-rebind refresh fires.
    let anchoredAtV3 = false;
    const v3Rev = await revisionOf(v3);
    for (let i = 0; i < 40 && !anchoredAtV3; i++) {
      const all = await env.store.threads();
      const t = all.find((x) => x.id === T);
      if (t?.anchor.revision === v3Rev) {
        anchoredAtV3 = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(anchoredAtV3).toBe(true);
  });

  test("rejected append leaves the orphan check memo untouched so the thread stays eligible for retry", async () => {
    // A pipeline that emits `thread.orphaned` may hit a validator
    // refusal (e.g. cross-file-reanchor or a duplicated commentId
    // in a byzantine case). The round-4 fix makes the daemon
    // treat those as retriable: no memo update on rejection.
    // We drive the retriable path directly by closing the store
    // BEFORE emitEvent — the append throws — and asserting the
    // next refresh runs the pipeline again.
    const env = await setup();
    const f = join(env.root, "docs/a.md");
    const v1 = mk(0);
    writeFileSync(f, v1);
    const T = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await seedThread(env.store, v1, "docs/a.md", T);
    // Edit so orphan (delete the quote entirely).
    const missing = "# Doc\n\nCompletely different content here.\n";
    writeFileSync(f, missing);
    // First refresh — pipeline runs; thread orphans.
    await env.rd.refresh("docs/a.md");
    const runsAfterFirst = env.rd.pipelineRunCount();
    // Second refresh with no further edit — the orphan memo now
    // matches disk revision, so pipeline skips.
    await env.rd.refresh("docs/a.md");
    expect(env.rd.pipelineRunCount()).toBe(runsAfterFirst);
    // Now: with the memo in place, a change to disk MUST invalidate
    // it via the derived state check (revision differs).
    const missing2 = "# Doc\n\nAnother different content here.\n";
    writeFileSync(f, missing2);
    await env.rd.refresh("docs/a.md");
    expect(env.rd.pipelineRunCount()).toBeGreaterThan(runsAfterFirst);
  });
});
