// `revkit mode [<m>]` — read or change the daemon's delivery mode
// (M2 item 6, ADR-0007 / DESIGN-0001 §5.3).
//
// Without an argument, prints the current mode + batched count on
// stdout as one JSON object per invocation. With one argument in
// {handover, live, quiet}, POSTs the change and prints the new
// status. Every path is bearer-authed with the agent token from
// `.revkit/serve.json`; a missing daemon exits with a message and
// code 1 (unlike the hook, this command is user-facing).

import { findRepoRootByPackageJson } from "./repo-root.ts";
import { findRunningDaemon } from "./serve/serve-state.ts";
import { deliveryModes, parseMode, type DeliveryMode } from "./serve/delivery-modes.ts";

/** Environment `runModeCommand` needs. */
export interface RunModeEnv {
  readonly cwd: string;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  readonly fetch?: typeof globalThis.fetch;
  readonly findRunningDaemon?: typeof findRunningDaemon;
}

/** Result. */
export interface RunModeResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Parse the argv slice `revkit mode` received: either empty (GET) or
 * exactly one arg in {handover, live, quiet, --handover, ...}. */
export function parseModeArgs(args: readonly string[]):
  | { ok: true; mode?: DeliveryMode }
  | { ok: false; message: string } {
  if (args.length === 0) return { ok: true };
  if (args.length > 1) {
    return { ok: false, message: `revkit mode: unexpected argument '${args[1]}'` };
  }
  let raw = args[0]!;
  if (raw.startsWith("--")) raw = raw.slice(2);
  const parsed = parseMode(raw);
  if (parsed === undefined) {
    return {
      ok: false,
      message: `revkit mode: unknown mode '${args[0]}' (expected one of: ${deliveryModes.join(", ")})`,
    };
  }
  return { ok: true, mode: parsed };
}

/** Run `revkit mode`. Prints JSON status on stdout. */
export async function runModeCommand(args: readonly string[], env: RunModeEnv): Promise<RunModeResult> {
  const parsed = parseModeArgs(args);
  if (!parsed.ok) return { exitCode: 2, stdout: "", stderr: parsed.message + "\n" };
  const out = env.out ?? ((line) => process.stdout.write(line));
  const err = env.err ?? ((line) => process.stderr.write(line));
  let repoRoot: string;
  try {
    repoRoot = findRepoRootByPackageJson(env.cwd);
  } catch (error) {
    err(`${(error as Error).message}\n`);
    return { exitCode: 2, stdout: "", stderr: (error as Error).message + "\n" };
  }
  const discover = env.findRunningDaemon ?? findRunningDaemon;
  const state = discover(repoRoot);
  if (state === undefined) {
    err("revkit mode: no running daemon (`.revkit/daemon.lock` is free)\n");
    return { exitCode: 1, stdout: "", stderr: "revkit mode: no running daemon\n" };
  }
  const fetch = env.fetch ?? globalThis.fetch;
  try {
    let response: Response;
    if (parsed.mode !== undefined) {
      response = await fetch(`${state.url}/api/delivery-mode`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${state.agentToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ mode: parsed.mode }),
      });
    } else {
      response = await fetch(`${state.url}/api/delivery-mode`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${state.agentToken}`,
          accept: "application/json",
        },
      });
    }
    if (!response.ok) {
      const message = `revkit mode: daemon returned ${response.status}\n`;
      err(message);
      return { exitCode: 1, stdout: "", stderr: message };
    }
    const body = await response.text();
    out(body + "\n");
    return { exitCode: 0, stdout: body + "\n", stderr: "" };
  } catch (error) {
    const message = `revkit mode: ${(error as Error).message}\n`;
    err(message);
    return { exitCode: 1, stdout: "", stderr: message };
  }
}
