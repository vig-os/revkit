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

import { statSync, watch, type FSWatcher } from "node:fs";
import { relative } from "node:path";
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
   * current file content on disk. Idempotent; serialised per path
   * (a second concurrent call joins the first's promise). */
  refresh(path: string): Promise<void>;
  /** Re-anchor every threaded path. Used by the build watcher when a
   * site rebuild lands, and by callers that read `/api/threads`
   * without a path filter. */
  refreshAll(): Promise<void>;
  /** Trigger a garbage-collection pass on the snapshot store,
   * deleting rows no live thread references. Fired opportunistically
   * after a refresh. */
  gc(): Promise<void>;
  /** Number of paths currently under an fs.watch (or poll). Diagnostic. */
  watchedPaths(): number;
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
  const inflight = new Map<string, Promise<void>>();
  const fileWatchers = new Map<string, { close: () => void }>();
  const fileTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let buildTimer: ReturnType<typeof setTimeout> | undefined;
  let buildWatcher: FSWatcher | undefined;
  let stopped = false;

  const handle: ReanchorDaemonHandle = {
    refresh,
    refreshAll,
    gc: gcOnce,
    watchedPaths: () => fileWatchers.size,
    stop,
  };

  async function refresh(path: string): Promise<void> {
    if (stopped) return;
    const existing = inflight.get(path);
    if (existing !== undefined) return existing;
    const run = doRefresh(path).finally(() => {
      inflight.delete(path);
    });
    inflight.set(path, run);
    return run;
  }

  async function doRefresh(path: string): Promise<void> {
    // Read the on-disk source under the containment helper — this
    // is the SAME resolver the POST /api/threads path uses, so a
    // path that snuck onto a thread despite the anchor check (or a
    // symlink that appeared between then and now) is refused here
    // too.
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
    try {
      const watcher = watch(rooted, { persistent: false }, fire);
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

  function installBuildWatcher(): void {
    if (distDir === undefined) return;
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
      });
    } catch (error) {
      // A non-existent dist dir is fine — the daemon may be run
      // without a site build; the lazy path still works.
      logger.warn("reanchor.build.watch.install-failed", {
        errorKind: (error as Error).name,
      });
    }
  }

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    for (const timer of fileTimers.values()) clearTimeout(timer);
    fileTimers.clear();
    if (buildTimer !== undefined) clearTimeout(buildTimer);
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

  // Expose the reconcile function via a hook: the daemon calls it
  // after every append (via a monkey-patch below in the wire-up
  // module) so a NEW thread on a NEW path gets a watcher installed.
  (handle as unknown as { reconcileWatchers: () => Promise<void> }).reconcileWatchers =
    reconcileWatchers;

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
