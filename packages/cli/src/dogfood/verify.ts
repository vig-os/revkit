// Runtime-facing lockdown verification. Finds the child claude by argv
// marker, waits for the pre-exec race in the nix claude wrapper to close
// (`/proc/<pid>/exe` resolves to `.claude-wrapped`), then calls the pure
// `verifyLockdown` from `lockdown.ts` with the parsed cmdline+environ.
//
// The verify guard is injectable: `main.ts` passes the real
// `verifyLockdown`; the bad-flags self-test passes the real one too and
// asserts it says NOT OK. A "weakened" verify — a mutant that would
// pass a bad argv — is what the test's RED evidence uses.

import { verifyLockdown } from "./lockdown.ts";
import type { LockdownExpectations, LockdownResult } from "./types.ts";
import { readProcCmdline, readProcEnviron, readProcExe, pgrepF } from "./proc-io.ts";
import type { Logger } from "./logger.ts";

export type LockdownGuard = (
  cmd: ReturnType<typeof readProcCmdline>,
  env: ReturnType<typeof readProcEnviron>,
  exp: LockdownExpectations,
) => LockdownResult;

/** The real guard — narrows the file-optional types before delegating. */
export const strictLockdownGuard: LockdownGuard = (cmd, env, exp) => {
  if (cmd === undefined) return { ok: false, reason: "could not read /proc/<pid>/cmdline" };
  if (env === undefined) return { ok: false, reason: "could not read /proc/<pid>/environ" };
  return verifyLockdown(cmd, env, exp);
};

/** Find the child claude pid by grepping for the unique mcp-config path. */
export async function findClaudePid(mcpConfigPath: string, timeoutMs: number): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pids = pgrepF(`claude.*${escapeRegex(mcpConfigPath)}`);
    if (pids.length > 0) return pids[0];
    await new Promise((r) => setTimeout(r, 500));
  }
  return undefined;
}

/** Wait for the nix claude wrapper's exec race to close. */
export async function waitClaudeWrapped(pid: number, timeoutMs: number): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exe = readProcExe(pid);
    if (exe !== undefined && exe.endsWith(".claude-wrapped")) return exe;
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
}

/** End-to-end pre-launch verification: find the pid, wait for the wrap
 *  race to close, then run the guard against the real /proc read. */
export async function verifyRunning(opts: {
  readonly expectations: LockdownExpectations;
  readonly guard: LockdownGuard;
  readonly logger: Logger;
  readonly findTimeoutMs?: number;
  readonly wrappedTimeoutMs?: number;
}): Promise<LockdownResult> {
  const findTimeout = opts.findTimeoutMs ?? 60_000;
  const wrapTimeout = opts.wrappedTimeoutMs ?? 30_000;
  const pid = await findClaudePid(opts.expectations.mcpConfigPath, findTimeout);
  if (pid === undefined) {
    return {
      ok: false,
      reason: `could not find claude pid via ${opts.expectations.mcpConfigPath}`,
    };
  }
  const exe = await waitClaudeWrapped(pid, wrapTimeout);
  if (exe === undefined) {
    return {
      ok: false,
      reason: `/proc/${pid}/exe did not resolve to .claude-wrapped within ${wrapTimeout} ms`,
    };
  }
  const cmd = readProcCmdline(pid);
  const env = readProcEnviron(pid);
  const result = opts.guard(cmd, env, opts.expectations);
  if (result.ok) {
    opts.logger.log(`lockdown verified OK for claude pid ${pid} (exe=${exe}): ${result.summary ?? ""}`);
  } else if (cmd !== undefined) {
    opts.logger.log(`LOCKDOWN-VERIFY: ${result.reason ?? "unknown"}`);
    opts.logger.log(`LOCKDOWN-VERIFY: full cmdline was:`);
    opts.logger.log(`  ${cmd.raw}`);
  } else {
    opts.logger.log(`LOCKDOWN-VERIFY: ${result.reason ?? "unknown"}`);
  }
  return result;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
