// Start an isolated `revkit serve` daemon in a temp state dir OUTSIDE the
// git worktree, and shut it down deterministically at teardown.
//
// PR #42 round-1 blocker was `(cd … && bun … serve &) ; echo $!` capturing
// the subshell's pid, not bun's. The typed Bun.spawn API sidesteps that
// class of bug — `subprocess.pid` is bun's own pid — but we still cross-
// check against `serve.json.pid` before trusting it for teardown.

import { spawn, type Subprocess } from "bun";
import { openSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonHandle, StateDir } from "./types.ts";
import type { Logger } from "./logger.ts";
import { redactLine } from "./redact.ts";

interface StartOptions {
  readonly stateDir: StateDir;
  readonly repoRoot: string;
  readonly bunBin: string;
  readonly logger: Logger;
  /** Fallback path where we move the daemon log on success. Kept as a
   *  parameter so tests can pass a temp dir. */
  readonly finalLogPath: string;
}

interface StoppedSubprocess {
  process?: Subprocess;
  pid: number;
}

/** Spawn `revkit serve` inside STATE_DIR. Waits up to 15 s for
 *  `.revkit/serve.json` to appear, then reads it for the verified pid,
 *  url, port and agentToken. */
export async function startDaemon(opts: StartOptions): Promise<DaemonHandle & StoppedSubprocess> {
  const daemonLogTmp = mkdtempSync(join(tmpdir(), "revkit-dogfood-daemon-"));
  const daemonLog = join(daemonLogTmp, "daemon.log");
  const logFd = openSync(daemonLog, "w");
  const proc = spawn({
    cmd: [opts.bunBin, join(opts.repoRoot, "packages/cli/bin/revkit.js"), "serve", "--dir", opts.stateDir.siteDist],
    cwd: opts.stateDir.path,
    stdin: "ignore",
    stdout: logFd,
    stderr: logFd,
    env: process.env as Record<string, string>,
  });
  opts.logger.log(`daemon spawned (bun pid ${proc.pid})`);

  const servePath = join(opts.stateDir.path, ".revkit/serve.json");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(servePath)) {
      try {
        const parsed = JSON.parse(readFileSync(servePath, "utf8")) as {
          pid: number;
          url: string;
          port: number;
          agentToken: string;
        };
        // Move the transient log to its final location AFTER the daemon
        // opened its file — the mktemp path is guarded by the caller for
        // final unlink / redact.
        try {
          renameSync(daemonLog, opts.finalLogPath);
        } catch {
          // rename fails across mount points; fall back to keeping the tmp path.
        }
        const finalLog = existsSync(opts.finalLogPath) ? opts.finalLogPath : daemonLog;
        // Cross-check pid.
        let verifiedPid = proc.pid ?? parsed.pid;
        if (parsed.pid !== verifiedPid) {
          opts.logger.log(
            `WARN: serve.json.pid=${parsed.pid} != captured bun pid ${verifiedPid} — using serve.json.pid for teardown`,
          );
          verifiedPid = parsed.pid;
        }
        opts.logger.log(`daemon at ${parsed.url} (pid ${verifiedPid})`);
        return {
          pid: verifiedPid,
          url: parsed.url,
          port: parsed.port,
          agentToken: parsed.agentToken,
          stateDir: opts.stateDir,
          logPath: finalLog,
          process: proc,
        };
      } catch {
        // File exists but wasn't fully written yet; retry.
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  // Daemon never wrote serve.json — dump the log and give up.
  const logDump = safeRead(daemonLog);
  if (logDump !== undefined) opts.logger.logBlock("serve.stdout", logDump);
  try {
    proc.kill("SIGKILL");
  } catch {
    // Best-effort.
  }
  try {
    unlinkSync(daemonLog);
  } catch {
    // Best-effort.
  }
  rmSync(daemonLogTmp, { recursive: true, force: true });
  throw new Error("daemon never wrote serve.json");
}

function safeRead(p: string): string | undefined {
  try {
    if (!existsSync(p)) return undefined;
    if (statSync(p).size === 0) return undefined;
    return redactLine(readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
}
