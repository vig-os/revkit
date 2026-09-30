// `.revkit/serve.json` — mode 600, atomic write, stale detection, and
// removal on shutdown. Every test builds a temporary "repo root" so
// the state file lands in isolation.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isPidAlive,
  readServeState,
  removeServeState,
  serveStatePath,
  writeServeState,
  type ServeState,
} from "../../src/serve/serve-state.ts";

const sample = (pid: number, port = 40000): ServeState => ({
  pid,
  port,
  url: `http://127.0.0.1:${port}`,
  agentToken: "AGENT-TOK",
  startedAt: "2026-09-30T12:00:00Z",
  version: "0.0.0",
});

describe("serve-state", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "revkit-serve-state-"));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("writes .revkit/serve.json at mode 600", () => {
    const outcome = writeServeState(repoRoot, sample(process.pid));
    expect(outcome.ok).toBe(true);
    const path = serveStatePath(repoRoot);
    expect(existsSync(path)).toBe(true);
    // 0o777 mask picks the permission bits; 0o600 is r/w owner only.
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("reads the state back", () => {
    writeServeState(repoRoot, sample(process.pid));
    const read = readServeState(repoRoot);
    expect(read).toBeDefined();
    expect(read?.pid).toBe(process.pid);
    expect(read?.agentToken).toBe("AGENT-TOK");
  });

  test("returns undefined when the file does not exist", () => {
    expect(readServeState(repoRoot)).toBeUndefined();
  });

  test("refuses to overwrite a file owned by a live pid", () => {
    // The current process is always alive.
    writeServeState(repoRoot, sample(process.pid));
    const outcome = writeServeState(repoRoot, sample(process.pid + 1_000_000));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refused.kind).toBe("already-running");
      expect(outcome.refused.state.pid).toBe(process.pid);
    }
  });

  test("replaces a file whose pid is dead", () => {
    // pid 0 is never a valid process id — `isPidAlive` returns false
    // for anything non-positive, which is what a stale file check
    // needs. Pick a large pid we can be reasonably sure is not alive.
    const deadPid = 2_147_483_646;
    writeServeState(repoRoot, sample(deadPid));
    const outcome = writeServeState(repoRoot, sample(process.pid));
    expect(outcome.ok).toBe(true);
    const read = readServeState(repoRoot);
    expect(read?.pid).toBe(process.pid);
  });

  test("removeServeState is idempotent", () => {
    writeServeState(repoRoot, sample(process.pid));
    removeServeState(repoRoot);
    expect(existsSync(serveStatePath(repoRoot))).toBe(false);
    // Second call: no throw.
    removeServeState(repoRoot);
  });
});

describe("isPidAlive", () => {
  test("true for the current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });
  test("false for a non-positive pid", () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
  });
});
