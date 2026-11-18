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
// **Why `flock(2)`, not `bun:sqlite` in EXCLUSIVE mode.** SQLite in
// EXCLUSIVE mode (`PRAGMA locking_mode=EXCLUSIVE` + `BEGIN EXCLUSIVE`)
// does deliver the same fcntl-family cross-process refusal on this
// host — the round-4 reviewer confirmed a second writer is refused.
// This module picks `flock(2)` because it is one syscall directly
// against a kernel lock, with no dependency on the SQLite driver's
// autocommit rules, journal mode, or WAL-vs-rollback lock semantics.
// One syscall in, one syscall out, kernel-released on exit: the
// mutual-exclusion contract is a property of the kernel primitive
// alone. A future review that wants to swap this for the SQLite
// path can do so — the surface (`acquireDaemonLock`,
// `DaemonLock.release`) does not depend on the mechanism.
//
// Advisory vs. mandatory: `flock(2)` on Linux is advisory. That is
// enough for the daemon's need — only `revkit serve` calls
// `acquireDaemonLock`, so mutual exclusion is between daemon
// instances (which the round-3 blocker asks for). An external tool
// that ignores flock cannot become "another daemon".

import { closeSync, constants, openSync } from "node:fs";

/** LOCK_EX / LOCK_NB / LOCK_UN from `sys/file.h`. Same constants on
 * Linux and macOS (BSD-derived flock lives on both). */
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

/** `FD_CLOEXEC` for `fcntl(F_SETFD, …)`. */
const FD_CLOEXEC = 1;
const F_SETFD = 2;

/** Lazily-resolved libc bindings. Loaded on the first
 * `acquireDaemonLock` call so that `revkit check` and every other
 * command path never touches `bun:ffi` (round-4 review nit). A test
 * or a runtime that lives without FFI (a browser build of the CLI —
 * hypothetical) sees the module import cost only if it also asks
 * for a daemon lock. */
interface LibcBindings {
  flock(fd: number, op: number): number;
  fcntl(fd: number, cmd: number, arg: number): number;
}
let cachedLibc: LibcBindings | undefined;

function loadLibc(): LibcBindings {
  if (cachedLibc !== undefined) return cachedLibc;
  // Kept behind an inline `require`-style dynamic import so the
  // `bun:ffi` runtime cost is paid only on first lock acquisition.
  const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
  const candidates =
    process.platform === "darwin"
      ? ["libSystem.B.dylib", "libSystem.dylib"]
      : ["libc.so.6", "libc.so"];
  let lastError: unknown = null;
  for (const name of candidates) {
    try {
      const lib = dlopen(name, {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
      cachedLibc = {
        flock: (fd, op) => Number(lib.symbols.flock(fd, op)),
        fcntl: (fd, cmd, arg) => Number(lib.symbols.fcntl(fd, cmd, arg)),
      };
      return cachedLibc;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`daemon-lock: could not load libc (tried ${candidates.join(", ")}): ${String(lastError)}`);
}

/** A held daemon lock. `release()` is idempotent. `fd` is the
 * underlying OS file descriptor — exposed so a caller that wants
 * the lock to outlive this process on SIGKILL can pass the fd to
 * a child via `Bun.spawn`'s `stdio` option (the inherited fd keeps
 * the flock alive while the child lives). */
export interface DaemonLock {
  readonly fd: number;
  release(): void;
}

/** Options for `acquireDaemonLock`. */
export interface AcquireDaemonLockOptions {
  /** When `true`, the lock fd is opened WITHOUT `O_CLOEXEC` so it
   * is inherited by subprocesses the caller spawns. This is what
   * `revkit serve` uses before its cold-start auto-build (#251
   * B1): a SIGKILL of the parent still leaves the astro child
   * holding the fd, so `flock(2)` stays held and a second
   * `revkit serve` cannot slip in to race the same `.revkit/dist`.
   * The child does not need to know about the fd — the kernel
   * keeps the flock alive while any process maps that fd to the
   * underlying inode. Defaults to `false` (the pre-#251 behaviour:
   * CLOEXEC on; the fd is closed at exec of any child). */
  readonly inheritable?: boolean;
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
export function acquireDaemonLock(
  lockPath: string,
  options: AcquireDaemonLockOptions = {},
): DaemonLock | null {
  const libc = loadLibc();
  const inheritable = options.inheritable === true;
  // O_RDWR because `flock` needs a writable fd on some filesystems
  // (specifically NFS with `local_lock=all`, which is a corner case
  // but easy to accommodate — the caller does not care what mode).
  //
  // `O_CLOEXEC` (default) so the lock fd is not inherited by any
  // subprocess the daemon spawns (a child that inherits the fd
  // would keep the lock alive past the daemon's exit, refusing
  // every future start). Node's `fs.constants.O_CLOEXEC` is present
  // on Linux and macOS — when it is missing we fall through to
  // `fcntl(F_SETFD, FD_CLOEXEC)` after the open.
  //
  // `inheritable: true` INVERTS this: we drop O_CLOEXEC and clear
  // FD_CLOEXEC so a `Bun.spawn`-ed child inherits the fd and keeps
  // the flock alive while it lives. `revkit serve` uses this before
  // the cold-start auto-build (#251 B1) so the astro child keeps
  // the lock even if the parent is SIGKILLed mid-build.
  const O_CLOEXEC = (constants as { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
  const openFlags =
    constants.O_RDWR | constants.O_CREAT | (inheritable ? 0 : O_CLOEXEC);
  let fd: number;
  try {
    fd = openSync(lockPath, openFlags, 0o600);
  } catch (error) {
    throw new Error(`daemon-lock: could not open '${lockPath}': ${(error as Error).message}`);
  }
  if (!inheritable && O_CLOEXEC === 0) {
    try {
      libc.fcntl(fd, F_SETFD, FD_CLOEXEC);
    } catch {
      // Not fatal on the daemon-in-foreground case; a spawned
      // child would inherit the lock. Log-worthy on platforms
      // that lack both mechanisms.
    }
  } else if (inheritable) {
    // Defence in depth: even if O_CLOEXEC was 0 (ignored), explicitly
    // clear FD_CLOEXEC so the fd survives exec. On Linux, `openSync`
    // without O_CLOEXEC already leaves FD_CLOEXEC off; this is a
    // no-op there but makes the inheritable contract explicit.
    try {
      libc.fcntl(fd, F_SETFD, 0);
    } catch {
      // Not fatal — the fd stays inheritable through POSIX defaults.
    }
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
    fd,
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
