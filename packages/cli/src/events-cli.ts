// `revkit events --follow` — line-oriented JSON stream of the daemon's
// events (M2 item 6, ADR-0007 Monitor-WebSocket fallback).
//
// Claude Code's `Monitor` tool can watch a shell command's stdout for
// notifications; each line becomes one Monitor frame. This command
// makes revkit's `/events?for=agent` stream fit that shape: one JSON
// object per line, escaped, agent-token authenticated, reconnect on
// close.
//
// The daemon's SSE payload is already JSON — we just re-emit the
// `data:` field on its own line. `JSON.stringify(event)` guarantees
// escaping (no raw newlines, no lone control chars), so a hostile
// comment body cannot break the line-per-frame contract Monitor
// depends on.
//
// The command is agent-bearer authed. It reads `.revkit/serve.json`
// through the shared `findRunningDaemon` helper (the daemon-lock is
// ground truth); a missing / stale daemon exits with code 1 and a
// diagnostic. Reconnect uses the same exponential backoff (500 ms
// → 30 s) the channel subscriber uses.

import { findRepoRootByPackageJson } from "./repo-root.ts";
import { findRunningDaemon } from "./serve/serve-state.ts";
import { startEventSubscriber } from "./mcp/event-subscriber.ts";

/** Environment `runEventsCommand` needs — swappable for tests. */
export interface RunEventsEnv {
  readonly cwd: string;
  /** Where each JSON line is written. Default: `process.stdout.write(line)`. */
  readonly out?: (line: string) => void;
  /** Where diagnostics go. Default: `process.stderr.write(line)`. */
  readonly err?: (line: string) => void;
  /** Test hook: swap `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Test hook: injected sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test hook: injected daemon discovery. */
  readonly findRunningDaemon?: typeof findRunningDaemon;
}

/** Result of the CLI subcommand. */
export interface RunEventsResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Resolves once the subscriber shuts down (Ctrl-C, daemon
   * disconnected + fatal). The CLI top-level awaits it. */
  readonly blockForever?: Promise<void>;
}

/** Parse the argv slice `revkit events` received. Supports `--follow`
 * (required for M2 — one-shot mode ships later), `--since <n>` (SSE
 * resume point) and `--dir` for parity with `revkit mcp`. */
export function parseEventsArgs(args: readonly string[]):
  | { ok: true; follow: boolean; since?: number; dir?: string }
  | { ok: false; message: string } {
  let follow = false;
  let since: number | undefined;
  let dir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--follow" || arg === "-f") follow = true;
    else if (arg === "--since") {
      const next = args[i + 1];
      if (next === undefined || !/^[0-9]+$/.test(next)) {
        return { ok: false, message: "revkit events: --since requires a non-negative integer" };
      }
      since = Number.parseInt(next, 10);
      i++;
    } else if (arg?.startsWith("--since=")) {
      const value = arg.slice("--since=".length);
      if (!/^[0-9]+$/.test(value)) {
        return { ok: false, message: "revkit events: --since requires a non-negative integer" };
      }
      since = Number.parseInt(value, 10);
    } else if (arg === "--dir") {
      const next = args[i + 1];
      if (next === undefined) return { ok: false, message: "revkit events: --dir requires a value" };
      dir = next;
      i++;
    } else if (arg?.startsWith("--dir=")) {
      dir = arg.slice("--dir=".length);
    } else {
      return { ok: false, message: `revkit events: unknown argument '${arg}'` };
    }
  }
  if (!follow) {
    return { ok: false, message: "revkit events: --follow is required (a one-shot mode ships later)" };
  }
  return {
    ok: true,
    follow,
    ...(since !== undefined ? { since } : {}),
    ...(dir !== undefined ? { dir } : {}),
  };
}

/** Run `revkit events --follow`. Blocks (via `blockForever`) until the
 * subscriber shuts down. Every event lands as one JSON line on
 * `out`; diagnostic messages go to `err`. */
export async function runEventsCommand(args: readonly string[], env: RunEventsEnv): Promise<RunEventsResult> {
  const parsed = parseEventsArgs(args);
  if (!parsed.ok) return { exitCode: 2, stdout: "", stderr: parsed.message + "\n" };

  let repoRoot: string;
  try {
    repoRoot = findRepoRootByPackageJson(env.cwd);
  } catch (error) {
    return { exitCode: 2, stdout: "", stderr: `${(error as Error).message}\n` };
  }

  const discover = env.findRunningDaemon ?? findRunningDaemon;
  const state = discover(repoRoot);
  if (state === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        "revkit events: no running daemon (`.revkit/daemon.lock` is free). " +
        "Start one with `revkit serve` in another terminal.\n",
    };
  }

  const out = env.out ?? ((line) => process.stdout.write(line));
  const err = env.err ?? ((line) => process.stderr.write(line));

  let shuttingDown = false;
  const handle = startEventSubscriber({
    url: state.url,
    agentToken: state.agentToken,
    ...(parsed.since !== undefined ? { since: parsed.since } : {}),
    ...(env.fetch !== undefined ? { fetch: env.fetch } : {}),
    ...(env.sleep !== undefined ? { sleep: env.sleep } : {}),
    onEvent: (event) => {
      // `JSON.stringify` handles every user-supplied field the event
      // carries — a `\n` in a comment body becomes `\\n`, a lone
      // `\r` becomes `\\r`. The result is safe to write on one line.
      // Bounded: the daemon caps comment bodies at 64 KiB, so a
      // single line is bounded too.
      out(JSON.stringify(event) + "\n");
    },
    onError: (error) => {
      if (shuttingDown) return;
      err(`revkit events: ${error.message}\n`);
    },
  });

  const blockForever = new Promise<void>((resolveDone) => {
    const onSignal = (): void => {
      shuttingDown = true;
      handle.close();
      resolveDone();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    // If the subscriber exits on its own (a fatal error) also resolve.
    void handle.done.finally(() => {
      shuttingDown = true;
      resolveDone();
    });
  });

  return { exitCode: 0, stdout: "", stderr: "", blockForever };
}
