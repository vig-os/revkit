// Issue #49 regressions.
//
// #49 nit 1: after a directory rebind the daemon called
// `installDirectoryPolling(dir, dw, { force: true })` and left that
// directory on 2 s `stat`-polling for the rest of its life, even when
// `fs.watch` could have been re-armed. The fix re-arms `fs.watch` once
// the directory has been OBSERVABLY stable, and keeps polling as the
// fallback whenever a watch cannot be established.
//
// #49 nit 2: the per-thread orphan-check memo kept a stale entry for a
// thread that had been re-anchored until the next `reconcileWatchers`.
// The fix prunes the entry on an explicit `thread.reanchored` for that
// thread — and only for that thread.
//
// The RUNTIME FACT this whole design rests on, and its true boundary.
//
// On `bun 1.3.13`, once `fs.watch(dir)` has been registered and `dir`'s
// inode is then replaced (rename-away or `rm -rf`), re-arming `fs.watch`
// on the SAME canonical path never signals again — five consecutive
// re-arms all received zero events.
//
// That is a BUN defect, NOT a kernel or inotify limit, and the
// difference is load-bearing for what the right remediation is. On one
// kernel (6.8.0-31-generic), one filesystem and one directory shape:
// raw `inotify_add_watch` via ctypes SIGNALS on re-arm (allocating a
// new wd), `node v24.21.0` `fs.watch` SIGNALS, `bun 1.3.13` is SILENT.
// So: report/track the Bun bug and cross-check under Node; do NOT add a
// native inotify binding, because inotify is not what is broken. The
// claim is version-specific to Bun 1.3.13.
//
// The `platform fact` describe block below is the probe that measures
// this at test time. It is the ONLY test here that fails when Bun
// changes behaviour, which is exactly its job: it is the signal to
// re-measure and relax `DirectoryWatcher.everWatched`, not evidence the
// daemon derives anything from. Linux-gated with a written reason,
// because the measurement is about Linux inotify semantics.
//
// `DIRECTORY-FORCE-POLL FACT` is a different kind of test: it pins the
// daemon's CONSEQUENT — a swap-damaged directory must not be reported as
// `watch` — and would keep passing on a Bun that recovers, because the
// `everWatched` gate is deliberately conservative.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revisionOf, isLineAnchor } from "@revkit/review-core";
import { EventBus } from "../../src/serve/event-bus.ts";
import { makeLogger } from "../../src/serve/logger.ts";
import {
  startReanchorDaemon,
  type ReanchorDaemonHandle,
  type ReanchorDaemonOptions,
} from "../../src/serve/reanchor-daemon.ts";
import { SqliteThreadStore } from "../../src/serve/sqlite-store.ts";
import type { Anchor, ReviewEventInput } from "@revkit/review-core";

const QUOTE = "The target phrase lives on this line and reviewers pick it.";
const OUTRO = "\n\nOutro.\n";

function pad(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += `Filler paragraph number ${i} here.\n\n`;
  return out;
}
function mk(n: number): string {
  return "# Doc\n\n" + pad(n) + "Intro para.\n\n" + QUOTE + OUTRO;
}

interface Env {
  root: string;
  store: SqliteThreadStore;
  rd: ReanchorDaemonHandle;
  dir: string;
}

const envs: Env[] = [];

type Overrides = Partial<
  Omit<ReanchorDaemonOptions, "store" | "bus" | "repoRoot" | "logger">
>;

/** `withDir: false` models a directory that does not exist when the
 * watcher is first installed — the ONE rebind shape whose canonical
 * path was never watched, and therefore the one shape where re-arming
 * `fs.watch` can actually work on this runtime. */
async function setup(overrides: Overrides & { withDir?: boolean } = {}): Promise<Env> {
  const { withDir = true, ...opts } = overrides;
  const root = mkdtempSync(join(tmpdir(), "revkit-rearm-"));
  if (withDir) mkdirSync(join(root, "docs"), { recursive: true });
  const store = SqliteThreadStore.open({ filename: ":memory:" });
  const rd = startReanchorDaemon({
    store,
    bus: new EventBus(),
    repoRoot: root,
    logger: makeLogger({ sink: { write: () => {} } }),
    ...opts,
  });
  const env: Env = { root, store, rd, dir: join(root, "docs") };
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
    commentId: `${threadId}c`,
    anchor,
    body: "x",
  };
  await store.append(input);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, ms = 3_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

async function threadStatus(store: SqliteThreadStore, threadId: string): Promise<string | undefined> {
  const all = await store.threads();
  return all.find((t) => t.id === threadId)?.status;
}

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

describe("issue #49 nit 1 — re-arm fs.watch once the directory is stable", () => {
  test("a rebound directory stops paying the 2 s poll latency", async () => {
    // The #49 symptom, measured through the PUBLIC surface only (no new
    // diagnostic API): after a rebind the directory is served by the
    // 2 s `stat`-poll forever, so an edit can sit unnoticed for up to
    // two seconds. With the watcher re-armed the worst case collapses
    // to a few ms. The poll interval is the REAL 2 s default so the
    // measurement is the one a user actually feels.
    const env = await setup({
      withDir: false,
      fileDebounceMs: 20,
      pollIntervalMs: 2_000,
      dirRebindIntervalMs: 40,
      dirStableIntervals: 2,
    });
    const f = join(env.dir, "a.md");
    const T = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
    await seedThread(env.store, mk(0), "docs/a.md", T);
    await env.rd.reconcileWatchers();

    mkdirSync(env.dir);
    writeFileSync(f, mk(0));
    // Let the rebind, its catch-up refresh and the stability window
    // elapse before measuring.
    await new Promise((r) => setTimeout(r, 400));

    const latencies: number[] = [];
    for (let i = 1; i <= 4; i++) {
      const src = mk(i * 3);
      const rev = await revisionOf(src);
      const started = Date.now();
      writeFileSync(f, src);
      while (Date.now() - started < 5_000) {
        const all = await env.store.threads();
        const t = all.find((x) => x.id === T);
        if (t !== undefined && isLineAnchor(t.anchor) && t.anchor.revision === rev) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      latencies.push(Date.now() - started);
      // Space writes off the poll tick so the poll's latency is sampled
      // across its whole period rather than one lucky phase.
      await new Promise((r) => setTimeout(r, 150));
    }
    const worst = Math.max(...latencies);
    // A live fs.watch signals in single-digit ms; the 2 s poll's worst
    // case approaches the interval.
    expect(worst).toBeLessThan(300);
  }, 60_000);

  test("a rebind polls FIRST, then returns to fs.watch once the dir is stable", async () => {
    const env = await setup({
      withDir: false,
      fileDebounceMs: 20,
      dirRebindIntervalMs: 40,
      pollIntervalMs: 40,
      dirStableIntervals: 2,
    });
    const f = join(env.dir, "a.md");
    // The thread exists but its directory does not — `statSync(dir)`
    // throws at install time, so the path was NEVER watched.
    await seedThread(env.store, mk(0), "docs/a.md", "11111111-1111-4111-8111-111111111111");
    await env.rd.reconcileWatchers();
    expect(env.rd.dirWatchMode(env.dir)).toBe("poll");

    mkdirSync(env.dir);
    writeFileSync(f, mk(0));

    // It must return to `fs.watch` — polling forever is the #49 nit.
    const rearmed = await waitFor(() => env.rd.dirWatchMode(env.dir) === "watch");
    expect(rearmed).toBe(true);
    expect(env.rd.dirWatchMode(env.dir)).toBe("watch");
  });

  test("the re-arm does NOT trigger a rebuild / re-anchor storm", async () => {
    const env = await setup({
      withDir: false,
      fileDebounceMs: 20,
      dirRebindIntervalMs: 40,
      pollIntervalMs: 40,
      dirStableIntervals: 2,
    });
    const f = join(env.dir, "a.md");
    await seedThread(env.store, mk(0), "docs/a.md", "22222222-2224-4222-8222-222222222222");
    await env.rd.reconcileWatchers();

    mkdirSync(env.dir);
    writeFileSync(f, mk(0));
    expect(await waitFor(() => env.rd.dirWatchMode(env.dir) === "watch")).toBe(true);

    // Quiesce, then measure across many further probe ticks. A watcher
    // that is merely holding still must not touch a single file.
    await new Promise((r) => setTimeout(r, 150));
    const readsBefore = env.rd.fileReadCount();
    const runsBefore = env.rd.pipelineRunCount();
    await new Promise((r) => setTimeout(r, 400));
    expect(env.rd.fileReadCount()).toBe(readsBefore);
    expect(env.rd.pipelineRunCount()).toBe(runsBefore);
  });

  test("if the re-arm cannot establish a watch, polling STAYS as the fallback", async () => {
    // Models a platform where `fs.watch` cannot signal at all (WSL bind
    // mount, FUSE, containerised mount): every re-arm attempt fails.
    let watchCalls = 0;
    const watchFn = (() => {
      watchCalls += 1;
      throw Object.assign(new Error("simulated unwatchable filesystem"), { code: "EACCES" });
    }) as unknown as ReanchorDaemonOptions["watchFn"];
    const env = await setup({
      withDir: false,
      fileDebounceMs: 20,
      dirRebindIntervalMs: 40,
      pollIntervalMs: 40,
      dirStableIntervals: 3,
      watchFn,
    });
    const f = join(env.dir, "a.md");
    const T = "33333333-3333-4333-8333-333333333333";
    await seedThread(env.store, mk(0), "docs/a.md", T);
    await env.rd.reconcileWatchers();

    mkdirSync(env.dir);
    writeFileSync(f, mk(0));
    await new Promise((r) => setTimeout(r, 500));

    // The re-arm was ATTEMPTED...
    expect(watchCalls).toBeGreaterThanOrEqual(1);
    // ...at the stability-gated cadence, NOT once per probe tick.
    expect(watchCalls).toBeLessThanOrEqual(4);
    // ...every attempt failed...
    expect(env.rd.dirWatchMode(env.dir)).toBe("poll");
    // ...and polling still catches writes. This is the
    // debounce-vs-poll race the design must not reintroduce.
    const rev = await revisionOf(mk(6));
    writeFileSync(f, mk(6));
    const settled = await waitFor(async () => {
      const all = await env.store.threads();
      const t = all.find((x) => x.id === T);
      return t !== undefined && isLineAnchor(t.anchor) && t.anchor.revision === rev;
    });
    expect(settled).toBe(true);
  });

  test("DIRECTORY-FORCE-POLL FACT: a rename-swapped directory does NOT pretend to have a watcher", async () => {
    // `fs.watch` cannot be re-armed on a path whose inode was replaced —
    // measured: 5/5 consecutive re-arms delivered zero events. So the
    // daemon must keep polling AND must not report `watch`. If this test
    // ever fails with mode `"watch"`, the runtime recovered and the
    // poison-tracking in the daemon can be relaxed.
    const env = await setup({
      fileDebounceMs: 20,
      dirRebindIntervalMs: 40,
      pollIntervalMs: 40,
    });
    const f = join(env.dir, "a.md");
    const T = "44444444-4444-4444-8444-444444444444";
    writeFileSync(f, mk(0));
    await seedThread(env.store, mk(0), "docs/a.md", T);
    await env.rd.reconcileWatchers();
    expect(await waitFor(() => env.rd.dirWatchMode(env.dir) === "watch")).toBe(true);

    renameSync(env.dir, join(env.root, "docs-old"));
    mkdirSync(env.dir);
    writeFileSync(f, mk(2));

    // Polling stays — and keeps working. Second write proves the
    // fallback is live, not just labelled.
    const rev4 = await revisionOf(mk(4));
    writeFileSync(f, mk(4));
    const settled = await waitFor(async () => {
      const all = await env.store.threads();
      const t = all.find((x) => x.id === T);
      return t !== undefined && isLineAnchor(t.anchor) && t.anchor.revision === rev4;
    });
    expect(settled).toBe(true);
    expect(env.rd.dirWatchMode(env.dir)).toBe("poll");
  });

  test("`poll: true` never re-arms — the caller asked for polling", async () => {
    const env = await setup({
      withDir: false,
      poll: true,
      fileDebounceMs: 20,
      dirRebindIntervalMs: 40,
      pollIntervalMs: 40,
      dirStableIntervals: 1,
    });
    await seedThread(env.store, mk(0), "docs/a.md", "55555555-5555-4555-8555-555555555555");
    await env.rd.reconcileWatchers();
    mkdirSync(env.dir);
    writeFileSync(join(env.dir, "a.md"), mk(0));
    await new Promise((r) => setTimeout(r, 300));
    expect(env.rd.dirWatchMode(env.dir)).toBe("poll");
  });
});

// The probe that measures the RUNTIME fact `DirectoryWatcher.everWatched`
// is built on. This is the one test in the file that is *meant* to fail
// when Bun's behaviour changes: a Bun that recovers (or regresses
// further) makes this red, which is the trigger to re-measure the three
// layers and then decide whether to relax the gate. Nothing in the daemon
// reads this result — the daemon is deliberately conservative either way.
describe("platform fact — does THIS runtime re-arm fs.watch after a directory swap?", () => {
  // Linux-only, and not out of caution: the fact being measured is
  // specific to Linux inotify semantics. Verified against three layers
  // on 6.8.0-31-generic — raw `inotify_add_watch` via ctypes allocates
  // a NEW wd and events arrive, and `node v24.21.0` signals — so
  // inotify and Node are fine and Bun 1.3.13 is the outlier. On macOS
  // the mechanism is FSEvents and this probe would be measuring
  // something else entirely, so it is skipped there rather than
  // reporting a fact it did not establish. The reason travels in the
  // test title so a skipped run says why.
  const SKIP_REASON = "Linux-only: inotify-specific fact, established on Linux";
  const notLinux = process.platform !== "linux";

  // Non-vacuity: a control proves the harness can observe events at all,
  // so the zero-event assertion below cannot pass merely because the
  // watcher was never wired up.
  test.skipIf(notLinux)(
    `a re-armed watch on a swapped directory receives zero events (control: a fresh one receives them) [${SKIP_REASON}]`,
    async () => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

      const control = mkdtempSync(join(tmpdir(), "revkit-fact-ctl-"));
      const controlDir = join(control, "docs");
      mkdirSync(controlDir);
      writeFileSync(join(controlDir, "a.md"), "v1");
      let controlEvents = 0;
      const controlWatcher = watch(controlDir, { persistent: false }, () => {
        controlEvents += 1;
      });
      await sleep(150);
      writeFileSync(join(controlDir, "a.md"), "v2");
      await sleep(450);
      controlWatcher.close();
      rmSync(control, { recursive: true, force: true });
      // If this fails, the runtime is not delivering events AT ALL and
      // the assertion below would be meaningless.
      expect(controlEvents).toBeGreaterThan(0);

      const root = mkdtempSync(join(tmpdir(), "revkit-fact-"));
      const dir = join(root, "docs");
      mkdirSync(dir);
      writeFileSync(join(dir, "a.md"), "v1");
      const first = watch(dir, { persistent: false }, () => {});
      await sleep(150);

      // The swap: rename the directory away and recreate it, so the
      // path exists again with a brand-new inode.
      renameSync(dir, join(root, "docs-old"));
      mkdirSync(dir);
      writeFileSync(join(dir, "a.md"), "v1");
      first.close();
      await sleep(80);

      let rearmEvents = 0;
      const rearmed = watch(dir, { persistent: false }, () => {
        rearmEvents += 1;
      });
      await sleep(150);
      writeFileSync(join(dir, "a.md"), "v2-after-swap");
      await sleep(500);
      rearmed.close();
      rmSync(root, { recursive: true, force: true });

      // Expected ZERO on bun 1.3.13. If this fails, Bun's re-arm now
      // works: re-run the three-layer probe (raw inotify via ctypes,
      // node, bun), confirm inotify and Node are still fine, and only
      // then consider relaxing `DirectoryWatcher.everWatched`.
      expect(rearmEvents).toBe(0);
    },
    30_000,
  );
});

describe("issue #49 nit 2 — prune the orphan memo on thread.reanchored", () => {
  test("an un-orphaned thread's memo entry is pruned immediately", async () => {
    const env = await setup();
    const f = join(env.dir, "a.md");
    const T = "66666666-6666-4666-8666-666666666666";
    writeFileSync(f, mk(0));
    await seedThread(env.store, mk(0), "docs/a.md", T);
    await env.rd.reconcileWatchers();

    // 1. Delete the quote entirely -> the thread orphans and the memo
    //    records "checked at this revision".
    writeFileSync(f, "# Doc\n\nCompletely different content here.\n");
    await env.rd.refresh("docs/a.md");
    expect(await threadStatus(env.store, T)).toBe("orphaned");
    expect(env.rd.orphanMemoSize()).toBe(1);

    // 2. Put the quote back (shifted) -> `thread.reanchored` fires and
    //    the thread goes back to `open`. The memo must be pruned NOW,
    //    not at the next `reconcileWatchers`.
    writeFileSync(f, mk(9));
    await env.rd.refresh("docs/a.md");
    expect(await threadStatus(env.store, T)).toBe("open");
    expect(env.rd.orphanMemoSize()).toBe(0);
  });

  test("a still-orphaned thread KEEPS its memo entry", async () => {
    const env = await setup();
    const f = join(env.dir, "a.md");
    const T = "77777777-7777-4777-8777-777777777777";
    writeFileSync(f, mk(0));
    await seedThread(env.store, mk(0), "docs/a.md", T);
    await env.rd.reconcileWatchers();

    writeFileSync(f, "# Doc\n\nCompletely different content here.\n");
    await env.rd.refresh("docs/a.md");
    expect(await threadStatus(env.store, T)).toBe("orphaned");
    expect(env.rd.orphanMemoSize()).toBe(1);

    // A second orphan refresh at a NEW revision must still be memoised —
    // pruning on "some other thread was re-anchored" would break this.
    writeFileSync(f, "# Doc\n\nYet another different content here.\n");
    await env.rd.refresh("docs/a.md");
    expect(await threadStatus(env.store, T)).toBe("orphaned");
    expect(env.rd.orphanMemoSize()).toBe(1);
  });

  test("two threads: re-anchoring ONE leaves the other's memo intact", async () => {
    const env = await setup();
    const A = "88888888-8888-4888-8888-888888888888";
    const B = "99999999-9999-4999-8999-999999999999";
    const fa = join(env.dir, "a.md");
    const fb = join(env.dir, "b.md");
    writeFileSync(fa, mk(0));
    writeFileSync(fb, mk(0));
    await seedThread(env.store, mk(0), "docs/a.md", A);
    await seedThread(env.store, mk(0), "docs/b.md", B);
    await env.rd.reconcileWatchers();

    // Both orphan.
    const gone = "# Doc\n\nCompletely different content here.\n";
    writeFileSync(fa, gone);
    writeFileSync(fb, gone);
    await env.rd.refresh("docs/a.md");
    await env.rd.refresh("docs/b.md");
    expect(env.rd.orphanMemoSize()).toBe(2);

    // Only A comes back.
    writeFileSync(fa, mk(9));
    await env.rd.refresh("docs/a.md");
    expect(await threadStatus(env.store, A)).toBe("open");
    expect(await threadStatus(env.store, B)).toBe("orphaned");
    expect(env.rd.orphanMemoSize()).toBe(1);
  });

  test("two threads on the SAME file: the re-anchored one is pruned, its orphaned bucket-sibling is not", async () => {
    // The shared-bucket case the cross-file test above cannot reach.
    // Both threads are seeded at the SAME revision on the SAME path, so
    // `doRefresh` groups them into ONE `byRevision` bucket and the
    // per-thread loop sees them back to back in a single `refresh` —
    // one `prepareReanchor`, one iteration order. If the prune swept
    // "the path's orphans" instead of "this thread's own re-anchor",
    // it would take the sibling's entry with it.
    const alpha = "Alpha marker unique line for the sibling case.";
    const beta = "Beta marker unique line for the sibling case.";
    // Fixed context paragraphs. Move detection needs `prefix + exact +
    // suffix` to survive verbatim, so the text either side of `alpha`
    // must be IDENTICAL across revisions and long enough (>32 chars)
    // to fill the context window. Only the filler in front of them
    // changes, which is what moves `alpha` to a different line.
    const pre = "Context paragraph that stays identical across revisions for anchoring purposes.";
    const post = "Trailing context paragraph that stays identical across revisions as well.";
    const sib = (opts: { alpha: boolean; beta: boolean; filler: number }): string => {
      let s = `# Doc\n\n${pad(opts.filler)}${pre}\n\n`;
      if (opts.alpha) s += `${alpha}\n\n`;
      s += `${post}\n\n`;
      if (opts.beta) s += `${beta}\n\n`;
      return s + QUOTE + OUTRO;
    };

    const env = await setup();
    // Ids and seeding order chosen so the SURVIVING orphan sorts FIRST
    // in the per-thread iteration. That is the worst case for a prune
    // that swept instead of keying on its own thread: the orphan
    // refreshes its memo, and then the re-anchoring thread's prune
    // would take that fresh entry with it. With the orphan visited
    // second the sweep is masked, because it re-establishes its own memo
    // afterwards — so this ordering is what makes the assertion bite.
    const ORPHAN = "11111111-1111-4111-8111-111111111111";
    const MOVER = "99999999-9999-4999-8999-999999999999";
    const f = join(env.dir, "same.md");
    const v1 = sib({ alpha: true, beta: true, filler: 0 });
    writeFileSync(f, v1);
    await seedThread(env.store, v1, "docs/same.md", ORPHAN, beta);
    await seedThread(env.store, v1, "docs/same.md", MOVER, alpha);
    await env.rd.reconcileWatchers();

    // Drop BOTH markers: both threads orphan, both memos recorded.
    writeFileSync(f, sib({ alpha: false, beta: false, filler: 0 }));
    await env.rd.refresh("docs/same.md");
    expect(await threadStatus(env.store, ORPHAN)).toBe("orphaned");
    expect(await threadStatus(env.store, MOVER)).toBe("orphaned");
    expect(env.rd.orphanMemoSize()).toBe(2);

    // Bring back ONLY alpha, and SHIFT it down so it re-anchors by
    // MOVEMENT (`kind: "anchored"` is reserved for the identity
    // short-circuit and emits no event, so a same-line restore would
    // never reach the prune at all).
    writeFileSync(f, sib({ alpha: true, beta: false, filler: 4 }));
    await env.rd.refresh("docs/same.md");

    expect(await threadStatus(env.store, MOVER)).toBe("open");
    expect(await threadStatus(env.store, ORPHAN)).toBe("orphaned");
    // The mover's entry is gone; the orphan's survives its sibling's
    // re-anchor even though it was visited FIRST in the same pass.
    expect(env.rd.orphanMemoSize()).toBe(1);
  });
});
