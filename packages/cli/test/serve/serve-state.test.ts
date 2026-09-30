// `.revkit/serve.json` and the daemon lock — mode 600, atomic write,
// ownership-checked shutdown, `findRunningDaemon` semantics. Every
// test builds a temporary "repo root" so the state file lands in
// isolation.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireAndPublish,
  daemonLockPath,
  findRunningDaemon,
  readServeState,
  readServeStateVerbose,
  removeServeState,
  serveStatePath,
  writeServeState,
  type ServeState,
} from "../../src/serve/serve-state.ts";
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
});
