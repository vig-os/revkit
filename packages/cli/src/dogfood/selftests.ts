// Self-tests. Two modes, both invoked via the harness `--selftest`
// flag or through the unit-test suite:
//
//   - `bad-flags` — asserts the pre-launch lockdown check aborts on an
//     injected forbidden value (`--tools default`). NEVER injects
//     `--dangerously-skip-permissions` — no rogue session ever runs.
//
//   - `decoy-teardown` — starts a decoy whose argv contains
//     `revkit.js serve` but whose cwd is unrelated to STATE_DIR.
//     The SHIPPING teardown's leak-guard checks BOTH argv AND cwd, so
//     the decoy is correctly ignored and cleanup reaches
//     `teardown complete`.
//
// Both self-tests take the LOAD-BEARING guard as a parameter — the same
// guard the SHIPPING harness uses. The RED-evidence path substitutes a
// MUTANT via that DI hook (never a local copy):
//
//   - bad-flags RED: pass `okAlwaysVerifier` — the mutant passes any
//     argv, so the self-test correctly FAILs.
//   - decoy-teardown RED: pass `weakArgvOnlyLeakGuard` — the mutant
//     flags the decoy as a leak, so the self-test correctly FAILs.

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { buildClaudeArgv } from "./argv.ts";
import { makeExpectations, verifyLockdown as realVerifyLockdown } from "./lockdown.ts";
import { parseCmdline, parseEnviron } from "./proc.ts";
import type { Logger } from "./logger.ts";
import type { LockdownResult, LockdownExpectations, ProcCmdline, ProcEnviron, PaneHandle, DaemonHandle } from "./types.ts";
import { makeTeardown, strictLeakGuard, weakArgvOnlyLeakGuard, type LeakGuard } from "./teardown.ts";
import { readProcCmdline, isAlive, pgrepF } from "./proc-io.ts";

export type SelfTestOutcome = "OK" | "FAIL" | "SKIP";

/** The verifier the bad-flags self-test uses. Signature matches the pure
 *  `verifyLockdown` from lockdown.ts. */
export type LockdownVerifier = (cmd: ProcCmdline, env: ProcEnviron, exp: LockdownExpectations) => LockdownResult;

/** MUTANT for the bad-flags RED path. Always says OK — the shipping
 *  self-test with THIS verifier substituted must FAIL. */
export const okAlwaysVerifier: LockdownVerifier = () => ({ ok: true, summary: "muted" });

/** Run the bad-flags self-test. `verifier` is the DI hook — default is
 *  the real `verifyLockdown`; pass `okAlwaysVerifier` for RED evidence. */
export function runBadFlagsSelftest(
  logger: Logger,
  opts: {
    readonly claudeBin: string;
    readonly envBin: string;
    readonly path: string;
    readonly home: string;
    readonly claudeConfigDir: string;
    readonly verifier?: LockdownVerifier;
  },
): SelfTestOutcome {
  const verifier = opts.verifier ?? realVerifyLockdown;
  const stateBase = mkdtempSync(join(tmpdir(), "revkit-dogfood-selftest-bad-flags-"));
  const mcpConfigPath = join(stateBase, "mcp-config.json");
  const settingsPath = join(stateBase, "settings.json");
  const exp = makeExpectations(mcpConfigPath, settingsPath);
  // Build the argv the runtime would build, with the forbidden injection.
  const injected = buildClaudeArgv({
    claudeBin: opts.claudeBin,
    envBin: opts.envBin,
    mcpConfigPath,
    settingsPath,
    claudeConfigDir: opts.claudeConfigDir,
    path: opts.path,
    home: opts.home,
    term: "xterm-256color",
    lang: "C.UTF-8",
    injectBadFlags: true,
  });
  // /proc/<pid>/cmdline of the CLAUDE process is what verifier reads.
  // Strip the `env -i` prefix so the fixture matches the real /proc read.
  const envMarkerIdx = injected.indexOf(opts.claudeBin);
  const cmdline = injected.slice(envMarkerIdx).join("\0");
  // Synthesise the environ the child would have: exactly the five names
  // env -i sets, matching the harness's real allowlist.
  const environ =
    `PATH=${opts.path}\0HOME=${opts.home}\0CLAUDE_CONFIG_DIR=${opts.claudeConfigDir}\0` +
    "TERM=xterm-256color\0LANG=C.UTF-8\0";
  const cmd = parseCmdline(cmdline);
  const env = parseEnviron(environ);
  const result = verifier(cmd, env, exp);
  if (!result.ok) {
    logger.log(
      `SELFTEST OK: lockdown check aborted as expected on the injected forbidden flag (reason: ${result.reason ?? "unknown"})`,
    );
    return "OK";
  }
  logger.log(
    "SELFTEST FAIL: the injected forbidden flag (--tools default) was NOT caught — this is a real regression (or the RED-evidence path)",
  );
  return "FAIL";
}

/** Run the decoy-teardown self-test. `leakGuard` is the DI hook — default
 *  is the shipping `strictLeakGuard`; pass `weakArgvOnlyLeakGuard` for
 *  RED evidence. */
export async function runDecoyTeardownSelftest(
  logger: Logger,
  opts: { readonly leakGuard?: LeakGuard } = {},
): Promise<SelfTestOutcome> {
  const guard = opts.leakGuard ?? strictLeakGuard;
  const sleepPath = "/usr/bin/sleep";
  if (!existsSync(sleepPath)) {
    logger.log("SELFTEST-TEARDOWN: skipping — /usr/bin/sleep does not exist (need a standalone sleep for exec -a).");
    return "SKIP";
  }
  // Start the decoy: bash spawns sleep with argv[0] rewritten to look
  // like a revkit serve.
  const decoyArgv = "bun /nonexistent/packages/cli/bin/revkit.js serve --dir /nonexistent/dist";
  const decoyProc = spawn({
    cmd: ["bash", "-c", `exec -a ${JSON.stringify(decoyArgv)} bash -c "${sleepPath} 60 ; :"`],
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const decoyPid = decoyProc.pid;
  if (decoyPid === undefined) {
    logger.log("SELFTEST-TEARDOWN: could not start decoy");
    return "FAIL";
  }
  await sleep(500);
  if (!isAlive(decoyPid)) {
    logger.log(`SELFTEST-TEARDOWN: decoy pid ${decoyPid} died at startup — cannot run the regression test`);
    return "FAIL";
  }
  const cmd = readProcCmdline(decoyPid);
  if (cmd === undefined || !cmd.raw.includes("revkit.js serve")) {
    logger.log(
      `SELFTEST-TEARDOWN: decoy pid ${decoyPid} did not preserve 'revkit.js serve' in cmdline (was: '${cmd?.raw ?? "<none>"}')`,
    );
    try {
      decoyProc.kill("SIGKILL");
    } catch {
      // best-effort
    }
    return "FAIL";
  }
  const visibleToPgrep = pgrepF("revkit\\.js serve").includes(decoyPid);
  if (!visibleToPgrep) {
    logger.log(`SELFTEST-TEARDOWN: decoy pid ${decoyPid} not visible via pgrep -f 'revkit\\.js serve'`);
    try {
      decoyProc.kill("SIGKILL");
    } catch {
      // best-effort
    }
    return "FAIL";
  }
  logger.log(
    `SELFTEST-TEARDOWN: decoy alive (pid ${decoyPid}, sleep=${sleepPath}, matches pgrep 'revkit.js serve')`,
  );
  logger.log("SELFTEST-TEARDOWN: triggering teardown — the shipping teardown must reach 'teardown complete'");
  // Build a minimal teardown against a fresh state dir that is
  // guaranteed NOT to be the decoy's cwd.
  const stateDir = mkdtempSync(join(tmpdir(), "revkit-dogfood-selftest-decoy-"));
  const teardown = makeTeardown({
    logger,
    sweep: guard,
    state: {
      pane: undefined as PaneHandle | undefined,
      daemon: undefined as DaemonHandle | undefined,
      playwrightPid: undefined,
      selftestDecoyPid: decoyPid,
      stateDirPath: stateDir,
      claudeConfigDir: "",
      keepDaemonLog: false,
      daemonLogFinalPath: undefined,
      artifactsDir: undefined,
      extraProfileDirs: [],
    },
  });
  const sweepOk = teardown.run();
  // The decoy is killed at the END of teardown — verify.
  await sleep(200);
  if (isAlive(decoyPid)) {
    try {
      process.kill(decoyPid, "SIGKILL");
    } catch {
      // best-effort
    }
  }
  if (sweepOk) {
    logger.log(
      "SELFTEST-TEARDOWN OK: teardown reached 'teardown complete' and the sweep did not flag the unrelated decoy",
    );
    return "OK";
  }
  logger.log("SELFTEST-TEARDOWN FAIL: the sweep flagged the unrelated decoy as a leak (RED-evidence path?)");
  return "FAIL";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Re-export the mutant guard so the SKILL's assertion contract can name it.
export { weakArgvOnlyLeakGuard };
