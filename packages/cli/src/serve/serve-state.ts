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
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
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
  /** Per-start random id, echoed by `GET /-/health` so a subsequent
   * launch can tell whether the port answers as THIS daemon or as a
   * foreign process that happened to reclaim the pid + port. Optional
   * on the wire so an older `serve.json` still parses. */
  readonly instanceId?: string;
}

/** Filename constants. Kept here so a rename lands in one place. */
export const SERVE_STATE_DIR = ".revkit";
export const SERVE_STATE_FILE = "serve.json";

/** Absolute path to `.revkit/serve.json` under `repoRoot`. */
export function serveStatePath(repoRoot: string): string {
  return join(repoRoot, SERVE_STATE_DIR, SERVE_STATE_FILE);
}

/** Outcome of `readServeState`. `missing` when the file does not
 * exist; `unparsable` when the file exists but is malformed
 * (truncated, empty, missing fields, not JSON). The caller decides
 * whether to treat unparsable as stale — see `writeServeState`. */
export type ReadOutcome =
  | { kind: "ok"; state: ServeState }
  | { kind: "missing" }
  | { kind: "unparsable"; reason: string };

/** Try to read the current state file. Returns a typed outcome so a
 * caller can distinguish "no file" from "file present but broken";
 * the previous `throw on parse error` behaviour blocked every restart
 * after a crash that left a truncated file behind, and turned into a
 * bare `JSON Parse error` on the console. */
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

/** Back-compat wrapper for callers that only want the parsed state and
 * `undefined` for either "missing" or "unparsable". Preserved so a
 * test / caller that predates `readServeStateVerbose` still works;
 * new code should use the verbose form for stale-detection paths. */
export function readServeState(repoRoot: string): ServeState | undefined {
  const outcome = readServeStateVerbose(repoRoot);
  return outcome.kind === "ok" ? outcome.state : undefined;
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

/** Options for `writeServeState`. `probeDaemon` is an escape hatch a
 * caller injects to distinguish a reused pid (another program that
 * happened to reclaim the number, or a live daemon whose port fell
 * over) from a real live daemon that still owns `serve.json`. Return
 * `"revkit"` when the port answers as our daemon and `"other"` when
 * the port answers something else or nothing at all. Default: assume
 * a live pid IS a live daemon (conservative — refuse the second
 * start). */
export interface WriteServeStateOptions {
  readonly probeDaemon?: (state: ServeState) => Promise<"revkit" | "other">;
}

/** Try to write the state atomically at mode 600. Refuses if a live
 * daemon already owns the file (`already-running`). Replaces a stale
 * file (dead pid, empty, truncated, unparsable, or a live pid whose
 * port does not respond as our daemon) without asking.
 *
 * **Atomicity via link().** A temp file is created at mode 0600,
 * fsync'd, then `linkSync` moved to the final name. `link` fails
 * with EEXIST if the final name already exists, giving the same
 * mutual exclusion as O_EXCL create, and the temp file is fully
 * written before it ever appears at the final name. This closes the
 * round-2 nit: a crash between `openSync(..., "wx")` and `writeSync`
 * used to leave an empty `serve.json` behind and block every
 * restart with a bare `JSON Parse error`. With link(), the final
 * name only ever holds a fully-written record.
 *
 * **Stale detection.** An existing file is stale when:
 *   1. its pid is dead;
 *   2. its content is empty / truncated / unparsable AND
 *      `probeDaemon` confirms the recorded port does not answer as
 *      our daemon (defence against a truncated file left behind by
 *      a live daemon: refuse rather than steal);
 *   3. its pid is alive but `probeDaemon` returns `"other"` (a
 *      reused pid, or a wedged daemon whose HTTP surface is down).
 * A stale file is unlinked and the link retry succeeds; a live one
 * refuses the second start. */
export async function writeServeState(
  repoRoot: string,
  state: ServeState,
  options: WriteServeStateOptions = {},
): Promise<{ ok: true } | { ok: false; refused: WriteRefused }> {
  const path = serveStatePath(repoRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirname(path), 0o700);
  } catch {
    // Not fatal — a caller-supplied dir may not be chmod-able.
  }

  const linkWithTemp = (): { ok: true } | { ok: false; code: string } => {
    const tmpSuffix = randomBytes(6).toString("hex");
    const tmpPath = `${path}.${tmpSuffix}.tmp`;
    let fd: number;
    try {
      fd = openSync(tmpPath, "wx", 0o600);
    } catch (error) {
      // A duplicate suffix is astronomically unlikely (48 random
      // bits); still surface it cleanly.
      return { ok: false, code: (error as NodeJS.ErrnoException).code ?? "TMP_OPEN" };
    }
    try {
      const payload = JSON.stringify(state, null, 2) + "\n";
      writeSync(fd, payload);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Force 0o600 in case the umask clamped the create mode.
    chmodSync(tmpPath, 0o600);
    try {
      linkSync(tmpPath, path);
    } catch (error) {
      // Clean up the tmp file whether the link succeeded or not.
      try { unlinkSync(tmpPath); } catch { /* already unlinked */ }
      return { ok: false, code: (error as NodeJS.ErrnoException).code ?? "LINK" };
    }
    // Link succeeded — the tmp file's ID is now at two paths; unlink
    // the tmp path so we do not leak.
    try { unlinkSync(tmpPath); } catch { /* fine */ }
    return { ok: true };
  };

  const firstAttempt = linkWithTemp();
  if (firstAttempt.ok) return { ok: true };
  if (firstAttempt.code !== "EEXIST") {
    throw new Error(`writeServeState: unexpected error creating ${path}: ${firstAttempt.code}`);
  }

  // File exists — decide whose.
  const outcome = readServeStateVerbose(repoRoot);
  if (outcome.kind === "ok") {
    const existing = outcome.state;
    const pidAlive = existing.pid !== state.pid && isPidAlive(existing.pid);
    if (pidAlive) {
      // A live pid could be a real daemon or a reclaimed pid. Ask
      // the probe: does the recorded port answer as ours? If yes,
      // refuse. If it answers as something else (or not at all),
      // treat as stale.
      const probe = options.probeDaemon;
      if (probe === undefined) return { ok: false, refused: { kind: "already-running", state: existing } };
      let probeResult: "revkit" | "other";
      try {
        probeResult = await probe(existing);
      } catch {
        // A probe that throws is inconclusive — treat as live
        // (conservative refuse).
        return { ok: false, refused: { kind: "already-running", state: existing } };
      }
      if (probeResult === "revkit") {
        return { ok: false, refused: { kind: "already-running", state: existing } };
      }
      // Reused-pid or wedged daemon — treat as stale.
    }
    // Stale (dead pid or reused pid). Fall through to the unlink +
    // retry path below.
  } else if (outcome.kind === "unparsable") {
    // A truncated / empty / non-JSON file. If the recorded port on
    // disk can't be trusted, fall back on "if we cannot read it,
    // treat as stale". A concurrent live daemon that wrote such a
    // file did so between open and write of THIS PR's O_EXCL path
    // — which we replaced with link(); the new path never leaves
    // that shape. Unparsable → stale.
    // (`outcome.reason` is included in the removal log the daemon
    // emits above via writeServeState's return value.)
  }

  // Stale (or a leftover from our own crashed prior run). Unlink and
  // retry the link ONCE — if another racing daemon beats us to it,
  // we report them as already-running.
  try {
    unlinkSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
  const secondAttempt = linkWithTemp();
  if (secondAttempt.ok) return { ok: true };
  if (secondAttempt.code !== "EEXIST") {
    throw new Error(`writeServeState: unexpected error creating ${path}: ${secondAttempt.code}`);
  }
  const raced = readServeState(repoRoot);
  return {
    ok: false,
    refused: {
      kind: "already-running",
      state: raced ?? {
        pid: -1,
        port: 0,
        url: "",
        agentToken: "",
        startedAt: "",
        version: "",
      },
    },
  };
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
