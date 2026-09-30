// CLI glue for `revkit serve` — parses `--dir` and `--port`, resolves
// the served directory against the current working directory, mints or
// reads the local user id from `.revkit/local-user`, starts the daemon
// with `announce: true` and blocks until the process is signalled.
//
// Kept away from `daemon.ts` so a caller (the CLI dispatcher, or a
// test that wants to run `startDaemon` directly) does not pick up the
// argv parser and the "block forever" behaviour they don't want.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { randomBytes } from "node:crypto";
import { startDaemon, type StartDaemonOptions } from "./daemon.ts";
import { ensureRevkitDir } from "./serve-state.ts";
import { findRepoRootByPackageJson } from "../repo-root.ts";

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
}

/** Parse `--dir <path>` and `--port <n>` off an argv slice. Returns
 * the parsed values or a usage error. */
export function parseServeArgs(args: readonly string[]): { ok: true; dir?: string; port?: number } | { ok: false; message: string } {
  let dir: string | undefined;
  let port: number | undefined;
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
    } else {
      return { ok: false, message: `revkit serve: unknown argument '${arg}'` };
    }
  }
  return {
    ok: true,
    ...(dir !== undefined ? { dir } : {}),
    ...(port !== undefined ? { port } : {}),
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
 * stderr; errors after bind bubble up through the daemon's log. */
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
  const dir = resolvePath(repoRoot, parsed.dir ?? "site/dist");
  const options: StartDaemonOptions = {
    dir,
    repoRoot,
    port: parsed.port ?? 0,
    version: env.version,
    localUserId: readOrMintLocalUserId(repoRoot),
    announce: true,
    installSignalHandlers: true,
  };
  let handle;
  try {
    handle = await startDaemon(options);
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: `${(error as Error).message}\n` };
  }
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
    stdout: "",
    stderr: "",
    blockForever,
  };
}
