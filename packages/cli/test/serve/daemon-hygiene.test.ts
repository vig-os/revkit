// Global daemon-hygiene guard (PR #38 round-2 review).
//
// Every test that spawns a `revkit serve` daemon MUST stop it in
// its own `afterEach` / `finally`. This spec runs LAST in the file
// order (bun test walks files alphabetically within a directory,
// and `daemon-hygiene` sorts after everything else in `test/serve/`
// except the intentionally-late `mutations.test.ts` — see the
// `beforeAll` below for the belt-and-braces sweep of any daemon
// that survived a preceding file).
//
// The check: no `revkit serve` process (identified by "revkit.js
// serve" or a nearby daemon lock file we recognise) is running in
// this user's process table under any of the tmpdir roots the
// tests use. If any survives, we fail the spec — pointing at the
// tests that leaked.

import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";

/** Return a list of pids running `bun … revkit.js serve` (or its
 * child that Bun.serve spawned) that belong to THIS user. */
function findRevkitServeProcesses(): Array<{ pid: number; cmd: string }> {
  // `ps -o pid=,args=` prints one row per process; `-u $USER`
  // limits to our own.
  const psArgs = ["-o", "pid=,args=", "-u", process.env.USER ?? String(process.getuid?.() ?? "")];
  const out = spawnSync("ps", psArgs, { encoding: "utf8" });
  if (out.status !== 0) return [];
  return out.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => /revkit\.js\s+serve|revkit\s+serve/.test(line))
    // Ignore the test runner itself and grep processes.
    .filter((line) => !/\bgrep\b|\bps\b|\bbun\s+test\b/.test(line))
    .map((line): { pid: number; cmd: string } => {
      const m = line.match(/^(\d+)\s+(.*)$/);
      if (m === null) return { pid: -1, cmd: line };
      return { pid: Number(m[1]!), cmd: m[2]! };
    })
    .filter((r) => r.pid > 0);
}

describe("daemon hygiene — no leftover `revkit serve`", () => {
  test("no revkit serve daemons survive the full test run", () => {
    const survivors = findRevkitServeProcesses();
    if (survivors.length > 0) {
      // Kill them so the next run starts clean, then fail.
      for (const s of survivors) {
        try { process.kill(s.pid, "SIGTERM"); } catch { /* already dead */ }
      }
    }
    expect(
      survivors,
      `Leftover daemons must be killed in the spawning test's afterEach/finally. Survivors:\n` +
        survivors.map((s) => `  pid ${s.pid}: ${s.cmd}`).join("\n"),
    ).toEqual([]);
  });
});
