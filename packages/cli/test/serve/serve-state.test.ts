// `.revkit/serve.json` and the daemon lock — mode 600, atomic write,
// ownership-checked shutdown, `findRunningDaemon` semantics. Every
// test builds a temporary "repo root" so the state file lands in
// isolation.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  acquireAndPublish,
  daemonLockPath,
  findRunningDaemon,
  readOrMintRepoId,
  readServeState,
  readServeStateVerbose,
  removeServeState,
  repoIdPath,
  serveStatePath,
  writeServeState,
  type ServeState,
} from "../../src/serve/serve-state.ts";
import { readFileSync } from "node:fs";
import { acquireDaemonLock } from "../../src/serve/daemon-lock.ts";

const sample = (instanceId: string, port = 40000): ServeState => ({
  pid: process.pid,
  port,
  url: `http://127.0.0.1:${port}`,
  agentToken: "AGENT-TOK",
  startedAt: "2026-09-30T12:00:00Z",
  version: "0.0.0",
  instanceId,
});

describe("serve-state", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "revkit-serve-state-"));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("writeServeState writes .revkit/serve.json at mode 600", () => {
    writeServeState(repoRoot, sample("id-1"));
    const path = serveStatePath(repoRoot);
    expect(existsSync(path)).toBe(true);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("readServeState reads the state back with the instanceId", () => {
    writeServeState(repoRoot, sample("id-1"));
    const read = readServeState(repoRoot);
    expect(read).toBeDefined();
    expect(read?.pid).toBe(process.pid);
    expect(read?.agentToken).toBe("AGENT-TOK");
    expect(read?.instanceId).toBe("id-1");
  });

  test("readServeStateVerbose returns 'missing' when the file does not exist", () => {
    const outcome = readServeStateVerbose(repoRoot);
    expect(outcome.kind).toBe("missing");
  });

  test("readServeStateVerbose reports 'unparsable' with a reason for an empty file", () => {
    // Empty-file repro: a crash between open("wx") and write used
    // to leave this shape and block every restart with a bare
    // "JSON Parse error". Now unparsable is a typed outcome; the
    // ownership check on shutdown / the lock-based restart handles
    // it correctly (see the lock tests below).
    const path = serveStatePath(repoRoot);
    require("node:fs").mkdirSync(join(repoRoot, ".revkit"), { recursive: true });
    writeFileSync(path, "");
    const outcome = readServeStateVerbose(repoRoot);
    expect(outcome.kind).toBe("unparsable");
    if (outcome.kind === "unparsable") {
      expect(outcome.reason).toContain(path);
    }
  });

  test("readServeStateVerbose reports 'unparsable' for a truncated / malformed JSON", () => {
    const path = serveStatePath(repoRoot);
    require("node:fs").mkdirSync(join(repoRoot, ".revkit"), { recursive: true });
    writeFileSync(path, "{ this is not json");
    const outcome = readServeStateVerbose(repoRoot);
    expect(outcome.kind).toBe("unparsable");
  });

  test("removeServeState is idempotent", () => {
    writeServeState(repoRoot, sample("id-1"));
    removeServeState(repoRoot);
    expect(existsSync(serveStatePath(repoRoot))).toBe(false);
    removeServeState(repoRoot);
  });
});

describe("acquireAndPublish + findRunningDaemon (round-3 lock behaviour)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "revkit-lock-"));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("acquireAndPublish grants the lock and writes serve.json", () => {
    const outcome = acquireAndPublish(repoRoot, sample("id-1"));
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      const read = readServeState(repoRoot);
      expect(read?.instanceId).toBe("id-1");
      outcome.release();
    }
  });

  test("release() removes serve.json only when the on-disk instanceId matches ours", () => {
    const outcome = acquireAndPublish(repoRoot, sample("id-1"));
    if (outcome.kind !== "ok") throw new Error("first acquire failed");
    // Overwrite serve.json with a foreign instanceId (this
    // simulates a racing daemon taking over the advertisement).
    writeServeState(repoRoot, sample("id-foreign", 40001));
    outcome.release();
    // The foreign file must survive our release.
    const surviving = readServeState(repoRoot);
    expect(surviving?.instanceId).toBe("id-foreign");
  });

  test("release() removes serve.json when it still carries our instanceId", () => {
    const outcome = acquireAndPublish(repoRoot, sample("id-1"));
    if (outcome.kind !== "ok") throw new Error("first acquire failed");
    outcome.release();
    expect(existsSync(serveStatePath(repoRoot))).toBe(false);
  });

  test("a second acquireAndPublish while the first is held is refused", () => {
    const first = acquireAndPublish(repoRoot, sample("id-1"));
    if (first.kind !== "ok") throw new Error("first should have acquired");
    try {
      const second = acquireAndPublish(repoRoot, sample("id-2"));
      expect(second.kind).toBe("already-running");
    } finally {
      first.release();
    }
  });

  test("acquireAndPublish succeeds after the previous lock is released", () => {
    const first = acquireAndPublish(repoRoot, sample("id-1"));
    if (first.kind !== "ok") throw new Error("first should have acquired");
    first.release();
    const second = acquireAndPublish(repoRoot, sample("id-2"));
    expect(second.kind).toBe("ok");
    if (second.kind === "ok") second.release();
  });

  test("findRunningDaemon returns undefined when no lock is held", () => {
    // No daemon has ever started here.
    expect(findRunningDaemon(repoRoot)).toBeUndefined();
    // Even with a stale serve.json on disk (previous daemon
    // crashed), findRunningDaemon must return undefined because
    // the lock is free.
    require("node:fs").mkdirSync(join(repoRoot, ".revkit"), { recursive: true });
    writeServeState(repoRoot, sample("id-stale"));
    // Also touch the lock file so `findRunningDaemon` reaches the
    // acquire step rather than short-circuiting on existsSync.
    writeFileSync(daemonLockPath(repoRoot), "");
    expect(findRunningDaemon(repoRoot)).toBeUndefined();
  });

  test("findRunningDaemon returns the advertisement when a daemon holds the lock", () => {
    const outcome = acquireAndPublish(repoRoot, sample("id-1"));
    if (outcome.kind !== "ok") throw new Error("first acquire failed");
    try {
      const found = findRunningDaemon(repoRoot);
      expect(found?.instanceId).toBe("id-1");
    } finally {
      outcome.release();
    }
  });
});

describe("daemon-lock (raw acquire / release)", () => {
  let repoRoot: string;
  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "revkit-lock-raw-"));
  });
  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("the second acquireDaemonLock while the first is held returns null", () => {
    const path = daemonLockPath(repoRoot);
    require("node:fs").mkdirSync(join(repoRoot, ".revkit"), { recursive: true });
    const first = acquireDaemonLock(path);
    expect(first).not.toBeNull();
    const second = acquireDaemonLock(path);
    expect(second).toBeNull();
    first?.release();
  });

  test("after release, another acquire succeeds", () => {
    const path = daemonLockPath(repoRoot);
    require("node:fs").mkdirSync(join(repoRoot, ".revkit"), { recursive: true });
    const first = acquireDaemonLock(path);
    first?.release();
    const second = acquireDaemonLock(path);
    expect(second).not.toBeNull();
    second?.release();
  });

  test("#251 B1: inheritable:true opens the lock fd WITHOUT FD_CLOEXEC so it survives exec", () => {
    // SIGKILL safety relies on the astro child inheriting the
    // lock fd: the kernel keeps the flock alive while any process
    // maps the fd to the inode. That only happens when
    // FD_CLOEXEC is off on the fd — otherwise exec clears it.
    //
    // We can't drive an exec from a unit test, but we can assert
    // the invariant that makes exec-time inheritance possible:
    // FD_CLOEXEC on the inheritable lock fd is 0.
    const path = daemonLockPath(repoRoot);
    require("node:fs").mkdirSync(join(repoRoot, ".revkit"), { recursive: true });

    const held = acquireDaemonLock(path, { inheritable: true });
    expect(held).not.toBeNull();
    try {
      const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
      const lib = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
        fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
      const F_GETFD = 1;
      const FD_CLOEXEC = 1;
      const flags = Number(lib.symbols.fcntl(held!.fd, F_GETFD, 0));
      // Inheritable: FD_CLOEXEC bit MUST be off.
      expect(flags & FD_CLOEXEC).toBe(0);
    } finally {
      held?.release();
    }
  });

  test("#251 B1 SIGKILL: an inherited lock fd survives parent death; a second acquire is refused until the child exits", async () => {
    // End-to-end proof that fd inheritance is what keeps the
    // flock alive on a parent SIGKILL. We simulate `revkit serve`
    // being killed mid-build by:
    //
    // 1. Spawning a Bun parent that acquires the lock
    //    (inheritable: true), then execs a child `sleep` with
    //    the fd inherited, and WAITS for the child.
    // 2. Killing the PARENT with SIGKILL while the child sleeps.
    // 3. From this test process: try `acquireDaemonLock` on the
    //    same path. It MUST be refused because the orphaned
    //    child still has the fd open and the kernel still holds
    //    the flock on that inode.
    // 4. Kill the child; verify the lock is then free.
    const path = daemonLockPath(repoRoot);
    require("node:fs").mkdirSync(join(repoRoot, ".revkit"), { recursive: true });
    // Parent that holds the inheritable lock + spawns a sleep
    // child that inherits the fd via `stdio` (Bun.spawn requires
    // the fd listed in `stdio` for inheritance — a non-CLOEXEC
    // fd is NOT silently inherited the way a plain posix_spawn
    // would have). The parent then blocks on the child; a
    // SIGKILL cuts the parent but leaves the orphaned sleep
    // (adopted by init / the test runner) with the fd.
    const parentScript = `
      const { acquireDaemonLock } = await import("${resolve(import.meta.dirname, "..", "..", "src", "serve", "daemon-lock.ts")}");
      const held = acquireDaemonLock(${JSON.stringify(path)}, { inheritable: true });
      if (held === null) { process.exit(2); }
      // stdio: [stdin, stdout, stderr, lockFd] — Bun inherits
      // the lock fd by appending it to the stdio array, which
      // mirrors how serve/cli.ts hands the fd to the astro child.
      const sleepProc = Bun.spawn(["sleep", "30"], {
        stdio: ["ignore", "inherit", "inherit", held.fd],
      });
      process.stderr.write("CHILDPID=" + sleepProc.pid + "\\n");
      await sleepProc.exited;
    `;
    const parent = (await import("node:child_process")).spawn(
      "bun",
      ["-e", parentScript],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let childPid: number | undefined;
    let stderrBuf = "";
    parent.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      const m = stderrBuf.match(/CHILDPID=(\d+)/);
      if (m !== null) childPid = Number(m[1]);
    });
    // Wait up to 5 s for the child to be announced.
    const deadline = Date.now() + 5_000;
    while (childPid === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(childPid).toBeDefined();
    try {
      // SIGKILL the parent — no handlers run, lock fd closes in
      // the parent, but the sleep child still has it mapped.
      parent.kill("SIGKILL");
      await new Promise((r) => parent.on("exit", r));
      // Lock is STILL held by the orphan: a second acquire is
      // refused.
      const refused = acquireDaemonLock(path);
      expect(refused).toBeNull();
      // Kill the orphan. On exit the kernel closes the fd and
      // releases the lock.
      process.kill(childPid!, "SIGKILL");
      // Poll briefly for the lock to become free.
      const freeDeadline = Date.now() + 2_000;
      let freed = false;
      while (Date.now() < freeDeadline) {
        const attempt = acquireDaemonLock(path);
        if (attempt !== null) {
          attempt.release();
          freed = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(freed).toBe(true);
    } finally {
      try { parent.kill("SIGKILL"); } catch { /* already dead */ }
      if (childPid !== undefined) {
        try { process.kill(childPid, "SIGKILL"); } catch { /* already dead */ }
      }
    }
  }, 15_000);

  test("#251 B1: inheritable omitted (default) keeps FD_CLOEXEC on — fd NOT inherited", () => {
    const path = daemonLockPath(repoRoot);
    require("node:fs").mkdirSync(join(repoRoot, ".revkit"), { recursive: true });

    const held = acquireDaemonLock(path); // default
    expect(held).not.toBeNull();
    try {
      const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
      const lib = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
        fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
      const F_GETFD = 1;
      const FD_CLOEXEC = 1;
      const flags = Number(lib.symbols.fcntl(held!.fd, F_GETFD, 0));
      // Default: FD_CLOEXEC bit MUST be on (the pre-#251 contract).
      expect(flags & FD_CLOEXEC).toBe(FD_CLOEXEC);
    } finally {
      held?.release();
    }
  });
});

describe("readOrMintRepoId (issue #60 PR #62 round-3)", () => {
  let repoRoot: string;
  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "revkit-repo-id-"));
  });
  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("mints a base64url tag on first call and persists it at mode 0600", () => {
    const id = readOrMintRepoId(repoRoot);
    expect(id).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    const path = repoIdPath(repoRoot);
    expect(existsSync(path)).toBe(true);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readFileSync(path, "utf8").trim()).toBe(id);
  });

  test("returns the same id on subsequent calls (stable across daemon restarts on same repo)", () => {
    const a = readOrMintRepoId(repoRoot);
    const b = readOrMintRepoId(repoRoot);
    expect(b).toBe(a);
  });

  test("two independent repos mint distinct ids", () => {
    const otherRoot = mkdtempSync(join(tmpdir(), "revkit-repo-id-other-"));
    try {
      const a = readOrMintRepoId(repoRoot);
      const b = readOrMintRepoId(otherRoot);
      expect(a).not.toBe(b);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  test("a corrupted / empty file is re-minted rather than trusted", () => {
    const path = repoIdPath(repoRoot);
    require("node:fs").mkdirSync(join(repoRoot, ".revkit"), { recursive: true });
    writeFileSync(path, "", { mode: 0o600 });
    const id = readOrMintRepoId(repoRoot);
    expect(id.length).toBeGreaterThanOrEqual(16);
    // The file has been rewritten with a fresh id.
    expect(readFileSync(path, "utf8").trim()).toBe(id);
  });
});
