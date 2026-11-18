// CLI glue for `revkit serve` — parses `--dir` and `--port`, resolves
// the served directory against the current working directory, mints or
// reads the local user id from `.revkit/local-user`, starts the daemon
// with `announce: true` and blocks until the process is signalled.
//
// Kept away from `daemon.ts` so a caller (the CLI dispatcher, or a
// test that wants to run `startDaemon` directly) does not pick up the
// argv parser and the "block forever" behaviour they don't want.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { randomBytes } from "node:crypto";
import { startDaemon, type StartDaemonOptions } from "./daemon.ts";
import {
  acquireStartingLock,
  cleanupOrphanedStagingDirs,
  clearStartFailure,
  ensureRevkitDir,
  newDistStagingName,
  promoteStagingDir,
  writeStartFailure,
  type AcquiredStartingDaemon,
} from "./serve-state.ts";
import { findRepoRootByPackageJson } from "../repo-root.ts";
import { defaultConsumerDist } from "../build/packaged.ts";
import { runBuildCommand } from "../build/cli.ts";
import { computeInputFingerprint } from "./input-fingerprint.ts";
import { mintToken } from "./auth.ts";

/** One CLI invocation of `revkit serve`. `blockForever` is a Promise
 * the caller can await; it resolves when the daemon stops. */
export interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly blockForever?: Promise<void>;
}

/** Environment `runServeCommand` needs — process cwd and the version
 * to record in `serve.json`. Kept explicit so tests can inject a
 * temporary directory. */
export interface RunServeEnv {
  readonly cwd: string;
  readonly version: string;
  /** Slug used by an auto-build's `revkit check` pass. Optional
   * because the pre-#57 tests don't supply it; the auto-build path
   * runs `--online: false` anyway. */
  readonly repoSlug?: string;
  /** Test hook: swap out the auto-build step. #251 B1 tests drive
   * the signal-abort + start-failure path without invoking the
   * real 3-minute astro build. Shape matches `runBuildCommand`
   * (args + env → RunBuildResult). Production callers never set
   * this — the default is `runBuildCommand`. */
  readonly runBuildOverride?: typeof runBuildCommand;
  /** Test hook: swap out `startDaemon`. #251 B1 tests drive the
   * post-build failure path without binding a real HTTP server.
   * Production callers never set this. */
  readonly startDaemonOverride?: typeof startDaemon;
}

/** True for a startDaemon error that is a lock-contention race, not
 * a bind-time failure the user needs to fix (#251 round 3 BLOCKER 2
 * (a)). `revkit serve`'s own lock-refused wording is matched here
 * so the filter stays co-located with the writer. */
function isLockContentionError(message: string): boolean {
  return (
    message.includes("another revkit daemon") ||
    message.includes("another daemon holds") ||
    message.includes(".revkit/daemon.lock")
  );
}

/** Parse `--dir <path>`, `--port <n>` and `--no-auto-build`. Returns
 * the parsed values or a usage error. */
export function parseServeArgs(args: readonly string[]): { ok: true; dir?: string; port?: number; noAutoBuild: boolean } | { ok: false; message: string } {
  let dir: string | undefined;
  let port: number | undefined;
  let noAutoBuild = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dir") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { ok: false, message: "revkit serve: --dir requires a value" };
      }
      dir = next;
      i++;
    } else if (arg?.startsWith("--dir=")) {
      dir = arg.slice("--dir=".length);
    } else if (arg === "--port") {
      const next = args[i + 1];
      if (next === undefined) {
        return { ok: false, message: "revkit serve: --port requires a value" };
      }
      const parsed = Number.parseInt(next, 10);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        return { ok: false, message: `revkit serve: --port must be an integer 0..65535 (got '${next}')` };
      }
      port = parsed;
      i++;
    } else if (arg?.startsWith("--port=")) {
      const raw = arg.slice("--port=".length);
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        return { ok: false, message: `revkit serve: --port must be an integer 0..65535 (got '${raw}')` };
      }
      port = parsed;
    } else if (arg === "--no-auto-build") {
      noAutoBuild = true;
    } else {
      return { ok: false, message: `revkit serve: unknown argument '${arg}'` };
    }
  }
  return {
    ok: true,
    ...(dir !== undefined ? { dir } : {}),
    ...(port !== undefined ? { port } : {}),
    noAutoBuild,
  };
}

/** Read the install-scoped local user id from
 * `.revkit/local-user`. Creates the file on first run with a random
 * base64url id. This is an OPAQUE tag (not the human's real name);
 * comments carry it as `actor.id` so a rename or a move never
 * invalidates an old comment (ADR-0011). */
export function readOrMintLocalUserId(repoRoot: string): string {
  const path = resolvePath(repoRoot, ".revkit", "local-user");
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8").trim();
    if (raw.length > 0) return raw;
  }
  const id = "local-" + randomBytes(9).toString("base64url");
  // Route through the one `.revkit/` directory owner in
  // `serve-state.ts` so the mode (0700) is consistent across every
  // entry point (round-4 review nit: an early `mkdir` here without
  // a mode left the dir at 0755).
  ensureRevkitDir(repoRoot);
  writeFileSync(path, id + "\n", { mode: 0o600 });
  return id;
}

/** Run `revkit serve` with the given argv slice. Starts the daemon
 * with `installSignalHandlers: true` and returns a `blockForever`
 * promise the CLI wrapper can await. Errors before bind (bad --dir,
 * another daemon running) return an exit code with the message on
 * stderr; errors after bind bubble up through the daemon's log.
 *
 * D1 auto-build (M5 part 2, issue #57): when `--dir` is absent, the
 * consumer's `<repoRoot>/.revkit/dist/` is the default. If that
 * directory does not exist, `revkit build` runs first — unless
 * `--no-auto-build` was passed, in which case the command refuses
 * with a message that names the exact command to run.
 *
 * The default `--dir` is
 *   - `<repoRoot>/.revkit/dist/` (packaged / consumer flow)
 * and NOT `site/dist` any more (issue #57): a repo that has both
 * still resolves the packaged path first, matching where `revkit
 * build` writes. The revkit repo itself keeps a working
 * `site/dist` from `bun run build` for the Playwright suite; the
 * dogfood flow will start writing to `.revkit/dist` too once M5
 * part 2 lands there. */
export async function runServeCommand(args: readonly string[], env: RunServeEnv): Promise<RunResult> {
  const parsed = parseServeArgs(args);
  if (!parsed.ok) {
    return { exitCode: 2, stdout: "", stderr: parsed.message + "\n" };
  }
  let repoRoot: string;
  try {
    repoRoot = findRepoRootByPackageJson(env.cwd);
  } catch (error) {
    return { exitCode: 2, stdout: "", stderr: `${(error as Error).message}\n` };
  }

  // Default dir resolution + auto-build. When `--dir` was passed
  // explicitly, respect it (no auto-build). When absent, prefer
  // `.revkit/dist/` (M5 part 2 convention); if that's missing, run
  // `revkit build` first unless `--no-auto-build`.
  const explicitDir = parsed.dir;
  const stdoutLines: string[] = [];
  let dir: string;
  let needsAutoBuild = false;
  if (explicitDir !== undefined) {
    dir = resolvePath(repoRoot, explicitDir);
  } else {
    const packagedDist = resolvePath(repoRoot, ".revkit", "dist");
    // Backwards compatibility: revkit's own repo has a `site/dist`
    // written by `bun run build` before `revkit serve` — if
    // `.revkit/dist` is missing but `site/dist` exists, use that.
    // Consumers with no `site/` never hit this branch.
    const legacySiteDist = resolvePath(repoRoot, "site", "dist");
    if (existsSync(packagedDist)) {
      dir = packagedDist;
    } else if (existsSync(legacySiteDist)) {
      dir = legacySiteDist;
    } else if (parsed.noAutoBuild) {
      return {
        exitCode: 2,
        stdout: "",
        stderr:
          `revkit serve: no built site at '${packagedDist}' and --no-auto-build was passed. ` +
          `Run 'revkit build' first (or drop --no-auto-build to have serve build for you).\n`,
      };
    } else {
      // Auto-build needed. We MUST take `.revkit/daemon.lock` BEFORE
      // the build runs so a concurrent `ensureDaemon` sees a
      // "starting" record and waits on readiness instead of spawning
      // another daemon that races into the same `.revkit/dist` (#251).
      dir = packagedDist;
      needsAutoBuild = true;
    }
  }

  // #251: when an auto-build is needed, claim the daemon lock and
  // publish a "starting" serve.json record BEFORE the build runs so a
  // concurrent `ensureDaemon` sees we are starting and WAITS on
  // readiness instead of spawning another daemon that races into the
  // same `.revkit/dist`. When no auto-build is needed (explicit
  // `--dir`), the legacy startDaemon-internal lock acquisition is
  // enough — serve.json stays unwritten until bind, which matches the
  // pre-#251 shape consumer-side scripts rely on (`bootDaemon`
  // helpers in site/tests read `serve.json` directly and expect
  // ready-state fields).
  let acquired: AcquiredStartingDaemon | undefined;
  let serveInstanceId: string | undefined;
  let serveStartedAt: string | undefined;
  if (needsAutoBuild) {
    serveInstanceId = mintToken();
    serveStartedAt = new Date().toISOString();
    const result = acquireStartingLock(repoRoot, {
      pid: process.pid,
      version: env.version,
      startedAt: serveStartedAt,
      instanceId: serveInstanceId,
    });
    if (result.kind === "already-running") {
      const existing = result.state;
      const where = existing !== undefined
        ? `pid ${existing.pid}${existing.url.length > 0 ? `, ${existing.url}` : ""}`
        : "no advertisement on disk";
      return {
        exitCode: 1,
        stdout: stdoutLines.length > 0 ? stdoutLines.join("\n") + "\n" : "",
        stderr:
          `revkit serve: another daemon holds .revkit/daemon.lock (${where}). Stop it, then retry.\n`,
      };
    }
    acquired = result;
  }

  // #251 round 3: once we hold the pre-bind lock we MUST clean up
  // before exiting on SIGINT / SIGTERM, or serve.json would stay
  // stuck on `status: "starting"`. The signal handlers below also
  // abort the in-flight auto-build via an AbortController so the
  // astro child (and its whole process group) dies with us
  // instead of continuing orphaned.
  //
  // SIGKILL safety is provided through the OUTPUT: the auto-build
  // writes to a private `.revkit/dist.staging-<pid>-<nonce>`
  // directory which this process atomically promotes to
  // `.revkit/dist` only after `check-dist` passes. If the parent
  // is SIGKILLed mid-build, the astro child's output lands in
  // its own staging dir and is NEVER promoted. The next cold
  // `revkit serve` sweeps stale staging dirs whose pid is dead.
  // Fd-inheritance into the child was reverted — a GC of the
  // Subprocess would close our serving daemon's own lock fd, which
  // was the round-3 reviewer's reproduced duplicate-daemon
  // scenario.
  const buildAbort = needsAutoBuild ? new AbortController() : undefined;
  let buildSignalHandlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = [];
  const abortedViaSignal = { reason: "" };
  if (acquired !== undefined && buildAbort !== undefined) {
    const onSignal = (signal: NodeJS.Signals): void => {
      abortedViaSignal.reason = signal;
      // Abort() is idempotent — a signal arriving after the build
      // already finished (during `startDaemon` pre-bind) is a
      // no-op on the AbortController but still tags the reason so
      // the post-startDaemon branch below can detect it.
      buildAbort.abort();
    };
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      const handler = () => onSignal(sig);
      buildSignalHandlers.push({ signal: sig, handler });
      process.on(sig, handler);
    }
  }
  const removeBuildSignalHandlers = (): void => {
    for (const { signal, handler } of buildSignalHandlers) {
      process.removeListener(signal, handler);
    }
    buildSignalHandlers = [];
  };

  // Private staging dir for the cold auto-build (#251 round 3).
  // Unused when no auto-build is needed; kept at a predictable name
  // so `cleanupOrphanedStagingDirs` finds and removes it after a
  // SIGKILL.
  let stagingDir: string | undefined;
  if (needsAutoBuild) {
    // Sweep stale staging dirs from SIGKILLed prior serves BEFORE
    // minting our own, so a crash-loop does not grow the tree.
    cleanupOrphanedStagingDirs(repoRoot);
    const nonce = randomBytes(6).toString("base64url");
    const stagingName = newDistStagingName(process.pid, nonce);
    stagingDir = resolvePath(repoRoot, ".revkit", stagingName);
    // The auto-build will create the dir; remove any stale same-named
    // leftover (pid collision after wrap-around — rare but cheap to
    // handle).
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      /* fine */
    }
  }
  const removeStaging = (): void => {
    if (stagingDir === undefined) return;
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      /* fine */
    }
  };

  if (needsAutoBuild) {
    // Auto-build the consumer's tree before serving. If it fails,
    // release the lock and surface the build error. A concurrent
    // ensureDaemon that saw the starting record then sees the lock
    // free (died while starting) and can retry or spawn.
    stdoutLines.push(`revkit serve: no dist at ${dir} — building first`);
    stdoutLines.push(`revkit serve: staging ${stagingDir}`);
    let buildResult;
    const build = env.runBuildOverride ?? runBuildCommand;
    try {
      buildResult = await build([], {
        cwd: env.cwd,
        version: env.version,
        repoSlug: env.repoSlug ?? "vig-os/revkit",
        ...(buildAbort !== undefined ? { signal: buildAbort.signal } : {}),
        // #251 round 3: route the astro build's output through a
        // private staging dir. serve atomically promotes it after
        // check-dist passes.
        ...(stagingDir !== undefined ? { distOutDir: stagingDir } : {}),
      });
    } catch (error) {
      removeBuildSignalHandlers();
      removeStaging();
      const abortedBySignal = buildAbort?.signal.aborted === true;
      const message = abortedBySignal
        ? `auto-build aborted by ${abortedViaSignal.reason || "signal"}`
        : `revkit serve: auto-build failed:\n${(error as Error).message}`;
      // A build-ending signal / abort is NEVER recorded as a
      // start-failure (#251 round 3 BLOCKER 2): the record is
      // reserved for genuine build or check-dist failures that
      // the user needs to fix. A transient abort would otherwise
      // wedge every future MCP auto-spawn until the user
      // manually removes the file.
      if (!abortedBySignal) {
        writeStartFailure(repoRoot, {
          stage: "build-failed",
          message,
          failedAt: new Date().toISOString(),
          version: env.version,
          inputs: { fingerprint: computeInputFingerprint(repoRoot) ?? "" },
        });
      }
      acquired?.release();
      return {
        exitCode: 1,
        stdout: stdoutLines.length > 0 ? stdoutLines.join("\n") + "\n" : "",
        stderr: `${message}\n`,
      };
    }
    if (buildResult.exitCode !== 0) {
      removeBuildSignalHandlers();
      removeStaging();
      const stderrTail = buildResult.stderr.slice(-4096);
      // If a signal arrived while the build was in flight, treat
      // this exit as an abort (not a build failure the user needs
      // to fix). We do NOT persist a start-failure for a signal
      // abort — see the matching comment on the catch branch.
      const abortedBySignal = buildAbort?.signal.aborted === true;
      const message = abortedBySignal
        ? `revkit serve: auto-build aborted by ${abortedViaSignal.reason || "signal"}`
        : "revkit serve: auto-build failed (see stderrTail)";
      if (!abortedBySignal) {
        writeStartFailure(repoRoot, {
          stage: "build-failed",
          message,
          stderrTail,
          failedAt: new Date().toISOString(),
          version: env.version,
          inputs: { fingerprint: computeInputFingerprint(repoRoot) ?? "" },
        });
      }
      acquired?.release();
      return {
        exitCode: buildResult.exitCode,
        stdout: buildResult.stdout,
        stderr: abortedBySignal
          ? `${message}\n`
          : `revkit serve: auto-build failed:\n${buildResult.stderr}`,
      };
    }
    if (buildResult.stdout.length > 0) stdoutLines.push(buildResult.stdout.trimEnd());
    // Build succeeded. Atomically promote the staging dir to
    // `.revkit/dist` while we still hold the daemon lock. If a
    // concurrent winner already published their output first
    // (kept-existing), we discard our staging dir and reuse theirs.
    if (stagingDir !== undefined) {
      const outcome = promoteStagingDir(stagingDir, dir);
      if (outcome.kind === "failed") {
        removeBuildSignalHandlers();
        removeStaging();
        const message = `revkit serve: could not promote staging dir to ${dir}: ${outcome.error ?? "unknown error"}`;
        writeStartFailure(repoRoot, {
          stage: "build-failed",
          message,
          failedAt: new Date().toISOString(),
          version: env.version,
          inputs: { fingerprint: computeInputFingerprint(repoRoot) ?? "" },
        });
        acquired?.release();
        return {
          exitCode: 1,
          stdout: stdoutLines.length > 0 ? stdoutLines.join("\n") + "\n" : "",
          stderr: `${message}\n`,
        };
      }
      if (outcome.kind === "kept-existing") {
        // Another cold serve won the race; use their dist and
        // discard ours. A later refactor could try to detect this
        // earlier, but it is strictly a transient during a two-
        // cold-start-at-once race, which the lock would otherwise
        // have also serialised.
        removeStaging();
        stdoutLines.push(`revkit serve: concurrent winner published ${dir}; staging discarded`);
      }
      stagingDir = undefined;
    }
  }
  // Build survived (or wasn't needed). Keep the pre-bind
  // handlers active through startDaemon's bind window so a SIGTERM
  // that arrives before the daemon's own handlers install doesn't
  // leak serve.json as "starting". We detect that case after
  // startDaemon returns (via `abortedViaSignal.reason`) and tear
  // the daemon back down cleanly.

  const options: StartDaemonOptions = {
    dir,
    repoRoot,
    port: parsed.port ?? 0,
    version: env.version,
    localUserId: readOrMintLocalUserId(repoRoot),
    announce: true,
    installSignalHandlers: true,
    ...(acquired !== undefined ? { acquired } : {}),
    ...(serveInstanceId !== undefined ? { acquiredInstanceId: serveInstanceId } : {}),
    ...(serveStartedAt !== undefined ? { acquiredStartedAt: serveStartedAt } : {}),
  };
  const startDaemonFn = env.startDaemonOverride ?? startDaemon;
  let handle;
  try {
    handle = await startDaemonFn(options);
  } catch (error) {
    removeBuildSignalHandlers();
    removeStaging();
    // #251 N1 / round 3: persist the failure so the MCP side (whose
    // spawn ignores stdio) can read the reason instead of re-
    // spawning blind on every tool call — but ONLY for a genuine
    // bind-time error (port permission denied, sqlite migration
    // refused). Transient races — a signal abort, or a lock
    // contention from a concurrent `revkit serve` that grabbed the
    // lock between our acquire window and startDaemon's — MUST NOT
    // land in `.revkit/start-failed.json`: they would otherwise
    // wedge every future MCP auto-spawn until the user manually
    // cleared the file (#251 round 3 BLOCKER 2 (a) + (c)).
    const message = (error as Error).message;
    const abortedBySignal = buildAbort?.signal.aborted === true;
    const lockContention = isLockContentionError(message);
    if (!abortedBySignal && !lockContention) {
      writeStartFailure(repoRoot, {
        stage: "start-failed",
        message: `revkit serve: startDaemon failed: ${message}`,
        failedAt: new Date().toISOString(),
        version: env.version,
        inputs: { fingerprint: computeInputFingerprint(repoRoot) ?? "" },
      });
    }
    acquired?.release();
    return {
      exitCode: 1,
      stdout: stdoutLines.length > 0 ? stdoutLines.join("\n") + "\n" : "",
      stderr: `${message}\n`,
    };
  }
  // #251 N1: the daemon bound cleanly. Any stale `start-failed.json`
  // from a prior failure is now irrelevant — clear it so the next
  // MCP tool call does not keep seeing the old error.
  clearStartFailure(repoRoot);
  // The daemon installed its own SIGINT / SIGTERM handlers inside
  // `startDaemon` (installSignalHandlers: true). Drop the pre-bind
  // handlers now so a signal fires the daemon's stop() path only.
  if (abortedViaSignal.reason.length > 0) {
    // A SIGINT/SIGTERM arrived during the bind window AFTER the
    // build had already finished (so the AbortController call was
    // a no-op). The daemon's handlers may or may not have been
    // active at that moment, so tear down deterministically here
    // instead of hoping Node's listener dispatch caught it.
    removeBuildSignalHandlers();
    void handle.stop();
    return {
      exitCode: 0,
      stdout: stdoutLines.length > 0 ? stdoutLines.join("\n") + "\n" : "",
      stderr: `revkit serve: aborted by ${abortedViaSignal.reason} during bind\n`,
    };
  }
  removeBuildSignalHandlers();
  // Return a `blockForever` promise the CLI top-level awaits so the
  // process does not exit until `stop()` resolves (either via a signal
  // or via the daemon's own error path).
  const blockForever = new Promise<void>((resolveDone) => {
    const originalStop = handle.stop.bind(handle);
    handle.stop = async (): Promise<void> => {
      await originalStop();
      resolveDone();
    };
  });
  return {
    exitCode: 0,
    stdout: stdoutLines.length > 0 ? stdoutLines.join("\n") + "\n" : "",
    stderr: "",
    blockForever,
  };
}
