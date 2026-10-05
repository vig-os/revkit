// #74 / #87: file-descriptor budget for the daemon-spawning suite.
//
// THE LEAK, MEASURED (#87). On `bun 1.3.13`, closing a `fs.watch`
// handle does NOT release the descriptors it opened. The quantity was
// re-derived here rather than inherited, and it is not the one the
// previous version of this header claimed:
//
//     closing watch(dir, {recursive: true}) leaks one real open(2)
//     descriptor per path its recursive walk opened before close():
//     the directory, every file, every subdirectory, to whatever
//     depth the (asynchronous) walk got to.
//
// So the count scales with the WATCHED TREE. Over 20 watch+close
// pairs on a `dist/{index.html, _astro/}` fixture with N files under
// `_astro/`, closing 50 ms after `watch()`, same host, five runs each:
//
//     N=0 -> 3     N=10 -> 13     N=100 -> 103     N=400 -> 403     N=1000 -> 1003
//
// i.e. exactly one per file. Those are measured THROUGH
// `startDaemon`/`stop` — the context every claim here is about, and the
// one this file's own test exercises. The harness is named because it
// changes the number: a bare `watch()`+`close()` loop never gets its
// walk past the watched directory's immediate entries, so it measures a
// flat 3.00 per close at every one of those N, while a FLAT `dist` (N
// files directly in it) leaks 101.00 at 100 files and 1001.00 at 1000 in
// either harness. What closes the gap is how long the watcher is
// allowed to live before `close()`. Three details worth keeping, all of
// which the earlier, coarser version of this header got wrong or did
// not know:
//
//   - It is NOT `anon_inode:inotify`. A LIVE watcher holds exactly two
//     descriptors — the inotify one and the watched directory — and
//     the inotify one IS released by `close()`. The survivors are
//     plain `open(2)` descriptors, and each keeps its inode alive
//     after the tree is deleted. "The inotify fd leaks" was the
//     wrong story, and an upstream report built on it would have been
//     about the wrong object.
//   - Closing in the same tick as `watch()` leaks less —
//     `1 + <immediate entries in dir>`, i.e. 3 rather than 4 on that
//     fixture — because the walk has not descended yet. The leak is
//     therefore scheduling-dependent, which is why a measurement of
//     it has to yield between iterations. It is never absent.
//     `recursive: false` behaves the same way on the directory and its
//     immediate entries, so `recursive` is not the trigger and
//     dropping it is not a workaround.
//
// Daemon teardown is correct; this is a Bun runtime bug, not a revkit
// defect. Following the #49 lesson (measure a platform's behaviour,
// name the runtime and version, cross-check a second implementation
// before blaming the OS) the same probe was run against
// `node v24.21.0`, which leaks **0** over the identical loop.
// Draft upstream report (NOT filed — outward-facing, owner call):
// `.revkit/run/upstream-drafts/bun-fswatch-close-fd-leak.md`.
//
// WHAT #87 DID ABOUT IT. The `startDaemon`/`stop` cycle installs
// exactly ONE `fs.watch`: the recursive build watcher on `site/dist`
// (`reanchor-daemon.ts` `installBuildWatcher`). The per-DIRECTORY
// watchers are not installed in this cycle at all — a fresh daemon has
// no threads, so `reconcileWatchers` has nothing to watch — which is
// what makes attribution a measurement rather than an inference: with
// `reanchor.poll = true` and again with an injected `watchFn` that
// throws, the leak was unchanged at 2.00/cycle, and a bare
// `watch(dist).close()` loop over the same one-entry fixture
// reproduced both the count and the descriptor kinds. (On a fixture
// with a NESTED file the bare loop stops at the immediate entries —
// see the harness note above — so the fixture this test now uses is
// quoted at 4.00/cycle, measured through the daemon.) So the
// mitigation replaces that one watch, on Bun only, with a `stat`-poll
// of the `dist` tree (`installBuildPolling`); `node` keeps `fs.watch`,
// which is correct there. Measured after the change: 0 leaked
// descriptors over 10 cycles and 0 over 40.
//
// The poll is not behaviour-neutral, and this file's scope is
// descriptors, so the rest of it is stated elsewhere rather than here:
// one settled build burst still produces exactly ONE `refreshAll` (the
// poll arms its settle only after the tree is unchanged across a full
// poll interval), at up to 2.5 s of detection latency instead of the
// watcher's 500 ms. The interval and its cost are documented on
// DEFAULT_BUILD_POLL_INTERVAL_MS in reanchor-daemon.ts, the decision is
// the #87 amendment in ADR-0006, and the one-pass property is pinned by
// the build-poll tests in reanchor-daemon.test.ts.
//
// WHAT IS STILL LEAKED, AND IS NOT COVERED HERE (stated so the tight
// budget is not read as "revkit leaks nothing"). The per-directory
// file watchers still use `fs.watch` on every runtime — issue #49's
// re-arm contract is asserted through `dirWatchMode()`, which only
// distinguishes `"watch"` from `"poll"`, so switching them to the poll
// on Bun would move the mechanism those tests pin rather than add
// coverage. They leak `1 + <immediate entries in that dir>` per
// directory per daemon, and again on every re-arm; instrumenting every
// watcher close across a full suite run on `origin/dev` accounted for
// 943 leaked descriptors, of which 230 came from the 114 directory
// watches and 738 from the 313 build watches. This test cannot see the
// directory half: it boots a daemon with no threads, so it never
// installs one. Tracked as #103; a guard for that path belongs with the
// code that creates it, not here.
//
// WHY A GUARD IS NEEDED AT ALL. The suite boots hundreds of daemons,
// so a few descriptors each accumulates into the thousands. Before the
// fix, over a full `packages/cli` run the peak was **4449** locally
// and 4687 on CI (run 37117007176; 4682 in 37117515667), on the same
// bun, against a post-warm-up floor of ~3433 — the ~1k above the floor
// matched the instrumented 943 almost exactly. Re-measured after #87,
// back-to-back on this host with the same leg — five runs of each here
// plus one independent run of each from the #106 review, so the spread
// is the spread rather than one sample's noise:
//
//     origin/dev   peak 4449-4454   floor 3433-3490   growth  962-1016
//     with #87     peak 4272-4327   floor 3429-3445   growth  837- 894
//
// (the CI figures were NOT re-measured; that needs a CI run). The
// residual growth of ~850 is NOT claimed to be watcher leak: the growth
// statistic is `max` minus `p10` over the post-warm-up window, and with
// the leak gone the maximum looks transient-dominated rather than
// end-of-run. That gap -- ~740 of accounted leak against ~150 of
// observed movement -- is written up in #104 rather than explained
// away. A host with the classic unprivileged 1024-descriptor limit dies with `EMFILE` partway through, and the
// resulting failure names no cause — that is the failure mode this
// file exists to pre-empt.
//
// SCOPE, measured rather than assumed. CI's runner defaults to a 65536 soft
// limit — which is exactly the value `just test` sets with `ulimit -S -n`,
// so on CI that line is a NO-OP, not a mitigation. And it is a weak
// mitigation anywhere else: with `prlimit --nofile=1024:1024` the raise is
// refused, the recipe warns and continues at 1024, and the suite would
// still die of `EMFILE`. It only helps in the soft-low/hard-high case.
//
// WHAT ACTUALLY PROTECTS CI, CORRECTED (#86). This header previously said the
// growth check in `scripts/fd-budget.sh` did, on the grounds that the absolute
// peak ceiling was blind to the first doubling. The second half was right; the
// first half is now retracted, and it is retracted rather than softened because
// this file's own rate test became the ONLY active guard as a result.
//
// The growth check is NOT applied to the `packages/cli` leg on CI. That leg is
// where this budget was derived from — ~3.4k fixed module-load descriptors plus
// ~1k of leak, the latter now identified as the `fs.watch` leak above (see #87
// above; the ~1k became ~850 on this host, and #104 records what the remainder
// is and is not) — and on the CI runner its ramp extends past the warm-up, so
// `scripts/fd-budget.sh` declines to report a growth figure and prints
// `baseline settled: no ... growth unmeasured` (measured twice: floor
// 3966/3971 against an opening probe of 3497/3431). The growth check still
// bounds growth across the whole process tree on the legs whose window IS
// settled (`packages/worker`, `site/playwright`).
//
// So: against a descriptor leak on CI, the guard that is actually active is
// the `per-cycle` test BELOW — and its scope is exactly one code path,
// `startDaemon` + `handle.stop()`, 10 cycles. It does not cover the
// per-directory watchers (see above), a new watcher, a child-process handle,
// a sqlite fd or a test helper, any of which the process-tree poller would
// have seen. What the absolute ceiling covers, and what it does not, is
// unchanged: the leg is ~3.4k fixed, so even a doubling of the whole leak
// stayed under the 8192 ceiling — the ceiling is a runaway backstop and is
// blind to the first doubling. The quantified band left unguarded is tracked
// with #86.
//
// WHAT EACH TEST COVERS, HONESTLY.
//
//   1. `per-cycle` is the load-bearing test: an order-independent
//      tripwire on the leak RATE, measured around a bounded number of
//      real daemon lifecycles. A new code path that leaks fails here,
//      naming the count AND the readlink target of every new
//      descriptor, instead of surfacing as an `EMFILE` crash hundreds
//      of tests later. Its budget is a TOTAL over `CYCLES` cycles, not
//      a per-cycle rate times `CYCLES`: a leak that scales with
//      `CYCLES` cannot hide behind a constant that also scales with it.
//      Its fixture carries THREE paths under `dist` (a file, a
//      directory, and a file inside that directory) on purpose — under
//      the old `fs.watch` that fixture leaked 4 per cycle rather than
//      2, so the old budget of `CYCLES * 2` would have been one
//      directory-shape away from being a false RED.
//   2. `suite ceiling` is a coarse backstop only. It reads the count
//      in whatever process state exists when THIS file runs, so it
//      observes the cumulative suite total only if bun happens to
//      have run the daemon tests first — which is NOT guaranteed and
//      is not asserted. Read it as "the count is not absurd", not as
//      a suite-wide total. The real suite-wide measurement is the
//      external poller in `scripts/fd-budget.sh`.
//
// Linux-gated with a written reason (same convention as
// `watcher-rearm.test.ts`): the quantity under test is a count of
// entries in `/proc/self/fd`, which has no portable equivalent.

import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../../src/serve/daemon.ts";

const hasProcFd = process.platform === "linux";

/** Cycles per measurement. 10 keeps the test under a second. The
 * budget below is a TOTAL over these cycles rather than a per-cycle
 * rate, so this constant no longer has to be re-derived whenever the
 * rate is: the property under test is "a daemon lifecycle is
 * descriptor-neutral", which holds for any `CYCLES`. */
const CYCLES = 10;

/** Total descriptor budget across ALL `CYCLES` cycles — i.e. ≈0 per
 * cycle, with exactly one descriptor of allowance for measurement
 * noise (an fd that the runtime opens and closes around the read, or
 * one that another in-flight test in the same process happens to hold
 * at the boundary sample).
 *
 * WHY A TOTAL, and not `CYCLES * a measured rate` (#87). The previous
 * version budgeted `CYCLES * 2` from the then-measured 2.00 fds per
 * cycle on `bun 1.3.13`, which made the guard only as strong as the
 * accuracy of a number that is runtime- AND directory-shape specific:
 * the leak is one descriptor per path the watcher's walk opened, so
 * 2.00 described this test's one-entry `dist` fixture and nothing else.
 * On the three-path fixture below the same leak is 4.00 per cycle — a
 * budget derived from the old fixture would have been one directory
 * shape away from being a false RED, and a fixture change would have
 * forced the budget to be re-derived rather than tracking the
 * property. One descriptor over ten cycles has no such dependency: it
 * is satisfied by "the cycle is neutral", on every runtime, at every
 * directory fan-out. */
const FD_DELTA_BUDGET = 1;

/** Absolute ceiling on this process's descriptor count.
 *
 * MEASURED peak 4454 over a full `packages/cli` run on
 * `bun 1.3.13`, before #87 — of which ~3433 is a one-time module-load
 * cost and the remaining ~1021 was watcher leak across the suite's
 * daemon cycles (instrumenting every watcher close accounts for 943 of
 * it: 738 build watches, 230 directory watches). The fixed cost is the
 * leg's post-warm-up FLOOR, read as the p10 of the post-warm-up window
 * (412 samples, loadavg ~3); the older `min`-based reading of the same
 * quantity was 3384 local / 3403 on CI. Two narrower probes give 52 for
 * a bare `bun test` and 3268 for one importing only `serve/daemon.ts`.
 * None of the fixed part grows, so none of it is a leak.
 *
 * NOT LOWERED by #87, deliberately: the ceiling is derived from that
 * measured floor, and the brief for #87 scoped lowering it out. It is
 * unchanged at 8192 so the constant dominates and the assertion stays
 * a backstop rather than a tripwire; test 1 is what tracks the leak,
 * and per this file's header it is the only active leak guard on CI —
 * see there for the scope that implies. Re-measured after #87 over six
 * runs (five here, one from the #106 review): peak 4272-4327 against
 * origin/dev's 4449-4454, floor unchanged at ~3430-3445 (the CI figure
 * was NOT re-measured; that needs a CI run). */
const SUITE_FD_CEILING = 8192;

/** Every descriptor this process holds, as fd → readlink target.
 * The readlink is what turns "3 new descriptors" into "3 new
 * descriptors, and here is what they are" — without it a failure
 * message can only guess at a cause. An fd that closes between the
 * readdir and the readlink is skipped rather than throwing: that race
 * is normal and is not a leak. */
function openFds(): Map<number, string> {
  const out = new Map<number, string>();
  for (const entry of readdirSync("/proc/self/fd")) {
    const fd = Number(entry);
    try {
      out.set(fd, readlinkSync(`/proc/self/fd/${entry}`));
    } catch {
      // Closed underneath us.
    }
  }
  return out;
}

/** Classify a readlink target into the kinds a reader can act on:
 * the inotify descriptor, a real path (and whether it is a watched
 * directory or one of its children), or something else. */
function fdKind(target: string): string {
  if (target.includes("inotify")) return "anon_inode:inotify (fs.watch registration)";
  if (target === "socket:[*]") return target;
  if (target.startsWith("/")) return `open fd on a real path: ${target}`;
  return target;
}

/** Descriptors held after the measurement that were not held before,
 * as `"fd N → kind"` strings. Matched by TARGET as well as by fd
 * number: the kernel recycles the lowest free fd, so a leaked
 * descriptor and a freshly-opened one can share a number while having
 * nothing to do with each other. Matching on target as well is what
 * makes "this target was already open, so it is not new" decidable.
 * Sorted so a failure message is stable. */
function newFdReport(before: Map<number, string>, after: Map<number, string>): string {
  const known = new Set(before.values());
  const report: string[] = [];
  for (const [fd, target] of [...after].sort((a, b) => a[0] - b[0])) {
    if (known.has(target)) continue;
    known.add(target);
    report.push(`fd ${fd} → ${fdKind(target)}`);
  }
  return report.length === 0 ? "(none — every descriptor held now was already held before)" : report.join("; ");
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function cycleOnce(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "revkit-fd-budget-"));
  roots.push(root);
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  // THREE paths under `dist`, across two levels: a file, a directory,
  // and a file inside that directory. Under the old
  // `fs.watch(dist, {recursive: true})` this fixture leaked 4
  // descriptors per cycle — measured, RED, 40 over the 10 cycles — so
  // the old `CYCLES * 2` budget sat exactly on the edge of a false RED
  // and the leak rate moved whenever the fixture did. A fixture that
  // leans on the shape the leak scales with is the point: the
  // assertion below has to be satisfied by the CYCLE, not by a rate
  // that depends on how this directory is shaped.
  mkdirSync(join(dist, "_astro"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><h1>ok</h1>");
  writeFileSync(join(dist, "_astro", "index.js"), "export const x = 1;\n");
  const handle = await startDaemon({
    dir: dist,
    repoRoot: root,
    port: 0,
    sqlitePath: ":memory:",
    version: "0.0.0-test",
    localUserId: "local-test",
    installSignalHandlers: false,
  });
  await handle.stop();
}

describe.skipIf(!hasProcFd)("daemon fd budget (#74, #87)", () => {
  test(
    `${CYCLES} startDaemon/stop cycles leak at most ${FD_DELTA_BUDGET} descriptor in total`,
    async () => {
      // Warm first: the module graph's descriptors are already open by
      // the time this runs, so the delta isolates the per-cycle
      // behaviour. Without the warm-up this measures module load.
      await cycleOnce();
      const before = openFds();
      for (let i = 0; i < CYCLES; i++) await cycleOnce();
      const after = openFds();
      const delta = after.size - before.size;
      expect(
        delta,
        `descriptor delta over ${CYCLES} daemon cycles was ${delta}, budget ${FD_DELTA_BUDGET} ` +
          `(≈0 per cycle). New descriptors: ${newFdReport(before, after)}. ` +
          `A startDaemon/stop cycle must be descriptor-neutral on every runtime. ` +
          `If the new descriptors are real paths under a temp dir, this is ` +
          `Bun's fs.watch leak again (#87: one descriptor per path the ` +
          `watcher's walk opened, not released by close()); the build watcher ` +
          `polls on Bun, so check whether a per-directory watcher was added ` +
          `to this path. See this file's header.`,
      ).toBeLessThanOrEqual(FD_DELTA_BUDGET);
    },
    60_000,
  );

  test("this process stays under the documented descriptor ceiling", () => {
    const count = readdirSync("/proc/self/fd").length;
    expect(
      count,
      `descriptor count was ${count} (ceiling ${SUITE_FD_CEILING}; measured packages/cli peak 4449 before #87, 4272-4327 after). ` +
        `This reads the count at the moment this file runs, so it is a coarse backstop — ` +
        `the suite-wide peak is measured by scripts/fd-budget.sh.`,
    ).toBeLessThanOrEqual(SUITE_FD_CEILING);
  });
});
