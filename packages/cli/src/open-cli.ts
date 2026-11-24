// `revkit open [path]` — mint and print a fresh single-use launch URL
// for the running daemon, and (when a TTY is attached) open it in the
// default browser. PR #38 round-2 blocker 3.
//
// The startup launch code has a 60 s TTL and is printed once on the
// daemon's stdout. An `revkit mcp`-spawned daemon has its stdout
// ignored, so a human running the CLI has no other way to get in.
// This command reads `.revkit/serve.json`, POSTs to `/-/launch-code`
// with the agent bearer, prints the returned URL and — if stdin
// looks like a TTY — spawns `xdg-open` / `open` / `start`.
//
// Kept small: no argv-heavy parsing, one shape.

import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { findRepoRootByPackageJson } from "./repo-root.ts";
import {
  findRunningDaemon,
  findRunningOrStartingDaemon,
  isReadyServeState,
  pidIsAlive,
} from "./serve/serve-state.ts";
import { DaemonClient } from "./mcp/daemon-client.ts";

/** Same shape the other `revkit *` subcommand runners return. */
export interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Environment `runOpenCommand` accepts. Kept explicit so tests can
 * inject a temp `cwd`. */
export interface RunOpenEnv {
  readonly cwd: string;
  /** Test hook: skip actual `xdg-open` / `open` spawn even when TTY.
   * Defaults to `process.stdout.isTTY`. */
  readonly openUrl?: (url: string) => void;
}

/** Parse `revkit open [path]`. */
export function parseOpenArgs(args: readonly string[]): { ok: true; path?: string } | { ok: false; message: string } {
  const positional: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--")) {
      return { ok: false, message: `revkit open: unknown flag '${arg}'` };
    }
    positional.push(arg);
  }
  if (positional.length > 1) {
    return { ok: false, message: "revkit open: expected at most one <path> argument" };
  }
  const first = positional[0];
  return { ok: true, ...(first !== undefined ? { path: first } : {}) };
}

/** Default URL opener: platform-specific spawn. Fires-and-forgets. */
function defaultUrlOpener(url: string): void {
  const cmd = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    // Ignore — the URL is already on stdout, the human can copy-paste.
  }
}

/** Run `revkit open`. Returns exit code + streams. */
export async function runOpenCommand(args: readonly string[], env: RunOpenEnv): Promise<RunResult> {
  const parsed = parseOpenArgs(args);
  if (!parsed.ok) return { exitCode: 2, stdout: "", stderr: parsed.message + "\n" };
  let repoRoot: string;
  try {
    repoRoot = findRepoRootByPackageJson(env.cwd);
  } catch (error) {
    return { exitCode: 2, stdout: "", stderr: `${(error as Error).message}\n` };
  }
  const resolvedRoot = resolvePath(repoRoot);
  const state = findRunningDaemon(resolvedRoot);
  if (state === undefined) {
    // #251 N4: a daemon in the pre-bind window (cold-start
    // auto-build) holds .revkit/daemon.lock with
    // `status: "starting"`, so `findRunningDaemon` (ready-only)
    // returns undefined. Report "building" instead of the
    // misleading "no daemon is running" — running `revkit serve`
    // would be refused by that lock.
    const starting = findRunningOrStartingDaemon(resolvedRoot);
    if (starting !== undefined && !isReadyServeState(starting)) {
      const parsed = Date.parse(starting.startedAt);
      const elapsedS = Number.isFinite(parsed)
        ? Math.max(0, Math.round((Date.now() - parsed) / 1000))
        : 0;
      // #251 round-3 nit: omit the pid when the recorded serve is
      // dead — pointing the agent at a vanished process confuses
      // more than it helps. After the inherited-fd revert this
      // branch only triggers mid-race; the normal path still
      // names the live serve.
      const pidAlive = pidIsAlive(starting.pid);
      const pidClause = pidAlive ? `pid ${starting.pid}, ` : "";
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          `revkit open: a daemon is starting (cold-start auto-build, ${pidClause}${elapsedS} s elapsed since ${starting.startedAt}). ` +
          `Try again once the build finishes.\n`,
      };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: "revkit open: no daemon is running. Start one with `revkit serve` first.\n",
    };
  }
  const client = new DaemonClient({ url: state.url, agentToken: state.agentToken });
  let minted: { launchUrl: string; ttlMs: number };
  try {
    minted = await client.mintLaunchUrl(parsed.path);
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: `revkit open: ${(error as Error).message}\n` };
  }
  const opener = env.openUrl ?? (process.stdout.isTTY === true ? defaultUrlOpener : () => {});
  opener(minted.launchUrl);
  return {
    exitCode: 0,
    stdout:
      `${minted.launchUrl}\n` +
      `revkit open: single-use, expires in ${Math.round(minted.ttlMs / 1000)}s.\n`,
    stderr: "",
  };
}
