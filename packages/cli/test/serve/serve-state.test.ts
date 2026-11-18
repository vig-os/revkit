// `.revkit/serve.json` and the daemon lock — mode 600, atomic write,
// ownership-checked shutdown, `findRunningDaemon` semantics. Every
// test builds a temporary "repo root" so the state file lands in
// isolation.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DIST_STAGING_PREFIX,
  DIST_STAGING_RE,
  acquireAndPublish,
  cleanupOrphanedStagingDirs,
  daemonLockPath,
  findRunningDaemon,
  listDistStagingDirs,
  newDistStagingName,
  pidIsAlive,
  promoteStagingDir,
  readOrMintRepoId,
  readServeState,
  readServeStateVerbose,
  readStartFailure,
  removeServeState,
  repoIdPath,
  serveStatePath,
  startFailurePath,
  writeServeState,
  writeStartFailure,
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

  test("#251 round 3: the lock fd is always CLOEXEC — a child does not keep the flock alive after parent death", async () => {
    // Round-3 revert of the inherited-fd mechanism. The lock fd
    // MUST be CLOEXEC so it never silently outlives its owning
    // process through an inherited subprocess. We assert both:
    //   (1) FD_CLOEXEC is set on the fd we got back, and
    //   (2) a subprocess that inherited our lock fd through
    //       `Bun.spawn`'s stdio does NOT keep the flock alive
    //       after the parent exits.
    const path = daemonLockPath(repoRoot);
    require("node:fs").mkdirSync(join(repoRoot, ".revkit"), { recursive: true });
    const held = acquireDaemonLock(path);
    expect(held).not.toBeNull();
    try {
      // (1) FD_CLOEXEC is on.
      const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
      const lib = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
        fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
      const F_GETFD = 1;
      const FD_CLOEXEC = 1;
      const flags = Number(lib.symbols.fcntl(held!.fd, F_GETFD, 0));
      expect(flags & FD_CLOEXEC).toBe(FD_CLOEXEC);
    } finally {
      held?.release();
    }
  });

  test("#251 round 3 BLOCKER 1: the lock is still held after a forced Bun.gc() following a completed build", async () => {
    // Pre-fix reproduction of the round-3 reviewer's duplicate-
    // daemon race.
    //
    // ROUND 2 (pre-fix): `acquireStartingLock` opened the lock
    // with `{ inheritable: true }` and exposed `lockFd` so
    // `revkit serve` could hand it to the astro child via
    // `Bun.spawn`'s `stdio` array. Bun closes fds passed through
    // `stdio` when the Subprocess is garbage-collected, so once
    // the build completed and the Subprocess dropped, GC closed
    // the serving daemon's OWN lock fd — the kernel then
    // released the flock while the daemon was still serving,
    // and a second `revkit serve` bound on the same repo
    // (reproduced: two daemons sharing threads.sqlite).
    //
    // ROUND 3 (post-fix): the `inheritable` option is gone
    // and `AcquiredStartingDaemon` no longer exposes `lockFd`.
    // The SIGKILL race is addressed through staging-dir
    // promotion instead. The flock is CLOEXEC-only, held by the
    // serving daemon for the life of that process — no fd ever
    // reaches a Subprocess's `stdio`, so GC of a Subprocess
    // cannot touch it.
    const { acquireStartingLock } = require("../../src/serve/serve-state.ts");
    const acquired = acquireStartingLock(repoRoot, {
      pid: process.pid,
      version: "0.0.0-test",
      startedAt: new Date().toISOString(),
      instanceId: "gc-test",
    });
    expect(acquired.kind).toBe("ok");
    try {
      // Simulate `revkit serve`'s cold-start astro spawn. Pre-
      // fix, `serve/cli.ts` passed `inheritFds: [lockFd]` which
      // the shared `defaultSpawn` turned into a stdio entry on
      // `Bun.spawn`. If a pre-fix-shaped `lockFd` leaks through
      // the API surface, drive the real inheritance path here
      // so the pre-fix bug is proved. Post-fix the field is
      // absent and we just spawn a plain child — the lock
      // stays held because no fd was ever handed to anyone.
      const maybeLockFd = (acquired as { lockFd?: number }).lockFd;
      let child: Bun.Subprocess | undefined;
      if (typeof maybeLockFd === "number") {
        child = Bun.spawn(["true"], {
          stdio: ["ignore", "ignore", "ignore", maybeLockFd] as never,
        });
      } else {
        child = Bun.spawn(["true"], { stdio: ["ignore", "ignore", "ignore"] });
      }
      await child.exited;
      // Drop the Subprocess reference and force GC. The round-2
      // reviewer reproduced the drop with this exact shape.
      child = undefined;
      Bun.gc(true);
      // Give Bun a tick to actually close resources.
      await Bun.sleep(50);
      // Second acquire MUST be refused — the serving daemon
      // (this test fixture) still holds the flock.
      const refused = acquireDaemonLock(daemonLockPath(repoRoot));
      expect(refused).toBeNull();
    } finally {
      acquired.release();
    }
  }, 15_000);
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

describe("#251 round 3: staging-dir promotion", () => {
  let repoRoot: string;
  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "revkit-staging-"));
    require("node:fs").mkdirSync(join(repoRoot, ".revkit"), { recursive: true });
  });
  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("newDistStagingName composes `dist.staging-<pid>-<nonce>` and strips unsafe chars", () => {
    const name = newDistStagingName(42, "abc_DEF-0");
    expect(name).toBe(`${DIST_STAGING_PREFIX}42-abc_DEF-0`);
    expect(DIST_STAGING_RE.test(name)).toBe(true);
    // The regex rejects a bogus nonce with slashes / spaces — only
    // the sanitised shape is written.
    const sanitised = newDistStagingName(99, "a/b c!");
    expect(DIST_STAGING_RE.test(sanitised)).toBe(true);
    expect(sanitised).toContain("abc");
  });

  test("listDistStagingDirs reports every matching dir under .revkit/", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    fs.mkdirSync(join(repoRoot, ".revkit", `${DIST_STAGING_PREFIX}1-abc`), { recursive: true });
    fs.mkdirSync(join(repoRoot, ".revkit", `${DIST_STAGING_PREFIX}2-def`), { recursive: true });
    fs.mkdirSync(join(repoRoot, ".revkit", "dist"), { recursive: true });
    fs.mkdirSync(join(repoRoot, ".revkit", "unrelated"), { recursive: true });
    const seen = listDistStagingDirs(repoRoot).map((e) => `${e.name}:${e.pid}`).sort();
    expect(seen).toEqual([`${DIST_STAGING_PREFIX}1-abc:1`, `${DIST_STAGING_PREFIX}2-def:2`]);
  });

  test("cleanupOrphanedStagingDirs removes dirs whose pid is dead, leaves live ones alone", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    // pid 1 is PID-1 (init), always alive on any POSIX host —
    // acts as our "live" placeholder (we would not scrub someone
    // else's staging dir mid-build).
    const alive = join(repoRoot, ".revkit", `${DIST_STAGING_PREFIX}1-alive`);
    fs.mkdirSync(alive, { recursive: true });
    // Pick a pid that is almost certainly dead: use a large one.
    // `process.kill(pid, 0)` returns ESRCH for a gap in the pid
    // space.
    let deadPid = 2 ** 20;
    while (pidIsAlive(deadPid)) deadPid++;
    const dead = join(repoRoot, ".revkit", `${DIST_STAGING_PREFIX}${deadPid}-dead`);
    fs.mkdirSync(dead, { recursive: true });
    const removed = cleanupOrphanedStagingDirs(repoRoot);
    expect(removed).toContain(`${DIST_STAGING_PREFIX}${deadPid}-dead`);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(alive)).toBe(true);
  });

  test("promoteStagingDir renames staging → dist when dist is absent", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const staging = join(repoRoot, ".revkit", `${DIST_STAGING_PREFIX}1-abc`);
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(join(staging, "index.html"), "<h1>staged</h1>");
    const dist = join(repoRoot, ".revkit", "dist");
    const outcome = promoteStagingDir(staging, dist);
    expect(outcome.kind).toBe("promoted");
    expect(existsSync(staging)).toBe(false);
    expect(readFileSync(join(dist, "index.html"), "utf8")).toBe("<h1>staged</h1>");
  });

  test("promoteStagingDir refuses to overwrite an existing dist (kept-existing)", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const staging = join(repoRoot, ".revkit", `${DIST_STAGING_PREFIX}1-abc`);
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(join(staging, "index.html"), "<h1>staged</h1>");
    const dist = join(repoRoot, ".revkit", "dist");
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(join(dist, "index.html"), "<h1>existing</h1>");
    const outcome = promoteStagingDir(staging, dist);
    expect(outcome.kind).toBe("kept-existing");
    // The existing winner survives untouched.
    expect(readFileSync(join(dist, "index.html"), "utf8")).toBe("<h1>existing</h1>");
    // Staging dir is left in place — caller discards it.
    expect(existsSync(staging)).toBe(true);
  });
});

describe("#251 round 3: StartFailureRecord uses an input fingerprint", () => {
  let repoRoot: string;
  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "revkit-start-failure-"));
    require("node:fs").mkdirSync(join(repoRoot, ".revkit"), { recursive: true });
  });
  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("writeStartFailure persists the fingerprint; readStartFailure round-trips it", () => {
    writeStartFailure(repoRoot, {
      stage: "build-failed",
      message: "revkit serve: auto-build failed (astro build exited 1)",
      stderrTail: "SyntaxError in docs/foo.mdx",
      failedAt: "2026-11-18T12:00:00Z",
      version: "test-0.1.0",
      inputs: { fingerprint: "0123456789abcdef" },
    });
    const read = readStartFailure(repoRoot);
    expect(read).toBeDefined();
    expect(read?.stage).toBe("build-failed");
    expect(read?.inputs.fingerprint).toBe("0123456789abcdef");
    expect(read?.stderrTail).toContain("SyntaxError");
  });

  test("readStartFailure refuses legacy records that only carry distExists (#251 round-3 BLOCKER 2 (d))", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    // The pre-fix shape had `inputs.distExists` and no
    // `fingerprint`. The round-3 schema refuses it (returns
    // undefined) so a legacy record from a crash never blocks a
    // new MCP auto-spawn forever.
    fs.writeFileSync(
      startFailurePath(repoRoot),
      JSON.stringify({
        stage: "build-failed",
        message: "legacy",
        failedAt: "2026-11-01T12:00:00Z",
        version: "0.0.0",
        inputs: { distExists: false },
      }),
      "utf8",
    );
    expect(readStartFailure(repoRoot)).toBeUndefined();
  });

  test('readStartFailure rejects stage "aborted" — round-3 removes that case entirely', () => {
    const fs = require("node:fs") as typeof import("node:fs");
    fs.writeFileSync(
      startFailurePath(repoRoot),
      JSON.stringify({
        stage: "aborted",
        message: "signal",
        failedAt: "2026-11-01T12:00:00Z",
        version: "0.0.0",
        inputs: { fingerprint: "deadbeef" },
      }),
      "utf8",
    );
    // After round 3, `stage: "aborted"` is never written; the
    // reader also refuses it so an operator who edits in the old
    // literal cannot silently wedge MCP.
    expect(readStartFailure(repoRoot)).toBeUndefined();
  });
});
