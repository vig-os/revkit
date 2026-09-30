// CLI glue for `revkit mcp` — locates the daemon (auto-starting it if
// needed), constructs the `DaemonClient`, and hands control to the
// channel server bound to stdio. Blocks until the transport closes
// (Claude Code exits, `Ctrl-D`, etc).
//
// Kept separate from `channel-server.ts` so a test can call
// `startChannelServer(...)` against an in-memory transport without
// pulling in the argv parser or the daemon-bootstrap side effects.

import { resolve as resolvePath } from "node:path";
import { findRepoRootByPackageJson } from "../repo-root.ts";
import { ensureDaemon, verifyDaemonInstance } from "./daemon-bootstrap.ts";
import { DaemonClient } from "./daemon-client.ts";
import { startChannelServer, type DiscoverResult } from "./channel-server.ts";

/** Environment `runMcpCommand` needs. Kept explicit so tests can
 * inject a temporary directory. */
export interface RunMcpEnv {
  readonly cwd: string;
  readonly version: string;
}

/** Result of one `revkit mcp` invocation. */
export interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly blockForever?: Promise<void>;
}

/** Parse `--dir <path>` off an argv slice. Currently the only accepted
 * option — `revkit mcp` inherits the daemon's `--dir` default when
 * not given. */
export function parseMcpArgs(args: readonly string[]): { ok: true; dir?: string } | { ok: false; message: string } {
  let dir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dir") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { ok: false, message: "revkit mcp: --dir requires a value" };
      }
      dir = next;
      i++;
    } else if (arg?.startsWith("--dir=")) {
      dir = arg.slice("--dir=".length);
    } else {
      return { ok: false, message: `revkit mcp: unknown argument '${arg}'` };
    }
  }
  return { ok: true, ...(dir !== undefined ? { dir } : {}) };
}

/** Run `revkit mcp` end-to-end. Ensures a daemon is up, connects the
 * MCP server to stdio, and returns a `blockForever` promise the CLI
 * wrapper awaits. `stderr` carries user-visible startup notes; nothing
 * goes to `stdout` (stdio belongs to the MCP protocol). */
export async function runMcpCommand(args: readonly string[], env: RunMcpEnv): Promise<RunResult> {
  const parsed = parseMcpArgs(args);
  if (!parsed.ok) return { exitCode: 2, stdout: "", stderr: parsed.message + "\n" };
  let repoRoot: string;
  try {
    repoRoot = findRepoRootByPackageJson(env.cwd);
  } catch (error) {
    return { exitCode: 2, stdout: "", stderr: `${(error as Error).message}\n` };
  }
  let bootstrap;
  try {
    bootstrap = await ensureDaemon({
      repoRoot,
      ...(parsed.dir !== undefined ? { dir: parsed.dir } : {}),
    });
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: `revkit mcp: ${(error as Error).message}\n` };
  }
  const state = bootstrap.state;
  const client = new DaemonClient({
    url: state.url,
    agentToken: state.agentToken,
  });
  // Reconnect discovery for the channel server: re-run `ensureDaemon`
  // (auto-starts if the previous daemon is gone), then confirm via
  // `/-/health` that the running daemon really is the one
  // `serve.json` advertises. On a mismatch we discard the stale
  // state and re-run `ensureDaemon` once — the second boot returns
  // the fresh id. On repeated mismatch we surface an error so the
  // caller's bounded reconnect deadline can fire cleanly rather
  // than looping.
  const discover = async (_previous: { instanceId?: string } | undefined): Promise<DiscoverResult> => {
    let attempts = 0;
    while (true) {
      attempts++;
      const boot = await ensureDaemon({
        repoRoot,
        ...(parsed.dir !== undefined ? { dir: parsed.dir } : {}),
      });
      const next = boot.state;
      if (next.instanceId === undefined) {
        return { url: next.url, agentToken: next.agentToken };
      }
      let live: boolean;
      try {
        live = await verifyDaemonInstance(next.url, next.instanceId);
      } catch {
        // /-/health unreachable — daemon may be shutting down. Retry
        // once, then give up so the tool-call deadline can return
        // a clean isError.
        if (attempts >= 2) throw new Error("verifyDaemonInstance: /-/health unreachable");
        continue;
      }
      if (live) {
        return {
          url: next.url,
          agentToken: next.agentToken,
          instanceId: next.instanceId,
        };
      }
      if (attempts >= 2) {
        throw new Error(
          `verifyDaemonInstance: serve.json advertised '${next.instanceId}' but /-/health reported a different id (daemon replaced mid-discover)`,
        );
      }
      // Loop: serve.json was stale by the time we read /-/health.
      // ensureDaemon on the next iteration will see the fresh
      // state (or spawn a new one).
    }
  };

  let handle;
  try {
    handle = await startChannelServer({
      client,
      url: state.url,
      agentToken: state.agentToken,
      ...(state.instanceId !== undefined ? { instanceId: state.instanceId } : {}),
      version: env.version,
      discover,
    });
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: `revkit mcp: channel server failed to start: ${(error as Error).message}\n` };
  }
  const blockForever = new Promise<void>((resolveDone) => {
    // The MCP transport closes when the client (Claude Code)
    // disconnects. The server's `onclose` fires once at that point.
    // Wire a hook so `revkit mcp` exits cleanly with the transport.
    handle.server.onclose = (): void => {
      // Fire-and-forget teardown of the SSE subscriber.
      void handle.stop().then(() => resolveDone());
    };
    // Signals — Ctrl-C from the terminal, SIGTERM from a supervisor.
    const onSignal = (): void => {
      void handle.stop().then(() => resolveDone());
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
  const bootMsg = bootstrap.spawned
    ? `revkit mcp: started daemon (pid ${state.pid}, ${state.url})\n`
    : `revkit mcp: attached to daemon (pid ${state.pid}, ${state.url})\n`;
  return {
    exitCode: 0,
    stdout: "",
    // Emit to stderr so it does not clash with the MCP stdio channel.
    stderr: bootMsg,
    blockForever,
  };
}

// Re-export for the top-level dispatcher's ergonomic types.
export { resolvePath };
