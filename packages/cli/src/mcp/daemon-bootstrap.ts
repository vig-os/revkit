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

import { resolve as resolvePath } from "node:path";
import { findRunningDaemon, type ServeState } from "../serve/serve-state.ts";

/** Options for `ensureDaemon`. */
export interface BootstrapOptions {
  /** Absolute path to the repo root. */
  readonly repoRoot: string;
  /** How long to wait, in ms, for a freshly spawned daemon to take
   * the lock and publish `serve.json`. Defaults to 10 s — the daemon
   * binds a random port + opens sqlite; a slow disk can take a beat. */
  readonly waitMs?: number;
  /** Between `findRunningDaemon` polls, this long in ms. Defaults to
   * 50. */
  readonly pollIntervalMs?: number;
  /** Directory (relative to repoRoot) the daemon should serve. Passed
   * to `revkit serve --dir`. Defaults to `site/dist`. */
  readonly dir?: string;
  /** Path to the `revkit` CLI entrypoint (`bin/revkit.js`). Defaults
   * to the entry that ships with this package. Tests inject the
   * absolute path to the local checkout's `bin/revkit.js`. */
  readonly revkitBin?: string;
  /** Test hook: swap out the spawn implementation. Defaults to
   * `Bun.spawn`. */
  readonly spawn?: (options: {
    cmd: string[];
    cwd: string;
    stdio: ["ignore", "ignore", "ignore"];
    detached: boolean;
  }) => { pid: number };
  /** Test hook: swap out `findRunningDaemon`. Defaults to the
   * shared implementation in `serve-state.ts`. Lets a test drive the
   * discover / spawn / re-discover cycle without touching a real
   * lock file. */
  readonly findRunningDaemon?: (repoRoot: string) => ServeState | undefined;
  /** Test hook: injected clock (ms epoch). */
  readonly nowMs?: () => number;
  /** Test hook: sleep (ms → Promise). */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Result of bootstrap: the daemon's state file, plus a flag saying
 * whether we spawned it (a caller may want to log the difference). */
export interface Bootstrapped {
  readonly state: ServeState;
  readonly spawned: boolean;
}

/** Ensure a daemon is running for `repoRoot` and return its state.
 * Uses `findRunningDaemon` (the lock is the ground truth), spawning
 * `revkit serve` when nothing owns the lock. Throws on timeout. */
export async function ensureDaemon(options: BootstrapOptions): Promise<Bootstrapped> {
  const repoRoot = resolvePath(options.repoRoot);
  const waitMs = options.waitMs ?? 10_000;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const spawn = options.spawn ?? defaultSpawn;
  const clock = options.nowMs ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const discover = options.findRunningDaemon ?? findRunningDaemon;

  // Case 1: a live daemon owns the lock.
  const existing = discover(repoRoot);
  if (existing !== undefined) {
    return { state: existing, spawned: false };
  }

  // Case 2: no live daemon. Spawn one.
  const revkitBin = options.revkitBin ?? defaultRevkitBin();
  const cmd = ["bun", revkitBin, "serve"];
  if (options.dir !== undefined) {
    cmd.push("--dir", options.dir);
  }
  spawn({
    cmd,
    cwd: repoRoot,
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });

  // Poll `findRunningDaemon` until the new daemon claims the lock
  // and publishes its state. The lock discipline (PR #36) guarantees
  // no false positive: `findRunningDaemon` returns a state only when
  // the lock is currently held.
  const deadline = clock() + waitMs;
  while (clock() < deadline) {
    await sleep(pollIntervalMs);
    const state = discover(repoRoot);
    if (state !== undefined) {
      return { state, spawned: true };
    }
  }
  throw new Error(
    `revkit mcp: spawned daemon did not take '.revkit/daemon.lock' within ${waitMs} ms`,
  );
}

/** Default `spawn`: `Bun.spawn` with `detached: true`. */
function defaultSpawn(options: {
  cmd: string[];
  cwd: string;
  stdio: ["ignore", "ignore", "ignore"];
  detached: boolean;
}): { pid: number } {
  const child = Bun.spawn({
    cmd: options.cmd,
    cwd: options.cwd,
    stdio: options.stdio,
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
 * vendored install both resolve. */
function defaultRevkitBin(): string {
  // src/mcp/daemon-bootstrap.ts → ../../bin/revkit.js
  const here = new URL(import.meta.url);
  const packageRoot = new URL("../../", here);
  return new URL("bin/revkit.js", packageRoot).pathname;
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
  const response = await fetchImpl(`${url.replace(/\/+$/, "")}/-/health`, {
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
