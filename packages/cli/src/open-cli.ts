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
import { findRunningDaemon } from "./serve/serve-state.ts";
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
  const state = findRunningDaemon(resolvePath(repoRoot));
  if (state === undefined) {
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
