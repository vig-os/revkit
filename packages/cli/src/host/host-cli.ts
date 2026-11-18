// `revkit host` CLI glue — parses `--config <path>` and boots the
// host-target server from the referenced JSON file. Separate from
// `server.ts` so a caller (the CLI dispatcher, a test harness that
// calls `startHostServer` directly) does not pick up the argv
// parser and the "block forever" behaviour they don't want.
//
// AC 1: no `.revkit/` workspace is required — the config file names
// every resource (sqlite path, static dir, socket path, …). The
// command is callable from a working directory that has nothing
// revkit-shaped in it.

import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { startHostServer, type HostHandle } from "./server.ts";
import { parseHostConfig, HostConfigError } from "./config.ts";

export interface RunHostResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly blockForever?: Promise<void>;
  readonly handle?: HostHandle;
}

export interface RunHostEnv {
  readonly cwd: string;
}

export interface ParsedHostArgs {
  readonly configPath: string;
}

export type ParseHostArgsResult =
  | { readonly ok: true; readonly value: ParsedHostArgs }
  | { readonly ok: false; readonly message: string };

/** Parse `--config <path>` out of a `revkit host` argv slice. */
export function parseHostArgs(args: readonly string[]): ParseHostArgsResult {
  let configPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--config") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { ok: false, message: "revkit host: --config requires a value" };
      }
      configPath = next;
      i++;
    } else if (arg !== undefined && arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
    } else {
      return { ok: false, message: `revkit host: unknown argument ${JSON.stringify(arg)}` };
    }
  }
  if (configPath === undefined) {
    return { ok: false, message: "revkit host: --config <path> is required" };
  }
  return { ok: true, value: { configPath } };
}

/** Run `revkit host <args>`; starts the server and returns a
 * `blockForever` promise the dispatcher awaits. */
export async function runHostCommand(args: readonly string[], env: RunHostEnv): Promise<RunHostResult> {
  const parsed = parseHostArgs(args);
  if (!parsed.ok) {
    return { exitCode: 2, stdout: "", stderr: parsed.message + "\n" };
  }
  const resolved = resolvePath(env.cwd, parsed.value.configPath);
  if (!existsSync(resolved)) {
    return { exitCode: 2, stdout: "", stderr: `revkit host: config file not found: ${resolved}\n` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolved, "utf8")) as unknown;
  } catch (error) {
    return { exitCode: 2, stdout: "", stderr: `revkit host: config is not valid JSON: ${(error as Error).message}\n` };
  }
  try {
    const config = parseHostConfig(raw);
    const handle = await startHostServer({ config });
    const blockForever = new Promise<void>((resolveDone) => {
      const originalStop = handle.stop.bind(handle);
      // Patch in-place so a signal handler can trigger shutdown
      // through the same promise.
      (handle as { stop: () => Promise<void> }).stop = async (): Promise<void> => {
        await originalStop();
        resolveDone();
      };
    });
    return {
      exitCode: 0,
      stdout: `revkit host: listening on ${handle.listenDescriptor}\n`,
      stderr: "",
      blockForever,
      handle,
    };
  } catch (error) {
    if (error instanceof HostConfigError) {
      return { exitCode: 2, stdout: "", stderr: error.message + "\n" };
    }
    return { exitCode: 1, stdout: "", stderr: `revkit host: ${(error as Error).message}\n` };
  }
}
