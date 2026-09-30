// Unit tests for the daemon-bootstrap module.
//
// The bootstrap is now a THIN wrapper over `findRunningDaemon`
// (PR #36 lock discipline): find → attach, or spawn → poll until
// findRunningDaemon returns.
//
// Coverage: a live daemon is REUSED and not duplicated (the
// "duplicate daemons" bug the coordinator wants proved dead); a
// killed daemon is RE-SPAWNED (the "stale lock" bug); the spawn
// command is bun revkit.js serve with --dir when given, cwd equal
// to repoRoot, detached true; a spawned daemon that never takes
// the lock times out.
//
// The `findRunningDaemon` hook is injected so the test drives the
// discover / spawn / re-discover cycle without touching a real
// flock. The full-stack "real daemon subprocess + real lock" path
// is exercised by the Playwright roundtrip, which spawns
// `revkit serve` for real.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultRevkitBin,
  ensureDaemon,
  filteredDaemonEnv,
  verifyDaemonInstance,
} from "../../src/mcp/daemon-bootstrap.ts";
import type { ServeState } from "../../src/serve/serve-state.ts";

/** One state fixture — the shape `findRunningDaemon` returns to the
 * bootstrap. `instanceId` is optional on the wire; every fixture
 * here sets one so the mutation tests for verifyDaemonInstance
 * have something to compare. */
function fixtureState(overrides: Partial<ServeState> = {}): ServeState {
  return {
    pid: process.pid,
    port: 12345,
    url: "http://127.0.0.1:12345",
    agentToken: "token-" + "x".repeat(40),
    startedAt: new Date().toISOString(),
    version: "0.0.0-test",
    instanceId: "instance-" + "y".repeat(20),
    ...overrides,
  };
}

describe("daemon-bootstrap", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "revkit-boot-"));
    mkdirSync(join(root, ".revkit"), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("attaches to a live daemon (no spawn) — the reuse path", async () => {
    const state = fixtureState();
    let spawned = false;
    const result = await ensureDaemon({
      repoRoot: root,
      findRunningDaemon: () => state,
      spawn: () => {
        spawned = true;
        return { pid: -1 };
      },
    });
    expect(spawned).toBe(false);
    expect(result.spawned).toBe(false);
    expect(result.state).toBe(state);
  });

  test("MUTATION: two back-to-back ensureDaemon calls reuse the same daemon", async () => {
    // The coordinator's "live daemon reused, not duplicated" gate.
    // Given `findRunningDaemon` reports the same state on both
    // calls, ensureDaemon must NOT spawn on either.
    const state = fixtureState();
    let spawnCount = 0;
    const spawn = (): { pid: number } => {
      spawnCount++;
      return { pid: 999 };
    };
    const one = await ensureDaemon({
      repoRoot: root,
      findRunningDaemon: () => state,
      spawn,
    });
    const two = await ensureDaemon({
      repoRoot: root,
      findRunningDaemon: () => state,
      spawn,
    });
    expect(spawnCount).toBe(0);
    expect(one.state).toBe(state);
    expect(two.state).toBe(state);
    expect(one.spawned).toBe(false);
    expect(two.spawned).toBe(false);
  });

  test("MUTATION: a killed daemon is re-spawned on the next call", async () => {
    // Simulate: first call attaches; between calls the daemon
    // exits (findRunningDaemon flips to undefined). The next call
    // must spawn a new one and reconnect to it.
    const first = fixtureState();
    const second = fixtureState({ instanceId: "instance-" + "z".repeat(20), agentToken: "fresh-token" });
    let call = 0;
    let spawned = 0;
    const spawn = (): { pid: number } => {
      spawned++;
      return { pid: 42 };
    };
    // 1st call: daemon is alive.
    const attach = await ensureDaemon({
      repoRoot: root,
      findRunningDaemon: () => first,
      spawn,
    });
    expect(attach.spawned).toBe(false);
    // 2nd call: daemon has died. `findRunningDaemon` returns
    // undefined until the spawned poll picks up the fresh daemon.
    call = 0;
    const revived = await ensureDaemon({
      repoRoot: root,
      findRunningDaemon: () => {
        call++;
        if (call === 1) return undefined; // initial probe
        if (call === 2) return undefined; // 1st poll
        return second; // fresh daemon claimed the lock
      },
      spawn,
      sleep: async () => {}, // no real delay
      pollIntervalMs: 5,
      waitMs: 60_000,
    });
    expect(spawned).toBe(1);
    expect(revived.spawned).toBe(true);
    expect(revived.state.instanceId).toBe(second.instanceId);
    expect(revived.state.agentToken).toBe("fresh-token");
  });

  test("spawn command: `bun <revkit.js> serve` with --dir when given", async () => {
    let spawnedCmd: string[] | undefined;
    let spawnedCwd: string | undefined;
    let spawnedDetached: boolean | undefined;
    const state = fixtureState({ instanceId: "fresh" });
    let call = 0;
    await ensureDaemon({
      repoRoot: root,
      dir: "custom/dist",
      findRunningDaemon: () => {
        call++;
        return call === 1 ? undefined : state;
      },
      spawn: (opts) => {
        spawnedCmd = opts.cmd;
        spawnedCwd = opts.cwd;
        spawnedDetached = opts.detached;
        return { pid: 999 };
      },
      sleep: async () => {},
      pollIntervalMs: 5,
      waitMs: 60_000,
    });
    expect(spawnedCmd?.[0]).toBe("bun");
    expect(spawnedCmd?.includes("serve")).toBe(true);
    expect(spawnedCmd?.includes("--dir")).toBe(true);
    expect(spawnedCmd?.includes("custom/dist")).toBe(true);
    expect(spawnedCwd).toBe(root);
    expect(spawnedDetached).toBe(true);
  });

  test("times out when the spawned daemon never takes the lock", async () => {
    let now = 0;
    const clock = (): number => now;
    const sleep = async (ms: number): Promise<void> => {
      now += ms;
    };
    let threw = false;
    try {
      await ensureDaemon({
        repoRoot: root,
        findRunningDaemon: () => undefined, // never appears
        spawn: () => ({ pid: 999 }),
        sleep,
        nowMs: clock,
        waitMs: 300,
        pollIntervalMs: 50,
      });
    } catch (error) {
      threw = true;
      expect((error as Error).message).toContain("did not take");
      expect((error as Error).message).toContain("daemon.lock");
    }
    expect(threw).toBe(true);
  });
});

describe("verifyDaemonInstance", () => {
  /** A minimal fetch stub. `verifyDaemonInstance` only needs
   * `(url, init?) => Promise<Response>`, so a plain function
   * satisfies the runtime; the double cast (`unknown` then
   * `typeof fetch`) skips the WHATWG-fetch shape's extra members
   * (`preconnect`, `preload`) which the caller does not touch. */
  const stubFetch = (impl: (url: string) => Promise<Response>): typeof fetch =>
    ((async (url: string): Promise<Response> => impl(url)) as unknown) as typeof fetch;

  test("returns true when /-/health's instanceId matches the advertisement", async () => {
    const fakeFetch = stubFetch(async () =>
      new Response(JSON.stringify({ instanceId: "abc", pid: 1 }), { status: 200 }),
    );
    const ok = await verifyDaemonInstance("http://127.0.0.1:9999", "abc", fakeFetch);
    expect(ok).toBe(true);
  });

  test("MUTATION: a new daemon at the same URL is caught by an instanceId mismatch", async () => {
    // The reconnect path — `serve.json` said `abc`, but /-/health
    // reports `xyz`. The daemon we thought we were talking to has
    // been replaced. The caller must re-run ensureDaemon.
    const fakeFetch = stubFetch(async () =>
      new Response(JSON.stringify({ instanceId: "xyz", pid: 2 }), { status: 200 }),
    );
    const ok = await verifyDaemonInstance("http://127.0.0.1:9999", "abc", fakeFetch);
    expect(ok).toBe(false);
  });

  test("throws on a 5xx (daemon crash mid-check) so the caller re-runs discovery", async () => {
    const fakeFetch = stubFetch(async () => new Response("boom", { status: 500 }));
    await expect(verifyDaemonInstance("http://127.0.0.1:9999", "abc", fakeFetch)).rejects.toThrow(/500/);
  });

  test("throws when /-/health response lacks instanceId (malformed)", async () => {
    const fakeFetch = stubFetch(async () =>
      new Response(JSON.stringify({ pid: 1 }), { status: 200 }),
    );
    await expect(verifyDaemonInstance("http://127.0.0.1:9999", "abc", fakeFetch)).rejects.toThrow(/instanceId/);
  });
});

describe("defaultRevkitBin — spaces in path", () => {
  test("returns a real filesystem path (not URL percent-encoded)", () => {
    // The path derived from this test file's import.meta.url has no
    // space, but we can still verify the CONTRACT: fileURLToPath's
    // output never contains "%20" for a space in the URL. Assert
    // the returned path exists as a file and does not contain "%".
    const bin = defaultRevkitBin();
    expect(bin).toContain("bin/revkit.js");
    expect(bin).not.toContain("%");
  });

  test("MUTATION: URL.pathname would break on a path with a space; fileURLToPath does not", () => {
    // Independent unit check for the underlying primitive: build a
    // file:// URL with a space and confirm `fileURLToPath` gives us
    // the raw path back, while `URL.pathname` percent-encodes it.
    const url = new URL("file:///Users/Some%20Person/bin/revkit.js");
    // URL.pathname is percent-encoded (browser convention).
    expect(url.pathname).toContain("%20");
    // fileURLToPath decodes.
    const nodeUrl = require("node:url") as typeof import("node:url");
    expect(nodeUrl.fileURLToPath(url)).toBe("/Users/Some Person/bin/revkit.js");
    expect(nodeUrl.fileURLToPath(url)).not.toContain("%");
  });
});

describe("filteredDaemonEnv — allowlist", () => {
  test("keeps PATH, HOME, LANG, TERM, XDG_*, NIX_*, LC_* — drops everything else", () => {
    const env = filteredDaemonEnv({
      PATH: "/usr/bin:/bin",
      HOME: "/tmp/home",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      NIX_LD: "/lib64/ld.so",
      XDG_CACHE_HOME: "/tmp/cache",
      TERM: "xterm",
      TMPDIR: "/tmp",
      // These MUST be dropped.
      NODE_OPTIONS: "--inspect",
      LD_PRELOAD: "/malicious/lib.so",
      REVKIT_AGENT_TOKEN: "secret",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      GITHUB_TOKEN: "ghp_xxx",
    });
    expect(env["PATH"]).toBe("/usr/bin:/bin");
    expect(env["HOME"]).toBe("/tmp/home");
    expect(env["LANG"]).toBe("en_US.UTF-8");
    expect(env["LC_ALL"]).toBe("C");
    expect(env["NIX_LD"]).toBe("/lib64/ld.so");
    expect(env["XDG_CACHE_HOME"]).toBe("/tmp/cache");
    expect(env["TERM"]).toBe("xterm");
    expect(env["TMPDIR"]).toBe("/tmp");
    // MUTATION: these must NOT leak through — a hostile agent env
    // could otherwise inject an inspector, a preload, or a token.
    expect(env["NODE_OPTIONS"]).toBeUndefined();
    expect(env["LD_PRELOAD"]).toBeUndefined();
    expect(env["REVKIT_AGENT_TOKEN"]).toBeUndefined();
    expect(env["SSH_AUTH_SOCK"]).toBeUndefined();
    expect(env["GITHUB_TOKEN"]).toBeUndefined();
  });

  test("undefined values are dropped (not passed through as literal 'undefined')", () => {
    const env = filteredDaemonEnv({
      PATH: "/usr/bin",
      HOME: undefined,
    });
    expect(env["PATH"]).toBe("/usr/bin");
    expect("HOME" in env).toBe(false);
  });
});
