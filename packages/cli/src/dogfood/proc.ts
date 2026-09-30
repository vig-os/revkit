// Pure /proc parsing helpers. No I/O; the caller reads the file and hands
// us the raw bytes.
//
// /proc/<pid>/cmdline separates argv with a single NUL byte and normally
// has a trailing NUL after the last arg (kernel guarantees this except
// for pids that overwrote their argv via prctl, which the child claude
// does not). We drop the trailing empty slot so downstream code sees an
// exact-length array. Ditto for environ.

import type { ProcCmdline, ProcEnviron } from "./types.ts";

/** Split a NUL-separated /proc/<pid>/cmdline byte string into argv. */
export function parseCmdline(raw: string): ProcCmdline {
  const parts = raw.split("\0");
  // Kernel appends a trailing NUL. Drop the last empty entry if present.
  while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return {
    argv: parts,
    raw: parts.join(" "),
  };
}

/** Split /proc/<pid>/environ (NUL-separated NAME=VALUE) into pairs.
 *  A malformed entry (no `=`) is skipped rather than throwing — the pipeline
 *  wants the child's real environ to fail on shape checks, not on a parse. */
export function parseEnviron(raw: string): ProcEnviron {
  const rows = raw.split("\0");
  const pairs: Array<{ readonly name: string; readonly value: string }> = [];
  const names = new Set<string>();
  for (const row of rows) {
    if (row.length === 0) continue;
    const eq = row.indexOf("=");
    if (eq <= 0) continue; // skip nameless / malformed
    const name = row.slice(0, eq);
    const value = row.slice(eq + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    pairs.push({ name, value });
    names.add(name);
  }
  const lookup = (n: string): string | undefined => {
    for (const p of pairs) if (p.name === n) return p.value;
    return undefined;
  };
  return { pairs, names, lookup };
}

/** Find the value that immediately follows `flag` in argv. Returns undefined
 *  when the flag is missing or has no trailing token. Multiple occurrences
 *  return the FIRST — this matches how a shell argv is consumed. */
export function argAfter(argv: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag) return argv[i + 1];
  }
  return undefined;
}

/** Return every value that follows `flag` up to the next `--…` token.
 *  Used for `--allowedTools tool1 tool2 tool3`. */
export function multiArgAfter(argv: readonly string[], flag: string): string[] {
  const out: string[] = [];
  const idx = argv.indexOf(flag);
  if (idx < 0) return out;
  for (let i = idx + 1; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === undefined) break;
    if (v.startsWith("--")) break;
    out.push(v);
  }
  return out;
}
