// `.revkit/serve.json` — advertisement only (round 3, PR #36).
//
// The daemon's identity and mutual-exclusion guarantee live in
// `.revkit/daemon.lock` — an OS-held `flock(2)` LOCK_EX held for the
// process's lifetime (see `daemon-lock.ts`). `serve.json` is what
// this file is now: a small JSON record advertising the running
// daemon's `port`, `url`, `agentToken`, `startedAt`, `version` and
// per-start `instanceId` for consumers (`revkit mcp`, later, and
// tests) that need to find the daemon.
//
// Fields (`ServeState`):
//   pid        — the daemon's process id (advisory; the lock is what
//                actually mediates single-instance).
//   port       — the loopback port the daemon bound to.
//   url        — `http://127.0.0.1:<port>` for convenience.
//   agentToken — the bearer token the MCP client / channel presents
//                on `/api/*` and `/events?for=agent`.
//   startedAt  — ISO-8601 with offset (start-of-serve timestamp).
//   version    — the daemon's own version string (revkit `VERSION`).
//   instanceId — per-start opaque random id. Round-3 removeServeState
//                refuses to delete the file unless its recorded
//                `instanceId` matches ours, so daemon A's shutdown
//                cannot delete daemon B's file after a stale-file
//                takeover (the corner case the round-3 review
//                reproduced with SIGSTOP + probe misclassification).
//
// **Mode 600.** The file carries the agent token. Write path:
//   1. `openSync(tmp, "wx", 0o600)` (O_EXCL create at mode 0600)
//   2. writeSync + fsyncSync + closeSync
//   3. `chmodSync(tmp, 0o600)` (in case the umask clamped the mode)
//   4. `renameSync(tmp, final)` — atomic rename within the same
//      directory. Any consumer that opens `serve.json` either sees
//      the old fully-written file or the new fully-written file,
//      never a partial write.
//
// A restart that finds an existing `serve.json` treats it as stale
// whenever the daemon-lock is free (or its content is unparsable /
// missing fields) — the lock is the source of truth, so no port
// probe / pid check is needed.

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { acquireDaemonLock } from "./daemon-lock.ts";

/** The wire shape of `.revkit/serve.json`. */
export interface ServeState {
  readonly pid: number;
  readonly port: number;
  readonly url: string;
  readonly agentToken: string;
  readonly startedAt: string;
  readonly version: string;
  /** Per-start opaque id echoed by `GET /-/health` and required by
   * `removeServeState` for the ownership check. Optional on the
   * wire so an older `serve.json` still parses; when missing,
   * `removeServeState` refuses to delete (a file without an
   * instanceId cannot be proved ours). */
  readonly instanceId?: string;
}

/** Filename constants. Kept here so a rename lands in one place. */
export const SERVE_STATE_DIR = ".revkit";
export const SERVE_STATE_FILE = "serve.json";
export const DAEMON_LOCK_FILE = "daemon.lock";

/** Absolute path to `.revkit/serve.json` under `repoRoot`. */
export function serveStatePath(repoRoot: string): string {
  return join(repoRoot, SERVE_STATE_DIR, SERVE_STATE_FILE);
}

/** Absolute path to `.revkit/daemon.lock` under `repoRoot`. */
export function daemonLockPath(repoRoot: string): string {
  return join(repoRoot, SERVE_STATE_DIR, DAEMON_LOCK_FILE);
}

/** Outcome of `readServeStateVerbose`. `missing` when the file
 * does not exist; `unparsable` when the file exists but is malformed
 * (truncated, empty, missing fields, not JSON). */
export type ReadOutcome =
  | { kind: "ok"; state: ServeState }
  | { kind: "missing" }
  | { kind: "unparsable"; reason: string };

/** Read the state file and return a typed outcome. */
export function readServeStateVerbose(repoRoot: string): ReadOutcome {
  const path = serveStatePath(repoRoot);
  if (!existsSync(path)) return { kind: "missing" };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return { kind: "unparsable", reason: `serve-state: could not read ${path}: ${(error as Error).message}` };
  }
  if (text.length === 0) {
    return { kind: "unparsable", reason: `serve-state: ${path} is empty.` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { kind: "unparsable", reason: `serve-state: ${path} is not valid JSON (${(error as Error).message}).` };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { kind: "unparsable", reason: `serve-state: ${path} is not a JSON object.` };
  }
  const record = parsed as Record<string, unknown>;
  for (const key of ["pid", "port"]) {
    if (typeof record[key] !== "number") {
      return { kind: "unparsable", reason: `serve-state: ${path} missing numeric '${key}'.` };
    }
  }
  for (const key of ["url", "agentToken", "startedAt", "version"]) {
    if (typeof record[key] !== "string") {
      return { kind: "unparsable", reason: `serve-state: ${path} missing string '${key}'.` };
    }
  }
  return {
    kind: "ok",
    state: {
      pid: record.pid as number,
      port: record.port as number,
      url: record.url as string,
      agentToken: record.agentToken as string,
      startedAt: record.startedAt as string,
      version: record.version as string,
      ...(typeof record.instanceId === "string" ? { instanceId: record.instanceId } : {}),
    },
  };
}

/** Convenience wrapper: undefined for either missing or unparsable. */
export function readServeState(repoRoot: string): ServeState | undefined {
  const outcome = readServeStateVerbose(repoRoot);
  return outcome.kind === "ok" ? outcome.state : undefined;
}

/** Reason `writeServeState` refused to write. `state` is the existing
 * live state — the caller may print it (this is a launch-time error,
 * so an "already running" message pointing at the URL is what the
 * user wants). */
export interface WriteRefused {
  readonly kind: "already-running";
  readonly state: ServeState | undefined;
}

/** Write `state` to `.revkit/serve.json` atomically at mode 0600.
 *
 * **Precondition**: the caller MUST hold `.revkit/daemon.lock` via
 * `acquireDaemonLock` (see `daemon-lock.ts`). The lock is the source
 * of truth for single-instance; this function is unconditional
 * because the lock has already excluded any peer.
 *
 * Atomicity: tmp file (O_EXCL create at 0600) → write → fsync →
 * close → chmod 0600 (defence against umask clamping) → rename.
 * Rename is atomic on POSIX within the same directory. Any partial
 * state on a crash lives in the tmp file, which we leave for the
 * next start to notice / ignore. */
export function writeServeState(repoRoot: string, state: ServeState): void {
  const path = serveStatePath(repoRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmpSuffix = randomBytes(6).toString("hex");
  const tmpPath = `${path}.${tmpSuffix}.tmp`;
  const fd = openSync(tmpPath, "wx", 0o600);
  try {
    const payload = JSON.stringify(state, null, 2) + "\n";
    writeSync(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, path);
}

/** Reason a caller tried to start but the lock was already held. */
export interface StaleFileClaim {
  readonly stateFile: ServeState | undefined;
  readonly reason: string;
}

/** Try to acquire the daemon lock and (once acquired) publish
 * `state` to `serve.json`. Returns `{ ok: true, release }` where
 * `release` un-locks + removes the state file (only if it still
 * carries our `instanceId`); returns `{ ok: false, refused }` when
 * another daemon holds the lock, with the existing state advertised
 * on disk (which may be stale — the caller decides).
 *
 * Callers keep the returned `release` alive for the daemon's
 * lifetime. On process exit (including SIGKILL), the OS releases
 * the lock; `serve.json` stays behind and is treated as stale on
 * the next start. */
export interface AcquiredDaemon {
  readonly kind: "ok";
  release(): void;
}
export interface RefusedDaemon {
  readonly kind: "already-running";
  readonly state: ServeState | undefined;
  readonly reason: string;
}

export function acquireAndPublish(repoRoot: string, state: ServeState): AcquiredDaemon | RefusedDaemon {
  const lockPath = daemonLockPath(repoRoot);
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const lock = acquireDaemonLock(lockPath);
  if (lock === null) {
    return {
      kind: "already-running",
      state: readServeState(repoRoot),
      reason: "another revkit daemon holds .revkit/daemon.lock",
    };
  }
  // We have the lock. Any existing `serve.json` is stale (an
  // exited-uncleanly daemon left it behind). Overwrite it.
  writeServeState(repoRoot, state);
  let released = false;
  return {
    kind: "ok",
    release(): void {
      if (released) return;
      released = true;
      // Only remove `serve.json` if it still carries OUR
      // instanceId. A racing daemon could conceivably have taken
      // over during our shutdown; do not delete their advertisement.
      const current = readServeStateVerbose(repoRoot);
      if (
        current.kind === "ok" &&
        current.state.instanceId !== undefined &&
        state.instanceId !== undefined &&
        current.state.instanceId === state.instanceId
      ) {
        try {
          unlinkSync(serveStatePath(repoRoot));
        } catch {
          // Fine if it is already gone.
        }
      }
      lock.release();
    },
  };
}

/** Remove `.revkit/serve.json` unconditionally. Kept for
 * back-compatibility with tests and for shutdown paths that never
 * acquired the lock (a startup abort). Callers that ran through
 * `acquireAndPublish` MUST use its `release()` instead so the
 * ownership check applies. */
export function removeServeState(repoRoot: string): void {
  const path = serveStatePath(repoRoot);
  try {
    unlinkSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    throw error;
  }
}

/** Consumer helper: find a running daemon by checking the lock. If
 * the lock is free, the state file — even if it exists — is stale.
 * Kept small so `revkit mcp` and other clients can import one
 * function to answer "is the daemon up, and if so where". */
export function findRunningDaemon(repoRoot: string): ServeState | undefined {
  const lockPath = daemonLockPath(repoRoot);
  if (!existsSync(lockPath)) return undefined;
  // Probe: can we acquire the lock? If yes, no daemon owns it —
  // release immediately and report undefined (any serve.json is
  // stale). If no (SQLITE_BUSY-shape / null), a daemon owns it.
  const attempt = acquireDaemonLock(lockPath);
  if (attempt !== null) {
    attempt.release();
    return undefined;
  }
  // Lock is held by someone. Return the advertisement.
  return readServeState(repoRoot);
}
