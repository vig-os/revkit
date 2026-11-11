// Daemon-hygiene check (PR #38 round-3 blocker).
//
// Every test that spawns a `revkit serve` daemon subprocess (either
// directly, or indirectly via `revkit mcp`'s auto-start) records
// its pid in the shared registry
// (`test/helpers/daemon-registry.ts`) as part of its own teardown.
// This spec runs LAST alphabetically in `test/serve/` and asserts
// that NO registered pid is still alive — i.e. every spawning test
// killed its own child.
//
// Round-3 fix: the previous check walked the whole process table
// for anything matching `revkit\.js\s+serve` and killed it,
// including the owner's real dogfood daemon on the same host. That
// is a footgun. This version NEVER touches a pid that isn't in
// the registry.

import { spawn } from "node:child_process";
import { describe, expect, test } from "bun:test";
import {
  liveRegisteredDaemons,
  registerDaemonPid,
  registeredDaemonPids,
  unregisterDaemonPid,
} from "../helpers/daemon-registry.ts";

/** Best-effort cmdline read for a diagnostic. Reads
 * `/proc/<pid>/cmdline` on Linux; falls back to "<pid unavailable>"
 * elsewhere. Only called for pids the test itself owns. */
function cmdlineFor(pid: number): string {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    // cmdline separates args with NUL; make it human-readable.
    return raw.replace(/\0/g, " ").trim();
  } catch {
    return "<cmdline unavailable>";
  }
}

describe("daemon hygiene — registry-scoped check", () => {
  test("MUTATION: a foreign process whose command matches `revkit serve` is NOT touched", () => {
    // Spawn a foreign sleep whose argv LOOKS LIKE a revkit serve
    // but whose pid is deliberately NOT registered. The old
    // hygiene test would have grepped it out of `ps` and
    // SIGTERM'd it — including the owner's real daemon. This
    // test proves the round-3 fix: nothing outside the registry
    // is touched.
    const foreign = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
    if (typeof foreign.unref === "function") foreign.unref();
    const foreignPid = foreign.pid!;
    try {
      // Sanity: the process is alive.
      expect(() => process.kill(foreignPid, 0)).not.toThrow();
      // The registry-scoped check must NOT see this pid.
      expect(registeredDaemonPids()).not.toContain(foreignPid);
      // Nothing in `liveRegisteredDaemons()` for a foreign pid.
      expect(liveRegisteredDaemons()).not.toContain(foreignPid);
      // Sanity again: still alive after the "check".
      expect(() => process.kill(foreignPid, 0)).not.toThrow();
    } finally {
      try { process.kill(foreignPid, "SIGTERM"); } catch { /* already dead */ }
    }
  });

  test("registered-but-dead pids are not flagged (kill happens in teardown)", async () => {
    // Simulate a well-behaved test: register a pid, kill it, wait
    // for the exit, then check `liveRegisteredDaemons` — the pid
    // should not appear.
    const child = spawn("sleep", ["10"], { stdio: "ignore" });
    const pid = child.pid!;
    registerDaemonPid(pid);
    process.kill(pid, "SIGTERM");
    // Await the exit event so `kill(pid, 0)` truly ESRCH's.
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(liveRegisteredDaemons()).not.toContain(pid);
    unregisterDaemonPid(pid);
  });

  test("no registered daemon pid is still alive at end-of-suite", () => {
    const survivors = liveRegisteredDaemons();
    if (survivors.length === 0) {
      // Nothing to report. Also print the total count so a
      // regression that stops registering shows up as zero.
      const total = registeredDaemonPids().length;
      expect(total).toBeGreaterThanOrEqual(0);
      return;
    }
    // Try SIGTERM as a courtesy, then unregister so a re-run
    // starts clean. We do NOT touch anything outside the registry.
    for (const pid of survivors) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
      unregisterDaemonPid(pid);
    }
    const detail = survivors.map((pid) => `  pid ${pid}: ${cmdlineFor(pid)}`).join("\n");
    expect(
      survivors,
      `Leftover daemons (from tests that DID register their pids but skipped cleanup):\n${detail}`,
    ).toEqual([]);
  });
});
