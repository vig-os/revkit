// CLI-glue tests for `revkit serve`: argv parsing and the persistent
// local-user id. The `runServeCommand` full path (start → block →
// stop) is covered by the integration suite via `startDaemon`; this
// file keeps the pure functions honest.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseServeArgs, readOrMintLocalUserId, runServeCommand } from "../../src/serve/cli.ts";
import { computeInputFingerprint } from "../../src/serve/input-fingerprint.ts";
import {
  DIST_STAGING_PREFIX,
  listDistStagingDirs,
  readStartFailure,
} from "../../src/serve/serve-state.ts";

describe("parseServeArgs", () => {
  test("accepts an empty argv (auto-build enabled by default)", () => {
    const outcome = parseServeArgs([]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.dir).toBeUndefined();
      expect(outcome.port).toBeUndefined();
      expect(outcome.noAutoBuild).toBe(false);
    }
  });

  test("parses --no-auto-build (M5 part 2, issue #57)", () => {
    const outcome = parseServeArgs(["--no-auto-build"]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.noAutoBuild).toBe(true);
  });

  test("parses --dir <path> and --port <n>", () => {
    const outcome = parseServeArgs(["--dir", "build", "--port", "4321"]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.dir).toBe("build");
      expect(outcome.port).toBe(4321);
    }
  });

  test("parses --dir=<path> and --port=<n>", () => {
    const outcome = parseServeArgs(["--dir=build", "--port=0"]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.dir).toBe("build");
      expect(outcome.port).toBe(0);
    }
  });

  test("rejects --port with a non-integer", () => {
    const outcome = parseServeArgs(["--port", "abc"]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("--port");
  });

  test("rejects --port out of range", () => {
    const outcome = parseServeArgs(["--port", "70000"]);
    expect(outcome.ok).toBe(false);
  });

  test("rejects an unknown flag", () => {
    const outcome = parseServeArgs(["--nope"]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("unknown");
  });

  test("rejects --dir with no value", () => {
    const outcome = parseServeArgs(["--dir"]);
    expect(outcome.ok).toBe(false);
  });
});

describe("readOrMintLocalUserId", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "revkit-local-user-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("mints an id on first call and persists it at mode 600", () => {
    const first = readOrMintLocalUserId(root);
    expect(first.startsWith("local-")).toBe(true);
    // The id is base64url after the "local-" prefix.
    expect(first.length).toBeGreaterThan("local-".length);
    const path = join(root, ".revkit", "local-user");
    expect(existsSync(path)).toBe(true);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    // Persisted content equals what was returned.
    expect(readFileSync(path, "utf8").trim()).toBe(first);
  });

  test("returns the same id on subsequent calls", () => {
    const first = readOrMintLocalUserId(root);
    const second = readOrMintLocalUserId(root);
    expect(second).toBe(first);
  });
});

describe("runServeCommand — #251 round 3: signal handling, staging promotion, persisted failure", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "revkit-serve-b1-"));
    // Minimal workspace: `revkit` marker in package.json so
    // findRepoRootByPackageJson resolves to `root`.
    writeFileSync(join(root, "package.json"), '{"name":"revkit","private":true}', "utf8");
    mkdirSync(join(root, ".revkit"), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("SIGTERM during auto-build aborts the build, releases the lock, and does NOT persist a start-failure (#251 B2 (c))", async () => {
    // A slow fake build that awaits the AbortSignal. We dispatch
    // SIGTERM via `process.emit("SIGTERM")` (triggers listeners
    // without actually killing the test runner).
    let buildSawSignal: AbortSignal | undefined;
    let resolveBuildStarted!: () => void;
    const buildStarted = new Promise<void>((r) => {
      resolveBuildStarted = r;
    });
    const runPromise = runServeCommand([], {
      cwd: root,
      version: "test-0.1.0",
      runBuildOverride: async (_args, opts) => {
        buildSawSignal = opts.signal;
        resolveBuildStarted();
        await new Promise<void>((resolveAbort) => {
          opts.signal?.addEventListener("abort", () => resolveAbort(), { once: true });
        });
        return { exitCode: 143, stdout: "", stderr: "aborted" };
      },
    });
    await buildStarted;
    // Lock + "starting" serve.json record should both exist.
    expect(existsSync(join(root, ".revkit", "daemon.lock"))).toBe(true);
    expect(existsSync(join(root, ".revkit", "serve.json"))).toBe(true);
    const beforeState = JSON.parse(readFileSync(join(root, ".revkit", "serve.json"), "utf8")) as { status: string };
    expect(beforeState.status).toBe("starting");
    // Fire SIGTERM.
    process.emit("SIGTERM");
    expect(buildSawSignal?.aborted).toBe(true);
    const result = await runPromise;
    expect(result.exitCode).not.toBe(0);
    // serve.json was cleaned up (ownership-checked unlink via
    // `acquired.release()`).
    expect(existsSync(join(root, ".revkit", "serve.json"))).toBe(false);
    // Round-3 BLOCKER 2 (c): a signal abort is NEVER recorded as
    // a start-failure. Before the fix, every SIGTERM planted an
    // "aborted" record that then blocked MCP auto-spawn forever.
    expect(readStartFailure(root)).toBeUndefined();
    // And the staging dir is removed.
    expect(listDistStagingDirs(root)).toEqual([]);
  }, 20_000);

  test("passes a private staging distOutDir to the auto-build (#251 round 3 BLOCKER 1)", async () => {
    let receivedDistOut: string | undefined;
    const result = await runServeCommand([], {
      cwd: root,
      version: "test-0.1.0",
      runBuildOverride: async (_args, opts) => {
        receivedDistOut = opts.distOutDir;
        // Fake a successful build at the staging dir.
        if (opts.distOutDir !== undefined) {
          mkdirSync(opts.distOutDir, { recursive: true });
          writeFileSync(join(opts.distOutDir, "index.html"), "<h1>x</h1>");
        }
        return { exitCode: 0, stdout: "built", stderr: "" };
      },
      startDaemonOverride: async () => {
        throw new Error("test: startDaemon not exercised");
      },
    });
    expect(result.exitCode).toBe(1);
    expect(receivedDistOut).toBeDefined();
    expect(receivedDistOut!).toContain(`${DIST_STAGING_PREFIX}${process.pid}-`);
    // Build succeeded → staging was promoted to dist.
    expect(existsSync(join(root, ".revkit", "dist", "index.html"))).toBe(true);
    // Staging dir no longer exists.
    expect(listDistStagingDirs(root)).toEqual([]);
  }, 10_000);

  test("non-zero build exit code persists a start-failure with a fingerprint, removes staging (#251 N1)", async () => {
    // Seed a docs tree so the fingerprint computes to something
    // non-trivial.
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "index.md"), "# hi\n");
    const result = await runServeCommand([], {
      cwd: root,
      version: "test-0.1.0",
      runBuildOverride: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "revkit build: astro build exited 1. Tail: a page body is empty",
      }),
    });
    expect(result.exitCode).not.toBe(0);
    const failure = readStartFailure(root);
    expect(failure).toBeDefined();
    expect(failure?.stage).toBe("build-failed");
    expect(failure?.stderrTail ?? "").toContain("a page body is empty");
    expect(failure?.inputs.fingerprint ?? "").toHaveLength(64); // sha256 hex
    // Lock + serve.json cleaned up.
    expect(existsSync(join(root, ".revkit", "serve.json"))).toBe(false);
    // Staging dir removed on failure.
    expect(listDistStagingDirs(root)).toEqual([]);
  }, 10_000);

  test("lock contention does NOT write a start-failure (#251 round 3 BLOCKER 2 (a))", async () => {
    // Simulate a second `revkit serve` losing the lock: hold the
    // flock manually, then run `runServeCommand`. It must refuse
    // with "another daemon holds .revkit/daemon.lock" and leave
    // `.revkit/start-failed.json` absent.
    const { acquireDaemonLock } = await import("../../src/serve/daemon-lock.ts");
    const held = acquireDaemonLock(join(root, ".revkit", "daemon.lock"));
    expect(held).not.toBeNull();
    try {
      const result = await runServeCommand([], {
        cwd: root,
        version: "test-0.1.0",
        runBuildOverride: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("another daemon holds");
    } finally {
      held?.release();
    }
    // Round-3 BLOCKER 2 (a): the record was never planted.
    expect(readStartFailure(root)).toBeUndefined();
  }, 10_000);

  test("concurrent warm sessions do not plant a start-failure (#251 round 3 BLOCKER 2 (b))", async () => {
    // Pre-fix reproduction: the second `runServeCommand`'s
    // "already running" branch used to flow into the start-
    // failure writer indirectly. Round-3 keeps the path write-
    // free: both the winner's and the loser's exit leave
    // start-failed.json absent.
    mkdirSync(join(root, ".revkit", "dist"), { recursive: true });
    writeFileSync(join(root, ".revkit", "dist", "index.html"), "<h1>warm</h1>");
    const { acquireDaemonLock } = await import("../../src/serve/daemon-lock.ts");
    const held = acquireDaemonLock(join(root, ".revkit", "daemon.lock"));
    expect(held).not.toBeNull();
    try {
      // --dir explicitly set so we would NOT hit the auto-build
      // path (keeps the test tight). The pre-bind lock refusal
      // lives above the auto-build branch.
      const result = await runServeCommand(["--dir", ".revkit/dist"], {
        cwd: root,
        version: "test-0.1.0",
      });
      expect(result.exitCode).not.toBe(0);
    } finally {
      held?.release();
    }
    expect(readStartFailure(root)).toBeUndefined();
  }, 10_000);

  test("#251 round 3 BLOCKER 1: SIGKILL serve mid-build, next start only promotes the second build's output (orphan never touches dist)", async () => {
    // Simulate a SIGKILLed prior serve: a stale staging dir
    // written by an orphaned astro + a dead pid. The next cold
    // `revkit serve` must sweep that dir and run its own build
    // against the staging path it mints, NEVER promote the
    // orphan's content to `.revkit/dist`.
    //
    // Pre-fix (3e4ad4c) never had staging dirs: the astro
    // orphan wrote directly to `.revkit/dist` and a second
    // serve started atop the orphan's half-built output.
    let deadPid = 2 ** 20;
    while (require("node:fs").existsSync(`/proc/${deadPid}`)) deadPid++;
    const orphanName = `${DIST_STAGING_PREFIX}${deadPid}-orphan`;
    const orphanDir = join(root, ".revkit", orphanName);
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(join(orphanDir, "index.html"), "<h1>orphan-from-sigkilled-serve</h1>");

    let seenDistOut: string | undefined;
    const result = await runServeCommand([], {
      cwd: root,
      version: "test-0.1.0",
      runBuildOverride: async (_args, opts) => {
        seenDistOut = opts.distOutDir;
        if (opts.distOutDir !== undefined) {
          mkdirSync(opts.distOutDir, { recursive: true });
          writeFileSync(join(opts.distOutDir, "index.html"), "<h1>second-build-winner</h1>");
        }
        return { exitCode: 0, stdout: "built", stderr: "" };
      },
      startDaemonOverride: async () => {
        throw new Error("test: startDaemon not exercised");
      },
    });
    expect(result.exitCode).toBe(1); // stopDaemon stub throws
    // The orphan staging dir was swept.
    expect(existsSync(orphanDir)).toBe(false);
    // The second build ran into ITS OWN staging dir.
    expect(seenDistOut).toBeDefined();
    expect(seenDistOut!).toContain(`${DIST_STAGING_PREFIX}${process.pid}-`);
    // The orphan NEVER touched `.revkit/dist`: the promoted
    // content is the winner's.
    expect(readFileSync(join(root, ".revkit", "dist", "index.html"), "utf8")).toContain("second-build-winner");
    expect(readFileSync(join(root, ".revkit", "dist", "index.html"), "utf8")).not.toContain("orphan");
  }, 15_000);

  test(
    "#251 round 4 BLOCKER 2: a fix written DURING the build is NOT absorbed into the recorded fingerprint",
    async () => {
      // Pre-fix (round 3): the fingerprint was computed AFTER the
      // build failed, so a user who saved a fix while the build
      // ran had their fix hashed into the record; MCP then saw the
      // "new" fingerprint == recorded fingerprint and suppressed
      // every retry for a bug that was already fixed. Round 4
      // pins the pre-build fingerprint and writes it to disk
      // verbatim.
      mkdirSync(join(root, "docs"), { recursive: true });
      writeFileSync(join(root, "docs", "a.md"), "# broken\n");
      const preBuild = computeInputFingerprint(root);
      expect(preBuild).toBeDefined();

      const result = await runServeCommand([], {
        cwd: root,
        version: "test-0.1.0",
        runBuildOverride: async () => {
          // Simulate the user saving a fix mid-build: touch a doc
          // AND mutate another input the whole-tree fingerprint
          // covers.
          writeFileSync(join(root, "docs", "a.md"), "# fixed\n");
          mkdirSync(join(root, "components"), { recursive: true });
          writeFileSync(join(root, "components", "Widget.tsx"), "export const x = 1;\n");
          return {
            exitCode: 1,
            stdout: "",
            stderr: "revkit build: astro build exited 1. Tail: a page body is empty",
          };
        },
      });
      expect(result.exitCode).not.toBe(0);
      const failure = readStartFailure(root);
      expect(failure).toBeDefined();
      const recorded = failure?.inputs.fingerprint ?? "";
      const postBuild = computeInputFingerprint(root);
      expect(postBuild).toBeDefined();
      // Round 4 contract: the record carries the PRE-BUILD
      // fingerprint, NOT the post-build one.
      expect(recorded).toBe(preBuild!);
      expect(recorded).not.toBe(postBuild!);
      // Consequence: `ensureDaemon` comparing the current tree
      // with the recorded fingerprint will see a mismatch and
      // clear the suppression on the next MCP tool call.
    },
    15_000,
  );

  test(
    "#251 round 5 (b): a build terminated by a signal (exit 128+n, e.g. 137 OOM) does NOT write a start-failure record",
    async () => {
      // Pre-fix (6c35db48): a signal-killed astro (oom-killer
      // SIGKILL = exit 137 in bash convention, admin `kill -9`,
      // any external signal that did NOT flip our own
      // AbortController) returned `exitCode != 0` and the serve
      // path planted a `.revkit/start-failed.json` record with an
      // input fingerprint. The record then wedged MCP's respawn
      // until the user manually removed the file or edited any
      // file in the tree. Round 5 (b) honours the round-3 rule:
      // a signal-terminated build is NEVER a genuine failure —
      // write no record.
      mkdirSync(join(root, "docs"), { recursive: true });
      writeFileSync(join(root, "docs", "a.md"), "# hi\n");
      const result = await runServeCommand([], {
        cwd: root,
        version: "test-0.1.0",
        runBuildOverride: async () => ({
          exitCode: 137, // 128 + SIGKILL(9) — the oom-killer shape
          stdout: "",
          stderr: "astro was killed before it could write anything",
          signalTerminated: true,
        }),
      });
      expect(result.exitCode).not.toBe(0);
      // Round 5 (b) contract: no start-failure record for a
      // signal termination. Pre-fix this file exists with a
      // valid-looking fingerprint and a build-failed stage.
      expect(readStartFailure(root)).toBeUndefined();
      // Lock + serve.json cleaned up as usual.
      expect(existsSync(join(root, ".revkit", "serve.json"))).toBe(false);
      expect(listDistStagingDirs(root)).toEqual([]);
    },
    10_000,
  );

  test("successful bind clears any stale start-failed.json", async () => {
    // Seed a stale record from a prior failed attempt.
    writeFileSync(
      join(root, ".revkit", "start-failed.json"),
      JSON.stringify({
        stage: "build-failed",
        message: "stale",
        failedAt: "2026-11-01T00:00:00Z",
        version: "0.0.0",
        inputs: { fingerprint: "stale-fp" },
      }),
      { mode: 0o600 },
    );
    expect(existsSync(join(root, ".revkit", "start-failed.json"))).toBe(true);
    mkdirSync(join(root, ".revkit", "dist"), { recursive: true });
    writeFileSync(join(root, ".revkit", "dist", "index.html"), "<h1>x</h1>");
    const result = await runServeCommand(["--dir", ".revkit/dist"], {
      cwd: root,
      version: "test-0.1.0",
      // Minimal startDaemon stub that returns a fake handle.
      startDaemonOverride: async () => {
        return { stop: async () => {} } as { stop: () => Promise<void> } as never;
      },
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, ".revkit", "start-failed.json"))).toBe(false);
    // Clean up: trigger the daemon handle's stop() so the
    // blockForever promise resolves (not awaited here).
    void result.blockForever;
  }, 10_000);
});
