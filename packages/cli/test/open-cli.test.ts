// `revkit open` — the diagnostic a human sees when no daemon is
// ready. Focused tests for #251 N4: a cold-start auto-build holds
// `.revkit/daemon.lock` with `status: "starting"`, so the ready-only
// `findRunningDaemon` returns undefined; `revkit open` must then say
// "a daemon is starting", NOT "no daemon is running" (which tells
// the human to run `revkit serve`, which would be refused by the
// still-held lock).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireStartingLock } from "../src/serve/serve-state.ts";
import { runOpenCommand } from "../src/open-cli.ts";

describe("runOpenCommand — #251 N4 (helpful message during a cold-start auto-build)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "revkit-open-n4-"));
    writeFileSync(join(root, "package.json"), '{"name":"revkit","private":true}', "utf8");
    mkdirSync(join(root, ".revkit"), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("reports 'a daemon is starting' when a starting record is live (NOT 'no daemon is running')", async () => {
    // Simulate the pre-bind window: acquire the daemon lock in a
    // "starting" state. In production this is `revkit serve` during
    // its cold-start auto-build.
    // Use `process.pid` as the "starting" fixture so the live-pid
    // check in `runOpenCommand` reports it in the message
    // (#251 round-3 nit: dead-pid is omitted; we test the
    // dead-pid branch separately against daemon-bootstrap).
    const acquired = acquireStartingLock(root, {
      pid: process.pid,
      version: "0.0.0-test",
      startedAt: new Date(Date.now() - 42_000).toISOString(),
      instanceId: "starting-n4-fixture",
    });
    expect(acquired.kind).toBe("ok");
    try {
      const result = await runOpenCommand([], { cwd: root });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("a daemon is starting");
      expect(result.stderr).toContain(`pid ${process.pid}`);
      // The old (wrong) message would send the human to `revkit
      // serve`, which the still-held lock refuses.
      expect(result.stderr).not.toContain("no daemon is running");
    } finally {
      if (acquired.kind === "ok") acquired.release();
    }
  });

  test("reports 'no daemon is running' when the lock is free (unchanged pre-fix path)", async () => {
    const result = await runOpenCommand([], { cwd: root });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("no daemon is running");
  });
});
