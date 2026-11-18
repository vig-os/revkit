// Daemon bootstrap — the `revkit mcp` startup path.
//
// The MCP server is a **client** of the daemon (DESIGN-0001 §5.3,
// ADR-0007). It does not own state; it reads `.revkit/serve.json`
// and proxies to the daemon's HTTP surface.
//
// Discovery is done through the daemon-lock the daemon holds
// (`packages/cli/src/serve/serve-state.ts:findRunningDaemon`, PR #36):
// the OS-held `flock(2)` on `.revkit/daemon.lock` is the ground
// truth. `serve.json` is advertisement only, trusted only while the
// lock is held. This file is a THIN wrapper over `findRunningDaemon`
// that adds the "auto-start if nothing is running" and the
// "reconnect to the daemon we just spawned" paths.
//
// Two paths at startup:
//
// 1. **Daemon already running.** `findRunningDaemon` returns the
//    current `ServeState`. We use its `agentToken` directly.
//
// 2. **No daemon.** `findRunningDaemon` returns undefined (lock is
//    free, or `.revkit/daemon.lock` doesn't exist yet). We spawn
//    `revkit serve` detached, then poll `findRunningDaemon` until
//    it returns a `ServeState`. The new daemon takes the lock, and
//    the caller reconnects on the next poll.
//
// The spawn uses `Bun.spawn` with `stdio: ['ignore', 'ignore',
// 'ignore']` and `detached: true` so the daemon outlives this
// process. The daemon writes its own state file (mode 600) and the
// bootstrap only ever reads it.

import { existsSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearStartFailure,
  findRunningOrStartingDaemon,
  isReadyServeState,
  readStartFailure,
  type ServeState,
  type StartFailureRecord,
} from "../serve/serve-state.ts";
import { stripTrailingSlashes } from "./daemon-client.ts";

/** Options for `ensureDaemon`. */
export interface BootstrapOptions {
  /** Absolute path to the repo root. */
  readonly repoRoot: string;
  /** How long to wait, in ms, for a freshly spawned daemon to take
   * the lock and publish `serve.json`. Defaults to 10 s — the daemon
   * binds a random port + opens sqlite; a slow disk can take a beat.
   *
   * #251: this is the deadline for reaching the "lock held" state.
   * Once we SEE a "starting" record, we instead wait for
   * `startingReadyMs` for the transition to "ready" — a cold-start
   * auto-build can legitimately take longer than this spawn window. */
  readonly waitMs?: number;
  /** How long to wait, in ms, for a daemon in `status: "starting"`
   * to reach `status: "ready"` (#251). Defaults to 10 s — same as
   * `waitMs`. Readiness is SIGNALLED (status flips to "ready"), not
   * guessed; this deadline only bounds how long an `ensureDaemon`
   * call will sit waiting on the signal before returning a clear
   * "daemon still starting after N ms" error to its caller. The
   * background reconnect loop (channel-server.ts) retries with
   * exponential backoff, so a slow build eventually surfaces as
   * a successful tool call once the daemon is ready. */
  readonly startingReadyMs?: number;
  /** Between `findRunningDaemon` polls, this long in ms. Defaults to
   * 50. */
  readonly pollIntervalMs?: number;
  /** Directory (relative to repoRoot) the daemon should serve. Passed
   * to `revkit serve --dir`. Defaults to `site/dist`. */
  readonly dir?: string;
  /** Path to the `revkit` CLI entrypoint (`bin/revkit.js`). Defaults
   * to the entry that ships with this running package. Tests inject the
   * absolute path to the local checkout's `bin/revkit.js`. */
  readonly revkitBin?: string;
  /** Test hook: swap out the spawn implementation. Defaults to
   * `Bun.spawn`. The `env` field is what `defaultSpawn` would
   * apply to `Bun.spawn`, i.e. `filteredDaemonEnv()` at the time
   * of the spawn — passed through the hook so a test can observe
   * that the allowlist filter really was applied (PR #38
   * round-4 review: a stub that skipped this arg silently masked
   * a regression where the daemon inherited the full parent env). */
  readonly spawn?: (options: {
    cmd: string[];
    cwd: string;
    stdio: ["ignore", "ignore", "ignore"];
    detached: boolean;
    env: NodeJS.ProcessEnv;
  }) => { pid: number };
  /** Test hook: called with the child pid right after spawn — the
   * dogfood spawn scenarios register the pid with the shared
   * daemon-registry so the end-of-suite hygiene sweep can only
   * SIGTERM daemons a test started, never an unrelated one. Kept
   * off the public wire (no default) so the production path stays
   * free of test bookkeeping. */
  readonly onSpawn?: (pid: number) => void;
  /** Test hook: swap out the daemon-discovery function. Defaults to
   * `findRunningOrStartingDaemon` (returns a ServeState whenever the
   * lock is held, in either "starting" or "ready" status). Lets a
   * test drive the discover / spawn / re-discover cycle without
   * touching a real lock file.
   *
   * Historical name retained: callers still pass `findRunningDaemon`
   * because the legacy callers of the ready-only `findRunningDaemon`
   * did — but what a bootstrap wants is EVERY state, so a starting
   * daemon stops us spawning another one (#251). */
  readonly findRunningDaemon?: (repoRoot: string) => ServeState | undefined;
  /** Test hook: swap out `readStartFailure`. Defaults to reading
   * `.revkit/start-failed.json` (#251 N1). */
  readonly readStartFailure?: (repoRoot: string) => StartFailureRecord | undefined;
  /** Test hook: swap out `clearStartFailure`. Defaults to deleting
   * `.revkit/start-failed.json` (#251 N1). */
  readonly clearStartFailure?: (repoRoot: string) => void;
  /** Test hook: injected clock (ms epoch). */
  readonly nowMs?: () => number;
  /** Test hook: sleep (ms → Promise). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** #251 B2: what to do when a "starting" ServeState is seen.
   *  - `"wait"` (default, legacy): block up to `startingReadyMs`
   *    for the transition to `"ready"`. Suits the background
   *    reconnect loop that will keep retrying with backoff.
   *  - `"diagnose"`: throw `DaemonBuildingError` immediately with
   *    elapsed computed from the record's `startedAt`. Suits the
   *    per-tool-call `discover` in `mcp/cli.ts`, which MUST return
   *    inside the tool-call deadline with a retriable message —
   *    sitting on `startingReadyMs` races the tool deadline and
   *    30 of 36 tool calls got the generic "reconnect did not
   *    complete" error in a real 3-minute build (see #251 B2). */
  readonly onStartingDaemon?: "wait" | "diagnose";
}

/** Result of bootstrap: the daemon's state file, plus a flag saying
 * whether we spawned it (a caller may want to log the difference). */
export interface Bootstrapped {
  readonly state: ServeState;
  readonly spawned: boolean;
}

/** Thrown by `ensureDaemon` in `onStartingDaemon: "diagnose"` mode
 * when a daemon-starting record is live (#251 B2). The message is
 * the agent-facing diagnostic: it names the pid and the elapsed
 * seconds computed from the record's `startedAt`, and tells the
 * agent to retry. Elapsed is wall-clock since the record was
 * published (NOT since the waiter started), so a tool call made
 * ten minutes into a slow build reports `elapsed ~= 600 s`, not
 * `elapsed ~= 10 s`. */
export class DaemonBuildingError extends Error {
  readonly pid: number;
  readonly elapsedMs: number;
  readonly startedAt: string;
  constructor(args: { pid: number; elapsedMs: number; startedAt: string }) {
    const elapsedS = Math.max(0, Math.round(args.elapsedMs / 1000));
    super(
      `revkit mcp: daemon is building (cold-start auto-build, pid ${args.pid}, ` +
        `${elapsedS} s elapsed since ${args.startedAt}). ` +
        `Retry this tool call in a few seconds.`,
    );
    this.name = "DaemonBuildingError";
    this.pid = args.pid;
    this.elapsedMs = args.elapsedMs;
    this.startedAt = args.startedAt;
  }
}

/** Thrown by `ensureDaemon` when `.revkit/start-failed.json` records
 * a recent failure and `.revkit/dist` is in the same state (#251
 * N1). Tells the caller WHY the last `revkit serve` could not
 * start — instead of silently re-spawning it on every tool call. */
export class DaemonStartFailedError extends Error {
  readonly stage: StartFailureRecord["stage"];
  readonly failedAt: string;
  readonly stderrTail?: string;
  constructor(record: StartFailureRecord) {
    super(
      `revkit mcp: daemon failed to start (${record.stage} at ${record.failedAt}): ${record.message}` +
        (record.stderrTail !== undefined && record.stderrTail.length > 0
          ? `\n--- last stderr ---\n${record.stderrTail}`
          : ""),
    );
    this.name = "DaemonStartFailedError";
    this.stage = record.stage;
    this.failedAt = record.failedAt;
    if (record.stderrTail !== undefined) this.stderrTail = record.stderrTail;
  }
}

/** Build the elapsed-ms value for a "starting" record. ISO-8601
 * with offset parses in every supported runtime; on an unparsable
 * value we fall back to 0 so the error still carries the pid. */
function elapsedSinceStartedAt(startedAt: string, nowMs: number): number {
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return 0;
  return Math.max(0, nowMs - started);
}

/** Ensure a daemon is running for `repoRoot` and return its READY
 * state. Uses `findRunningOrStartingDaemon` (the lock is the ground
 * truth), spawning `revkit serve` only when nothing owns the lock.
 *
 * #251 lifecycle contract. A daemon doing a cold-start auto-build
 * holds `.revkit/daemon.lock` and advertises `status: "starting"`
 * BEFORE binding, so:
 *
 *   - If a "ready" state is seen, return it (no spawn, no wait).
 *   - If a "starting" state is seen, wait on the transition to
 *     "ready" (bounded by `startingReadyMs`) — NEVER spawn a second
 *     daemon. A starting daemon that DIES (lock released while we
 *     wait) is detected promptly via the next poll and surfaced as a
 *     "died while starting" error, not after the full deadline.
 *   - If no daemon owns the lock, spawn `revkit serve` detached and
 *     poll until it transitions to "starting" or "ready". A spawn
 *     window of `waitMs` bounds how long we wait for the lock to be
 *     taken (a daemon that cannot start at all); once "starting"
 *     appears we hand off to the readiness-wait path above.
 *
 * Throws on timeout or on a daemon that dies while starting. */
export async function ensureDaemon(options: BootstrapOptions): Promise<Bootstrapped> {
  const repoRoot = resolvePath(options.repoRoot);
  const waitMs = options.waitMs ?? 10_000;
  const startingReadyMs = options.startingReadyMs ?? 10_000;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const spawn = options.spawn ?? defaultSpawn;
  const clock = options.nowMs ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const discover = options.findRunningDaemon ?? findRunningOrStartingDaemon;
  const readFailure = options.readStartFailure ?? readStartFailure;
  const clearFailure = options.clearStartFailure ?? clearStartFailure;
  const onStarting = options.onStartingDaemon ?? "wait";

  // Case 1: a daemon already owns the lock (ready OR starting).
  const existing = discover(repoRoot);
  if (existing !== undefined) {
    if (isReadyServeState(existing)) {
      return { state: existing, spawned: false };
    }
    // Starting state. #251 B2: honour `onStartingDaemon`. Elapsed
    // is computed from the record's `startedAt`, not from the
    // caller's clock-at-entry, so a tool call made ten minutes
    // into a build reports ~600 s elapsed — not ~0 s.
    if (onStarting === "diagnose") {
      throw new DaemonBuildingError({
        pid: existing.pid,
        elapsedMs: elapsedSinceStartedAt(existing.startedAt, clock()),
        startedAt: existing.startedAt,
      });
    }
    // A starting daemon is here — wait for it (no spawn).
    const ready = await waitForReady({
      discover,
      repoRoot,
      pollIntervalMs,
      deadlineMs: clock() + startingReadyMs,
      startingReadyMs,
      clock,
      sleep,
      startingPid: existing.pid,
    });
    return { state: ready, spawned: false };
  }

  // #251 N1: before spawning, check for a persisted start failure.
  // `revkit serve`'s spawn ignores stdio, so a build or startDaemon
  // failure is otherwise invisible — every MCP tool call would
  // keep blindly respawning it. The record is honoured only while
  // the recorded inputs match the current state (dist still
  // missing / present as it was at failure time); when the user
  // runs `revkit build` manually, dist exists and the record is
  // treated as stale (cleared, then spawn proceeds).
  const failure = readFailure(repoRoot);
  if (failure !== undefined) {
    const distExistsNow = existsSync(defaultDistPath(repoRoot, options.dir));
    if (distExistsNow === failure.inputs.distExists) {
      throw new DaemonStartFailedError(failure);
    }
    // Inputs changed — the user likely ran `revkit build`. Clear
    // the record and proceed to spawn a fresh daemon.
    clearFailure(repoRoot);
  }

  // Case 2: no live daemon. Spawn one.
  const revkitBin = options.revkitBin ?? defaultRevkitBin();
  const cmd = [...daemonExecutable(revkitBin), "serve"];
  if (options.dir !== undefined) {
    cmd.push("--dir", options.dir);
  }
  // `env` is computed here (not inside `defaultSpawn`) so the test
  // hook sees the SAME environment the production path would apply
  // — a stub that ignored `env` used to bypass the filter and mask
  // regressions. Dropping the allowlist filter now turns
  // `filteredDaemonEnv` tests red AND flips this bootstrap path's
  // integration check (both fixed at the call site).
  const spawnResult = spawn({
    cmd,
    cwd: repoRoot,
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
    env: filteredDaemonEnv(),
  });
  options.onSpawn?.(spawnResult.pid);

  // Poll `findRunningOrStartingDaemon` until the new daemon claims
  // the lock. The lock discipline (PR #36) guarantees no false
  // positive: discover returns a state only when the lock is
  // currently held. #251: once we see a state (ready OR starting),
  // hand off to the readiness-wait path — never spawn twice.
  const spawnDeadline = clock() + waitMs;
  while (clock() < spawnDeadline) {
    await sleep(pollIntervalMs);
    const state = discover(repoRoot);
    if (state === undefined) {
      // #251 N1: a start-failed record written while we were
      // polling means our spawn died cleanly (serve wrote its
      // reason to disk and released the lock). Surface it now
      // instead of waiting out the full spawnDeadline.
      const latestFailure = readFailure(repoRoot);
      if (latestFailure !== undefined) {
        throw new DaemonStartFailedError(latestFailure);
      }
      continue;
    }
    if (isReadyServeState(state)) {
      return { state, spawned: true };
    }
    // Starting record visible. #251 B2: honour `onStartingDaemon`.
    if (onStarting === "diagnose") {
      throw new DaemonBuildingError({
        pid: state.pid,
        elapsedMs: elapsedSinceStartedAt(state.startedAt, clock()),
        startedAt: state.startedAt,
      });
    }
    // Wait for readiness. The `startingReadyMs` deadline resets
    // here so a cold build gets its full readiness window (it
    // already consumed part of `waitMs` in the spawn window).
    const ready = await waitForReady({
      discover,
      repoRoot,
      pollIntervalMs,
      deadlineMs: clock() + startingReadyMs,
      startingReadyMs,
      clock,
      sleep,
      startingPid: state.pid,
    });
    return { state: ready, spawned: true };
  }
  throw new Error(
    `spawned daemon did not take '.revkit/daemon.lock' within ${waitMs} ms`,
  );
}

/** Resolve the dist path that `revkit serve` would default to.
 * Used by `ensureDaemon` to check whether `revkit build` created
 * dist after a recorded start failure. */
function defaultDistPath(repoRoot: string, dir: string | undefined): string {
  if (dir !== undefined) return resolvePath(repoRoot, dir);
  return join(repoRoot, ".revkit", "dist");
}

/** Wait for a daemon in `status: "starting"` to reach `"ready"`.
 * Polls `discover` on `pollIntervalMs` and resolves on the
 * `"ready"` transition. Throws promptly on:
 *   - the lock being released while we wait (daemon died while
 *     starting; pid gone), without a fixed-length wait;
 *   - the deadline passing (surfaced as "building, N s elapsed"
 *     so the agent sees a clear retriable status). */
async function waitForReady(args: {
  readonly discover: (repoRoot: string) => ServeState | undefined;
  readonly repoRoot: string;
  readonly pollIntervalMs: number;
  readonly deadlineMs: number;
  readonly startingReadyMs: number;
  readonly clock: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly startingPid: number;
}): Promise<ServeState> {
  const {
    discover,
    repoRoot,
    pollIntervalMs,
    deadlineMs,
    startingReadyMs,
    clock,
    sleep,
    startingPid,
  } = args;
  const startMs = clock();
  while (clock() < deadlineMs) {
    const state = discover(repoRoot);
    if (state === undefined) {
      // Lock released while we were waiting — the starting daemon
      // died before it could bind. This is the "promptly detected"
      // path (#251 AC): we do NOT burn the rest of the deadline.
      throw new Error(
        `revkit serve (pid ${startingPid}) died while starting (daemon.lock released before ready)`,
      );
    }
    if (isReadyServeState(state)) {
      return state;
    }
    await sleep(pollIntervalMs);
  }
  const elapsedS = Math.max(0, Math.round((clock() - startMs) / 1000));
  throw new Error(
    `revkit serve (pid ${startingPid}) still starting after ${startingReadyMs} ms (building, ${elapsedS} s elapsed). Try again once the daemon is ready.`,
  );
}

/** Reuse the running runtime by absolute path. Compiled Bun programs have
 * their entry inside Bun's virtual filesystem and need no script argument. */
export function daemonExecutable(entry: string, main = Bun.main, executable = process.execPath): string[] {
  return main.startsWith("/$bunfs/") || main.startsWith("B:/~BUN/")
    ? [executable]
    : [executable, entry];
}

/** Default `spawn`: `Bun.spawn` with `detached: true`, running with
 * the `env` the caller computed (`filteredDaemonEnv()` from
 * `ensureDaemon` — always applied on the production path, never
 * elided by a test hook that dropped the field). */
function defaultSpawn(options: {
  cmd: string[];
  cwd: string;
  stdio: ["ignore", "ignore", "ignore"];
  detached: boolean;
  env: NodeJS.ProcessEnv;
}): { pid: number } {
  const child = Bun.spawn({
    cmd: options.cmd,
    cwd: options.cwd,
    stdio: options.stdio,
    env: options.env,
    // A detached child continues after this process exits — which is
    // the point of `revkit mcp` auto-starting the daemon: an agent
    // session may spin up and tear down the MCP server many times,
    // and we don't want the daemon flapping with it.
    // Bun's ProcessSpawnOptions accepts `detached: true` on POSIX
    // (Linux, macOS).
    ...(options.detached ? { detached: true } : {}),
  });
  // Unref so the parent process doesn't wait on the child at exit.
  if (typeof child.unref === "function") child.unref();
  return { pid: child.pid };
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
}

/** Default `revkit` binary: `bin/revkit.js` shipped with this
 * package. Computed from `import.meta.url` so a workspace or a
 * vendored install both resolve. Uses `fileURLToPath` (not
 * `URL.pathname`) because the latter percent-encodes spaces and
 * other filesystem-legal characters — a path like
 * `/Users/Some Person/repo/…` would come back as
 * `/Users/Some%20Person/…` and fail `Bun.spawn`. Exported for tests. */
export function defaultRevkitBin(): string {
  // src/mcp/daemon-bootstrap.ts → ../../bin/revkit.js
  const here = new URL(import.meta.url);
  const packageRoot = new URL("../../", here);
  return fileURLToPath(new URL("bin/revkit.js", packageRoot));
}

/** Minimum env vars the spawned daemon needs to run under Bun on
 * NixOS / macOS. Kept as an EXPLICIT allowlist (no `NIX_*` prefix
 * blanket) so a hostile agent process cannot poison the daemon's
 * environment with tokens, `LD_PRELOAD`, `NIX_LD` /
 * `NIX_LD_LIBRARY_PATH`, `NODE_OPTIONS`, or other side channels
 * (PR #38 round-2 review). Anything the daemon needs at runtime
 * must be listed here by name.
 *
 * - `PATH`: preserved for tools the daemon invokes; bootstrap never resolves Bun through it.
 * - `HOME`: `bun install`, `bun run` look up config there.
 * - `USER`: some tools resolve `$USER/…` in home paths.
 * - `TMPDIR` (+ `TMP` / `TEMP`): where `mktemp` lands.
 * - `LANG` / `LC_*`: preserve locale so date formatting is stable.
 * - `TERM`: harmless; useful if the spawned daemon errors and
 *   writes a coloured log line before we redirect its stdio.
 * - `NIX_PROFILES` / `NIX_PATH` / `NIX_USER_PROFILE_DIR`: needed
 *   for the flake wrappers to find the tool chain on NixOS. These
 *   are the ONLY three `NIX_*` names the daemon needs; `NIX_LD` /
 *   `NIX_LD_LIBRARY_PATH` are drop-in code-execution side channels
 *   and MUST NOT be forwarded. Verified: `bun packages/cli/bin/
 *   revkit.js serve` starts under the nix shell without `NIX_LD`.
 * - `SSL_CERT_FILE` / `NIX_SSL_CERT_FILE`: reserved for a future
 *   outbound-fetch path. The M2 daemon is loopback-only and does
 *   no `fetch` at rest, but a M3 GitHub adapter that runs inside
 *   the daemon (ADR-0025) will need cert bundles; allowlist them
 *   now to avoid a surprise regression.
 * - `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` (lower + upper):
 *   same rationale — reserved for outbound; a loopback-only daemon
 *   is unaffected. */
const DAEMON_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "HOME",
  "LANG",
  "PATH",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "USER",
  "NIX_PROFILES",
  "NIX_PATH",
  "NIX_USER_PROFILE_DIR",
  "SSL_CERT_FILE",
  "NIX_SSL_CERT_FILE",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
]);
const DAEMON_ENV_PREFIX_ALLOWLIST: readonly string[] = ["LC_", "XDG_"];

/** Filter `process.env` down to the allowlist. Exported for tests. */
export function filteredDaemonEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (DAEMON_ENV_ALLOWLIST.has(key) || DAEMON_ENV_PREFIX_ALLOWLIST.some((p) => key.startsWith(p))) {
      out[key] = value;
    }
  }
  return out;
}

// Re-export ServeState so `revkit mcp` callers get one import path.
export type { ServeState } from "../serve/serve-state.ts";

/** Fetch a running daemon's `/-/health` `{instanceId, pid}` and
 * compare `instanceId` with `advertised.instanceId` to confirm the
 * daemon we reconnect to is the same one `serve.json` advertises.
 *
 * A reconnect from a long-lived MCP session finds `serve.json`
 * pointing at a URL. Between reading `serve.json` and using its
 * bearer, the original daemon might have died and been replaced by
 * a new one (different `instanceId`) — in which case the bearer we
 * read is stale. This helper lets the caller detect that: fetch
 * `/-/health`, compare `instanceId`. A mismatch means "reconnect".
 *
 * Returns `true` on match, `false` on mismatch (fresh daemon
 * detected — re-run `ensureDaemon`), and throws on transport
 * failure (`fetch` rejected — nobody home). */
export async function verifyDaemonInstance(
  url: string,
  advertisedInstanceId: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<boolean> {
  const response = await fetchImpl(`${stripTrailingSlashes(url)}/-/health`, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`verifyDaemonInstance: /-/health returned ${response.status}`);
  }
  const body = (await response.json()) as { instanceId?: unknown };
  if (typeof body.instanceId !== "string") {
    throw new Error(`verifyDaemonInstance: /-/health missing instanceId`);
  }
  return body.instanceId === advertisedInstanceId;
}
