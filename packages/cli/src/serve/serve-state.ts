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
//
// `.revkit/repo-id` follows the same write path through the shared
// `writeSecretAtomic` helper, and is minted while the daemon lock is
// HELD (see `acquireAndPublish` / `readOrMintRepoId`, issue #63).

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
  writeFileSync,
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
  /** Lifecycle marker (#251):
   *  - `"starting"` — the daemon holds `.revkit/daemon.lock` and is
   *    doing pre-bind work (e.g. the cold-start auto-build in
   *    `serve/cli.ts`). `url`/`agentToken`/`port` are placeholders
   *    (empty strings / 0) because the HTTP server has not bound yet.
   *  - `"ready"` (or absent, for backwards compat) — the HTTP server
   *    is bound and the connection fields are meaningful.
   *
   * A second `ensureDaemon` seeing `"starting"` MUST wait for the
   * transition to `"ready"` instead of spawning another daemon;
   * see `findRunningOrStartingDaemon` and `mcp/daemon-bootstrap.ts`. */
  readonly status?: "starting" | "ready";
}

/** Filename constants. Kept here so a rename lands in one place. */
export const SERVE_STATE_DIR = ".revkit";
export const SERVE_STATE_FILE = "serve.json";
export const DAEMON_LOCK_FILE = "daemon.lock";
/** `.revkit/repo-id` — a persistent random tag advertised by
 * `GET /-/health` (as `repoId`) so the rail's per-viewer "seen"
 * localStorage bucket is keyed to THIS repo, stable across daemon
 * restarts (issue #60 PR #62 round-3 review: the pre-fix
 * `instanceId` keying wiped seen marks on every restart of a
 * fixed `--port` daemon). Random — never derived from the repo
 * path — so an unauthenticated `/-/health` cannot fingerprint the
 * caller's filesystem layout. Mode 0600 like every other secret
 * under `.revkit/`. */
export const REPO_ID_FILE = "repo-id";

/** Ensure `.revkit/` exists under `repoRoot` at mode 0700 — the one
 * owner for that directory's create + mode, so a caller that
 * accidentally does its own `mkdirSync` without a mode does not
 * end up with a 0755 tree that leaks the sqlite / cookie files.
 * Idempotent; safe to call from multiple entry points (`revkit
 * serve`, `readOrMintLocalUserId`, tests). */
export function ensureRevkitDir(repoRoot: string): string {
  const dir = join(repoRoot, SERVE_STATE_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // `mkdir` with a mode does not downgrade an existing dir's mode.
  // Force 0700 on the created / existing dir — the tests spawn the
  // real CLI in a fresh temp repo, so this call is the one that
  // matters for the mode-observation test.
  try {
    chmodSync(dir, 0o700);
  } catch {
    // A caller-supplied dir may be a symlink chain we cannot
    // chmod; not fatal.
  }
  return dir;
}

/** Absolute path to `.revkit/serve.json` under `repoRoot`. */
export function serveStatePath(repoRoot: string): string {
  return join(repoRoot, SERVE_STATE_DIR, SERVE_STATE_FILE);
}

/** Write `payload` to `path` atomically at mode 0600 — the ONE
 * publish path for a secret-bearing file under `.revkit/`.
 *
 * 1. `openSync(tmp, "wx", 0o600)` — O_EXCL create at mode 0600, so
 *    the temp name can never collide with a live file and can never
 *    be followed by a symlink planted in `.revkit/`.
 * 2. write → `fsync` → close.
 * 3. `chmodSync(tmp, 0o600)` — defence against a umask that clamped
 *    the create mode.
 * 4. `renameSync(tmp, path)` — atomic within the same directory, so
 *    a reader of `path` sees either the previous file or the new
 *    one. Never a truncated payload (issue #63: `repo-id` used to be
 *    written in place).
 *
 * A crash between steps 2 and 4 leaves the temp file behind. It is
 * named apart from `path`, so no reader ever sees it, and the next
 * write ignores it. */
function writeSecretAtomic(path: string, payload: string): void {
  const tmpSuffix = randomBytes(6).toString("hex");
  const tmpPath = `${path}.${tmpSuffix}.tmp`;
  const fd = openSync(tmpPath, "wx", 0o600);
  try {
    writeSync(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, path);
}

/** Absolute path to `.revkit/repo-id` under `repoRoot`. */
export function repoIdPath(repoRoot: string): string {
  return join(repoRoot, SERVE_STATE_DIR, REPO_ID_FILE);
}

/** Read `.revkit/repo-id` and return it when the payload is a
 * well-formed tag, else `undefined` (absent, unreadable, truncated,
 * or otherwise not the shape this module writes). One read, no
 * `existsSync` pre-check — the pre-check was a second syscall AND a
 * TOCTOU window between "is it there?" and "read it". */
function readRepoIdFile(path: string): string | undefined {
  try {
    const raw = readFileSync(path, "utf8").trim();
    // Guard against a truncated / empty file — treat as absent.
    if (/^[A-Za-z0-9_-]{16,64}$/.test(raw)) return raw;
  } catch {
    // Absent or unreadable — the caller mints.
  }
  return undefined;
}

/** Read `.revkit/repo-id`, or mint one on first run. The value is a
 * 24-char base64url token (144 bits of entropy — a long-form random
 * tag, never derived from the repo path, so `GET /-/health` cannot
 * leak filesystem layout). Idempotent; stable across daemon
 * restarts, so the rail's `revkit.rail.seen.v1.<repoId>`
 * localStorage bucket survives a `revkit serve` restart on the same
 * `--port`. Round-3 review, issue #60.
 *
 * **Atomic (issue #63).** The write goes through a 0600 temp file
 * plus `rename(2)` — the same shape `writeServeState` uses — so a
 * concurrent reader sees either the previous file or the new one,
 * never a truncated payload. The pre-fix `writeFileSync(path)` was
 * an in-place O_TRUNC + write.
 *
 * **Callers must hold `.revkit/daemon.lock`** (via
 * `acquireAndPublish`, the only production caller). Minting is a
 * check-then-write, so two starts overlapping that window would each
 * mint a different id and each write it; the lock then elects one
 * winner while the file is left holding the loser's id — the winner
 * advertises an id that is not on disk, and the next restart reads a
 * third one and resets the reviewer's ack state. Under the lock the
 * winner is the only writer. */
export function readOrMintRepoId(repoRoot: string): string {
  const path = repoIdPath(repoRoot);
  const existing = readRepoIdFile(path);
  if (existing !== undefined) return existing;
  ensureRevkitDir(repoRoot);
  const id = randomBytes(18).toString("base64url");
  writeSecretAtomic(path, id + "\n");
  return id;
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
  const status =
    record.status === "starting" || record.status === "ready" ? record.status : undefined;
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
      ...(status !== undefined ? { status } : {}),
    },
  };
}

/** True when `state` advertises a bound HTTP server (`status === "ready"`,
 * or `status` absent for backwards compat). A `"starting"` state is NOT
 * ready — its `url`/`agentToken`/`port` are placeholders (#251). */
export function isReadyServeState(state: ServeState): boolean {
  return state.status !== "starting";
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
 * See `writeSecretAtomic`, which is the shared implementation. */
export function writeServeState(repoRoot: string, state: ServeState): void {
  ensureRevkitDir(repoRoot);
  writeSecretAtomic(serveStatePath(repoRoot), JSON.stringify(state, null, 2) + "\n");
}

/** Reason a caller tried to start but the lock was already held. */
export interface StaleFileClaim {
  readonly stateFile: ServeState | undefined;
  readonly reason: string;
}

/** Try to acquire the daemon lock and (once acquired) publish
 * `state` to `serve.json`. Returns `{ ok: true, repoId, release }`
 * where `release` un-locks + removes the state file (only if it
 * still carries our `instanceId`); returns `{ ok: false, refused }`
 * when another daemon holds the lock, with the existing state
 * advertised on disk (which may be stale — the caller decides).
 *
 * `repoId` is read (or minted) INSIDE the lock (issue #63): the
 * pre-fix call order minted it from `revkit serve` before the lock
 * was attempted, so two overlapping starts could each mint and write
 * a different id while the lock elected one winner. Under the lock
 * exactly one process ever writes it, which is what makes the id on
 * disk and the id the winner advertises on `/-/health` the same
 * value — and therefore what keeps the rail's per-repo seen bucket
 * stable across a restart.
 *
 * Callers keep the returned `release` alive for the daemon's
 * lifetime. On process exit (including SIGKILL), the OS releases
 * the lock; `serve.json` stays behind and is treated as stale on
 * the next start. */
export interface AcquiredDaemon {
  readonly kind: "ok";
  /** The repo's persistent id, read-or-minted while we held the
   * lock. The daemon serves this on `/-/health`. */
  readonly repoId: string;
  release(): void;
}
export interface RefusedDaemon {
  readonly kind: "already-running";
  readonly state: ServeState | undefined;
  readonly reason: string;
}

/** Initial record identifying a starting daemon. The caller supplies
 * these before bind; `publishReady` later swaps in the bound state. */
export interface AcquiredStartingInit {
  readonly pid: number;
  readonly version: string;
  readonly startedAt: string;
  readonly instanceId: string;
}

/** Acquired daemon-lock PRE-bind (#251). The caller (serve/cli.ts)
 * takes this BEFORE the cold-start auto-build so a concurrent
 * `revkit serve` is refused immediately and a concurrent
 * `ensureDaemon` sees a "starting" state and waits on readiness
 * instead of spawning another daemon. `publishReady(state)` must be
 * called once the HTTP server has bound, before the daemon begins
 * answering requests. `release()` is idempotent and does the
 * ownership-checked unlink of `serve.json` plus drops the OS lock.
 *
 * `lockFd` is the OS file descriptor of the flock. The caller passes
 * it to `Bun.spawn` (via `stdio: [..., ..., ..., lockFd]` or by
 * leaving it inheritable and letting POSIX inherit it) so a child
 * process keeps the flock alive if the parent is SIGKILLed mid-build
 * (#251 B1). */
export interface AcquiredStartingDaemon {
  readonly kind: "ok";
  readonly repoId: string;
  readonly lockFd: number;
  publishReady(state: ServeState): void;
  release(): void;
}

/** Acquire `.revkit/daemon.lock` and publish a "starting" record to
 * `serve.json`. Returns a handle the caller uses to publish the
 * bound state later and release on shutdown.
 *
 * Writes a ServeState with `status: "starting"`, `pid` / `version` /
 * `startedAt` / `instanceId` set, and placeholders in `url` (empty
 * string), `agentToken` (empty string) and `port` (0). Consumers
 * that see this record wait for the "ready" transition — the
 * placeholders are chosen so a legacy consumer that forgets to
 * check `status` fails fast (HTTP to an empty URL) rather than
 * silently talking to a half-born daemon. */
export function acquireStartingLock(
  repoRoot: string,
  init: AcquiredStartingInit,
): AcquiredStartingDaemon | RefusedDaemon {
  ensureRevkitDir(repoRoot);
  const lockPath = daemonLockPath(repoRoot);
  // #251 B1: open the lock fd WITHOUT O_CLOEXEC so it is inherited
  // by the astro child the cold-start auto-build spawns. On a SIGKILL
  // of the parent `revkit serve` the child keeps the fd open and the
  // flock stays held — a second `revkit serve` is refused immediately
  // and cannot race into the same `.revkit/dist`. The child does not
  // need to know about the fd; the kernel tracks the flock on the
  // inode as long as any process has it open.
  const lock = acquireDaemonLock(lockPath, { inheritable: true });
  if (lock === null) {
    // Deliberately does NOT read `.revkit/repo-id` (issue #63
    // review nit). See `acquireAndPublish` for the rationale.
    return {
      kind: "already-running",
      state: readServeState(repoRoot),
      reason: "another revkit daemon holds .revkit/daemon.lock",
    };
  }
  // We have the lock, so we are the only writer for the life of the
  // daemon. Read-or-mint the repo id under the lock (issue #63).
  const repoId = readOrMintRepoId(repoRoot);
  const startingState: ServeState = {
    pid: init.pid,
    port: 0,
    url: "",
    agentToken: "",
    startedAt: init.startedAt,
    version: init.version,
    instanceId: init.instanceId,
    status: "starting",
  };
  writeServeState(repoRoot, startingState);
  let released = false;
  // Track the most recently published state so `release()` can do
  // the ownership check against whichever record we actually own
  // right now (starting first, ready afterwards).
  let ownedState: ServeState = startingState;
  return {
    kind: "ok",
    repoId,
    lockFd: lock.fd,
    publishReady(state: ServeState): void {
      if (released) {
        throw new Error("acquireStartingLock: publishReady called after release");
      }
      // The caller composes the final state (with the bound port,
      // agent token, url). We enforce `status: "ready"` and the
      // same `instanceId` we started under so the lifecycle is
      // one coherent story on disk.
      const readyState: ServeState = {
        ...state,
        instanceId: init.instanceId,
        status: "ready",
      };
      writeServeState(repoRoot, readyState);
      ownedState = readyState;
    },
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
        ownedState.instanceId !== undefined &&
        current.state.instanceId === ownedState.instanceId
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

export function acquireAndPublish(repoRoot: string, state: ServeState): AcquiredDaemon | RefusedDaemon {
  ensureRevkitDir(repoRoot);
  const lockPath = daemonLockPath(repoRoot);
  const lock = acquireDaemonLock(lockPath);
  if (lock === null) {
    // Deliberately does NOT read `.revkit/repo-id` (issue #63
    // review nit). See `acquireStartingLock` for the rationale.
    return {
      kind: "already-running",
      state: readServeState(repoRoot),
      reason: "another revkit daemon holds .revkit/daemon.lock",
    };
  }
  // We have the lock. Mint the repo id under the lock (#63) and
  // publish ONCE — this is the fast path for callers that need no
  // pre-bind window (every pre-#251 caller, the Playwright
  // `bootDaemon` helpers in `site/tests` that read `serve.json`
  // directly and expect ready-state fields). Two atomic writes
  // back-to-back would otherwise expose a "starting" record on disk
  // for one scheduler tick — enough time for a concurrent reader to
  // see empty `url`/`agentToken`. See #251.
  const repoId = readOrMintRepoId(repoRoot);
  writeServeState(repoRoot, state);
  let released = false;
  return {
    kind: "ok",
    repoId,
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

/** Consumer helper: find a READY daemon by checking the lock. If
 * the lock is free, the state file — even if it exists — is stale;
 * if it is held but the state is `"starting"` (#251 pre-bind window),
 * this helper returns `undefined` so legacy callers (`revkit events`,
 * `revkit open`, `revkit hook`) that would blindly fetch from the
 * advertised URL get a clean "no daemon" result rather than a
 * placeholder empty URL. Clients that need to WAIT for a starting
 * daemon call `findRunningOrStartingDaemon` instead
 * (`mcp/daemon-bootstrap.ts`).
 *
 * **Race note (acceptable).** `findRunningDaemon` and a starting
 * daemon can race: the caller's `acquireDaemonLock` probe succeeds
 * (lock is free), the caller releases; a `revkit serve` then
 * acquires the lock and writes `serve.json`; the caller returns
 * `undefined`. The consumer's next call sees the running daemon.
 * The alternative — a lock the caller holds while reading state —
 * would block a new daemon from starting whenever `revkit mcp`
 * probes, which is the wrong trade. `revkit mcp` retries on
 * `undefined`, so the race window is a single extra probe. */
export function findRunningDaemon(repoRoot: string): ServeState | undefined {
  const state = findRunningOrStartingDaemon(repoRoot);
  if (state === undefined) return undefined;
  return isReadyServeState(state) ? state : undefined;
}

/** Variant of `findRunningDaemon` that ALSO returns a daemon whose
 * `status` is `"starting"` (the pre-bind window during a cold-start
 * auto-build, #251). The caller must guard on `state.status` and
 * either wait for the transition to `"ready"` or treat the lock
 * holder as "a daemon is starting; don't spawn another" — see
 * `mcp/daemon-bootstrap.ts`. */
export function findRunningOrStartingDaemon(repoRoot: string): ServeState | undefined {
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
  // Lock is held by someone. Return the advertisement (ready OR
  // starting; the caller decides).
  return readServeState(repoRoot);
}

// ── #251 N1: persisted last-start failure ────────────────────────
//
// `revkit mcp` spawns `revkit serve` detached with ignored stdio,
// so a build-time failure in the spawned serve never reaches the
// MCP caller. Each MCP tool call would then re-spawn serve, which
// would fail the same way, which the caller would see as an
// unexplained "died while starting" on every retry.
//
// Fix (#251 N1): `revkit serve` writes a small failure record to
// `.revkit/start-failed.json` when its auto-build or startDaemon
// fails, and clears it on a successful start. `ensureDaemon` reads
// the record BEFORE spawning: if one exists whose inputs match the
// current state (`.revkit/dist` still missing), it surfaces the
// recorded error instead of re-spawning. A manual `revkit build` or
// a successful `revkit serve` clears the record.

/** Shape written to `.revkit/start-failed.json` (#251 N1). */
export interface StartFailureRecord {
  /** One-line summary of what failed (`build-failed`, `start-failed`). */
  readonly stage: "build-failed" | "start-failed" | "aborted";
  /** The error message (user-facing). */
  readonly message: string;
  /** Last ~4 KiB of the spawned child's stderr, when available. */
  readonly stderrTail?: string;
  /** ISO-8601 timestamp of the failure. */
  readonly failedAt: string;
  /** The daemon version that recorded this failure. */
  readonly version: string;
  /** Snapshot of the inputs that failed. A caller can compare with
   * the current state to decide whether a respawn is warranted. */
  readonly inputs: {
    /** Did `.revkit/dist` exist at the time of failure? When false,
     * the respawn-suppression stays in force as long as dist is
     * still missing; `revkit build` creating dist changes the
     * inputs and lifts suppression. */
    readonly distExists: boolean;
  };
}

/** Absolute path to `.revkit/start-failed.json` under `repoRoot`. */
export function startFailurePath(repoRoot: string): string {
  return join(repoRoot, SERVE_STATE_DIR, "start-failed.json");
}

/** Write `.revkit/start-failed.json` atomically at mode 0600.
 * Callers: `revkit serve` on a non-zero-exit auto-build or a
 * failed `startDaemon`. Never carries secrets (the daemon has not
 * minted its agent token yet at this point). */
export function writeStartFailure(repoRoot: string, record: StartFailureRecord): void {
  ensureRevkitDir(repoRoot);
  writeSecretAtomic(startFailurePath(repoRoot), JSON.stringify(record, null, 2) + "\n");
}

/** Read `.revkit/start-failed.json`. Returns `undefined` when the
 * file is absent, unreadable, unparsable, or carries a shape this
 * module does not recognise. Fail-closed — a malformed record never
 * blocks a spawn. */
export function readStartFailure(repoRoot: string): StartFailureRecord | undefined {
  const path = startFailurePath(repoRoot);
  if (!existsSync(path)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  const stage = record.stage;
  if (stage !== "build-failed" && stage !== "start-failed" && stage !== "aborted") {
    return undefined;
  }
  if (typeof record.message !== "string") return undefined;
  if (typeof record.failedAt !== "string") return undefined;
  if (typeof record.version !== "string") return undefined;
  const inputs = record.inputs as Record<string, unknown> | undefined;
  if (inputs === undefined || typeof inputs.distExists !== "boolean") return undefined;
  return {
    stage,
    message: record.message,
    ...(typeof record.stderrTail === "string" ? { stderrTail: record.stderrTail } : {}),
    failedAt: record.failedAt,
    version: record.version,
    inputs: { distExists: inputs.distExists },
  };
}

/** Delete `.revkit/start-failed.json`. Callers: `revkit serve` after
 * a successful bind, and `ensureDaemon` when it decides the inputs
 * have changed (the user ran `revkit build`, so dist exists now).
 * Silent on `ENOENT`. */
export function clearStartFailure(repoRoot: string): void {
  try {
    unlinkSync(startFailurePath(repoRoot));
  } catch {
    // Fine if already gone.
  }
}
