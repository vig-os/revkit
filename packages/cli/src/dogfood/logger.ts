// Simple line-oriented logger. Every log line is prefixed with `[dogfood]`
// and mirrored to a file so the harness's transcript is grep-able. Two
// small variants:
//   - `log(msg)` prints one plain line.
//   - `logBlock(prefix, body)` prints each line of `body` prefixed with
//     `[dogfood <prefix>]`, running through the redactor first — used for
//     multi-line output blocks (pane reads, daemon stdout).
//
// The logger is a small class so the harness can be constructed with a
// no-op logger in unit tests without wiring env vars.

import { appendFileSync } from "node:fs";
import { redactAll, redactLine } from "./redact.ts";

export interface Logger {
  log(msg: string): void;
  logBlock(prefix: string, body: string): void;
  file(): string | undefined;
}

/** Real file-backed logger. */
export function makeLogger(logPath: string | undefined): Logger {
  const write = (line: string): void => {
    // Every stdout line also lands in the log file. Redact the line
    // (idempotent — the on-disk file must never carry a credential).
    const safe = redactLine(line);
    process.stdout.write(`${safe}\n`);
    if (logPath !== undefined) {
      try {
        appendFileSync(logPath, `${safe}\n`);
      } catch {
        // Best effort: a full disk shouldn't crash the harness.
      }
    }
  };
  return {
    log(msg: string): void {
      write(`[dogfood] ${msg}`);
    },
    logBlock(prefix: string, body: string): void {
      const clean = redactAll(body);
      for (const line of clean.split("\n")) {
        write(`[dogfood ${prefix}] ${line}`);
      }
    },
    file(): string | undefined {
      return logPath;
    },
  };
}

/** No-op logger for tests. */
export function silentLogger(): Logger {
  return {
    log(): void {},
    logBlock(): void {},
    file(): undefined {
      return undefined;
    },
  };
}
