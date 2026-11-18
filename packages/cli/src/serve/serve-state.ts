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
  readdirSync,
  renameSync,
  rmSync,
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
 * The lock is always CLOEXEC: round-3 of #251 reverted the
 * `inheritable: true` fd-inheritance mechanism. SIGKILL safety for
 * the cold build is now provided through output staging — the
 * auto-build writes to a private `.revkit/dist.staging-<pid>-<nonce>`
 * directory that `revkit serve` atomically promotes to
 * `.revkit/dist` only after `check-dist` passes. An orphaned astro
 * from a SIGKILLed serve writes its own staging dir, which is never
 * promoted. */
export interface AcquiredStartingDaemon {
  readonly kind: "ok";
  readonly repoId: string;
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
  // The lock is always CLOEXEC: fd inheritance into the astro child
  // was reverted in #251 round 3 (see `daemon-lock.ts` and
  // `AcquiredStartingDaemon` above). A SIGKILLed serve now releases
  // the lock immediately; the orphaned astro writes only its own
  // staging dir, which `revkit serve` never promotes.
  const lock = acquireDaemonLock(lockPath);
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
// Fix (#251 round 3): `revkit serve` writes a small failure record
// to `.revkit/start-failed.json` ONLY for a genuine build or
// check-dist failure — never for lock contention, a signal/abort,
// or a bind-time race, each of which is transient and would
// otherwise poison every future respawn. The record carries an
// input fingerprint (sha256 over `docs/`, `vocab/`, `plots/` paths/
// sizes/mtimes plus `package.json` — see
// `input-fingerprint.ts`'s `FINGERPRINT_INPUT_ROOTS` /
// `FINGERPRINT_CONFIG_FILES`), and `ensureDaemon` refuses to
// respawn ONLY while the current fingerprint matches the recorded
// one. Any change to the inputs, a successful `revkit build` or
// `revkit check`, or a successful bind clears / invalidates it.
//
// The manual escape (`revkit serve` directly, or `rm
// .revkit/start-failed.json`) is documented in SKILL.md.

/** Shape written to `.revkit/start-failed.json` (#251 N1, round 3).
 *
 * `stage` is EXCLUSIVELY a genuine failure: a non-zero build exit,
 * a `check-dist` refusal of the built output, or a bind-time
 * startDaemon error. A SIGTERM/SIGINT abort, a lock contention
 * ("someone else is already serving"), and any other transient is
 * NOT written — those would otherwise wedge the MCP auto-start
 * forever. */
export interface StartFailureRecord {
  readonly stage: "build-failed" | "start-failed";
  /** The error message (user-facing, bounded). */
  readonly message: string;
  /** Last ~4 KiB of the spawned child's stderr, when available. */
  readonly stderrTail?: string;
  /** ISO-8601 timestamp of the failure. */
  readonly failedAt: string;
  /** The daemon version that recorded this failure. */
  readonly version: string;
  /** Snapshot of the inputs that failed.
   *
   * `fingerprint` is a deterministic hash over the consumer's
   * build inputs at failure time (see `input-fingerprint.ts`).
   * `ensureDaemon` compares this hash with the current fingerprint
   * and respawn-suppresses only while they match. */
  readonly inputs: {
    readonly fingerprint: string;
  };
}

/** Message bound for `StartFailureRecord.message`. A failure message
 * is user-facing and must never include a secret (`revkit serve`
 * never surfaces its agent token into this file), but the shape
 * still bounds it so a pathological stack trace does not blow out
 * the record. 4 KiB matches `stderrTail`. */
export const START_FAILURE_MESSAGE_MAX = 4096;

/** `stderrTail` is also bounded — the 4 KiB tail is what the caller
 * typically grabs; this constant names the enforced ceiling. */
export const START_FAILURE_STDERR_TAIL_MAX = 4096;

/** Absolute path to `.revkit/start-failed.json` under `repoRoot`. */
export function startFailurePath(repoRoot: string): string {
  return join(repoRoot, SERVE_STATE_DIR, "start-failed.json");
}

/** Write `.revkit/start-failed.json` atomically at mode 0600.
 * Callers: `revkit serve` ONLY on a genuine build-failed /
 * check-dist-failed / startDaemon-failed outcome. Never carries
 * secrets (the daemon has not minted its agent token yet at this
 * point). */
export function writeStartFailure(repoRoot: string, record: StartFailureRecord): void {
  ensureRevkitDir(repoRoot);
  // Bound the message and tail so a runaway stack trace cannot
  // blow past the atomic-write ceiling.
  const bounded: StartFailureRecord = {
    stage: record.stage,
    message: record.message.slice(0, START_FAILURE_MESSAGE_MAX),
    ...(record.stderrTail !== undefined
      ? { stderrTail: record.stderrTail.slice(-START_FAILURE_STDERR_TAIL_MAX) }
      : {}),
    failedAt: record.failedAt,
    version: record.version,
    inputs: { fingerprint: record.inputs.fingerprint },
  };
  writeSecretAtomic(startFailurePath(repoRoot), JSON.stringify(bounded, null, 2) + "\n");
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
  if (stage !== "build-failed" && stage !== "start-failed") {
    return undefined;
  }
  if (typeof record.message !== "string") return undefined;
  if (typeof record.failedAt !== "string") return undefined;
  if (typeof record.version !== "string") return undefined;
  const inputs = record.inputs as Record<string, unknown> | undefined;
  if (inputs === undefined || typeof inputs.fingerprint !== "string") return undefined;
  if (inputs.fingerprint.length === 0) return undefined;
  return {
    stage,
    message: record.message,
    ...(typeof record.stderrTail === "string" ? { stderrTail: record.stderrTail } : {}),
    failedAt: record.failedAt,
    version: record.version,
    inputs: { fingerprint: inputs.fingerprint },
  };
}

/** Delete `.revkit/start-failed.json`. Callers: `revkit serve` after
 * a successful bind, `revkit build` / `revkit check` after a
 * successful run, and `ensureDaemon` when it decides the inputs
 * have changed (fingerprint mismatch). Silent on `ENOENT`. */
export function clearStartFailure(repoRoot: string): void {
  try {
    unlinkSync(startFailurePath(repoRoot));
  } catch {
    // Fine if already gone.
  }
}

// ── #251 round 3: staging-dir promotion for the cold auto-build ──
//
// The cold `revkit serve` auto-build writes to a private
// `.revkit/dist.staging-<pid>-<nonce>/` and, only after `check-dist`
// passes, atomically renames it to `.revkit/dist`. If `.revkit/dist`
// already exists at promotion time, serve keeps the existing one
// and removes the staging dir instead (a concurrent winner's output
// is authoritative). An orphaned astro from a SIGKILLed parent
// writes only its own staging dir, which is never promoted; the
// next cold serve removes stale staging dirs whose pid is dead.

/** The prefix for staging dirs under `.revkit/`. A directory under
 * `.revkit/` that starts with this prefix is managed by
 * `revkit serve`'s cold-start build. */
export const DIST_STAGING_PREFIX = "dist.staging-";

/** Build a new staging dir name (not yet created): `dist.staging-
 * <pid>-<base64url nonce>`. The pid identifies the parent so stale
 * detection can check whether the writer is still alive. */
export function newDistStagingName(pid: number, nonce: string): string {
  // The nonce must be filesystem-safe; the caller is expected to pass
  // a base64url-shaped token from `crypto.randomBytes(…).toString(
  // "base64url")`. We defensively strip any character outside that
  // alphabet to keep the format predictable.
  const safeNonce = nonce.replace(/[^A-Za-z0-9_-]/g, "");
  return `${DIST_STAGING_PREFIX}${pid}-${safeNonce}`;
}

/** The regex that `listDistStagingDirs` uses to recognise one of
 * its own staging dirs. Exported for tests. */
export const DIST_STAGING_RE = /^dist\.staging-(\d+)-[A-Za-z0-9_-]+$/;

/** List every `.revkit/dist.staging-*` directory, with the pid
 * parsed out of each name. Silent on a missing `.revkit/`. */
export function listDistStagingDirs(
  repoRoot: string,
): Array<{ readonly name: string; readonly path: string; readonly pid: number }> {
  const revkitDir = join(repoRoot, SERVE_STATE_DIR);
  if (!existsSync(revkitDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(revkitDir);
  } catch {
    return [];
  }
  const out: Array<{ name: string; path: string; pid: number }> = [];
  for (const name of entries) {
    const match = DIST_STAGING_RE.exec(name);
    if (match === null) continue;
    out.push({ name, path: join(revkitDir, name), pid: Number(match[1]) });
  }
  return out;
}

/** Is `pid` alive? `process.kill(pid, 0)` throws `ESRCH` when no
 * process has that id. A permission error (`EPERM`) means a process
 * with that pid EXISTS but is not ours — treat it as alive so we
 * do not accidentally scrub a running daemon's staging dir (bullet
 * 4 of the #251 round-3 brief). */
export function pidIsAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

/** Remove every `.revkit/dist.staging-*` directory whose owner pid
 * is dead. Returns the names of the directories removed. Called by
 * `revkit serve` before it mints its own staging dir, so an
 * orphaned SIGKILLed-serve leftover never grows the tree. */
export function cleanupOrphanedStagingDirs(repoRoot: string): readonly string[] {
  const removed: string[] = [];
  for (const entry of listDistStagingDirs(repoRoot)) {
    if (pidIsAlive(entry.pid)) continue;
    try {
      rmSync(entry.path, { recursive: true, force: true });
      removed.push(entry.name);
    } catch {
      // A permission error or a vanished dir is non-fatal; we only
      // need to be eventually-clean.
    }
  }
  return removed;
}

/** Atomically promote `stagingDir` to `finalDir` while the caller
 * holds `.revkit/daemon.lock`. Returns:
 *   - `"promoted"` when the rename succeeded and `finalDir` now
 *     holds the staged output;
 *   - `"kept-existing"` when `finalDir` already exists (a concurrent
 *     winner beat us); the caller MUST discard `stagingDir`;
 *   - `"failed"` on an unexpected IO error (surfaced via `error`).
 *
 * The rename IS the atomic guarantee (POSIX `renameat2` /
 * `rename(2)` on the same filesystem). The pre-rename existence
 * check is advisory and races a concurrent promotion; the rename
 * then fails with `ENOTEMPTY` / `EEXIST`, which we translate to
 * `kept-existing`. */
export interface PromoteOutcome {
  readonly kind: "promoted" | "kept-existing" | "failed";
  readonly error?: string;
}
export function promoteStagingDir(stagingDir: string, finalDir: string): PromoteOutcome {
  // Fast-path: a pre-existing final dir short-circuits the rename.
  if (existsSync(finalDir)) {
    return { kind: "kept-existing" };
  }
  try {
    renameSync(stagingDir, finalDir);
    return { kind: "promoted" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTEMPTY" || code === "EEXIST") {
      // Concurrent promotion landed between our existsSync and our
      // rename; treat as "kept-existing" and let the caller clean
      // up its staging dir.
      return { kind: "kept-existing" };
    }
    return { kind: "failed", error: (error as Error).message };
  }
}
