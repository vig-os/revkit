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
//      fallback engages after a fs.watch error OR after start-up if
//      `poll: true` is passed explicitly.
//   3. **Build watcher on `site/dist`.** A site rebuild changes
//      rendered HTML but the anchors live in the SOURCE files
//      (`docs/…`, `site/src/content/docs/…`). A rebuild often
//      coincides with a source edit (Astro rebuilds on source
//      change), so we watch `dist/` for a stable-file signal (no
//      writes for 500 ms after a burst) and then re-run `refresh`
//      for every threaded path. Debounce = 500 ms.
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

import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename as basenameOf, dirname, relative } from "node:path";
import {
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
   * un-orphan event (`thread.reanchored`) leaves the memo behind
   * but the thread's status flips to `open`, so subsequent
   * up-to-date checks look at `anchor.revision` instead — the memo
   * is inert. `reconcileWatchers` sweeps entries for threads no
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
    const allUpToDate = threads.every((thread) => {
      if (thread.status === "open") return thread.anchor.revision === newRevision;
      return orphanCheckRevision.get(thread.id) === newRevision;
    });
    if (allUpToDate) return;

    // Group by old revision so `prepareReanchor` runs once per (old,
    // new) pair rather than once per thread.
    const byRevision = new Map<string, Thread[]>();
    for (const thread of threads) {
      const existing = byRevision.get(thread.anchor.revision);
      if (existing !== undefined) existing.push(thread);
      else byRevision.set(thread.anchor.revision, [thread]);
    }

    // Store the new source under its revision BEFORE emitting events
    // so a concurrent read that lands mid-refresh can already find
    // it if it looks.
    putSnapshotSafe(newRevision, newSource);

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
        // A rejected append leaves the memo untouched — retry on
        // the next refresh. A successful append that moved a
        // thread from `orphaned` → `open` leaves the stale memo,
        // but the state-derived skip now checks `anchor.revision`
        // (open) so the memo is inert.
        if (seq !== null && result.kind === "orphaned") {
          orphanCheckRevision.set(thread.id, newRevision);
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
    // Every path that currently has a thread. Reading via
    // `store.threads()` (no filter) is O(events); for a repo with
    // a moderate log this is a few ms.
    const all = await store.threads();
    const paths = new Set<string>();
    for (const thread of all) paths.add(thread.anchor.path);
    await Promise.all([...paths].map((path) => refresh(path)));
  }

  async function gcOnce(): Promise<void> {
    if (stopped) return;
    // Retain every revision an open OR orphaned thread points at.
    // Resolved threads keep their snapshot too — a `thread.reopened`
    // event later would want to re-anchor against it.
    const all = await store.threads();
    const retain = new Set<string>();
    for (const thread of all) retain.add(thread.anchor.revision);
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
      dw = { basenames: new Map(), needsRebind: false };
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
   * differs from the one we bound to (round-4 blocker G(a)). */
  function installDirectoryWatcher(dir: string, dw: DirectoryWatcher): void {
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
      const watcher = watch(dir, { persistent: false }, (eventType, filename) => {
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
              dw.watcher?.close();
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
      watcher.on("error", () => {
        try {
          watcher.close();
        } catch {
          // Already closed.
        }
        dw.watcher = undefined;
        dw.needsRebind = true;
        installDirectoryPolling(dir, dw);
      });
      dw.watcher = watcher;
      dw.needsRebind = false;
      dw.boundIdent = boundIdent;
      // If a polling fallback was previously installed, tear it down
      // — the fs.watch is now live.
      if (dw.poll !== undefined) {
        clearInterval(dw.poll);
        dw.poll = undefined;
        dw.pollStat = undefined;
      }
      // Round-4 blocker G(b): after a fresh bind we may have missed
      // events between the old watcher dying and the new one
      // installing. Trigger a refresh for every tracked path so
      // an already-written file is reprocessed against the current
      // content.
      for (const trackedPath of dw.basenames.values()) fireForPath(trackedPath);
    } catch {
      installDirectoryPolling(dir, dw);
    }
  }

  /** Polling fallback for a directory. Compares (mtime, size) of
   * each tracked file at `pollIntervalMs` and fires a refresh when
   * either changes. A file that vanishes fires once so `refresh`
   * (which does its own read + orphan) sees the deletion. */
  function installDirectoryPolling(dir: string, dw: DirectoryWatcher): void {
    if (dw.poll !== undefined) return;
    dw.pollStat = new Map();
    for (const [basename, path] of dw.basenames) {
      void basename;
      dw.pollStat.set(path, safeStat(repoRoot + "/" + path));
    }
    const interval = setInterval(() => {
      if (stopped) return;
      for (const [basename, path] of dw.basenames) {
        void basename;
        const rooted = repoRoot + "/" + path;
        const now = safeStat(rooted);
        const prev = dw.pollStat!.get(path);
        if (prev === undefined && now === undefined) continue;
        if (prev === undefined || now === undefined) {
          dw.pollStat!.set(path, now);
          fireForPath(path);
          continue;
        }
        if (prev.mtimeMs !== now.mtimeMs || prev.size !== now.size) {
          dw.pollStat!.set(path, now);
          fireForPath(path);
        }
      }
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
      // the resolution).
      if (thread.status === "resolved") continue;
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
   * The polling fallback for a missing dir keeps firing refreshes
   * until the fs.watch is confirmed installed — the installer
   * clears the poll on success. */
  function rebindMissingDirWatchers(): void {
    for (const [dir, dw] of dirWatchers) {
      // Explicit rebind flag (needsRebind path).
      if (dw.needsRebind) {
        if (!existsSync(dir)) continue;
        installDirectoryWatcher(dir, dw);
        continue;
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
          continue;
        }
        if (
          currentIdent.dev !== dw.boundIdent.dev ||
          currentIdent.ino !== dw.boundIdent.ino
        ) {
          try {
            dw.watcher.close();
          } catch {
            // Already closed.
          }
          dw.watcher = undefined;
          dw.needsRebind = true;
          installDirectoryWatcher(dir, dw);
        }
      }
    }
  }

  /** Install a watcher on `distDir`. Reinstalled after an error or
   * a `distDir` recreate (`rm -rf dist && just build` is a common
   * shape). The reinstall is guarded by a polling probe every
   * `buildRebindIntervalMs` so a deleted-then-recreated dist gets a
   * fresh watcher instead of dropping build signals forever. See PR
   * #45 round-2 nit. */
  let buildRebindTimer: ReturnType<typeof setInterval> | undefined;
  /** Periodic probe that reinstalls a directory watcher whose parent
   * came back after being removed (probe G: `rmdir docs && mkdir
   * docs` while a thread is anchored under it). Same cadence as the
   * build-watcher rebind, so a common shape for both. */
  let dirRebindTimer: ReturnType<typeof setInterval> | undefined;
  function armDirRebind(): void {
    if (dirRebindTimer !== undefined || stopped) return;
    dirRebindTimer = setInterval(() => {
      if (stopped) return;
      rebindMissingDirWatchers();
    }, dirRebindIntervalMs);
    (dirRebindTimer as unknown as { unref?: () => void }).unref?.();
  }
  function installBuildWatcher(): void {
    if (distDir === undefined || stopped) return;
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
