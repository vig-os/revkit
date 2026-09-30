// Teardown / cleanup.
//
// PR #42 round-6 hardening — this module preserves every property the
// bash version established over 7 review rounds:
//
//   1. IDEMPOTENT. bash runs the EXIT trap after SIGINT / SIGTERM, so
//      the ^C path fires cleanup twice; the guard flag makes cleanup a
//      one-shot. The TS equivalent registers `process.on("SIGINT"/…"SIGTERM"/
//      "exit"/"uncaughtException")` and stashes the same flag on the
//      Teardown object.
//   2. BEST-EFFORT. A single failing step never stops the rest — each
//      is wrapped in try/catch. This mirrors the bash `set +e` at the
//      top of `cleanup()`.
//   3. SWEEP FOR LEAKS. After the ordered shutdown we scan for
//      revkit-serve pids by BOTH argv AND `/proc/<pid>/cwd` under
//      STATE_DIR. This is the round-3 nit that caught MCP-auto-spawned
//      daemons whose argv didn't name STATE_DIR.
//   4. CLOSE PANE BY ID AND BY NAME. When PANE_ID never got parsed but
//      the pane exists, `flk agent list | select .name == AGENT_NAME`
//      finds it.
//   5. PROFILE DIR: containment-checked; only THIS run's dir removed.
//   6. daemon.log unlink by default; redact-in-place when
//      REVKIT_DOGFOOD_KEEP_DAEMON_LOG=1.
//   7. Playwright pipeline killed FIRST (tree-kill; SIGTERM then SIGKILL).
//   8. Self-test decoy pid, when set, killed LAST (AFTER the sweep) so
//      the sweep has something to observe.
//
// The sweep is injectable via `LeakGuard` so the decoy-teardown self-
// test can substitute a weakened impl for RED evidence.

import { existsSync, rmSync, statSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import type { Logger } from "./logger.ts";
import type { DaemonHandle, PaneHandle } from "./types.ts";
import { agentList, paneClose } from "./flk.ts";
import { isAlive, pgrepF, readProcCwd } from "./proc-io.ts";
import { isSafeToRemoveProfileDir, projectDirFor } from "./containment.ts";
import { redactAll } from "./redact.ts";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

/** Injectable guard: given a state dir, return every pid that appears
 *  to belong to a revkit-serve rooted at (or claiming) that state dir.
 *  The shipping guard checks BOTH argv AND cwd (round-3 nit). Tests
 *  substitute a mutant that omits the cwd leg for RED evidence. */
export type LeakGuard = (stateDirPath: string) => number[];

/** Ship this guard by default. */
export const strictLeakGuard: LeakGuard = (stateDirPath) => {
  const byArgv = pgrepF(`revkit\\.js serve.*${stateDirPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  const byCwd = pgrepF("revkit\\.js serve").filter((pid) => {
    const cwd = readProcCwd(pid);
    return cwd !== undefined && cwd.startsWith(stateDirPath);
  });
  return dedupe([...byArgv, ...byCwd]);
};

/** A weakened guard that flags EVERY `revkit.js serve` process anywhere
 *  on the box — the mutant the decoy-teardown self-test uses for RED
 *  evidence. It omits the state-dir constraint on BOTH the argv match
 *  and the cwd match. Exported so the test injects it via the shipping
 *  code's DI hook, NOT a local copy. Under this guard, an unrelated
 *  daemon (owner's real dogfood daemon, a neighbouring worktree's test
 *  daemon, a decoy) is flagged as a leak and would be SIGKILL'd — the
 *  exact class of bug PR #42 round-2 fixed. */
export const weakArgvOnlyLeakGuard: LeakGuard = () => pgrepF("revkit\\.js serve");

/** Mutable, shared state the teardown reads at the moment it fires. */
export interface TeardownState {
  pane: PaneHandle | undefined;
  daemon: DaemonHandle | undefined;
  playwrightPid: number | undefined;
  selftestDecoyPid: number | undefined;
  stateDirPath: string | undefined;
  claudeConfigDir: string;
  keepDaemonLog: boolean;
  daemonLogFinalPath: string | undefined;
  artifactsDir: string | undefined;
  extraProfileDirs: readonly string[]; // reserved
}

export interface Teardown {
  readonly state: TeardownState;
  run(): boolean; // returns `sweep_ok` (true = no leaks found)
}

/** Build a teardown that closes over the shared state. `sweep` selects
 *  the leak-guard implementation (`strictLeakGuard` in shipping code). */
export function makeTeardown(opts: {
  readonly logger: Logger;
  readonly sweep: LeakGuard;
  readonly state: TeardownState;
}): Teardown {
  let ran = false;
  return {
    state: opts.state,
    run(): boolean {
      if (ran) return true;
      ran = true;
      const { logger, sweep, state } = opts;
      logger.log("teardown starting");
      // 1. Kill Playwright FIRST so the poll doesn't wedge us.
      if (state.playwrightPid !== undefined) {
        const pid = state.playwrightPid;
        state.playwrightPid = undefined;
        if (isAlive(pid)) {
          logger.log(`killing in-flight Playwright pipeline (pid ${pid}) and its descendants`);
          try {
            spawnSync("pkill", ["-TERM", "-P", String(pid)]);
          } catch {
            // best-effort
          }
          safeKill(pid, "SIGTERM");
          waitDeadFor(pid, 1_000);
          try {
            spawnSync("pkill", ["-9", "-P", String(pid)]);
          } catch {
            // best-effort
          }
          safeKill(pid, "SIGKILL");
        }
      }
      // 2. Snapshot the pane (final read) and close it.
      if (state.pane !== undefined) {
        const paneId = state.pane.paneId;
        if (paneId !== undefined) {
          logger.log("pane final read (redacted):");
          const buf = readPaneSafely(paneId);
          if (buf !== undefined) logger.logBlock("pane", buf);
          if (paneClose(paneId)) logger.log(`closed pane ${paneId}`);
        }
        // Name-based sweep for the "start succeeded but pane-id parse failed" leak.
        const agentName = state.pane.agentName;
        const agents = agentList();
        if (agents !== undefined) {
          const hit = agents.find((a) => a.name === agentName);
          if (hit?.pane_id !== undefined && hit.pane_id !== paneId) {
            logger.log(`found leftover pane ${hit.pane_id} by AGENT_NAME=${agentName}, closing`);
            paneClose(hit.pane_id);
          }
        }
      }
      // 3. Kill the daemon we started.
      if (state.daemon !== undefined) {
        const daemonPid = state.daemon.pid;
        if (isAlive(daemonPid)) {
          logger.log(`killing daemon pid ${daemonPid}`);
          safeKill(daemonPid, "SIGTERM");
          waitDeadFor(daemonPid, 4_000);
          if (isAlive(daemonPid)) {
            logger.log("daemon didn't stop on SIGTERM — SIGKILLing");
            safeKill(daemonPid, "SIGKILL");
            waitDeadFor(daemonPid, 500);
          }
        }
      }
      // 4. POST-TEARDOWN SELF-CHECK.
      let sweepBad = false;
      if (state.pane !== undefined) {
        const agents = agentList();
        const still = agents?.find((a) => a.name === state.pane!.agentName)?.pane_id;
        if (still !== undefined) {
          logger.log(`SELF-CHECK: leaked pane ${still} (name ${state.pane.agentName}) — forcing close`);
          paneClose(still);
          sweepBad = true;
        }
      }
      if (state.stateDirPath !== undefined) {
        const leaks = sweep(state.stateDirPath);
        if (leaks.length > 0) {
          logger.log(`SELF-CHECK: leaked revkit-serve pids ${leaks.join(" ")} — SIGKILLing`);
          for (const pid of leaks) {
            try {
              const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").slice(0, 200);
              logger.log(`SELF-CHECK: leaked pid ${pid} cmdline: ${cmdline}`);
            } catch {
              // pid may already be gone.
            }
            safeKill(pid, "SIGKILL");
          }
          sweepBad = true;
        }
        try {
          rmSync(state.stateDirPath, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
      // 5. Profile-dir cleanup, containment-checked.
      if (state.stateDirPath !== undefined && state.claudeConfigDir !== "") {
        const projectDir = projectDirFor(state.claudeConfigDir, state.stateDirPath);
        const runBase = basename(state.stateDirPath);
        const projectsRoot = `${state.claudeConfigDir}/projects`;
        if (existsSync(projectDir)) {
          if (isSafeToRemoveProfileDir(projectDir, projectsRoot, runBase)) {
            logger.log(`removing this run's profile dir: ${projectDir}`);
            try {
              rmSync(projectDir, { recursive: true, force: true });
            } catch {
              // best-effort
            }
          } else {
            logger.log(`SAFETY: profile dir '${projectDir}' failed containment check; NOT removing`);
          }
        }
      }
      // 6. daemon.log — redact in place OR unlink.
      if (state.daemonLogFinalPath !== undefined) {
        try {
          if (existsSync(state.daemonLogFinalPath) && statSync(state.daemonLogFinalPath).isFile()) {
            if (state.keepDaemonLog) {
              const raw = readFileSync(state.daemonLogFinalPath, "utf8");
              const clean = redactAll(raw);
              writeFileSync(state.daemonLogFinalPath, clean);
              logger.log(`daemon.log kept (redacted): ${state.daemonLogFinalPath}`);
            } else {
              unlinkSync(state.daemonLogFinalPath);
            }
          }
        } catch {
          // best-effort
        }
      }
      // 7. Artifacts scratch dir.
      if (state.artifactsDir !== undefined) {
        try {
          if (existsSync(state.artifactsDir)) {
            rmSync(state.artifactsDir, { recursive: true, force: true });
          }
        } catch {
          // best-effort
        }
      }
      // 8. Self-test decoy — killed LAST so the sweep saw it.
      if (state.selftestDecoyPid !== undefined) {
        const decoy = state.selftestDecoyPid;
        state.selftestDecoyPid = undefined;
        safeKill(decoy, "SIGKILL");
        logger.log(`SELFTEST-TEARDOWN: killed decoy pid ${decoy} (after sweep)`);
      }
      logger.log("teardown complete");
      return !sweepBad;
    },
  };
}

/** Install the process-signal handlers that fire the teardown once,
 *  return a function the main path calls on happy exit. */
export function installSignalHandlers(teardown: Teardown, logger: Logger): { runOnce: () => boolean } {
  const runOnce = (): boolean => teardown.run();
  const onSignal = (signal: NodeJS.Signals) => (): void => {
    logger.log(`received ${signal}`);
    runOnce();
    // Exit the process after cleanup; use 130 for SIGINT convention.
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", onSignal("SIGINT"));
  process.on("SIGTERM", onSignal("SIGTERM"));
  process.on("uncaughtException", (err) => {
    try {
      logger.log(`uncaught: ${(err as Error).message}`);
    } catch {
      // best-effort
    }
    runOnce();
    process.exit(1);
  });
  return { runOnce };
}

// -- helpers -------------------------------------------------------------

function safeKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Best-effort.
  }
}

function waitDeadFor(pid: number, ms: number): void {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    // Busy-wait in short slices — teardown is one-shot, so a synchronous
    // sleep(50) is fine. Bun.sleepSync is available on Bun >= 1.0; on
    // Node we fall back to a small out-of-process sleep.
    const bunAny = Bun as unknown as { sleepSync?: (ms: number) => void };
    if (typeof bunAny.sleepSync === "function") {
      bunAny.sleepSync(50);
    } else {
      spawnSync("sleep", ["0.05"]);
    }
  }
}

function dedupe(pids: readonly number[]): number[] {
  return Array.from(new Set(pids));
}

function readPaneSafely(paneId: string): string | undefined {
  try {
    const r = spawnSync("flk", ["agent", "read", paneId, "--lines", "80"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    if (r.status !== 0) return undefined;
    try {
      const parsed = JSON.parse(r.stdout?.toString?.() ?? "{}") as { result?: { read?: { text?: string } } };
      return parsed.result?.read?.text ?? undefined;
    } catch {
      return undefined;
    }
  } catch {
    return undefined;
  }
}

/** Types re-export so callers don't need to know the module split. */
export type { LeakGuard as _LeakGuard };
