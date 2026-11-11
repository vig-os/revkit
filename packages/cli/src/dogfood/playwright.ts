// Drive `site/scripts/dogfood-playwright.ts`. That script uses
// `@playwright/test` which is only installed in the `site` workspace, so
// we `Bun.spawn` from that dir. This module is a thin wrapper — the
// Playwright script itself is unchanged from PR #53.

import { spawn, type Subprocess } from "bun";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Logger } from "./logger.ts";
import type { DaemonHandle } from "./types.ts";
import { redactLine } from "./redact.ts";

export interface PlaywrightResult {
  readonly ok: boolean;
  readonly latencyMs?: number;
  readonly screenshotAt?: string;
  readonly pid: number | undefined;
}

/** Run the site-side Playwright script. */
export async function runPlaywright(opts: {
  readonly repoRoot: string;
  readonly nonce: string;
  readonly stateDir: string;
  readonly logger: Logger;
  readonly bunBin: string;
  readonly registerPid: (pid: number | undefined) => void;
}): Promise<PlaywrightResult> {
  const artifacts = mkdtempSync(join(tmpdir(), "revkit-dogfood-artifacts-"));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    REVKIT_DOGFOOD_NONCE: opts.nonce,
    REVKIT_DOGFOOD_STATE_DIR: opts.stateDir,
    REVKIT_DOGFOOD_ARTIFACTS_DIR: artifacts,
  };
  const cmd = [opts.bunBin, join(opts.repoRoot, "site/scripts/dogfood-playwright.ts")];
  const proc: Subprocess = spawn({
    cmd,
    cwd: join(opts.repoRoot, "site"),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  opts.registerPid(proc.pid ?? undefined);
  let latencyMs: number | undefined;
  const captureAndReport = async (label: string, stream: ReadableStream<Uint8Array> | null): Promise<void> => {
    if (stream === null) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let carry = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        if (carry !== "") {
          const clean = redactLine(carry);
          opts.logger.log(`[playwright ${label}] ${clean}`);
          const match = /reply_latency_ms=(\d+)/.exec(clean);
          if (match) latencyMs = Number.parseInt(match[1]!, 10);
        }
        return;
      }
      const buf = carry + decoder.decode(chunk.value, { stream: true });
      const lines = buf.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") continue;
        const clean = redactLine(line);
        opts.logger.log(`[playwright ${label}] ${clean}`);
        const match = /reply_latency_ms=(\d+)/.exec(clean);
        if (match) latencyMs = Number.parseInt(match[1]!, 10);
      }
    }
  };
  await Promise.all([
    captureAndReport("out", proc.stdout as unknown as ReadableStream<Uint8Array> | null),
    captureAndReport("err", proc.stderr as unknown as ReadableStream<Uint8Array> | null),
  ]);
  const status = await proc.exited;
  opts.registerPid(undefined);
  const shot = join(artifacts, "reply-visible.png");
  const okShot = existsSync(shot) && statSync(shot).isFile();
  return {
    ok: status === 0,
    latencyMs,
    screenshotAt: okShot ? shot : undefined,
    pid: undefined,
  };
}

/** Type alias for one daemon field callers occasionally want. */
export type _DaemonUrl = DaemonHandle["url"];
