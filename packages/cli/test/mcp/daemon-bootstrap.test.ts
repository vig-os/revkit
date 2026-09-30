// Unit tests for the daemon-bootstrap module.
//
// The bootstrap has two paths:
//  1. `serve.json` exists and the pid is alive → attach.
//  2. Otherwise spawn `revkit serve` and poll until `serve.json`
//     appears.
//
// We drive each path with a fake `spawn` and a fake clock/sleep, so
// the test is deterministic. The full end-to-end auto-start against a
// real subprocess is exercised implicitly by the Playwright round-trip
// (which spawns `revkit serve` for real).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDaemon } from "../../src/mcp/daemon-bootstrap.ts";
import { writeServeState, type ServeState } from "../../src/serve/serve-state.ts";

describe("daemon-bootstrap", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "revkit-boot-"));
    mkdirSync(join(root, ".revkit"), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("attaches to a live serve.json (no spawn)", async () => {
    const state: ServeState = {
      pid: process.pid, // this process is alive by definition
      port: 12345,
      url: "http://127.0.0.1:12345",
      agentToken: "test-token-" + "x".repeat(40),
      startedAt: new Date().toISOString(),
      version: "0.0.0-test",
    };
    const writeResult = await writeServeState(root, state);
    expect(writeResult.ok).toBe(true);
    let spawned = false;
    const result = await ensureDaemon({
      repoRoot: root,
      spawn: () => {
        spawned = true;
        return { pid: -1 };
      },
    });
    expect(spawned).toBe(false);
    expect(result.spawned).toBe(false);
    expect(result.state.pid).toBe(process.pid);
    expect(result.state.agentToken).toBe(state.agentToken);
  });

  test("spawns when no serve.json AND waits for it to appear", async () => {
    let spawnedWith: { cmd: string[]; cwd: string } | undefined;
    const state: ServeState = {
      pid: process.pid,
      port: 22222,
      url: "http://127.0.0.1:22222",
      agentToken: "spawn-token-" + "y".repeat(40),
      startedAt: new Date().toISOString(),
      version: "0.0.0-test",
    };
    // Simulate the spawn writing serve.json a couple of "polls" later.
    let pollsBeforeWrite = 3;
    const fakeSleep = async (): Promise<void> => {
      if (pollsBeforeWrite === 0) {
        // Write the state as the "daemon" would.
        await writeServeState(root, state);
      }
      pollsBeforeWrite--;
    };
    const result = await ensureDaemon({
      repoRoot: root,
      spawn: (opts) => {
        spawnedWith = { cmd: opts.cmd, cwd: opts.cwd };
        return { pid: 999 };
      },
      sleep: fakeSleep,
      waitMs: 60_000, // deterministic — clock is not injected
      pollIntervalMs: 5,
    });
    expect(result.spawned).toBe(true);
    expect(result.state.agentToken).toBe(state.agentToken);
    expect(spawnedWith?.cmd[0]).toBe("bun");
    expect(spawnedWith?.cmd[spawnedWith.cmd.length - 1]).toBe("serve");
    expect(spawnedWith?.cwd).toBe(root);
  });

  test("propagates --dir to the spawned daemon", async () => {
    let spawnedCmd: string[] | undefined;
    const state: ServeState = {
      pid: process.pid,
      port: 33333,
      url: "http://127.0.0.1:33333",
      agentToken: "d-token-" + "z".repeat(40),
      startedAt: new Date().toISOString(),
      version: "0.0.0-test",
    };
    let polls = 2;
    const fakeSleep = async (): Promise<void> => {
      if (polls === 0) await writeServeState(root, state);
      polls--;
    };
    await ensureDaemon({
      repoRoot: root,
      dir: "custom/dist",
      spawn: (opts) => {
        spawnedCmd = opts.cmd;
        return { pid: 999 };
      },
      sleep: fakeSleep,
      waitMs: 60_000,
      pollIntervalMs: 5,
    });
    expect(spawnedCmd).toContain("--dir");
    expect(spawnedCmd).toContain("custom/dist");
  });

  test("times out when the spawned daemon never writes serve.json", async () => {
    let now = 0;
    const clock = (): number => now;
    const sleep = async (ms: number): Promise<void> => {
      now += ms;
    };
    let threw = false;
    try {
      await ensureDaemon({
        repoRoot: root,
        spawn: () => ({ pid: 999 }),
        sleep,
        nowMs: clock,
        waitMs: 300,
        pollIntervalMs: 50,
      });
    } catch (error) {
      threw = true;
      expect((error as Error).message).toContain("did not write");
    }
    expect(threw).toBe(true);
  });

  test("replaces a stale serve.json (dead pid)", async () => {
    // Pid 1 exists on Linux (init), so use a very high pid nobody
    // has. `isPidAlive` returns false for a pid that raises ESRCH.
    // 0x7fffffff is the max signed 32-bit — outside any realistic
    // range.
    const stalePid = 0x7fffffff;
    // writeServeState refuses to overwrite a live-pid state, so we
    // seed the stale file by writing directly.
    const path = join(root, ".revkit", "serve.json");
    writeFileSync(
      path,
      JSON.stringify({
        pid: stalePid,
        port: 44444,
        url: "http://127.0.0.1:44444",
        agentToken: "stale-token",
        startedAt: new Date().toISOString(),
        version: "0.0.0-test",
      }),
      { mode: 0o600 },
    );
    chmodSync(path, 0o600);
    const freshState: ServeState = {
      pid: process.pid,
      port: 44445,
      url: "http://127.0.0.1:44445",
      agentToken: "fresh-token-" + "w".repeat(40),
      startedAt: new Date().toISOString(),
      version: "0.0.0-test",
    };
    let polls = 1;
    const sleep = async (): Promise<void> => {
      if (polls === 0) await writeServeState(root, freshState);
      polls--;
    };
    const result = await ensureDaemon({
      repoRoot: root,
      spawn: () => ({ pid: 999 }),
      sleep,
      pollIntervalMs: 5,
      waitMs: 60_000,
    });
    // Bootstrap saw the stale file, called spawn, then attached to
    // the fresh state.
    expect(result.spawned).toBe(true);
    expect(result.state.agentToken).toBe(freshState.agentToken);
  });
});
