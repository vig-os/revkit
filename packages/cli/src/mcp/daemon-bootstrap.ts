// Daemon bootstrap — the `revkit mcp` startup path.
//
// The MCP server is a **client** of the daemon (DESIGN-0001 §5.3,
// ADR-0007). It does not own state; it reads `.revkit/serve.json`
// and proxies to the daemon's HTTP surface. Two states matter at
// startup:
//
// 1. **Daemon already running.** `serve.json` exists, the recorded
//    pid is alive and reachable at `url`. We use its `agentToken`
//    directly.
//
// 2. **No daemon.** No `serve.json`, or the recorded pid is dead.
//    We spawn `revkit serve` detached, wait up to a short deadline
//    for `serve.json` to appear and the daemon to answer a probe on
//    `url/-/auth`, then read the token. Failure surfaces as an
//    error — we never fall back to a half-connected client.
//
// The spawn uses `Bun.spawn` with `stdio: ['ignore', 'ignore',
// 'ignore']` and `detached: true` so the daemon outlives this
// process. The daemon writes its own state file (mode 600) and the
// bootstrap only ever reads it.

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { readServeState, serveStatePath, isPidAlive, type ServeState } from "../serve/serve-state.ts";

/** Options for `ensureDaemon`. */
export interface BootstrapOptions {
  /** Absolute path to the repo root. */
  readonly repoRoot: string;
  /** How long to wait, in ms, for a freshly spawned daemon's
   * `serve.json` to appear. Defaults to 10 s — the daemon binds a
   * random port + reads sqlite; a slow disk can take a beat. */
  readonly waitMs?: number;
  /** Between polls of `serve.json`, this long in ms. Defaults to 50. */
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
 * Reads an existing live `serve.json`, or spawns a new daemon and
 * waits for it. Throws on timeout or on a broken state file. */
export async function ensureDaemon(options: BootstrapOptions): Promise<Bootstrapped> {
  const repoRoot = resolvePath(options.repoRoot);
  const waitMs = options.waitMs ?? 10_000;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const spawn = options.spawn ?? defaultSpawn;
  const clock = options.nowMs ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  // Case 1: a live daemon owns `serve.json`.
  const existing = readServeStateSafe(repoRoot);
  if (existing !== undefined && isPidAlive(existing.pid)) {
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

  // Poll `serve.json` until it appears with a live pid.
  const deadline = clock() + waitMs;
  while (clock() < deadline) {
    await sleep(pollIntervalMs);
    const state = readServeStateSafe(repoRoot);
    if (state !== undefined && isPidAlive(state.pid)) {
      return { state, spawned: true };
    }
  }
  throw new Error(
    `revkit mcp: spawned daemon did not write '.revkit/serve.json' within ${waitMs} ms`,
  );
}

/** Read `serve.json`, or `undefined` if it doesn't exist / is
 * malformed. A malformed file is treated the same as a missing one so
 * a stale write from a crashed daemon can be superseded by a fresh
 * spawn. `readServeState` throws on parse errors; we swallow that
 * here specifically because the caller's intent is "recover", not
 * "diagnose". */
function readServeStateSafe(repoRoot: string): ServeState | undefined {
  try {
    return readServeState(repoRoot);
  } catch {
    return undefined;
  }
}

/** Default `spawn`: `Bun.spawn`. Cast to the caller's shape so the
 * types stay minimal. */
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

// Exposed so the CLI can also read `serve.json` directly (e.g. print
// diagnostic output on non-fatal errors) without duplicating the
// error-swallow guard. The default `readServeState` throws on
// parse errors; use this from anywhere that would rather recover.
export { readServeStateSafe };

// `existsSync`, `statSync`, `readFileSync` are re-exported so the
// bootstrap tests can spot-check `serve.json` mode/contents without
// duplicating node imports.
export { existsSync, statSync, readFileSync };
