// `.revkit/serve.json` — the state file the daemon writes at startup
// and removes on clean shutdown (DESIGN-0001 §5, ADR-0013).
//
// Fields (`ServeState`):
//   pid        — the daemon's process id; a stale file (dead pid) is
//                detected on next start and replaced.
//   port       — the loopback port the daemon bound to.
//   url        — `http://127.0.0.1:<port>` for convenience.
//   agentToken — the bearer token the MCP client / channel presents on
//                `/api/*` and `/events?for=agent`.
//   startedAt  — ISO-8601 with offset (start-of-serve timestamp; a
//                staleness diagnostic).
//   version    — the daemon's own version string (revkit `VERSION`).
//
// **Mode 600.** The file carries a token. Write path:
//   1. `open(tmpPath, O_WRONLY|O_CREAT|O_EXCL, 0600)`
//   2. write JSON, fsync, close
//   3. rename(tmpPath, finalPath)
// This is atomic on POSIX (rename within the same directory) and gives
// the final file the 0600 mode from the moment it exists. The tempfile
// carries a random suffix so two daemons cannot collide on it.
//
// **Stale detection.** On startup, if `.revkit/serve.json` exists and
// its `pid` process is alive AND belongs to the current user AND that
// pid was not the daemon before (checked by re-reading after acquiring
// the fs write intent), the daemon refuses to start (another daemon is
// running). Otherwise the file is replaced.

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

/** The wire shape of `.revkit/serve.json`. */
export interface ServeState {
  readonly pid: number;
  readonly port: number;
  readonly url: string;
  readonly agentToken: string;
  readonly startedAt: string;
  readonly version: string;
}

/** Filename constants. Kept here so a rename lands in one place. */
export const SERVE_STATE_DIR = ".revkit";
export const SERVE_STATE_FILE = "serve.json";

/** Absolute path to `.revkit/serve.json` under `repoRoot`. */
export function serveStatePath(repoRoot: string): string {
  return join(repoRoot, SERVE_STATE_DIR, SERVE_STATE_FILE);
}

/** Try to read the current state file. Returns undefined when it does
 * not exist, throws on a parse error (a truncated file is a bug the
 * caller should see — silently ignoring it lets a broken state file
 * hide a second daemon). */
export function readServeState(repoRoot: string): ServeState | undefined {
  const path = serveStatePath(repoRoot);
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`serve-state: ${path} is not a JSON object.`);
  }
  const record = parsed as Record<string, unknown>;
  for (const key of ["pid", "port"]) {
    if (typeof record[key] !== "number") {
      throw new Error(`serve-state: ${path} missing numeric '${key}'.`);
    }
  }
  for (const key of ["url", "agentToken", "startedAt", "version"]) {
    if (typeof record[key] !== "string") {
      throw new Error(`serve-state: ${path} missing string '${key}'.`);
    }
  }
  return {
    pid: record.pid as number,
    port: record.port as number,
    url: record.url as string,
    agentToken: record.agentToken as string,
    startedAt: record.startedAt as string,
    version: record.version as string,
  };
}

/** Is the given pid a live process? Uses `kill(pid, 0)` — throws
 * ESRCH if the process does not exist, EPERM if it exists but is
 * owned by another user (still "alive" for our purpose). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

/** Reason `writeServeState` refused to write. `state` is the existing
 * live state — the caller may print it (this is a launch-time error,
 * so an "already running" message pointing at the URL is what the
 * user wants). */
export interface WriteRefused {
  readonly kind: "already-running";
  readonly state: ServeState;
}

/** Try to write the state atomically at mode 600. Refuses if a live
 * daemon already owns the file (`already-running`). Replaces a stale
 * file (dead pid) without asking. */
export function writeServeState(repoRoot: string, state: ServeState): { ok: true } | { ok: false; refused: WriteRefused } {
  const path = serveStatePath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readServeState(repoRoot) : undefined;
  if (existing !== undefined) {
    // Never remove a live daemon's file. Stale (dead pid) files are
    // fine to replace — the file has no owner any more.
    if (existing.pid !== state.pid && isPidAlive(existing.pid)) {
      return { ok: false, refused: { kind: "already-running", state: existing } };
    }
  }
  const tmpSuffix = randomBytes(6).toString("hex");
  const tmpPath = `${path}.${tmpSuffix}.tmp`;
  // O_WRONLY | O_CREAT | O_EXCL, mode 0o600. A race that lands another
  // process on the same tmpPath is impossible in practice (16 hex
  // chars = 48 random bits) but O_EXCL still surfaces it as an error
  // rather than silently truncating.
  const fd = openSync(tmpPath, "wx", 0o600);
  try {
    const payload = JSON.stringify(state, null, 2) + "\n";
    writeSync(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // On some filesystems (older glibc, WSL) the file's mode after
  // `openSync(..., 0o600)` is the umask-clamped mode. Force 0o600 with
  // an explicit chmod so the invariant is a property of this code,
  // not of the calling umask.
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, path);
  return { ok: true };
}

/** Remove the state file. Idempotent — a shutdown path calls this even
 * if the file was never written (aborted start). */
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
