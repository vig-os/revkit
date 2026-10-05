// Live re-anchoring for the `revkit serve` daemon (M2 item 5b, story A8).
//
// The re-anchoring engine (`@revkit/review-core`'s `reanchor.ts`)
// is a pure pipeline: given `(oldSource, newSource, anchor)`, it
// returns a `ReanchorResult`. This module wires the engine into
// the daemon's mutable world — the sqlite store, `.revkit/`
// snapshots, filesystem watchers, and the event bus.
//
// **Trigger design (chosen).** Three complementary triggers:
//
//   1. **Lazy — before `/api/threads` GET and before `/events`
//      catch-up.** The daemon calls `refresh(path)` for every path
//      the caller is about to read (or every threaded path when the
//      caller reads without a filter). This is the ONE trigger that
//      is guaranteed correct — even if watchers miss an event or
//      the site was edited while the daemon was down, the next read
//      re-anchors before serving. All other triggers exist only to
//      keep the rail LIVE (a comment posted right now sees the
//      re-anchor without a manual refresh).
//   2. **File watcher on anchored source files.** For every
//      threaded path, `fs.watch` is installed lazily on the first
//      seen thread and torn down when no threads remain on that
//      path. The watcher fires `refresh(path)` on a 300 ms debounce.
//      On systems where `fs.watch` does not signal — WSL bind
//      mounts, some FUSE filesystems, containerised bind mounts on
//      macOS — the class falls back to a `stat`-poll at 2 s. The
//      fallback engages after a fs.watch error, after a directory
//      rebind, or after start-up if `poll: true` is passed
//      explicitly. A rebound directory is re-armed onto `fs.watch`
//      once it has been observably stable, but only where the runtime
//      can still register on that path — see the rebind probe and
//      issue #49.
//   3. **Build watcher on `site/dist`.** A site rebuild changes
//      rendered HTML but the anchors live in the SOURCE files
//      (`docs/…`, `site/src/content/docs/…`). A rebuild often
//      coincides with a source edit (Astro rebuilds on source
//      change), so we watch `dist/` for a stable-file signal (no
//      writes for 500 ms after a burst) and then re-run `refresh`
//      for every threaded path. Debounce = 500 ms.
//
//      **On Bun that watch is a `stat`-poll, not `fs.watch`** — see
//      `buildWatchLeaksOnThisRuntime` below and issue #87. Bun 1.3.13
//      does not release the descriptors `fs.watch` opens when the
//      watcher is closed, so the poll trades up to
//      `DEFAULT_BUILD_POLL_INTERVAL_MS` of detection latency for a
//      leak-free teardown. The DEBOUNCE contract is unchanged: the
//      settle timer restarts on every observed change and fires
//      `refreshAll` once the tree has been quiet for
//      `buildDebounceMs`.
//
// **Justification.** Lazy alone would leave the rail stale until
// the next fetch; the watchers close that gap on the interactive
// path. Watchers alone would leave the rail stale across a daemon
// restart on a file that changed while the daemon was down; lazy
// closes that gap. Together they cover both.
//
// **Concurrency (per-path mutex).** `refresh(path)` serialises
// through a per-path Map<string, Promise<void>>. A second call
// while one is running joins the same promise — never a second
// prepareReanchor pass on the same file. Different paths run
// concurrently because they touch different anchors and different
// snapshot rows.
//
// **Boundedness.** A file over `REANCHOR_SOURCE_MAX_BYTES` is
// refused by `resolveSourceUnderRoot` (same 5 MiB cap the anchor
// POST enforces). On refusal, every thread on that path orphans
// with a reason. A missing snapshot for a thread's revision is
// the same: orphan with a reason, never hang.
//
// **Actor.** Re-anchor events are appended as an `agent` author
// with id `revkit-reanchor` — a distinct, namespaced id that a
// consumer can filter on without seeing the human user's Claude
// Code session (`agentActorId`, typically `"agent"`). Using the
// existing `agent` kind (author.ts's enum) keeps the schema
// unchanged; the id is the discriminator. The rail, the channel
// server and any future PR-adapter can display or hide these
// events independently. See M2 item 5b's design note.

import { existsSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename as basenameOf, dirname, relative } from "node:path";
import {
  isLineAnchor,
  prepareReanchor,
  reanchorEvent,
  reanchorWith,
  ThreadStoreAppendError,
  type Author,
  type ReanchorContext,
  type ReviewEvent,
  type ReviewEventInput,
  type Thread,
} from "@revkit/review-core";
import type { EventBus } from "./event-bus.ts";
import type { Logger } from "./logger.ts";
import type { SqliteThreadStore } from "./sqlite-store.ts";
import { REANCHOR_SOURCE_MAX_BYTES, resolveSourceUnderRoot } from "./anchor-source.ts";

/** Author id the daemon writes on `thread.reanchored` /
 * `thread.orphaned`. Kept namespaced so a channel consumer can
 * filter on it without seeing the user's own agent id. */
export const REANCHOR_ACTOR_ID = "revkit-reanchor";


/** Debounce for the anchored-file watcher. A single edit fires 2–3
 * OS-level events (write, stat, close); 300 ms coalesces them into
 * one re-anchor pass without noticeably delaying the interactive
 * "type + save + see rail update" path. */
export const DEFAULT_FILE_DEBOUNCE_MS = 300;

/** Debounce for the `site/dist` build watcher. A build writes many
 * files over a few seconds; 500 ms after the last write gives the
 * builder time to finish before we start reading source files
 * (which the build may still be renaming). */
export const DEFAULT_BUILD_DEBOUNCE_MS = 500;

/** Interval for the polling fallback when `fs.watch` cannot signal
 * (WSL bind mount, container FUSE, macOS bind mount). 2 s trades a
 * bit of latency for `stat`-syscall load — one `stat(2)` per
 * watched file per 2 s is trivial. */
export const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** How often the build-watcher rebind probe runs (`rm -rf dist &&
 * just build` deletes and recreates the directory the watcher was
 * bound to; the probe re-installs the watcher). 2 s matches the
 * poll interval so a common shape for both is exercised together. */
export const DEFAULT_BUILD_REBIND_INTERVAL_MS = 2_000;

/** Interval for the Bun-only `dist` `stat`-poll (issue #87).
 *
 * This is the ONLY mechanism standing between a `revkit serve`
 * daemon and a `fs.watch(dist, {recursive: true})` that leaks one
 * descriptor per output file on Bun (see
 * `buildWatchLeaksOnThisRuntime`), so its cost is stated rather than
 * tuned away:
 *
 *   - **Latency.** A build's change is noticed up to this interval
 *     late, then `buildDebounceMs` (500 ms) of settle time elapses
 *     before `refreshAll` runs — the SAME settle window the
 *     `fs.watch` debounce used, so only the *detection* step is
 *     added, not a second debounce. Worst case a rebuild surfaces
 *     ~1 s later than it used to; the reviewer reloads and the lazy
 *     trigger has usually already re-anchored by then.
 *   - **CPU.** One `readdir`+`stat` walk of `dist/` per tick.
 *     Measured on this host: 0.07 ms for 52 entries, 1.11 ms for
 *     805, 11.4 ms for 6 409 (median of 25). At 1 s that is
 *     ≤ 1.1% of one core for a realistic Astro `dist`, and it is
 *     bounded by tree size, not by reviewer activity. (The same walk
 *     is what a single `fs.watch` did for free — this is the real
 *     price of the mitigation.)
 *   - **What is given up.** Sub-second build-signal latency on Bun,
 *     and the ability of a kernel-level watch to see a write that
 *     lands between two ticks. Neither is load-bearing: trigger 1
 *     (the lazy `refresh` before every `/api/threads` read) is the
 *     correctness backstop and is untouched by this.
 *   - **What is bought.** On Bun the recursive watch costs one
 *     descriptor per file in the build output — measured at 103 for a
 *     100-file `dist`, 403 for 400, 1003 for 1000 — paid at start-up
 *     and again on every re-install after `rm -rf dist && just
 *     build`. For a long review session that is thousands of
 *     descriptors where there used to be one watcher.
 *
 * 1 s is deliberately shorter than the 2 s file-poll interval: a
 * finished build is what the reviewer is waiting on, and the walk is
 * two orders of magnitude cheaper than the poll it sits beside. */
export const DEFAULT_BUILD_POLL_INTERVAL_MS = 1_000;

/** Does `fs.watch` leak descriptors on THIS runtime?
 *
 * MEASURED on `bun 1.3.13` (Linux 6.8, ext4): closing a
 * `watch(dir, {recursive: true})` handle leaks one real `open(2)`
 * descriptor for every path its recursive walk opened before the
 * `close()` landed — the directory, each file, each subdirectory, to
 * whatever depth the (asynchronous) walk reached. It is NOT
 * `anon_inode:inotify`: a live watcher holds exactly two descriptors
 * (inotify + the directory) and the inotify one IS released by
 * `close()`; the survivors are the plain `open(2)` ones, and each
 * keeps its inode alive after the tree is deleted.
 *
 * The count therefore scales with the watched tree, which is the part
 * that makes it matter. Over 20 `watch()`+`close()` pairs on a
 * `dist/{index.html, _astro/}` fixture with N files under `_astro/`,
 * closing 50 ms after `watch()` (i.e. after the walk finishes):
 *
 *     N=0 -> 3    N=10 -> 13    N=100 -> 103    N=400 -> 403    N=1000 -> 1003
 *
 * i.e. exactly one per file. Closing in the same tick as `watch()`
 * leaks less (`1 + <immediate entries>` for this fixture: 3 rather
 * than 4), because the walk has not descended yet — so the leak is
 * scheduling-dependent but never absent. `recursive: false` behaves
 * the same way on the directory and its immediate entries, so
 * `recursive` is not the trigger and dropping it is not a workaround.
 * `node v24.21.0` leaks 0 over the identical loop.
 *
 * Only the BUILD watcher is switched to polling, and only because it
 * is the one that watches a whole tree recursively: for a real Astro
 * `dist` that is one descriptor per output file, paid again on every
 * re-install after `rm -rf dist && just build`. The per-DIRECTORY
 * watchers below keep `fs.watch` on every runtime — they are bounded
 * by `1 + <entries in that one directory>`, and issue #49's re-arm
 * contract is asserted through `dirWatchMode()`, which only
 * distinguishes `"watch"` from `"poll"`. Their residual leak is
 * tracked in #103. */
const buildWatchLeaksOnThisRuntime = process.versions.bun !== undefined;

/** How many CONSECUTIVE clean observations of a rebound directory the
 * rebind probe must make before the daemon tries to re-arm `fs.watch`
 * on it (issue #49). "Clean" means: this tick performed no rebind, saw
 * no watch error, and found the directory's `(dev, ino)` unchanged
 * since the last tick.
 *
 * Stability is therefore derived from the probe's own observable
 * state — not from a sleep. One tick is not enough (the very first
 * tick after a rebind can land mid-`mkdir`), and the count costs
 * nothing extra because the probe already runs every
 * `dirRebindIntervalMs`. With the defaults this is 3 × 2 s = 6 s, well
 * inside the window where the `stat`-poll (2 s worst case) is still
 * serving correctness; the poll is what carries the directory until
 * the watcher is genuinely back. */
export const DEFAULT_DIR_STABLE_INTERVALS = 3;

/** Options a caller can override. In production the daemon calls
 * `startReanchorDaemon({ store, bus, repoRoot, distDir, logger })`
 * with the defaults; tests inject clocks and shorter debounces so
 * a spec runs in tens of ms. */
export interface ReanchorDaemonOptions {
  readonly store: SqliteThreadStore;
  readonly bus: EventBus;
  readonly repoRoot: string;
  /** Directory whose "stable" signal (no writes for `buildDebounceMs`)
   * triggers a refresh of every threaded path. Optional — a
   * daemon without a site build (a bare CLI test) simply omits it
   * and the build watcher is not installed. */
  readonly distDir?: string;
  readonly logger: Logger;
  /** Force polling instead of `fs.watch`. Off by default; the
   * daemon installs `fs.watch` and falls back to polling on error. */
  readonly poll?: boolean;
  readonly fileDebounceMs?: number;
  readonly buildDebounceMs?: number;
  readonly pollIntervalMs?: number;
  /** How often the periodic rebind probe reinstalls a directory
   * watcher whose parent came back after being removed. Default
   * `DEFAULT_BUILD_REBIND_INTERVAL_MS` (2 s); tests inject a shorter
   * value so a probe-G reproduction settles inside a few hundred
   * ms. */
  readonly dirRebindIntervalMs?: number;
  /** Interval for the Bun-only `dist` `stat`-poll that replaces
   * `fs.watch(dist, {recursive: true})` on runtimes where closing a
   * watcher leaks its descriptors (issue #87). Default
   * `DEFAULT_BUILD_POLL_INTERVAL_MS`. Ignored on runtimes where
   * `fs.watch` releases its descriptors (node). */
  readonly buildPollIntervalMs?: number;
  /** Consecutive clean probe observations a rebound directory needs
   * before the daemon re-arms `fs.watch` on it. Default
   * `DEFAULT_DIR_STABLE_INTERVALS`. See that constant for the exact
   * definition of "clean". */
  readonly dirStableIntervals?: number;
  /** **Test-only.** The `fs.watch` implementation the daemon installs
   * directory watchers with. Production never passes one; a test that
   * needs to prove the POLLING fallback survives a failed re-arm
   * injects a `watchFn` that throws. Typed as the loose shape the
   * daemon actually uses (`watch(dir, opts, listener)`) so a test can
   * delegate to the real `watch` for the calls it wants to succeed. */
  readonly watchFn?: (
    target: string,
    options: { persistent: boolean },
    listener: (eventType: string, filename: string | null) => void,
  ) => FSWatcher;
  /** **Test-only.** Called during `doRefresh` after the file has
   * been read + hashed but before any state is consulted. A probe
   * awaits this to sequence a concurrent write against the pipeline
   * (round-4 blocker A regression test). Production callers never
   * pass one. Throwing from the hook is caught and logged; the
   * refresh continues. */
  readonly postReadHook?: (path: string, newRevision: string) => Promise<void> | void;
  /** Injected clock (ms) for tests. */
  readonly nowMs?: () => number;
}

/** Handle returned by `startReanchorDaemon`. `refresh(path)` is the
 * lazy trigger the daemon calls from `/api/threads` and `/events`;
 * `stop()` tears down watchers and clears pending debounce timers. */
export interface ReanchorDaemonHandle {
  /** Re-anchor every open or orphaned thread on `path` against the
   * current file content on disk. Serialised per path with a dirty-
   * flag: a caller that arrives while one refresh is in flight
   * marks the path dirty and joins a coalesced rerun that starts
   * after the first finishes, so the awaited promise always reflects
   * a run that read a source at or newer than the caller's request
   * time. See PR #45 round-2 blocker 2. */
  refresh(path: string): Promise<void>;
  /** Re-anchor every threaded path. Used by the build watcher when a
   * site rebuild lands, and by callers that read `/api/threads`
   * without a path filter. Uses the per-path
   * mtime+size+revision cache so an unchanged file skips the
   * `revisionOf` hash and the pipeline. See PR #45 round-2 nit. */
  refreshAll(): Promise<void>;
  /** Trigger a garbage-collection pass on the snapshot store,
   * deleting rows no live thread references. Fired opportunistically
   * after a refresh. */
  gc(): Promise<void>;
  /** Reconcile the watched-file set with the current threads: install
   * an fs.watch (or polling watcher) for a threaded path that has
   * none, and tear down a watcher for a path whose threads all
   * resolved. Called by the daemon after every `store.append`. */
  reconcileWatchers(): Promise<void>;
  /** Number of paths currently under a watcher (real fs.watch or
   * polling fallback). A single directory watcher covers all its
   * threaded files; this counter reflects paths, not watchers. */
  watchedPaths(): number;
  /** Number of directory watchers currently held. Since M2 item 5b
   * round 3, watchers are per-DIRECTORY with a fan-out to the set
   * of threaded files inside; a doc dir with N threaded files
   * carries ONE watcher, not N. */
  watchedDirs(): number;
  /** Number of times the daemon read + hashed a file
   * (`resolveSourceUnderRoot`). Under the correctness-first
   * cache, every refresh reads and hashes; a "skip" is when the
   * hashed revision matches the last-processed one. Diagnostic for
   * tests only — see `pipelineRunCount()` for the "did the pipeline
   * actually run?" counter. */
  fileReadCount(): number;
  /** Number of times the pipeline (`prepareReanchor` +
   * per-thread `reanchorWith`) actually executed on a fresh
   * revision. A burst of refreshes over an unchanged file leaves
   * this at its previous value — that is what the "unchanged file
   * skips the pipeline" test asserts on. Diagnostic; not exposed
   * over HTTP. */
  pipelineRunCount(): number;
  /** How the directory watcher for `dir` is currently served:
   * `"watch"` (a live `fs.watch`), `"poll"` (the `stat`-poll
   * fallback), or `undefined` when the directory has no watcher.
   * Diagnostic for tests only — issue #49's re-arm contract is
   * asserted through this, because "which mechanism is live" is not
   * otherwise observable. */
  dirWatchMode(dir: string): "watch" | "poll" | undefined;
  /** Size of the per-thread orphan-check memo (`orphanCheckRevision`).
   * Diagnostic for tests only — issue #49 prunes an entry the moment
   * its thread is re-anchored, and the entry is inert by then, so
   * there is no behavioural proxy for "was it pruned?". */
  orphanMemoSize(): number;
  /** How the `site/dist` build signal is currently served: `"watch"`
   * (a live `fs.watch(dist, {recursive: true})`), `"poll"` (the Bun
   * `stat`-poll of issue #87), or `undefined` when there is no
   * `distDir` or the daemon is stopped. Diagnostic for tests only —
   * without it, "which mechanism is carrying the build signal" is not
   * observable, and the poll-vs-watch choice would be untestable on
   * the runtime that has it. */
  buildWatchMode(): "watch" | "poll" | undefined;
  stop(): Promise<void>;
}

/** Start the re-anchoring daemon. Installs the build watcher (if
 * `distDir` is set), pre-registers file watchers for every path
 * that already has a thread, and returns the handle the daemon
 * uses to drive lazy refreshes. */
export function startReanchorDaemon(options: ReanchorDaemonOptions): ReanchorDaemonHandle {
  const {
    store,
    bus,
    repoRoot,
    distDir,
    logger,
    poll: forcePoll = false,
    fileDebounceMs = DEFAULT_FILE_DEBOUNCE_MS,
    buildDebounceMs = DEFAULT_BUILD_DEBOUNCE_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    dirRebindIntervalMs = DEFAULT_BUILD_REBIND_INTERVAL_MS,
    buildPollIntervalMs = DEFAULT_BUILD_POLL_INTERVAL_MS,
    dirStableIntervals = DEFAULT_DIR_STABLE_INTERVALS,
    watchFn = watch,
    postReadHook,
  } = options;

  const actor: Author = { kind: "agent", id: REANCHOR_ACTOR_ID };
  /** Per-path in-flight state. `run` is the current pipeline
   * promise; `pending` is a coalesced rerun (created lazily) that
   * a caller who arrived AFTER the current run started can await,
   * so a caller never observes stale anchors. `dirty` is set every
   * time `refresh(path)` is called after `run` began; the completion
   * path uses it to decide whether to launch a fresh run before
   * resolving `pending`. */
  interface InflightState {
    run: Promise<void>;
    pending?: { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void };
    dirty: boolean;
  }
  const inflight = new Map<string, InflightState>();
  /** Per-orphaned-thread record of the revision at which the
   * pipeline last checked it. Keyed on `(threadId)` so it is
   * naturally per-thread (round-4 blocker 1 fix). Set only after a
   * successful check where the thread stayed orphaned; the next
   * refresh at the SAME `newRevision` skips this thread. An
   * un-orphan event (`thread.reanchored`) DELETES the entry — the
   * thread's status flips to `open`, so the entry is dead weight, and
   * issue #49 prunes it at the moment the re-anchor lands rather than
   * waiting for the next `reconcileWatchers`. The prune is keyed on an
   * explicit re-anchor of THAT thread, never a sweep, so a thread that
   * is still orphaned always keeps the entry the skip test reads.
   * `reconcileWatchers` additionally sweeps entries for threads no
   * longer under a watcher, so the map stays bounded. */
  const orphanCheckRevision = new Map<string, string>();
  /** Per-directory watcher, fanned out to the set of threaded
   * basenames inside. Round-3 nit: the previous code installed one
   * watcher per file, all bound to the SAME parent inode; five
   * threads under `docs/` used five watchers. Now we install ONE
   * watcher per directory and dispatch the `filename` argument to
   * the matching threaded paths.
   *
   * `paths` is the set of REPO-RELATIVE paths whose parent is this
   * directory; the map's basename → path lookup is `basename` →
   * the entry in `paths` whose basename matches (linear over the
   * set — tiny). We keep both a basename-set for the O(1) match on
   * the `filename` argument and the `paths` set for reconcile
   * bookkeeping. */
  interface DirectoryWatcher {
    watcher?: FSWatcher;
    /** basename → repo-relative path. Used by the fs.watch callback
     * to look up which refresh to schedule. Kept as a Map so a
     * future filename that differs by case (mac HFS) stays
     * discriminating. */
    basenames: Map<string, string>;
    /** Polling interval id when we fell back off `fs.watch`. */
    poll?: ReturnType<typeof setInterval>;
    /** Per-file mtime+size snapshot the polling fallback compares
     * against. Only populated when `poll` is set. */
    pollStat?: Map<string, { mtimeMs: number; size: number } | undefined>;
    /** Set when the parent dir itself was removed and the watcher
     * needs a rebind (probe G). */
    needsRebind: boolean;
    /** (dev, ino) captured at bind time. The rebind probe
     * compares the current dir's inode against this; a mismatch
     * (rename-away + recreate with a fresh inode) means the
     * watcher is bound to a dead inode and must be reinstalled,
     * even though `existsSync(dir)` says the path exists. Round-4
     * blocker G(a). */
    boundIdent?: { dev: number; ino: number };
    /** Has a `fs.watch` REGISTRATION ever succeeded on this exact
     * canonical `dir` path? Once true it stays true for the lifetime
     * of this watcher, which is what makes a re-arm safe to attempt
     * only when it is false.
     *
     * The asymmetry is a BUN defect, not a platform limit. Issue #49
     * measured, on one kernel and filesystem: after a re-arm on a path
     * whose inode was replaced, raw `inotify_add_watch` via ctypes
     * SIGNALS (new wd) and `node v24.21.0` `fs.watch` SIGNALS, but
     * `bun 1.3.13` receives ZERO events (5/5 re-arms; also via
     * `dir + "/."`, after `rm -rf`, and before a rename-save). So on
     * this runtime a swapped directory can only be served by polling.
     * `false` means the path was never successfully watched — the dir
     * was missing at install time, or `watch()` threw before
     * registering — and that is the case a re-arm can actually fix.
     *
     * If a future Bun recovers, this gate is CONSERVATIVE, not wrong:
     * those directories keep the poll (2 s slower, never blind). The
     * runtime probe in `test/serve/watcher-rearm.test.ts` is the
     * signal to re-measure and relax this, not the daemon itself. */
    everWatched: boolean;
    /** Consecutive clean observations by the rebind probe (see
     * `DEFAULT_DIR_STABLE_INTERVALS`). Reset to 0 on any rebind, any
     * watch error, and after every re-arm attempt. */
    stableObs: number;
  }
  const dirWatchers = new Map<string, DirectoryWatcher>();
  /** Per-path debounce timer for the fan-out. */
  const fileTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let buildTimer: ReturnType<typeof setTimeout> | undefined;
  let buildWatcher: FSWatcher | undefined;
  let stopped = false;
  let fileReadCount = 0;
  /** Number of times the pipeline (`prepareReanchor` + per-thread
   * `reanchorWith`) actually ran on a distinct revision. The
   * content-revision cache short-circuits a refresh whose content
   * matches the last-processed revision, so a burst of GETs on an
   * idle file leaves this counter unchanged. */
  let pipelineRunCount = 0;

  /** Number of threaded paths currently under a watcher (real or
   * poll). Kept in a local helper so both `watchedPaths` and the
   * dir-rebind probe use one source of truth. */
  function countWatchedPaths(): number {
    let total = 0;
    for (const dw of dirWatchers.values()) total += dw.basenames.size;
    return total;
  }

  const handle: ReanchorDaemonHandle = {
    refresh,
    refreshAll,
    gc: gcOnce,
    reconcileWatchers,
    watchedPaths: countWatchedPaths,
    watchedDirs: () => dirWatchers.size,
    fileReadCount: () => fileReadCount,
    pipelineRunCount: () => pipelineRunCount,
    dirWatchMode: (dir) => {
      const dw = dirWatchers.get(dir);
      if (dw === undefined) return undefined;
      if (dw.watcher !== undefined) return "watch";
      return dw.poll !== undefined ? "poll" : undefined;
    },
    orphanMemoSize: () => orphanCheckRevision.size,
    buildWatchMode: () => {
      if (buildPoll !== undefined) return "poll";
      if (buildWatcher !== undefined) return "watch";
      return undefined;
    },
    stop,
  };

  /** Refresh a path, coalescing concurrent calls into at most one
   * in-flight run plus one pending rerun. The returned promise
   * resolves after a run that STARTED at or after the caller's
   * invocation, so a joiner never observes stale anchors — the
   * blocker 2 fix. */
  async function refresh(path: string): Promise<void> {
    if (stopped) return;
    const existing = inflight.get(path);
    if (existing === undefined) {
      // Fresh run.
      const run = doRefresh(path).finally(() => onRunFinished(path));
      inflight.set(path, { run, dirty: false });
      return run;
    }
    // A run is already in flight. Mark dirty so the completion path
    // launches a coalesced rerun, then hand back the pending promise
    // (creating one if this is the first joiner of the current run).
    existing.dirty = true;
    if (existing.pending === undefined) {
      let resolveFn: () => void = () => {};
      let rejectFn: (error: unknown) => void = () => {};
      const promise = new Promise<void>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
      existing.pending = { promise, resolve: resolveFn, reject: rejectFn };
    }
    return existing.pending.promise;
  }

  /** Called by every run's `.finally`. If the path was marked dirty
   * during the run, launch ONE more run and route the pending
   * promise to its completion. Otherwise the state slot is freed. */
  function onRunFinished(path: string): void {
    const state = inflight.get(path);
    if (state === undefined) return;
    if (!state.dirty) {
      inflight.delete(path);
      // A pending promise here means we saw a joiner but forgot the
      // dirty flag — impossible by construction, but defensively
      // resolve so nothing hangs.
      state.pending?.resolve();
      return;
    }
    state.dirty = false;
    const pending = state.pending;
    state.pending = undefined;
    const next = doRefresh(path).finally(() => onRunFinished(path));
    state.run = next;
    if (pending !== undefined) {
      // Route the pending joiners' promise to THIS coalesced run's
      // completion. Any joiners that arrive during `next` get their
      // own fresh pending slot by the block above.
      next.then(pending.resolve, pending.reject);
    }
  }

  async function doRefresh(path: string): Promise<void> {
    // Read the on-disk source under the containment helper — this
    // is the SAME resolver the POST /api/threads path uses, so a
    // path that snuck onto a thread despite the anchor check (or a
    // symlink that appeared between then and now) is refused here
    // too. Always read + hash: the SHA-256 of a source under the
    // 5 MiB cap is < 1 ms, and it removes an entire class of
    // stat-race bugs (PR #45 round-3 blocker).
    fileReadCount += 1;
    const resolved = await resolveSourceUnderRoot(path, repoRoot);
    if (!resolved.ok) {
      // Refused (missing, over cap, symlink escape): every thread on
      // this path orphans with a stable reason. The pipeline itself
      // never runs. The reason string is generic enough not to
      // reveal WHICH failure mode fired (matches
      // `UNIFORM_ANCHOR_REJECTION`'s privacy stance) — an operator
      // reads the daemon's own log for the specific cause.
      logger.warn("reanchor.source.rejected", { path, reason: resolved.reason });
      await orphanAll(
        path,
        `source file unavailable at re-anchor time (missing, over ${REANCHOR_SOURCE_MAX_BYTES} bytes, or refused by containment).`,
      );
      return;
    }
    const { revision: newRevision, source: newSource } = resolved;

    // **Barrier hook (test-only).** A caller may inject
    // `postReadHook(path, revision)` to synchronise a probe between
    // the read+hash and everything else. Production code never
    // provides one; the round-4 blocker A regression test injects a
    // hook that pauses here while a second write lands, then lets
    // the run continue. Without the hook the doRefresh is a simple
    // linear read → decide → pipeline.
    if (postReadHook !== undefined) {
      try {
        await postReadHook(path, newRevision);
      } catch {
        // Test-only; a hook throwing must not crash the daemon.
      }
    }

    // Fetch open + orphaned threads on this path. `resolved` threads
    // are not tracked — the human/agent's final word stands.
    const threads = await store.threads({ path, status: ["open", "orphaned"] });
    if (threads.length === 0) {
      // Nothing to do; ensure the snapshot for the new revision is
      // stored anyway so a subsequent POST does not re-read the file.
      putSnapshotSafe(newRevision, newSource);
      return;
    }

    // **Snapshot backfill BEFORE the skip (round-5 blocker J).**
    // A pre-5b DB (migration case) carries threads at the current
    // disk revision but no snapshot row. If we skip the pipeline
    // via the state-derived check without first storing the
    // snapshot, the file's first edit runs `prepareReanchor` with
    // no old source in hand and orphans every thread with a
    // spurious "no snapshot" reason. `putSnapshot` is
    // `INSERT OR IGNORE` (content-addressed) so this is safe to
    // call every refresh; the cost is a small INSERT-that-does-
    // nothing on the hot path and is the sqlite equivalent of the
    // documented migration behaviour (`sqlite-store.ts` schema note).
    putSnapshotSafe(newRevision, newSource);

    // **State-derived skip (round-4 blocker 1 fix).** The previous
    // "last processed revision per path" cache broke when threads
    // changed: a resolved thread that reopens, or a POST that lands
    // a new thread at an older revision, both leave the cache
    // pointing at a revision the pipeline never processed for
    // *those* threads. Skipping under a per-path key would then
    // silently strand the newly-eligible threads at their old
    // anchor.
    //
    // Derive the decision from state: skip the pipeline only if
    // every OPEN thread's `anchor.revision` already matches the
    // current on-disk revision AND every ORPHANED thread was
    // already checked against this exact revision (memo:
    // `orphanCheckRevision`). If any thread is behind, run the
    // pipeline. This is naturally correct across resolve/reopen and
    // late-POST cases without invalidation hooks.
    // Filter out unanchored threads (PR #43) — they have no
    // revision / no quote, the reducer stamps them `orphaned` at
    // creation, and the pipeline has nothing to do with them.
    // Coordinator note 2026-09-30. Explicit type-guard callback so
    // TypeScript narrows `pipelineThreads`'s anchor to `Anchor`.
    type LineAnchoredThread = Omit<Thread, "anchor"> & { anchor: import("@revkit/review-core").Anchor };
    const pipelineThreads = threads.filter(
      (thread): thread is LineAnchoredThread => isLineAnchor(thread.anchor),
    );
    if (pipelineThreads.length === 0) return;

    const allUpToDate = pipelineThreads.every((thread) => {
      if (thread.status === "open") return thread.anchor.revision === newRevision;
      return orphanCheckRevision.get(thread.id) === newRevision;
    });
    if (allUpToDate) return;

    // Group by old revision so `prepareReanchor` runs once per (old,
    // new) pair rather than once per thread.
    const byRevision = new Map<string, LineAnchoredThread[]>();
    for (const thread of pipelineThreads) {
      const existing = byRevision.get(thread.anchor.revision);
      if (existing !== undefined) existing.push(thread);
      else byRevision.set(thread.anchor.revision, [thread]);
    }

    for (const [oldRevision, bucket] of byRevision) {
      // Identity: nothing changed on the file since the anchor was
      // taken. Skip pipeline work, but memo the orphan check so a
      // subsequent refresh at the same revision short-circuits at
      // the state-derived skip above.
      if (oldRevision === newRevision) {
        for (const thread of bucket) {
          if (thread.status === "orphaned") orphanCheckRevision.set(thread.id, newRevision);
        }
        continue;
      }

      const oldSource = store.getSnapshot(oldRevision);
      if (oldSource === undefined) {
        // No snapshot for the anchor's revision. The pipeline cannot
        // trust the diff; every thread on this bucket orphans with a
        // "missing snapshot" reason. The alternative — silently
        // guessing — would be worse than orphaning (ADR-0006).
        for (const thread of bucket) {
          if (thread.status === "orphaned") {
            // Already orphaned; no event to emit, but memo the
            // check at the current revision so a repeat refresh
            // skips this thread.
            orphanCheckRevision.set(thread.id, newRevision);
            continue;
          }
          const seq = await tryEmitEvent({
            kind: "thread.orphaned",
            actor,
            threadId: thread.id,
            revision: newRevision,
            reason: `no snapshot for the anchor's revision ${oldRevision.slice(0, 12)}… (rebuild predates the daemon or the snapshot was pruned).`,
          });
          // Only memo when the append landed. A rejected event
          // (validator refusal, sqlite error) leaves the thread
          // eligible for retry — the state-derived skip fires
          // again on the next refresh (round-4 blocker 1 nit).
          if (seq !== null) orphanCheckRevision.set(thread.id, newRevision);
        }
        continue;
      }

      let ctx: ReanchorContext;
      try {
        ctx = await prepareReanchor(oldSource, newSource);
      } catch (error) {
        // A diff timeout or a WebCrypto failure is a soft error — do
        // not crash the daemon; log and orphan.
        logger.warn("reanchor.prepare.failed", {
          path,
          errorKind: (error as Error).name,
        });
        for (const thread of bucket) {
          if (thread.status === "orphaned") {
            orphanCheckRevision.set(thread.id, newRevision);
            continue;
          }
          const seq = await tryEmitEvent({
            kind: "thread.orphaned",
            actor,
            threadId: thread.id,
            revision: newRevision,
            reason: `re-anchor pipeline failed to prepare context: ${(error as Error).message}`,
          });
          if (seq !== null) orphanCheckRevision.set(thread.id, newRevision);
        }
        continue;
      }

      for (const thread of bucket) {
        const result = await reanchorWith(ctx, thread.anchor);
        if (result.kind === "anchored") continue;
        if (result.kind === "orphaned" && thread.status === "orphaned") {
          // Already orphaned and still orphaned — no event, but
          // memo the check at newRevision.
          orphanCheckRevision.set(thread.id, newRevision);
          continue;
        }
        const event = reanchorEvent(thread.id, actor, result);
        if (event === null) continue;
        const seq = await tryEmitEvent(event);
        if (seq === null) continue;
        if (result.kind === "orphaned") {
          orphanCheckRevision.set(thread.id, newRevision);
        } else {
          // Issue #49: a `thread.reanchored` that LANDED flips this
          // thread back to `open`, so its orphan-check memo is dead
          // weight — prune it here rather than letting it linger until
          // the next `reconcileWatchers`. Keyed on this thread's own
          // re-anchor, never a sweep, so a still-orphaned sibling
          // keeps the entry its skip test reads. Only on a successful
          // append: a rejected event leaves the thread orphaned and
          // still in need of its memo.
          orphanCheckRevision.delete(thread.id);
        }
      }
    }

    pipelineRunCount += 1;

    // Opportunistic GC. Cheap when nothing changed, bounded by
    // snapshot count.
    await gcOnce();
  }

  /** Append the event to the store and fan it out on the bus.
   * Returns the assigned `seq` on success, or `null` when the
   * append was rejected (a validator refusal, a sqlite error).
   * Errors are logged (never thrown) — a re-anchor loop must not
   * crash the daemon, and the caller uses the return value to
   * decide whether to memo the orphan check: a rejected append
   * MUST leave the thread eligible for retry on the next refresh
   * (round-4 blocker 1 nit). */
  async function tryEmitEvent(input: ReviewEventInput): Promise<number | null> {
    let seq: number;
    try {
      seq = await store.append(input);
    } catch (error) {
      if (error instanceof ThreadStoreAppendError) {
        logger.warn("reanchor.append.rejected", {
          artefact: input.kind,
          errorKind: error.rejection.kind,
          ...("threadId" in input ? { threadId: (input as { threadId: string }).threadId } : {}),
        });
      } else {
        logger.warn("reanchor.append.error", {
          artefact: input.kind,
          errorKind: (error as Error).name,
        });
      }
      return null;
    }
    // Fan out. `since(seq - 1)` is the cheap way to grab exactly the
    // row we just wrote.
    const events = await store.since(seq - 1);
    const event = events.find((e: ReviewEvent) => e.seq === seq);
    if (event !== undefined) {
      void bus.publish(event);
    }
    return seq;
  }

  /** Wrap `store.putSnapshot` in a try/catch so a sqlite-side error
   * (disk full, WAL contention) does not crash the re-anchor loop —
   * an orphan is preferable to a hung daemon. */
  function putSnapshotSafe(revision: string, source: string): void {
    try {
      store.putSnapshot(revision, source);
    } catch (error) {
      logger.warn("reanchor.snapshot.put.failed", {
        errorKind: (error as Error).name,
      });
    }
  }

  async function orphanAll(path: string, reason: string): Promise<void> {
    const threads = await store.threads({ path, status: "open" });
    for (const thread of threads) {
      await tryEmitEvent({
        kind: "thread.orphaned",
        actor,
        threadId: thread.id,
        // For a missing source we do not have a "new" revision to
        // report. Use SHA-256(""), the deterministic empty-string
        // hash, so the field stays a valid 64-hex string and the
        // consumer can spot the sentinel. Documented in the M2
        // item 5b PR body.
        revision: EMPTY_SOURCE_REVISION,
        reason,
      });
    }
  }

  async function refreshAll(): Promise<void> {
    if (stopped) return;
    // Every path that currently has a LINE-anchored thread. Reading
    // via `store.threads()` (no filter) is O(events); for a repo
    // with a moderate log this is a few ms. Unanchored threads (PR
    // #43) contribute nothing here — they have no revision to
    // re-anchor against.
    const all = await store.threads();
    const paths = new Set<string>();
    for (const thread of all) {
      if (!isLineAnchor(thread.anchor)) continue;
      paths.add(thread.anchor.path);
    }
    await Promise.all([...paths].map((path) => refresh(path)));
  }

  async function gcOnce(): Promise<void> {
    if (stopped) return;
    // Retain every revision an open OR orphaned LINE-anchored
    // thread points at. Resolved threads keep their snapshot too
    // — a `thread.reopened` event later would want to re-anchor
    // against it. Unanchored threads (PR #43) have no revision.
    const all = await store.threads();
    const retain = new Set<string>();
    for (const thread of all) {
      if (!isLineAnchor(thread.anchor)) continue;
      retain.add(thread.anchor.revision);
    }
    try {
      const deleted = store.gcSnapshots(retain);
      if (deleted > 0) {
        logger.info("reanchor.snapshots.gc", {
          count: deleted,
          bytes: store.snapshotBytes(),
        });
      }
    } catch (error) {
      logger.warn("reanchor.gc.failed", { errorKind: (error as Error).name });
    }
  }

  // ── Watchers ──────────────────────────────────────────────────────

  /** Install a watcher for `path`. If `fs.watch` throws (WSL bind
   * mount, some containers), fall back to `stat`-poll at
   * `pollIntervalMs`. Idempotent — a second call for the same path
   * is a no-op. */
  /** Schedule a debounced `refresh(path)`. Coalesces bursts of
   * events on the same file. */
  function fireForPath(path: string): void {
    const existing = fileTimers.get(path);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      fileTimers.delete(path);
      void refresh(path).catch((error) =>
        logger.warn("reanchor.watch.refresh.failed", {
          path,
          errorKind: (error as Error).name,
        }),
      );
    }, fileDebounceMs);
    fileTimers.set(path, timer);
  }

  /** Make sure the directory that `path` lives in has a watcher (or
   * polling fallback), and register `path`'s basename with it.
   * Idempotent: a second call for the same path is a no-op. */
  function ensureWatcher(path: string): void {
    if (stopped) return;
    const rooted = repoRoot + "/" + path;
    const dir = dirname(rooted);
    const basename = basenameOf(rooted);
    let dw = dirWatchers.get(dir);
    if (dw === undefined) {
      dw = { basenames: new Map(), needsRebind: false, everWatched: false, stableObs: 0 };
      dirWatchers.set(dir, dw);
      installDirectoryWatcher(dir, dw);
    }
    dw.basenames.set(basename, path);
    if (dw.pollStat !== undefined && !dw.pollStat.has(path)) {
      // Prime the polling snapshot so the first tick after adding a
      // new file to an existing polled dir does not fire spuriously.
      dw.pollStat.set(path, safeStat(rooted));
    }
  }

  /** Try `fs.watch(dir)`, fall back to polling on error. `needsRebind`
   * is set when the directory disappears (probe G); the rebind loop
   * below (`rebindMissingDirWatchers`) reinstalls the watcher when
   * the dir returns.
   *
   * Captures `boundIdent = (dev, ino)` at bind time so the rebind
   * probe can spot a rename-swap: the path exists, but its inode
   * differs from the one we bound to (round-4 blocker G(a)).
   *
   * `handoverFromPolling` is the issue-#49 re-arm mode. On a plain
   * install we fire a catch-up refresh for EVERY tracked path (the
   * round-4 blocker G(b) requirement: events between the old watcher
   * dying and this one installing were missed). A re-arm is a
   * different thing — the poll has been serving that directory
   * correctly right up to the swap, so a blind fan-out would be a
   * pointless refresh burst. Instead the poll's own snapshot is used
   * as the handover baseline and only paths whose `(mtime, size)`
   * actually moved are fired, which closes the switchover window
   * without the storm. */
  function installDirectoryWatcher(
    dir: string,
    dw: DirectoryWatcher,
    options: { handoverFromPolling?: boolean } = {},
  ): void {
    if (forcePoll) {
      installDirectoryPolling(dir, dw);
      return;
    }
    let boundIdent: { dev: number; ino: number } | undefined;
    try {
      const st = statSync(dir);
      boundIdent = { dev: st.dev, ino: st.ino };
    } catch {
      // Directory does not exist; arm polling + mark rebind.
      dw.needsRebind = true;
      installDirectoryPolling(dir, dw);
      return;
    }
    try {
      // Capture the watcher reference so its callbacks can check
      // that they are still the CURRENT watcher before touching
      // `dw`. Without this guard, a stale watcher's async close /
      // error event can clobber a NEW watcher's state after a
      // rebind. (PR #45 round-5 defence-in-depth.)
      let capturedWatcher: FSWatcher | undefined;
      capturedWatcher = watchFn(dir, { persistent: false }, (eventType, filename) => {
        if (dw.watcher !== capturedWatcher) return;
        // Any event on the DIRECTORY itself (its own inode) — no
        // `filename` on most kernels — dispatch to every threaded
        // path. `filename === ''` happens on some macOS versions
        // and is treated as a directory-level signal too.
        if (filename === null || filename === "" || !dw.basenames.has(filename)) {
          // Directory-level event or an untracked filename. If the
          // dir was just removed, mark for rebind and fan out to
          // every tracked path so `refresh` orphans them.
          if (!existsSync(dir)) {
            dw.needsRebind = true;
            for (const p of dw.basenames.values()) fireForPath(p);
            // Close the dead watcher; the rebind loop will reinstall.
            try {
              capturedWatcher?.close();
            } catch {
              // Already closed.
            }
            dw.watcher = undefined;
            return;
          }
          // Directory rename event with no filename → conservatively
          // fan out to every tracked path.
          if (eventType === "rename") {
            for (const p of dw.basenames.values()) fireForPath(p);
          }
          return;
        }
        const targetPath = dw.basenames.get(filename)!;
        fireForPath(targetPath);
      });
      capturedWatcher.on("error", () => {
        if (dw.watcher !== capturedWatcher) return;
        try {
          capturedWatcher?.close();
        } catch {
          // Already closed.
        }
        dw.watcher = undefined;
        dw.needsRebind = true;
        dw.stableObs = 0;
        installDirectoryPolling(dir, dw);
      });
      const watcher = capturedWatcher;
      dw.watcher = watcher;
      dw.needsRebind = false;
      dw.boundIdent = boundIdent;
      // Issue #49: a registration now exists on this canonical path.
      // From here on, if the inode is replaced the path can no longer
      // be re-armed (see `DirectoryWatcher.everWatched`).
      dw.everWatched = true;
      const handover = options.handoverFromPolling === true ? dw.pollStat : undefined;
      // If a polling fallback was previously installed, tear it down
      // — the fs.watch is now live.
      if (dw.poll !== undefined) {
        clearInterval(dw.poll);
        dw.poll = undefined;
        dw.pollStat = undefined;
      }
      if (handover !== undefined) {
        // Issue #49 re-arm: fire only what the poll had not yet seen.
        // Nothing else — the poll was live a moment ago, so a write in
        // the switchover window is the ONLY thing this can owe.
        fireChangedSince(dir, dw, handover);
      } else {
        // Round-4 blocker G(b): after a fresh bind we may have missed
        // events between the old watcher dying and the new one
        // installing. Trigger a refresh for every tracked path so
        // an already-written file is reprocessed against the current
        // content.
        for (const trackedPath of dw.basenames.values()) fireForPath(trackedPath);
      }
    } catch {
      installDirectoryPolling(dir, dw);
    }
  }

  /** Fire a refresh for every tracked path under `dir` whose current
   * `(mtime, size)` differs from `baseline`, and update the live poll
   * snapshot. Shared by the polling fallback's tick and the issue-#49
   * poll→watch handover so both answer the same question with the
   * same comparison. */
  function fireChangedSince(
    dir: string,
    dw: DirectoryWatcher,
    baseline: Map<string, { mtimeMs: number; size: number } | undefined>,
  ): void {
    for (const path of dw.basenames.values()) {
      const rooted = repoRoot + "/" + path;
      const now = safeStat(rooted);
      const prev = baseline.get(path);
      const absentBoth = prev === undefined && now === undefined;
      const moved = prev === undefined || now === undefined
        ? !absentBoth
        : prev.mtimeMs !== now.mtimeMs || prev.size !== now.size;
      if (!moved) continue;
      dw.pollStat?.set(path, now);
      fireForPath(path);
    }
  }

  /** Polling fallback for a directory. Compares (mtime, size) of
   * each tracked file at `pollIntervalMs` and fires a refresh when
   * either changes. A file that vanishes fires once so `refresh`
   * (which does its own read + orphan) sees the deletion. */
  function installDirectoryPolling(
    dir: string,
    dw: DirectoryWatcher,
    options: { force?: boolean } = {},
  ): void {
    if (dw.poll !== undefined) {
      if (options.force !== true) return;
      clearInterval(dw.poll);
      dw.poll = undefined;
      dw.pollStat = undefined;
    }
    // If a live fs.watch is still hanging around from a previous
    // install, close it — the caller uses `force: true` to swap.
    if (options.force === true && dw.watcher !== undefined) {
      try {
        dw.watcher.close();
      } catch {
        // Already closed.
      }
      dw.watcher = undefined;
    }
    dw.pollStat = new Map();
    for (const [basename, path] of dw.basenames) {
      void basename;
      dw.pollStat.set(path, safeStat(repoRoot + "/" + path));
    }
    const interval = setInterval(() => {
      if (stopped) return;
      fireChangedSince(dir, dw, dw.pollStat!);
    }, pollIntervalMs);
    (interval as unknown as { unref?: () => void }).unref?.();
    dw.poll = interval;
  }

  function safeStat(rooted: string): { mtimeMs: number; size: number } | undefined {
    try {
      const st = statSync(rooted);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return undefined;
    }
  }

  /** Remove `path` from its directory's watcher. If the directory
   * has no more tracked paths, tear the whole watcher down. */
  function tearDownWatcher(path: string): void {
    const rooted = repoRoot + "/" + path;
    const dir = dirname(rooted);
    const basename = basenameOf(rooted);
    const dw = dirWatchers.get(dir);
    if (dw === undefined) return;
    dw.basenames.delete(basename);
    if (dw.pollStat !== undefined) dw.pollStat.delete(path);
    const timer = fileTimers.get(path);
    if (timer !== undefined) {
      clearTimeout(timer);
      fileTimers.delete(path);
    }
    if (dw.basenames.size === 0) {
      try {
        dw.watcher?.close();
      } catch {
        // Already closed.
      }
      if (dw.poll !== undefined) clearInterval(dw.poll);
      dirWatchers.delete(dir);
    }
  }

  /** Watch every threaded path. Idempotent — pass all threaded paths
   * from `store.threads()` after a POST /api/threads that opened a
   * new thread on a new path, and this method (a) installs the
   * missing watchers, (b) tears down watchers for paths that no
   * longer have any thread. */
  async function reconcileWatchers(): Promise<void> {
    if (stopped) return;
    const all = await store.threads();
    const wanted = new Set<string>();
    const trackedThreadIds = new Set<string>();
    for (const thread of all) {
      // Only watch open+orphaned threads. A resolved thread's
      // source-file edit does not need to re-anchor it (respect
      // the resolution). Unanchored threads (PR #43) have no
      // revision to watch against — the reducer treats them as
      // orphaned-from-birth and the rail renders them at the
      // file level.
      if (thread.status === "resolved") continue;
      if (!isLineAnchor(thread.anchor)) {
        trackedThreadIds.add(thread.id);
        continue;
      }
      wanted.add(thread.anchor.path);
      trackedThreadIds.add(thread.id);
    }
    for (const path of wanted) ensureWatcher(path);
    // Tear down any tracked path no longer wanted. Iterate a
    // snapshot of the map contents because `tearDownWatcher` may
    // remove the directory entry when its basename set empties.
    const trackedPaths: string[] = [];
    for (const dw of dirWatchers.values()) {
      for (const path of dw.basenames.values()) trackedPaths.push(path);
    }
    for (const path of trackedPaths) {
      if (!wanted.has(path)) tearDownWatcher(path);
    }
    // Rebind directory watchers whose parent came back or whose
    // inode changed underneath.
    rebindMissingDirWatchers();
    // Prune the orphan-check memo of threads no longer tracked.
    // Bounded: even under an adversarial mass-orphan-then-resolve
    // pattern the map only grows for threads that are currently
    // orphaned.
    for (const id of orphanCheckRevision.keys()) {
      if (!trackedThreadIds.has(id)) orphanCheckRevision.delete(id);
    }
  }

  /** Reinstall any directory watcher whose parent directory has
   * returned OR whose inode changed underneath us. Called from
   * `reconcileWatchers` (a POST /api/threads has landed) and from
   * the periodic rebind probe.
   *
   * **Two rebind triggers** (round-4 blocker G):
   *
   *   (a) `dw.needsRebind` was set — the watcher errored, or the
   *       fs.watch callback saw the dir vanish. Standard case.
   *   (b) The dir EXISTS and the watcher LIVES, but the current
   *       `(dev, ino)` differs from the one captured at bind time.
   *       Happens on `renameSync(dir, dir + "-old"); mkdirSync(dir)`:
   *       the old dir kept its inode (moved with the rename), a
   *       fresh inode was created for the new dir, and the watcher
   *       is now bound to the DEAD one. Without this check the
   *       daemon silently misses every subsequent event.
   *
   * **Rebind → polling, then re-arm once stable (round-5 blocker G +
   * issue #49).** A REBOUND directory does not get a fresh `fs.watch`
   * on the same canonical path — but the reason is a BUN defect, not
   * a platform limit, and the distinction decides what to do about it.
   * On `bun 1.3.13`, after a `renameSync(dir, …); mkdirSync(dir)`,
   * FIVE consecutive re-arms each received zero events (also via
   * `dir + "/."`, after `rm -rf`, and ahead of a rename-save), and a
   * recursive watch on the parent never saw the recreated directory's
   * writes. On the SAME kernel and filesystem, raw `inotify_add_watch`
   * via ctypes SIGNALS (allocating a new wd) and `node v24.21.0`
   * SIGNALS — so inotify is healthy and this is Bun's watch
   * implementation, version-specific to 1.3.13. Remediation is to
   * report/track the Bun bug and cross-check under Node; a native
   * inotify binding is explicitly NOT warranted, because inotify is
   * not what is broken. Such a directory is served by the
   * `stat`-poll — one `stat(2)` per tracked file per `pollIntervalMs`
   * (default 2 s): cheap, correct.
   *
   * **What #49 changed, and how narrow it is.** `DirectoryWatcher.
   * everWatched` records whether a registration ever succeeded on the
   * canonical path, and the probe re-arms once `dirStableIntervals`
   * consecutive clean observations prove the directory has settled,
   * ONLY when `everWatched` is false — i.e. the directory was missing
   * at install time, or `watch()` threw before registering. **The
   * rename-swap and `rm -rf` shapes have necessarily carried a
   * registration, so they keep the poll and keep the 2 s worst-case
   * detection latency; #49 did not remove it for them.** The poll
   * carries a directory until a re-arm lands and is torn down only
   * once a watcher is actually live, so a failed re-arm degrades to
   * the status quo rather than to a blind directory. */
  function rebindMissingDirWatchers(options: { tick?: boolean } = {}): void {
    for (const [dir, dw] of dirWatchers) {
      if (stepDirRebind(dir, dw)) {
        // The directory was rebound (or is still missing): it has not
        // demonstrated stability, so the re-arm counter restarts.
        dw.stableObs = 0;
        continue;
      }
      // Stability is a WALL-CLOCK notion — count it on the periodic
      // probe only. `reconcileWatchers` also calls this function, and
      // letting a POST /api/threads advance the counter would make
      // "N intervals" mean "N events" instead.
      if (options.tick !== true) continue;
      if (dw.watcher !== undefined || forcePoll || dw.everWatched) continue;
      if (dw.stableObs < dirStableIntervals) {
        dw.stableObs += 1;
        continue;
      }
      // Attempt the re-arm. Either outcome resets the counter: a
      // success now has to prove itself over the next N ticks, and a
      // failure re-arms the stability gate so a persistently
      // unwatchable directory costs one `watch()` per N probe
      // intervals rather than one per tick.
      dw.stableObs = 0;
      installDirectoryWatcher(dir, dw, { handoverFromPolling: true });
    }
  }

  /** One rebind step for `dir`. Returns true when the watcher is
   * disturbed — a rebind was performed, or the directory is missing
   * and still needs one — which is precisely the condition that
   * resets the stability counter. Returns false only when this tick
   * found nothing wrong with `dir`. */
  function stepDirRebind(dir: string, dw: DirectoryWatcher): boolean {
    // Explicit rebind flag (needsRebind path).
    if (dw.needsRebind) {
      if (!existsSync(dir)) return true;
      installDirectoryPolling(dir, dw, { force: true });
      // Capture the fresh identity so the inode-swap check below
      // does not fire again on the same swap.
      try {
        const st = statSync(dir);
        dw.boundIdent = { dev: st.dev, ino: st.ino };
      } catch {
        dw.boundIdent = undefined;
      }
      dw.needsRebind = false;
      // Round-4 blocker G(b): the polling fallback's own tick
      // will spot the write eventually, but firing a refresh
      // right now covers a write that already landed before the
      // rebind ran.
      for (const p of dw.basenames.values()) fireForPath(p);
      return true;
    }
    // Silent inode swap — dir looks fine but the watcher is bound
    // to a dead inode.
    if (dw.watcher !== undefined && dw.boundIdent !== undefined) {
      let currentIdent: { dev: number; ino: number } | undefined;
      try {
        const st = statSync(dir);
        currentIdent = { dev: st.dev, ino: st.ino };
      } catch {
        // Dir gone since; the next tick's `needsRebind` path handles it.
        return true;
      }
      if (currentIdent.dev !== dw.boundIdent.dev || currentIdent.ino !== dw.boundIdent.ino) {
        try {
          dw.watcher.close();
        } catch {
          // Already closed.
        }
        dw.watcher = undefined;
        dw.boundIdent = currentIdent;
        // A swap means this path HAS carried a registration, so
        // `everWatched` is already true and no re-arm will be
        // attempted: polling is the terminal mechanism here.
        installDirectoryPolling(dir, dw, { force: true });
        for (const p of dw.basenames.values()) fireForPath(p);
        return true;
      }
    }
    return false;
  }

  /** Install a watcher on `distDir`. Reinstalled after an error or
   * a `distDir` recreate (`rm -rf dist && just build` is a common
   * shape). The reinstall is guarded by a polling probe every
   * `buildRebindIntervalMs` so a deleted-then-recreated dist gets a
   * fresh watcher instead of dropping build signals forever. See PR
   * #45 round-2 nit. */
  let buildRebindTimer: ReturnType<typeof setInterval> | undefined;
  /** Interval id of the Bun-only `dist` `stat`-poll. Mutually
   * exclusive with `buildWatcher`/`buildRebindTimer`: exactly one of
   * the three serves the build signal on a given runtime. */
  let buildPoll: ReturnType<typeof setInterval> | undefined;
  /** Periodic probe that reinstalls a directory watcher whose parent
   * came back after being removed (probe G: `rmdir docs && mkdir
   * docs` while a thread is anchored under it). Same cadence as the
   * build-watcher rebind, so a common shape for both. */
  let dirRebindTimer: ReturnType<typeof setInterval> | undefined;
  function armDirRebind(): void {
    if (dirRebindTimer !== undefined || stopped) return;
    dirRebindTimer = setInterval(() => {
      if (stopped) return;
      rebindMissingDirWatchers({ tick: true });
    }, dirRebindIntervalMs);
    (dirRebindTimer as unknown as { unref?: () => void }).unref?.();
  }
  function installBuildWatcher(): void {
    if (distDir === undefined || stopped) return;
    // Issue #87: on a runtime whose `fs.watch` does not release the
    // descriptors it opened, the recursive `dist` watch leaks one
    // descriptor per file in the build output, on every teardown and
    // every re-install. The poll below carries the same contract
    // (settle, then `refreshAll`) with no descriptor at all.
    if (buildWatchLeaksOnThisRuntime) {
      installBuildPolling();
      return;
    }
    if (!existsSync(distDir)) {
      // dist/ does not exist yet — schedule a probe so we install
      // the watcher when the first build lands. Fire once now to
      // pick up a build that finished BEFORE the daemon started.
      armBuildRebind();
      return;
    }
    try {
      // `recursive: true` catches every write under dist/. Astro
      // writes many files during a build; the debounce (500 ms
      // after the LAST write) fires after the build settles.
      buildWatcher = watch(distDir, { persistent: false, recursive: true }, () => {
        if (buildTimer !== undefined) clearTimeout(buildTimer);
        buildTimer = setTimeout(() => {
          buildTimer = undefined;
          void refreshAll().catch((error) =>
            logger.warn("reanchor.build.refresh.failed", {
              errorKind: (error as Error).name,
            }),
          );
        }, buildDebounceMs);
      });
      buildWatcher.on("error", () => {
        try {
          buildWatcher?.close();
        } catch {
          // Already closed.
        }
        buildWatcher = undefined;
        // Watcher died (dist was rm -rf'd, for example). Arm the
        // rebind probe so we reinstall once dist exists again.
        armBuildRebind();
      });
      // Once a watcher is live, we can stop the rebind probe.
      if (buildRebindTimer !== undefined) {
        clearInterval(buildRebindTimer);
        buildRebindTimer = undefined;
      }
    } catch (error) {
      // A permission error or a race with a concurrent build — arm
      // the rebind probe so a subsequent attempt lands.
      logger.warn("reanchor.build.watch.install-failed", {
        errorKind: (error as Error).name,
      });
      armBuildRebind();
    }
  }

  /** Bun-only stand-in for `fs.watch(dist, {recursive: true})`
   * (issue #87 — see `buildWatchLeaksOnThisRuntime`). Holds NO
   * descriptor: the signal is "the tree under `distDir` differs from
   * the snapshot I took last tick", where a tree is a flat map of
   * relative path → `mtimeMs:size` for every file and a `dir` marker
   * for every directory, so additions, removals, in-place rewrites and
   * a `dist` that appears or disappears are all one comparison.
   *
   * The debounce contract is deliberately identical to the watcher's:
   * every observed change RESTARTS the settle timer, and
   * `refreshAll` runs once the tree has been quiet for
   * `buildDebounceMs`. That makes a poll tick indistinguishable from
   * a burst of kernel events for everything downstream — including
   * the `rm -rf dist && just build` shape, which the watcher served
   * by erroring out and re-arming: here it is served by the snapshot
   * emptying and refilling, so `armBuildRebind` is not needed on this
   * path at all. */
  function installBuildPolling(): void {
    if (distDir === undefined || stopped || buildPoll !== undefined) return;
    const dir = distDir;
    let snapshot = snapshotTree(dir);
    const interval = setInterval(() => {
      if (stopped) return;
      const next = snapshotTree(dir);
      if (sameTree(snapshot, next)) return;
      snapshot = next;
      if (buildTimer !== undefined) clearTimeout(buildTimer);
      buildTimer = setTimeout(() => {
        buildTimer = undefined;
        void refreshAll().catch((error) =>
          logger.warn("reanchor.build.refresh.failed", {
            errorKind: (error as Error).name,
          }),
        );
      }, buildDebounceMs);
    }, buildPollIntervalMs);
    (interval as unknown as { unref?: () => void }).unref?.();
    buildPoll = interval;
  }

  function armBuildRebind(): void {
    if (buildRebindTimer !== undefined || stopped || distDir === undefined) return;
    buildRebindTimer = setInterval(() => {
      if (stopped || distDir === undefined) return;
      if (buildWatcher !== undefined) return;
      if (existsSync(distDir)) {
        // Directory came back — try to install. `installBuildWatcher`
        // clears the rebind timer on success.
        installBuildWatcher();
      }
    }, DEFAULT_BUILD_REBIND_INTERVAL_MS);
    (buildRebindTimer as unknown as { unref?: () => void }).unref?.();
  }

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    for (const timer of fileTimers.values()) clearTimeout(timer);
    fileTimers.clear();
    if (buildTimer !== undefined) clearTimeout(buildTimer);
    if (buildRebindTimer !== undefined) {
      clearInterval(buildRebindTimer);
      buildRebindTimer = undefined;
    }
    if (buildPoll !== undefined) {
      clearInterval(buildPoll);
      buildPoll = undefined;
    }
    if (dirRebindTimer !== undefined) {
      clearInterval(dirRebindTimer);
      dirRebindTimer = undefined;
    }
    for (const dw of dirWatchers.values()) {
      try {
        dw.watcher?.close();
      } catch {
        // Already closed.
      }
      if (dw.poll !== undefined) clearInterval(dw.poll);
    }
    dirWatchers.clear();
    try {
      buildWatcher?.close();
    } catch {
      // Already closed.
    }
    buildWatcher = undefined;
  }

  // Kick off: install the build watcher and reconcile file watchers
  // for anything already in the store. Deliberately fire-and-forget —
  // a fresh daemon has no threads yet; a restart's reconcile happens
  // in the background and never blocks the first request.
  installBuildWatcher();
  armDirRebind();
  void reconcileWatchers().catch((error) =>
    logger.warn("reanchor.reconcile.failed", { errorKind: (error as Error).name }),
  );
  return handle;
}

/** A `dist` tree reduced to one comparable string per entry:
 * `mtimeMs:size` for a file, the literal `"dir"` for a directory.
 * Keys are rooted at `root`, so two snapshots of the same tree
 * compare key-for-key regardless of walk order. Used only by the
 * Bun build poll (issue #87). */
type TreeSnapshot = Map<string, string>;

/** Walk `root` into `out`. A missing/unreadable directory contributes
 * no entries rather than throwing — that IS the signal the build poll
 * needs for `rm -rf dist` (the snapshot empties) and for a `dist` that
 * has not been built yet (the snapshot starts empty). Symlinks are
 * recorded but never followed: a build does not rewrite through one,
 * and following would walk outside `dist`. */
function walkTree(root: string, prefix: string, out: TreeSnapshot): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const key = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.set(key, "dir");
      walkTree(root + "/" + entry.name, key, out);
      continue;
    }
    try {
      const st = statSync(root + "/" + entry.name);
      out.set(key, `${st.mtimeMs}:${st.size}`);
    } catch {
      // Vanished mid-walk (a build replacing it). Record it as gone so
      // the next tick sees a difference rather than a silent stall.
      out.set(key, "gone");
    }
  }
}

function snapshotTree(root: string): TreeSnapshot {
  const out: TreeSnapshot = new Map();
  walkTree(root, "", out);
  return out;
}

function sameTree(a: TreeSnapshot, b: TreeSnapshot): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

/** Sentinel revision string for `orphanAll`'s missing-source path.
 * `SHA-256("")` — the deterministic empty-string hash. Documented so
 * an operator scrolling logs can spot the sentinel and know the
 * source was unavailable at re-anchor time (as opposed to a real
 * new revision). */
export const EMPTY_SOURCE_REVISION =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// Re-export the source cap so callers name one constant.
export { REANCHOR_SOURCE_MAX_BYTES };

/** Compute a relative display path under the repo root. Used by
 * log lines that want a short label without a full absolute path. */
export function repoRelative(repoRoot: string, absolute: string): string {
  const rel = relative(repoRoot, absolute);
  return rel === "" || rel.startsWith("..") ? absolute : rel;
}
