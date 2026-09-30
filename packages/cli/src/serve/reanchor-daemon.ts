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
   * polling fallback). Diagnostic. */
  watchedPaths(): number;
  /** Number of times the re-anchor pipeline actually READ a file
   * (called `resolveSourceUnderRoot`). A skip through the
   * mtime+size cache does not increment this counter — the counter
   * is what the "no re-hash on unchanged file" test asserts on. */
  fileReadCount(): number;
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
  /** Per-path read cache (mtime + size + revision) so an unchanged
   * file is skipped without re-hashing the whole source. `resolveSourceUnderRoot`
   * still opens the file and runs `revisionOf` when the mtime/size
   * says the file changed, so a rename-save (which changes both) still
   * hits the pipeline. */
  const readCache = new Map<string, { mtimeMs: number; size: number; revision: string; source: string }>();
  const fileWatchers = new Map<string, { close: () => void }>();
  const fileTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let buildTimer: ReturnType<typeof setTimeout> | undefined;
  let buildWatcher: FSWatcher | undefined;
  let stopped = false;
  let fileReadCount = 0;

  const handle: ReanchorDaemonHandle = {
    refresh,
    refreshAll,
    gc: gcOnce,
    reconcileWatchers,
    watchedPaths: () => fileWatchers.size,
    fileReadCount: () => fileReadCount,
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
    // too.
    //
    // Fast path: the (mtime, size) tuple already matches the cached
    // (mtime, size, revision). Skip the read + hash + pipeline
    // entirely — nothing has changed since the last refresh. This
    // is what keeps `/api/threads` cheap under the lazy trigger.
    // A rename-save (write tmp + rename over) changes mtime AND
    // size, so it still hits the pipeline (blocker 1 fix relies on
    // this).
    const rooted = repoRoot + "/" + path;
    const cached = readCache.get(path);
    if (cached !== undefined) {
      try {
        const stat = statSync(rooted);
        if (stat.mtimeMs === cached.mtimeMs && stat.size === cached.size) {
          // No change on disk; the pipeline would emit `anchored` for
          // every thread (identity short-circuit). Skip.
          return;
        }
      } catch {
        // Fall through to `resolveSourceUnderRoot`, which will report
        // the removal + orphan every thread.
      }
    }
    fileReadCount += 1;
    const resolved = await resolveSourceUnderRoot(path, repoRoot);
    if (!resolved.ok) {
      // Refused (missing, over cap, symlink escape): every thread on
      // this path orphans with a stable reason. The pipeline itself
      // never runs. The reason string is generic enough not to
      // reveal WHICH failure mode fired (matches
      // `UNIFORM_ANCHOR_REJECTION`'s privacy stance) — an operator
      // reads the daemon's own log for the specific cause.
      readCache.delete(path);
      logger.warn("reanchor.source.rejected", { path, reason: resolved.reason });
      await orphanAll(
        path,
        `source file unavailable at re-anchor time (missing, over ${REANCHOR_SOURCE_MAX_BYTES} bytes, or refused by containment).`,
      );
      return;
    }
    const { revision: newRevision, source: newSource } = resolved;
    // Refresh the read cache. `statSync` here is called AFTER the
    // read; a write between the two settles at the next refresh (a
    // rename-save's second event fires the watcher again).
    try {
      const stat = statSync(rooted);
      readCache.set(path, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        revision: newRevision,
        source: newSource,
      });
    } catch {
      readCache.delete(path);
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
      // taken. Skip — the pipeline's `anchored` result is a no-op.
      if (oldRevision === newRevision) continue;

      const oldSource = store.getSnapshot(oldRevision);
      if (oldSource === undefined) {
        // No snapshot for the anchor's revision. The pipeline cannot
        // trust the diff; every thread on this bucket orphans with a
        // "missing snapshot" reason. The alternative — silently
        // guessing — would be worse than orphaning (ADR-0006).
        for (const thread of bucket) {
          if (thread.status === "orphaned") continue;
          await emitEvent({
            kind: "thread.orphaned",
            actor,
            threadId: thread.id,
            revision: newRevision,
            reason: `no snapshot for the anchor's revision ${oldRevision.slice(0, 12)}… (rebuild predates the daemon or the snapshot was pruned).`,
          });
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
          if (thread.status === "orphaned") continue;
          await emitEvent({
            kind: "thread.orphaned",
            actor,
            threadId: thread.id,
            revision: newRevision,
            reason: `re-anchor pipeline failed to prepare context: ${(error as Error).message}`,
          });
        }
        continue;
      }

      for (const thread of bucket) {
        const result = await reanchorWith(ctx, thread.anchor);
        if (result.kind === "anchored") continue;
        // A resolved thread's re-anchor still fires from the pipeline
        // above (we filter to open+orphaned), but the validator refuses
        // `thread.orphaned` for a non-open thread. Skip a repeat-orphan
        // for an already-orphaned thread whose outcome is orphan again.
        if (result.kind === "orphaned" && thread.status === "orphaned") continue;
        const event = reanchorEvent(thread.id, actor, result);
        if (event === null) continue;
        await emitEvent(event);
      }
    }

    // Opportunistic GC. Cheap when nothing changed, bounded by
    // snapshot count.
    await gcOnce();
  }

  /** Append the event to the store and fan it out on the bus. Errors
   * are logged (never thrown) — a re-anchor loop must not crash the
   * daemon. */
  async function emitEvent(input: ReviewEventInput): Promise<void> {
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
      return;
    }
    // Fan out. `since(seq - 1)` is the cheap way to grab exactly the
    // row we just wrote.
    const events = await store.since(seq - 1);
    const event = events.find((e: ReviewEvent) => e.seq === seq);
    if (event !== undefined) {
      void bus.publish(event);
    }
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
      await emitEvent({
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
  function ensureWatcher(path: string): void {
    if (stopped || fileWatchers.has(path)) return;
    const rooted = repoRoot + "/" + path;
    const fire = (): void => {
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
    };
    if (forcePoll) {
      installPollingWatcher(path, rooted, fire);
      return;
    }
    // **Blocker 1 fix**: watch the PARENT directory and filter by
    // basename. `fs.watch(file)` binds to the inode, so vim,
    // Sublime, VS Code, `git checkout` and every atomic-save (write
    // tmp + `renameSync` over the target) silently break the
    // watcher — no more events, no error, and the polling fallback
    // never arms. Watching the parent and matching the basename
    // catches BOTH `change` events (in-place writes) and `rename`
    // events (atomic replace, delete, recreate). The `filename`
    // argument may be null on some kernels; when it is, we treat
    // any event as a match and let the refresh's own mtime cache
    // short-circuit the no-op case.
    const dir = dirname(rooted);
    const basename = basenameOf(rooted);
    // A parent directory that does not exist yet (rare — the file
    // was just written) fails `fs.watch`. Fall back to polling in
    // that case; the caller can re-`ensureWatcher` once the dir
    // exists.
    try {
      const watcher = watch(dir, { persistent: false }, (_eventType, filename) => {
        if (filename !== null && filename !== basename) return;
        fire();
      });
      watcher.on("error", () => {
        // fs.watch failed after start; swap to polling silently. The
        // debounce timer keeps whatever the last `fire()` scheduled.
        try {
          watcher.close();
        } catch {
          // Already closed.
        }
        fileWatchers.delete(path);
        installPollingWatcher(path, rooted, fire);
      });
      fileWatchers.set(path, {
        close: () => {
          try {
            watcher.close();
          } catch {
            // Already closed.
          }
        },
      });
    } catch {
      installPollingWatcher(path, rooted, fire);
    }
  }

  function installPollingWatcher(path: string, rooted: string, fire: () => void): void {
    // `path` is the map key we install under so tearDown finds us.
    let lastMtime = -1;
    let lastSize = -1;
    const interval = setInterval(() => {
      try {
        const stat = statSync(rooted);
        if (lastMtime === -1) {
          lastMtime = stat.mtimeMs;
          lastSize = stat.size;
          return;
        }
        if (stat.mtimeMs !== lastMtime || stat.size !== lastSize) {
          lastMtime = stat.mtimeMs;
          lastSize = stat.size;
          fire();
        }
      } catch {
        // File gone — fire once so orphanAll runs on the next refresh.
        if (lastMtime !== -1) {
          lastMtime = -1;
          lastSize = -1;
          fire();
        }
      }
    }, pollIntervalMs);
    // `unref` so the interval does not keep the process alive on its
    // own — the daemon's server keeps it up while active, and
    // `stop()` clears the interval.
    (interval as unknown as { unref?: () => void }).unref?.();
    fileWatchers.set(path, {
      close: () => clearInterval(interval),
    });
  }

  function tearDownWatcher(path: string): void {
    const watcher = fileWatchers.get(path);
    if (watcher !== undefined) {
      watcher.close();
      fileWatchers.delete(path);
    }
    const timer = fileTimers.get(path);
    if (timer !== undefined) {
      clearTimeout(timer);
      fileTimers.delete(path);
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
    for (const thread of all) {
      // Only watch open+orphaned threads. A resolved thread's
      // source-file edit does not need to re-anchor it (respect
      // the resolution).
      if (thread.status === "resolved") continue;
      wanted.add(thread.anchor.path);
    }
    for (const path of wanted) ensureWatcher(path);
    for (const path of [...fileWatchers.keys()]) {
      if (!wanted.has(path)) tearDownWatcher(path);
    }
  }

  /** Install a watcher on `distDir`. Reinstalled after an error or
   * a `distDir` recreate (`rm -rf dist && just build` is a common
   * shape). The reinstall is guarded by a polling probe every
   * `buildRebindIntervalMs` so a deleted-then-recreated dist gets a
   * fresh watcher instead of dropping build signals forever. See PR
   * #45 round-2 nit. */
  let buildRebindTimer: ReturnType<typeof setInterval> | undefined;
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
    for (const watcher of fileWatchers.values()) watcher.close();
    fileWatchers.clear();
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
