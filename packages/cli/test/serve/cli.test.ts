// CLI-glue tests for `revkit serve`: argv parsing and the persistent
// local-user id. The `runServeCommand` full path (start → block →
// stop) is covered by the integration suite via `startDaemon`; this
// file keeps the pure functions honest.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseServeArgs, readOrMintLocalUserId, runServeCommand } from "../../src/serve/cli.ts";
import { readStartFailure } from "../../src/serve/serve-state.ts";

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

describe("runServeCommand — #251 B1 (signal cleanup, SIGKILL safety) & N1 (persisted failure)", () => {
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

  test("SIGTERM during auto-build aborts the build, releases the lock, and clears serve.json (#251 B1)", async () => {
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
        // Return a non-zero exit so runServeCommand treats it
        // as a failure after abort (equivalent to astro exiting
        // on kill).
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
    // The build sees the signal.
    expect(buildSawSignal?.aborted).toBe(true);
    // runServeCommand returns with a non-zero exit code.
    const result = await runPromise;
    expect(result.exitCode).not.toBe(0);
    // serve.json was cleaned up (ownership-checked unlink via
    // `acquired.release()`).
    expect(existsSync(join(root, ".revkit", "serve.json"))).toBe(false);
    // start-failed.json is persisted so a subsequent MCP tool
    // call reads the reason (#251 N1).
    const failure = readStartFailure(root);
    expect(failure).toBeDefined();
    expect(failure?.stage).toBe("aborted");
    expect(failure?.message).toContain("SIGTERM");
  }, 20_000);

  test("passes inheritFds=[lockFd] to the auto-build so the astro child inherits the lock (#251 B1 SIGKILL safety)", async () => {
    let receivedFds: readonly number[] | undefined;
    const result = await runServeCommand([], {
      cwd: root,
      version: "test-0.1.0",
      runBuildOverride: async (_args, opts) => {
        receivedFds = opts.inheritFds;
        // Fake a successful build. Create the default dist so the
        // "dist exists" postcondition is met.
        mkdirSync(join(root, ".revkit", "dist"), { recursive: true });
        writeFileSync(join(root, ".revkit", "dist", "index.html"), "<h1>x</h1>");
        return { exitCode: 0, stdout: "built", stderr: "" };
      },
      // A fake startDaemon that fails fast — we only care about
      // whether inheritFds reached runBuildCommand.
      startDaemonOverride: async () => {
        throw new Error("test: startDaemon not exercised");
      },
    });
    expect(result.exitCode).toBe(1);
    expect(receivedFds).toBeDefined();
    expect(receivedFds!.length).toBe(1);
    expect(receivedFds![0]).toBeGreaterThan(2); // the lock fd, above stdin/stdout/stderr
  }, 10_000);

  test("non-zero build exit code persists a start-failure record (#251 N1)", async () => {
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
    expect(failure?.inputs.distExists).toBe(false);
    // Lock + serve.json cleaned up.
    expect(existsSync(join(root, ".revkit", "serve.json"))).toBe(false);
  }, 10_000);
});
