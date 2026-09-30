// Shared registry of daemon child pids the test suite spawned.
// PR #38 round-3 blocker: the previous `daemon-hygiene.test.ts`
// walked the whole process table for anything matching
// `revkit\.js\s+serve` and killed it — including the owner's own
// dogfood daemon on the same host. That's dangerous. The fix:
//
//   1. Every test that spawns a daemon (either via `startDaemon`
//      or by `child_process.spawn`ing `revkit serve`) records the
//      child's pid here via `registerDaemonPid(pid)`.
//   2. On teardown or at end-of-suite, `daemon-hygiene.test.ts`
//      looks up ONLY those pids. Any that's still alive fails
//      the run. Nothing OUTSIDE the registered set is even
//      inspected.
//
// The registry is one in-memory Set — bun test workers do not
// share memory between files, but every test file that spawns
// records into the same module (bun's module cache in a single
// worker), and `daemon-hygiene.test.ts` runs after `serve/`
// tests alphabetically in the same worker.

const REGISTERED_PIDS: Set<number> = new Set<number>();

/** Called by any test helper right after `Bun.spawn` / `child_process.spawn`
 * returns a pid. */
export function registerDaemonPid(pid: number): void {
  if (Number.isInteger(pid) && pid > 0) REGISTERED_PIDS.add(pid);
}

/** Read the current registered pids. Used by `daemon-hygiene.test.ts`. */
export function registeredDaemonPids(): readonly number[] {
  return [...REGISTERED_PIDS];
}

/** Remove a pid from the registry — teardown paths that DID kill
 * their daemon call this so the survivor check does not flag it. */
export function unregisterDaemonPid(pid: number): void {
  REGISTERED_PIDS.delete(pid);
}

/** Are any registered pids still alive? Uses `kill(pid, 0)` — the
 * same probe `isPidAlive` in serve-state uses (ESRCH → dead, EPERM
 * → alive-but-not-ours-on-POSIX). Returns the live subset. */
export function liveRegisteredDaemons(): number[] {
  const out: number[] = [];
  for (const pid of REGISTERED_PIDS) {
    try {
      process.kill(pid, 0);
      out.push(pid);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM") out.push(pid);
      // ESRCH / other → dead.
    }
  }
  return out;
}
