// Filesystem-facing helpers around /proc. Kept apart from the pure
// parsers so unit tests can exercise `parseCmdline` / `parseEnviron`
// on fixtures without any /proc dependency.
//
// The functions here run only on Linux. Every read is best-effort:
// EACCES on another user's process, ESRCH on a race — both return
// `undefined`.

import { readFileSync, readlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseCmdline, parseEnviron } from "./proc.ts";
import type { ProcCmdline, ProcEnviron } from "./types.ts";

/** Read /proc/<pid>/cmdline. Returns undefined on any error. */
export function readProcCmdline(pid: number): ProcCmdline | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, { encoding: "binary" });
    return parseCmdline(raw);
  } catch {
    return undefined;
  }
}

/** Read /proc/<pid>/environ. Returns undefined on any error. */
export function readProcEnviron(pid: number): ProcEnviron | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/environ`, { encoding: "binary" });
    return parseEnviron(raw);
  } catch {
    return undefined;
  }
}

/** Resolve /proc/<pid>/exe (a symlink to the executable). Undefined on error. */
export function readProcExe(pid: number): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return undefined;
  }
}

/** Read /proc/<pid>/cwd. Undefined on error. */
export function readProcCwd(pid: number): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return undefined;
  }
}

/** Is the pid alive? `kill -0` semantics — never sends a signal. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but is not ours to signal — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Run pgrep -f <pattern>, return one line per pid. Empty on no match. */
export function pgrepF(pattern: string): number[] {
  const r = spawnSync("pgrep", ["-f", pattern], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0 && r.status !== 1) return [];
  const out = r.stdout?.toString?.() ?? "";
  const pids: number[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const n = Number.parseInt(trimmed, 10);
    if (Number.isFinite(n)) pids.push(n);
  }
  return pids;
}
