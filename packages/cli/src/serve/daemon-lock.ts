// OS-held single-daemon lock (round-3 review, PR #36).
//
// The daemon holds a `flock(2)` LOCK_EX on `.revkit/daemon.lock` for
// its entire lifetime. The kernel releases the lock only when the
// process exits (crash, SIGKILL and — critically — even SIGSTOP
// keeps it held), so a second `revkit serve` cannot slip in on the
// stale-detection heuristics the previous rounds used. No probe. No
// pid check. If the second process gets the lock, the first is truly
// gone.
//
// **Why `flock(2)` via FFI, not `bun:sqlite` in EXCLUSIVE mode.**
// The reviewer suggested a dedicated SQLite database with
// `PRAGMA locking_mode=EXCLUSIVE` + `BEGIN EXCLUSIVE`. Probed on Bun
// 1.3.13 on this host: a second connection's WRITE succeeds while
// the first's EXCLUSIVE transaction is open (an identical Python
// holder correctly returns "database is locked" — SQLITE_BUSY — so
// the mechanism does work, but Bun's connection does not hold the
// OS-level lock across statements the way the docs describe). The
// underlying property the reviewer wants is a kernel-held fcntl-
// family lock that survives SIGSTOP; `flock(2)` is that same
// mechanism, called directly, so the same guarantee holds without
// depending on the SQLite driver's autocommit / lock-retention
// behaviour.
//
// Advisory vs. mandatory: `flock(2)` on Linux is advisory. That is
// enough for the daemon's need — only `revkit serve` calls
// `acquireDaemonLock`, so mutual exclusion is between daemon
// instances (which the round-3 blocker asks for). An external tool
// that ignores flock cannot become "another daemon".

import { dlopen, FFIType } from "bun:ffi";
import { closeSync, constants, openSync } from "node:fs";

/** LOCK_EX and LOCK_NB from `sys/file.h`. Same constants on Linux
 * and macOS (BSD-derived flock lives on both). */
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

/** Resolve libc for this platform. Bun's `dlopen` accepts a literal
 * path or a name it will search. */
function loadLibc(): { flock: (fd: number, op: number) => number } {
  const candidates =
    process.platform === "darwin"
      ? ["libSystem.B.dylib", "libSystem.dylib"]
      : ["libc.so.6", "libc.so"];
  let lastError: unknown = null;
  for (const name of candidates) {
    try {
      const lib = dlopen(name, {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
      return {
        flock: (fd, op) => Number(lib.symbols.flock(fd, op)),
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`daemon-lock: could not load libc (tried ${candidates.join(", ")}): ${String(lastError)}`);
}

const libc = loadLibc();

/** A held daemon lock. `release()` is idempotent. */
export interface DaemonLock {
  release(): void;
}

/** Try to acquire an exclusive OS-held lock on `lockPath`. Returns
 * the lock handle on success or `null` when another process already
 * holds it. `lockPath` is `open()`'d at mode 0600 (owner-only).
 *
 * The kernel releases the lock on process exit (any exit — clean
 * or not — because file descriptors are always closed). This means
 * no explicit unlock is needed on crash. `release()` exists so the
 * daemon can hand the lock off deliberately during a graceful
 * shutdown, but leaking the fd through process exit is safe. */
export function acquireDaemonLock(lockPath: string): DaemonLock | null {
  // O_RDWR because `flock` needs a writable fd on some filesystems
  // (specifically NFS with `local_lock=all`, which is a corner case
  // but easy to accommodate — the caller does not care what mode).
  let fd: number;
  try {
    fd = openSync(lockPath, constants.O_RDWR | constants.O_CREAT, 0o600);
  } catch (error) {
    throw new Error(`daemon-lock: could not open '${lockPath}': ${(error as Error).message}`);
  }
  const rc = libc.flock(fd, LOCK_EX | LOCK_NB);
  if (rc !== 0) {
    // Someone else holds the lock. Close our fd (do NOT keep it
    // open — a hanging fd would prevent unlink on shutdown of
    // the other daemon) and report the miss to the caller.
    try {
      closeSync(fd);
    } catch {
      // Not fatal.
    }
    return null;
  }
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      try {
        libc.flock(fd, LOCK_UN);
      } catch {
        // Not fatal — the fd close below releases the lock too.
      }
      try {
        closeSync(fd);
      } catch {
        // Not fatal.
      }
    },
  };
}
