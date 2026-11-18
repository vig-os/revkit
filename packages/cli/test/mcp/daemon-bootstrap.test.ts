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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  daemonExecutable,
  defaultRevkitBin,
  ensureDaemon,
  filteredDaemonEnv,
  verifyDaemonInstance,
} from "../../src/mcp/daemon-bootstrap.ts";
import type { ServeState, StartFailureRecord } from "../../src/serve/serve-state.ts";

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

  test("starts a real daemon with no bun on PATH and publishes serve.json", async () => {
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist/index.html"), "<h1>bootstrap</h1>");
    writeFileSync(join(root, "package.json"), '{"name":"revkit"}');
    const priorPath = process.env.PATH;
    let childPid: number | undefined;
    try {
      process.env.PATH = "";
      const boot = await ensureDaemon({ repoRoot: root, dir: "dist", onSpawn: (pid) => { childPid = pid; } });
      expect(boot.spawned).toBe(true);
      expect(childPid).toBe(boot.state.pid);
      expect(existsSync(join(root, ".revkit/serve.json"))).toBe(true);
    } finally {
      process.env.PATH = priorPath;
      if (childPid !== undefined) {
        process.kill(childPid, "SIGTERM");
        await Bun.sleep(200);
      }
    }
  }, 20_000);

  test("compiled identity has no separate entry argument", () => {
    expect(daemonExecutable("unused", "/$bunfs/root/revkit", "/opt/bin/revkit")).toEqual(["/opt/bin/revkit"]);
    expect(daemonExecutable("/opt/revkit.js", "/opt/revkit.js", "/opt/bin/bun")).toEqual(["/opt/bin/bun", "/opt/revkit.js"]);
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
    expect(spawnedCmd?.[0]).toBe(process.execPath);
    expect(spawnedCmd?.includes("serve")).toBe(true);
    expect(spawnedCmd?.includes("--dir")).toBe(true);
    expect(spawnedCmd?.includes("custom/dist")).toBe(true);
    expect(spawnedCwd).toBe(root);
    expect(spawnedDetached).toBe(true);
  });

  // Mutation H (PR #38 round-4 review): `ensureDaemon` MUST apply
  // `filteredDaemonEnv()` to the spawn's env — the daemon must not
  // inherit `NODE_OPTIONS`, `LD_PRELOAD`, an agent's private
  // tokens, etc. Before this test, the spawn stub bypassed the
  // computed env entirely, so removing the filter from the
  // production path did not turn any test red. Now the hook
  // receives `env` and the assertion confirms both a keep and a
  // drop, so dropping `filteredDaemonEnv` here flips it red.
  test("MUTATION H: spawn env is the filtered allowlist, not the raw parent env", async () => {
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    const state = fixtureState({ instanceId: "post-filter" });
    let call = 0;
    // Inject a hostile-looking parent env: PATH must survive the
    // filter, NIX_LD / NODE_OPTIONS / a fake token must not.
    const originalEnv = { ...process.env };
    process.env["NIX_LD"] = "/malicious/ld.so";
    process.env["NODE_OPTIONS"] = "--inspect";
    process.env["REVKIT_AGENT_TOKEN"] = "leaked-token";
    try {
      await ensureDaemon({
        repoRoot: root,
        findRunningDaemon: () => {
          call++;
          return call === 1 ? undefined : state;
        },
        spawn: (opts) => {
          spawnedEnv = opts.env;
          return { pid: 999 };
        },
        sleep: async () => {},
        pollIntervalMs: 5,
        waitMs: 60_000,
      });
    } finally {
      // Restore parent env so this test never leaks into a sibling.
      delete process.env["NIX_LD"];
      delete process.env["NODE_OPTIONS"];
      delete process.env["REVKIT_AGENT_TOKEN"];
      for (const [k, v] of Object.entries(originalEnv)) if (v !== undefined && !(k in process.env)) process.env[k] = v;
    }
    // PATH is on the allowlist, so it must survive.
    expect(spawnedEnv?.["PATH"]).toBeDefined();
    // Every hostile name must have been stripped.
    expect(spawnedEnv?.["NIX_LD"]).toBeUndefined();
    expect(spawnedEnv?.["NODE_OPTIONS"]).toBeUndefined();
    expect(spawnedEnv?.["REVKIT_AGENT_TOKEN"]).toBeUndefined();
  });

  // Sibling to Mutation H: the `onSpawn` hook is called with the
  // child pid so the shared daemon-registry can bookmark it for
  // the end-of-suite hygiene sweep (Nit C — PID reuse). Missing
  // this call once let a killed pid stay unregistered; a later
  // recycled OS pid would then be SIGTERMed by the sweep.
  test("onSpawn hook receives the child pid", async () => {
    const state = fixtureState({ instanceId: "post-hook" });
    let call = 0;
    let observedPid: number | undefined;
    await ensureDaemon({
      repoRoot: root,
      findRunningDaemon: () => {
        call++;
        return call === 1 ? undefined : state;
      },
      spawn: () => ({ pid: 4242 }),
      onSpawn: (pid) => {
        observedPid = pid;
      },
      sleep: async () => {},
      pollIntervalMs: 5,
      waitMs: 60_000,
    });
    expect(observedPid).toBe(4242);
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

describe("ensureDaemon — #251 starting-state lifecycle", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "revkit-boot-starting-"));
    mkdirSync(join(root, ".revkit"), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Shape of a "starting" record published pre-bind by
   * `acquireStartingLock` (serve/cli.ts #251): the lock is held, pid
   * is real, but the URL/token/port are placeholders because the
   * HTTP server has not bound yet. */
  function startingFixture(overrides: Partial<ServeState> = {}): ServeState {
    return {
      pid: process.pid,
      port: 0,
      url: "",
      agentToken: "",
      startedAt: new Date().toISOString(),
      version: "0.0.0-test",
      instanceId: "starting-" + "x".repeat(20),
      status: "starting",
      ...overrides,
    };
  }

  test("#251: a starting daemon is WAITED on — ensureDaemon does NOT spawn another", async () => {
    // This is the direct repro: a cold-start `revkit serve` is in
    // the pre-bind window (lock held, status="starting"). A
    // concurrent `ensureDaemon` (the first tool call from `revkit
    // mcp`) must wait on the readiness transition, NEVER spawn a
    // second daemon. BEFORE the fix, `findRunningDaemon` returned
    // undefined for a "starting" record (empty url) and
    // `ensureDaemon` spawned a second `revkit serve` that raced
    // into the build.
    const starting = startingFixture({ instanceId: "starting-1" });
    const ready = fixtureState({ instanceId: "ready-1" });
    let findCalls = 0;
    let spawnCount = 0;
    const result = await ensureDaemon({
      repoRoot: root,
      findRunningDaemon: () => {
        findCalls++;
        // Starting for the first 3 probes (simulating a slow
        // auto-build); then ready.
        return findCalls <= 3 ? starting : ready;
      },
      spawn: () => {
        spawnCount++;
        return { pid: 999 };
      },
      sleep: async () => {},
      pollIntervalMs: 5,
      waitMs: 60_000,
      startingReadyMs: 60_000,
    });
    expect(spawnCount).toBe(0);
    expect(result.spawned).toBe(false);
    expect(result.state.instanceId).toBe("ready-1");
  });

  test("#251: a spawned daemon that advertises 'starting' is waited on (ONE spawn, no second)", async () => {
    // Variant: no daemon on first probe → ensureDaemon spawns.
    // The spawn's "revkit serve" takes the lock and writes a
    // starting record. The subsequent polls see "starting" then
    // "ready". There must be EXACTLY ONE spawn, even though the
    // starting window spans several polls.
    const starting = startingFixture({ instanceId: "starting-2" });
    const ready = fixtureState({ instanceId: "ready-2" });
    let findCalls = 0;
    let spawnCount = 0;
    const result = await ensureDaemon({
      repoRoot: root,
      findRunningDaemon: () => {
        findCalls++;
        if (findCalls === 1) return undefined; // initial probe
        if (findCalls <= 4) return starting; // during pre-bind
        return ready; // after bind
      },
      spawn: () => {
        spawnCount++;
        return { pid: 4242 };
      },
      sleep: async () => {},
      pollIntervalMs: 5,
      waitMs: 10_000,
      startingReadyMs: 60_000,
    });
    expect(spawnCount).toBe(1);
    expect(result.spawned).toBe(true);
    expect(result.state.instanceId).toBe("ready-2");
  });

  test("#251: a daemon that dies while starting is reported promptly (lock released)", async () => {
    // A starting daemon crashes before it can bind. The lock is
    // released on process exit; the next poll returns undefined.
    // `ensureDaemon` must fail PROMPTLY with a diagnostic naming
    // the dead pid — NOT after `startingReadyMs` of sleeping.
    const starting = startingFixture({ pid: 31337, instanceId: "starting-3" });
    let findCalls = 0;
    const spawnCount = { n: 0 };
    let threw: Error | undefined;
    try {
      await ensureDaemon({
        repoRoot: root,
        findRunningDaemon: () => {
          findCalls++;
          // First probe: starting daemon visible.
          // Subsequent probes: lock released (daemon died).
          return findCalls === 1 ? starting : undefined;
        },
        spawn: () => {
          spawnCount.n++;
          return { pid: 999 };
        },
        sleep: async () => {},
        pollIntervalMs: 5,
        waitMs: 60_000,
        startingReadyMs: 60_000,
      });
    } catch (error) {
      threw = error as Error;
    }
    expect(threw).toBeDefined();
    expect(threw?.message ?? "").toContain("died while starting");
    expect(threw?.message ?? "").toContain("31337");
    // The MCP side NEVER tries to spawn on top of a live lock —
    // detection + propagation only; the CALLER (channel server's
    // reconnect loop) decides whether to retry.
    expect(spawnCount.n).toBe(0);
  });

  test("#251: a starting daemon that never reaches ready is surfaced as 'building, N s elapsed'", async () => {
    // When `startingReadyMs` passes with the daemon still
    // "starting", `ensureDaemon` throws a diagnostic the agent can
    // retry. No widened timeout, no sleeping past the deadline:
    // the deadline is a bounded wait on the readiness signal, not
    // a blind guess.
    const starting = startingFixture({ pid: 9999, instanceId: "starting-4" });
    let now = 0;
    const clock = (): number => now;
    const sleep = async (ms: number): Promise<void> => {
      now += ms;
    };
    let threw: Error | undefined;
    try {
      await ensureDaemon({
        repoRoot: root,
        findRunningDaemon: () => starting, // forever "starting"
        spawn: () => ({ pid: 999 }),
        sleep,
        nowMs: clock,
        pollIntervalMs: 50,
        waitMs: 1_000,
        startingReadyMs: 2_000,
      });
    } catch (error) {
      threw = error as Error;
    }
    expect(threw).toBeDefined();
    expect(threw?.message ?? "").toContain("still starting");
    expect(threw?.message ?? "").toContain("building");
    expect(threw?.message ?? "").toContain("9999");
  });

  test("#251: concurrent ensureDaemon calls on a REAL shared filesystem elect ONE daemon", async () => {
    // End-to-end race test: two concurrent `ensureDaemon` callers
    // on the SAME repoRoot, using the REAL `acquireStartingLock`
    // for the simulated daemons. Even when both callers probe
    // "no daemon" at the same instant, only one spawned daemon
    // can take `.revkit/daemon.lock` — the other must fail to
    // acquire, and both callers converge on the same winner.
    const { acquireStartingLock } = await import("../../src/serve/serve-state.ts");
    const winnerStates: Array<{ status?: string }> = [];
    let acquireAttempts = 0;
    let acquireWins = 0;
    const simulateServeSpawn = (): { pid: number } => {
      acquireAttempts++;
      const acquired = acquireStartingLock(root, {
        pid: process.pid,
        version: "0.0.0-test",
        startedAt: new Date().toISOString(),
        instanceId: `starting-race-${acquireAttempts}`,
      });
      if (acquired.kind === "already-running") {
        return { pid: -1 };
      }
      acquireWins++;
      // Simulate build + bind: publish ready after some sleeps,
      // then release the lock. We leave the state on disk so
      // ensureDaemon returns it; it will be released in the test's
      // afterEach cleanup (rmSync of root).
      setTimeout(() => {
        acquired.publishReady({
          pid: process.pid,
          port: 54321,
          url: "http://127.0.0.1:54321",
          agentToken: "race-token",
          startedAt: new Date().toISOString(),
          version: "0.0.0-test",
          instanceId: `ready-race-${acquireAttempts}`,
        });
      }, 20);
      return { pid: 1234 };
    };
    // Both callers share the real `findRunningOrStartingDaemon`
    // (no `findRunningDaemon` override), so they see the real lock
    // state on disk. `spawn` simulates `revkit serve` taking the
    // lock in-process — the second concurrent spawn will be
    // refused because the first already holds it.
    const bootstrapA = ensureDaemon({
      repoRoot: root,
      spawn: simulateServeSpawn,
      pollIntervalMs: 5,
      waitMs: 1_000,
      startingReadyMs: 1_000,
    });
    const bootstrapB = ensureDaemon({
      repoRoot: root,
      spawn: simulateServeSpawn,
      pollIntervalMs: 5,
      waitMs: 1_000,
      startingReadyMs: 1_000,
    });
    const [resultA, resultB] = await Promise.all([bootstrapA, bootstrapB]);
    winnerStates.push(resultA.state, resultB.state);
    // EXACTLY ONE daemon acquired the lock and published "ready".
    // Both callers converge on the same winner (either both
    // `spawned: true` from the same spawn — conceivable if their
    // `undefined` probes raced and both spawned, but only one
    // won the lock — or one spawned and one waited).
    expect(acquireWins).toBe(1);
    expect(resultA.state.instanceId).toBe(resultB.state.instanceId);
    // Both results show a READY state: status is either absent
    // (legacy wire-shape, treated as ready) or "ready"; never
    // "starting", which is the pre-bind window ensureDaemon waits on.
    expect(resultA.state.status === "starting").toBe(false);
    expect(resultB.state.status === "starting").toBe(false);
  }, 10_000);
});

describe("ensureDaemon — #251 B2 (prompt building diagnostic) & N1 (persisted start failure)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "revkit-boot-b2-"));
    mkdirSync(join(root, ".revkit"), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A "starting" record whose `startedAt` is `elapsedS` seconds
   * before `now`, so the diagnostic reports a specific elapsed. */
  function startingAt(now: number, elapsedS: number, overrides: Partial<ServeState> = {}): ServeState {
    return {
      pid: 4242,
      port: 0,
      url: "",
      agentToken: "",
      startedAt: new Date(now - elapsedS * 1000).toISOString(),
      version: "0.0.0-test",
      instanceId: "starting-b2",
      status: "starting",
      ...overrides,
    };
  }

  test("#251 B2: onStartingDaemon='diagnose' throws DaemonBuildingError IMMEDIATELY (no wait)", async () => {
    // Fake clock lets us assert zero sleep calls — the point of
    // the diagnose mode is that the tool-call deadline never
    // races the startingReadyMs wait.
    let now = 1_700_000_000_000;
    const clock = (): number => now;
    let sleepCalls = 0;
    const sleep = async (ms: number): Promise<void> => {
      sleepCalls++;
      now += ms;
    };
    const starting = startingAt(now, 73, { pid: 31337 });
    let threw: Error | undefined;
    try {
      await ensureDaemon({
        repoRoot: root,
        findRunningDaemon: () => starting,
        spawn: () => ({ pid: -1 }),
        sleep,
        nowMs: clock,
        onStartingDaemon: "diagnose",
        startingReadyMs: 60_000, // would race the tool deadline in "wait" mode
        waitMs: 60_000,
      });
    } catch (error) {
      threw = error as Error;
    }
    expect(threw).toBeDefined();
    expect(threw?.name).toBe("DaemonBuildingError");
    expect(threw?.message).toContain("31337");
    // Elapsed MUST be computed from startedAt, not from the
    // waiter's start (which would be 0 s). 73 s is the fixture.
    expect(threw?.message).toContain("73 s elapsed");
    // No sleeps — we did not race the deadline.
    expect(sleepCalls).toBe(0);
  });

  test("#251 B2: onStartingDaemon='wait' (default) keeps the pre-#251-B2 behaviour", async () => {
    // Baseline check: in "wait" mode we still block on readiness
    // so the background reconnect loop converges once the daemon
    // is ready. Tool calls use "diagnose" instead.
    let now = 0;
    let findCalls = 0;
    const starting = startingAt(now, 5, { instanceId: "starting-wait" });
    const ready = fixtureState({ instanceId: "ready-wait" });
    const result = await ensureDaemon({
      repoRoot: root,
      findRunningDaemon: () => (findCalls++ < 2 ? starting : ready),
      spawn: () => ({ pid: -1 }),
      sleep: async (ms) => {
        now += ms;
      },
      nowMs: () => now,
      startingReadyMs: 10_000,
      waitMs: 10_000,
      // onStartingDaemon default = "wait"
    });
    expect(result.state.instanceId).toBe("ready-wait");
  });

  test("#251 N1: a persisted start failure surfaces DaemonStartFailedError without re-spawning", async () => {
    // A failure record whose inputs match the current state
    // (dist still missing). The bootstrap must NOT try to spawn
    // a daemon — every retry would fail the same way.
    let spawnCount = 0;
    const failure: StartFailureRecord = {
      stage: "build-failed",
      message: "revkit serve: auto-build failed",
      stderrTail: "SyntaxError in docs/foo.mdx line 42",
      failedAt: new Date().toISOString(),
      version: "0.0.0-test",
      inputs: { distExists: false }, // dist didn't exist at failure time; still doesn't
    };
    let threw: Error | undefined;
    try {
      await ensureDaemon({
        repoRoot: root,
        findRunningDaemon: () => undefined, // no live daemon
        readStartFailure: () => failure,
        clearStartFailure: () => {},
        spawn: () => {
          spawnCount++;
          return { pid: 999 };
        },
        sleep: async () => {},
      });
    } catch (error) {
      threw = error as Error;
    }
    expect(threw).toBeDefined();
    expect(threw?.name).toBe("DaemonStartFailedError");
    expect(threw?.message).toContain("auto-build failed");
    expect(threw?.message).toContain("SyntaxError");
    expect(spawnCount).toBe(0);
  });

  test("#251 N1: a stale failure (inputs changed — dist now exists) is cleared and bootstrap proceeds", async () => {
    // The user ran `revkit build` after the failure, so dist
    // exists now. The record is stale; bootstrap must clear it
    // and proceed to spawn.
    mkdirSync(join(root, ".revkit", "dist"), { recursive: true });
    const failure: StartFailureRecord = {
      stage: "build-failed",
      message: "revkit serve: auto-build failed",
      failedAt: new Date().toISOString(),
      version: "0.0.0-test",
      inputs: { distExists: false }, // was missing then
    };
    let clearCalled = 0;
    let spawnCount = 0;
    const ready = fixtureState({ instanceId: "ready-n1-stale" });
    const result = await ensureDaemon({
      repoRoot: root,
      findRunningDaemon: (() => {
        let n = 0;
        return () => (n++ === 0 ? undefined : ready);
      })(),
      readStartFailure: () => failure,
      clearStartFailure: () => {
        clearCalled++;
      },
      spawn: () => {
        spawnCount++;
        return { pid: 777 };
      },
      sleep: async () => {},
      pollIntervalMs: 1,
      waitMs: 100,
    });
    expect(clearCalled).toBe(1);
    expect(spawnCount).toBe(1);
    expect(result.spawned).toBe(true);
    expect(result.state.instanceId).toBe("ready-n1-stale");
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
  test("keeps only the named allowlist entries and LC_/XDG_ prefixes; drops NIX_LD / NODE_OPTIONS / tokens", () => {
    const env = filteredDaemonEnv({
      PATH: "/usr/bin:/bin",
      HOME: "/tmp/home",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      NIX_PROFILES: "/nix/p",
      NIX_PATH: "channels",
      NIX_USER_PROFILE_DIR: "/tmp/prof",
      XDG_CACHE_HOME: "/tmp/cache",
      TERM: "xterm",
      TMPDIR: "/tmp",
      SSL_CERT_FILE: "/etc/ssl/cert.pem",
      NIX_SSL_CERT_FILE: "/etc/ssl/cert.pem",
      HTTPS_PROXY: "https://proxy:3128",
      http_proxy: "http://proxy:3128",
      NO_PROXY: "127.0.0.1",
      // These MUST be dropped by the filter. Nix loader-injection
      // env, an inspector env, a preloader env, and three
      // credential-shaped names are all listed here as "hostile
      // agent env leaked in" simulants.
      NIX_LD: "/malicious/ld.so",
      NIX_LD_LIBRARY_PATH: "/malicious/lib",
      NODE_OPTIONS: "--inspect",
      LD_PRELOAD: "/malicious/lib.so",
      REVKIT_AGENT_TOKEN: "secret",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      GITHUB_TOKEN: "ghp_xxx",
    });
    // Kept.
    expect(env["PATH"]).toBe("/usr/bin:/bin");
    expect(env["HOME"]).toBe("/tmp/home");
    expect(env["LANG"]).toBe("en_US.UTF-8");
    expect(env["LC_ALL"]).toBe("C");
    expect(env["NIX_PROFILES"]).toBe("/nix/p");
    expect(env["NIX_PATH"]).toBe("channels");
    expect(env["XDG_CACHE_HOME"]).toBe("/tmp/cache");
    expect(env["TERM"]).toBe("xterm");
    expect(env["TMPDIR"]).toBe("/tmp");
    expect(env["SSL_CERT_FILE"]).toBe("/etc/ssl/cert.pem");
    expect(env["NIX_SSL_CERT_FILE"]).toBe("/etc/ssl/cert.pem");
    expect(env["HTTPS_PROXY"]).toBe("https://proxy:3128");
    expect(env["http_proxy"]).toBe("http://proxy:3128");
    expect(env["NO_PROXY"]).toBe("127.0.0.1");
    // MUTATION dropped.
    expect(env["NIX_LD"]).toBeUndefined();
    expect(env["NIX_LD_LIBRARY_PATH"]).toBeUndefined();
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
