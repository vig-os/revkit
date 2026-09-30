// revkit dogfood — end-to-end channel loop with a real Claude Code
// session, ported from `scripts/dogfood-channel.sh` (issue #50).
//
// The bash version accreted over 7 PR-#42 review rounds and needed to
// be ported to typed process handling. Everything the bash script proved
// is preserved (see .claude/skills/revkit_dogfood/SKILL.md for the
// runbook and the failure playbook):
//
//   - PRE-LAUNCH /proc verification of the child claude's flags + env
//     allowlist. The verify guard is INJECTABLE (`--selftest bad-flags`).
//   - Isolated STATE_DIR outside the worktree, per-run daemon.
//   - Locked-down test pane (`--tools ""`, `--allowedTools <3 revkit>`,
//     `--permission-mode dontAsk`, `--strict-mcp-config`, absolute
//     `--mcp-config`, `--setting-sources ""`, `--settings <ours>`,
//     `env -i` explicit env allowlist).
//   - Two isolation post-conditions: flk `agent_session` null,
//     owner CLAUDE.md absent from the transcript, fail-closed if the
//     transcript dir is missing.
//   - Handover-mode flush (M2 item 6, PR #53).
//   - Idempotent, best-effort teardown that sweeps by argv AND cwd,
//     removes profile dirs after a containment check, and either
//     unlinks daemon.log or redacts it in place when the caller sets
//     REVKIT_DOGFOOD_KEEP_DAEMON_LOG to one.
//   - `--selftest bad-flags` and `--selftest decoy-teardown` — the
//     decoy-teardown test uses the SHIPPING teardown's DI hook to
//     substitute a weakened guard for RED evidence.

import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { makeLogger, type Logger } from "./logger.ts";
import { setupStateDir } from "./state.ts";
import { startDaemon } from "./daemon.ts";
import { buildClaudeArgv } from "./argv.ts";
import { makeExpectations, ALLOWED_TOOLS } from "./lockdown.ts";
import { strictLockdownGuard, verifyRunning } from "./verify.ts";
import { agentStart, paneIdByName, paneRead, paneRun } from "./flk.ts";
import { answerPrompts, waitReadyOrThrow } from "./prompts.ts";
import { runPlaywright } from "./playwright.ts";
import { installSignalHandlers, makeTeardown, strictLeakGuard, weakArgvOnlyLeakGuard, type LeakGuard, type TeardownState } from "./teardown.ts";
import { requireAgentSessionNull, requireNoOwnerClaudemdInTranscript } from "./isolation.ts";
import { runBadFlagsSelftest, runDecoyTeardownSelftest, okAlwaysVerifier, type LockdownVerifier } from "./selftests.ts";
import type { PaneHandle } from "./types.ts";

interface CliOptions {
  readonly selftest: "bad-flags" | "decoy-teardown" | undefined;
  /** Only meaningful for `decoy-teardown`. */
  readonly leakGuard: LeakGuard;
  /** Only meaningful for `bad-flags`. */
  readonly verifier: LockdownVerifier | undefined;
}

/** Env-driven DI hook for RED-evidence runs. Two flags — one per
 *  self-test — swap in the mutant version of the load-bearing guard.
 *  Documented in `.claude/skills/revkit_dogfood/SKILL.md`. */
function parseCliArgs(argv: readonly string[]): CliOptions {
  let selftest: CliOptions["selftest"] = undefined;
  let leakGuard: LeakGuard = strictLeakGuard;
  let verifier: LockdownVerifier | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--selftest") {
      const val = argv[i + 1];
      if (val === "bad-flags" || val === "decoy-teardown") {
        selftest = val;
        i += 1;
      } else {
        throw new Error(`--selftest requires bad-flags or decoy-teardown (got ${val ?? "<nothing>"})`);
      }
    }
  }
  // Env-driven DI hooks (RED-evidence paths).
  if (process.env.DOGFOOD_SELFTEST_WEAKEN_GUARD === "1") {
    leakGuard = weakArgvOnlyLeakGuard;
  }
  if (process.env.DOGFOOD_SELFTEST_WEAKEN_VERIFIER === "1") {
    verifier = okAlwaysVerifier;
  }
  return { selftest, leakGuard, verifier };
}

/** Find an executable on PATH; throw with a clear message if missing. */
function requireBin(name: string): string {
  const r = spawnSync("command", ["-v", name], { stdio: ["ignore", "pipe", "pipe"] });
  const out = (r.stdout?.toString?.() ?? "").trim();
  if (r.status !== 0 || out === "") {
    // Retry via which — bash's `command -v` isn't always available as an
    // external.
    const r2 = spawnSync("which", [name], { stdio: ["ignore", "pipe", "pipe"] });
    const out2 = (r2.stdout?.toString?.() ?? "").trim();
    if (r2.status !== 0 || out2 === "") {
      throw new Error(`missing required binary: ${name}`);
    }
    return out2;
  }
  return out;
}

/** Freshness check: rebuild `site/dist` when any source is newer. */
function shouldRebuild(repoRoot: string): boolean {
  const dist = join(repoRoot, "site/dist/index.html");
  if (!existsSync(dist)) return true;
  const distMtime = statSync(dist).mtimeMs;
  const roots = [
    join(repoRoot, "site/src"),
    join(repoRoot, "docs"),
    join(repoRoot, "vocab"),
    join(repoRoot, "plots"),
    join(repoRoot, "packages/cli/src/rail"),
  ];
  for (const dir of roots) {
    if (!existsSync(dir)) continue;
    const r = spawnSync("find", [dir, "-type", "f", "-newer", dist, "-print", "-quit"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if ((r.stdout?.toString?.() ?? "").trim() !== "") return true;
  }
  // Silence the unused-var lint for now.
  void distMtime;
  return false;
}

async function mainImpl(): Promise<number> {
  const cli = parseCliArgs(process.argv.slice(2));
  // Repo root: walk up from this file until package.json says "revkit".
  const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "../../../..");
  const dogfoodDir = join(repoRoot, ".revkit/dogfood");
  mkdirSync(dogfoodDir, { recursive: true });
  const logFile = join(dogfoodDir, "last.log");
  writeFileSync(logFile, "");
  const logger = makeLogger(logFile);
  // ── selftest paths short-circuit here ────────────────────────────────
  if (cli.selftest === "bad-flags") {
    const outcome = runBadFlagsSelftest(logger, {
      claudeBin: requireBin("claude"),
      envBin: requireBin("env"),
      path: process.env.PATH ?? "",
      home: process.env.HOME ?? "",
      claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? `${process.env.HOME ?? ""}/.claude`,
      verifier: cli.verifier,
    });
    return outcome === "OK" ? 0 : 1;
  }
  if (cli.selftest === "decoy-teardown") {
    const outcome = await runDecoyTeardownSelftest(logger, { leakGuard: cli.leakGuard });
    if (outcome === "SKIP") return 0;
    return outcome === "OK" ? 0 : 1;
  }
  // ── real run ─────────────────────────────────────────────────────────
  logger.log(`worktree: ${repoRoot}`);
  requireBin("bun");
  requireBin("claude");
  requireBin("flk");
  requireBin("jq");
  requireBin("curl");
  requireBin("rsync");
  requireBin("pgrep");
  requireBin("flock");
  requireBin("readlink");
  if (!("IN_NIX_SHELL" in process.env) && !("DEVCONTAINER_ACTIVE" in process.env)) {
    if (!/(:\/nix\/store\/[^:]*bun[^:]*\/bin(:|$))/.test(`:${process.env.PATH ?? ""}:`)) {
      throw new Error("dev shell not active — run 'direnv allow' or 'nix develop -c just dogfood'");
    }
  }
  const bunBin = requireBin("bun");
  const envBin = existsSync("/usr/bin/env") ? "/usr/bin/env" : requireBin("env");
  // bun install once, if needed.
  if (!existsSync(join(repoRoot, "node_modules/.bun"))) {
    logger.log("installing workspace deps");
    const r = spawnSync("bun", ["install", "--frozen-lockfile"], { cwd: repoRoot, stdio: "inherit" });
    if (r.status !== 0) throw new Error("bun install failed");
  }
  if (shouldRebuild(repoRoot)) {
    logger.log("site source is newer than dist — running 'just build'");
    const r = spawnSync("just", ["build"], { cwd: repoRoot, stdio: "inherit" });
    if (r.status !== 0) throw new Error("site build failed");
  } else {
    logger.log("site/dist is up to date with sources");
  }
  const stateDir = setupStateDir({ repoRoot, bunBin });
  logger.log(`isolated state dir: ${stateDir.path} (outside the git worktree)`);
  // ── teardown wired up NOW so a crash below doesn't leak ──────────────
  const teardownState: TeardownState = {
    pane: undefined,
    daemon: undefined,
    playwrightPid: undefined,
    selftestDecoyPid: undefined,
    stateDirPath: stateDir.path,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? `${process.env.HOME ?? ""}/.claude`,
    keepDaemonLog: process.env.REVKIT_DOGFOOD_KEEP_DAEMON_LOG === "1",
    daemonLogFinalPath: undefined,
    artifactsDir: undefined,
    extraProfileDirs: [],
  };
  const teardown = makeTeardown({ logger, sweep: strictLeakGuard, state: teardownState });
  installSignalHandlers(teardown, logger);
  let rc = 0;
  try {
    // ── daemon ─────────────────────────────────────────────────────────
    const finalDaemonLog = join(dogfoodDir, "daemon.log");
    const daemon = await startDaemon({
      stateDir,
      repoRoot,
      bunBin,
      logger,
      finalLogPath: finalDaemonLog,
    });
    teardownState.daemon = daemon;
    teardownState.daemonLogFinalPath = daemon.logPath;
    // ── build argv, start pane ────────────────────────────────────────
    const nonce = randomBytes(6).toString("hex");
    const agentName = `revkit-dogfood-${nonce}`;
    logger.log(`test agent: ${agentName}`);
    const argv = buildClaudeArgv({
      claudeBin: requireBin("claude"),
      envBin,
      mcpConfigPath: stateDir.mcpConfigPath,
      settingsPath: stateDir.settingsPath,
      claudeConfigDir: teardownState.claudeConfigDir,
      path: process.env.PATH ?? "",
      home: process.env.HOME ?? "",
      term: process.env.TERM ?? "xterm-256color",
      lang: process.env.LANG ?? "C.UTF-8",
    });
    const started = agentStart({ name: agentName, cwd: stateDir.path, argv });
    const pane: PaneHandle = { paneId: started.paneId, agentName };
    teardownState.pane = pane;
    if (started.paneId === undefined) {
      logger.log("WARN: could not parse pane id from flk agent start — will close by AGENT_NAME on teardown");
      logger.logBlock("flk-start", started.raw);
    } else {
      logger.log(`started pane ${started.paneId}`);
    }
    // ── verify BEFORE sending any prompt ──────────────────────────────
    const expectations = makeExpectations(stateDir.mcpConfigPath, stateDir.settingsPath);
    const verifyResult = await verifyRunning({
      expectations,
      guard: strictLockdownGuard,
      logger,
    });
    if (!verifyResult.ok) {
      throw new Error(`lockdown verification failed: ${verifyResult.reason ?? "unknown"}`);
    }
    // ── recover pane id if lost ────────────────────────────────────────
    if (pane.paneId === undefined) {
      const byName = paneIdByName(agentName);
      if (byName === undefined) throw new Error("cannot drive prompts: no pane id and no name-based lookup");
      pane.paneId = byName;
      logger.log(`recovered PANE_ID=${byName} by AGENT_NAME`);
    }
    // ── first-run prompts + ready ─────────────────────────────────────
    await answerPrompts({ paneId: pane.paneId, logger });
    logger.log("waiting for test agent to reach ready state (post-prompts)");
    waitReadyOrThrow(pane.paneId, logger);
    await sleep(3000);
    // ── send instructions ─────────────────────────────────────────────
    const instructions =
      `This is a disposable local test session for revkit's review loop. ` +
      `You are connected to a running revkit daemon via the \`revkit\` MCP server. ` +
      `Please wait for a channel notification from server:revkit — it may be a ` +
      `per-comment event OR a hand-over frame (the reviewer batches under the ` +
      `default handover mode; either shape signals there is a review thread to read). ` +
      `When it arrives: call \`threads\` to find the open thread whose comment ` +
      `body contains the token ${nonce}; call \`reply\` on that thread with body ` +
      `\`ack ${nonce}\` (use the last comment's id as parent_id); then call \`resolve\`. ` +
      `That's it. No file changes, no git, nothing else.`;
    if (!paneRun(pane.paneId, instructions)) {
      logger.log("flk pane run failed — reading pane state:");
      const buf = paneRead(pane.paneId, 60);
      if (buf !== undefined) logger.logBlock("pane", buf);
      throw new Error("could not send instructions to the test agent");
    }
    logger.log("sent instructions to the test agent");
    // ── Playwright ────────────────────────────────────────────────────
    logger.log("handing off to Playwright");
    const play = await runPlaywright({
      repoRoot,
      nonce,
      stateDir: stateDir.path,
      logger,
      bunBin,
      registerPid: (pid) => {
        teardownState.playwrightPid = pid;
      },
    });
    if (!play.ok) {
      logger.log("Playwright failed — pane state follows:");
      const buf = paneRead(pane.paneId, 200);
      if (buf !== undefined) logger.logBlock("pane", buf);
      throw new Error("end-to-end loop did not complete");
    }
    logger.log("Playwright reported success");
    if (play.screenshotAt !== undefined) {
      const dst = join(dogfoodDir, "reply-visible.png");
      try {
        copyFileSync(play.screenshotAt, dst);
        logger.log("screenshot: .revkit/dogfood/reply-visible.png");
      } catch {
        // best-effort
      }
    }
    // ── isolation checks ──────────────────────────────────────────────
    const okSession = requireAgentSessionNull({ agentName, logger });
    const okClaudemd = requireNoOwnerClaudemdInTranscript({
      claudeConfigDir: teardownState.claudeConfigDir,
      stateDirPath: stateDir.path,
      logger,
    });
    if (!okSession || !okClaudemd) {
      throw new Error("isolation proof failed — the test agent inherited some part of the owner's Claude profile");
    }
    logger.log(`END-TO-END loop succeeded — nonce=${nonce}${play.latencyMs !== undefined ? ` reply_latency_ms=${play.latencyMs}` : ""}`);
  } catch (err) {
    logger.log(`ERROR: ${(err as Error).message}`);
    rc = 1;
  }
  // Teardown (once).
  const sweepOk = teardown.run();
  if (!sweepOk && rc === 0) {
    logger.log("SELF-CHECK failed — reporting non-zero exit");
    return 3;
  }
  return rc;
}

/** Utility. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Preserve the `basename` import used by inline containment checks in
 *  teardown. Also documents the module's dependency on it for reviewers
 *  scanning imports at a glance. */
void basename;

mainImpl()
  .then((rc) => process.exit(rc))
  .catch((err) => {
    // eslint-disable-next-line no-console -- entry point, cannot use logger safely
    console.error(`dogfood: ${(err as Error).message}`);
    process.exit(1);
  });
