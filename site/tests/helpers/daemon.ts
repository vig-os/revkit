import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BOOT_TIMEOUT_MS = 15_000;
const OUTPUT_LIMIT = 8192;
const GRACEFUL_EXIT_TIMEOUT_MS = 3_000;
const liveChildren = new Set<ChildProcess>();
let handlersInstalled = false;

function track(child: ChildProcess): void {
  liveChildren.add(child);
  child.once("exit", () => liveChildren.delete(child));
  child.once("error", () => liveChildren.delete(child));
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.once("exit", () => { for (const c of liveChildren) c.kill("SIGKILL"); });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      for (const c of liveChildren) c.kill("SIGKILL");
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

/** Stop only a child we own, waiting for exit before a restart can take its lock. */
export async function stopDaemon(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  await new Promise<void>((done) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), GRACEFUL_EXIT_TIMEOUT_MS);
    child.once("exit", () => { clearTimeout(timer); done(); });
    child.kill("SIGTERM");
  });
}

/** Diagnostics must never expose the single-use launch code or bearer tokens. */
function redact(output: string): string {
  return output
    .replace(/([?&]code=)[^\s&]+/g, "$1[redacted]")
    .replace(/("?(?:agentToken|instanceId)"?\s*[:=]\s*"?)[^"\s,}]+/g, "$1[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}

/** One spawn and event-driven readiness path, including the fake review fixture.
 * The parser sees complete stdout lines, never partially written JSON. */
export async function bootProcess<T>(options: {
  readonly args: readonly string[];
  readonly root: string;
  readonly ready: (line: string) => T | undefined;
  readonly timeoutMs?: number;
  readonly command?: string;
}): Promise<{ child: ChildProcess; info: T; elapsedMs: number }> {
  const started = performance.now();
  const child = spawn(options.command ?? "bun", [...options.args], {
    cwd: options.root,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  track(child);
  let stdout = "";
  let stderr = "";
  let pending = "";
  try {
    const info = await new Promise<T>((resolveReady, rejectReady) => {
      let settled = false;
      const fail = (reason: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectReady(new Error(
          `daemon boot ${reason}; elapsed=${Math.round(performance.now() - started)}ms; ` +
          `exitCode=${child.exitCode}; signal=${child.signalCode}; ` +
          `alive=${child.pid !== undefined && child.exitCode === null && child.signalCode === null}\n` +
          `last stderr lines:\n${redact(stderr)}\nlast stdout lines:\n${redact(stdout)}`,
        ));
      };
      const timer = setTimeout(() => fail("timed out"), options.timeoutMs ?? BOOT_TIMEOUT_MS);
      child.once("error", (error) => fail(`spawn failed: ${error.message}`));
      child.once("exit", () => fail("exited before readiness"));
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-OUTPUT_LIMIT);
      });
      child.stdout!.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdout = (stdout + text).slice(-OUTPUT_LIMIT);
        if (settled) return;
        pending = (pending + text).slice(-OUTPUT_LIMIT);
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          try {
            const ready = options.ready(line);
            if (ready !== undefined) {
              clearTimeout(timer);
              settled = true;
              resolveReady(ready);
              return;
            }
          } catch (error) {
            fail(`invalid readiness: ${(error as Error).message}`);
          }
        }
      });
    });
    const elapsedMs = Math.round(performance.now() - started);
    if (process.env.REVKIT_E2E_TIMINGS === "1") {
      process.stderr.write(`[daemon boot] ready=${elapsedMs}ms\n`);
    }
    return { child, info, elapsedMs };
  } catch (error) {
    await stopDaemon(child);
    throw error;
  }
}

export interface DaemonInfo {
  readonly url: string;
  readonly port: number;
  readonly agentToken: string;
  readonly launchUrl: string;
}

/** The existing launch announcement is emitted after serve.json is published. */
export async function bootDaemon(options: {
  readonly root: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
}): Promise<DaemonInfo & { child: ChildProcess; root: string }> {
  const { child, info } = await bootProcess<DaemonInfo>({
    ...options,
    ready: (line) => {
      const launchUrl = line.match(/^\s*launch:\s+(\S+)/)?.[1];
      if (launchUrl === undefined) return undefined;
      const state = JSON.parse(readFileSync(join(options.root, ".revkit", "serve.json"), "utf8")) as DaemonInfo;
      return { url: state.url, port: state.port, agentToken: state.agentToken, launchUrl };
    },
  });
  return { ...info, child, root: options.root };
}

export async function bootReviewDaemon<T>(options: {
  readonly root: string;
  readonly args: readonly string[];
}): Promise<T & { child: ChildProcess; root: string }> {
  const { child, info } = await bootProcess<T>({
    ...options,
    timeoutMs: 30_000,
    ready: (line) => line.trim().startsWith("{") ? JSON.parse(line.trim()) as T : undefined,
  });
  return { ...info, child, root: options.root };
}
