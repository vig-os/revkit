// Round-3 blocker-1 scenario tests. Each spawns real subprocesses so
// the kernel-held `flock(2)` is exercised end to end (in-process
// flock on Linux shares the fd across the same process and would
// let the test fool itself).
//
// The critical property: the daemon lock is fcntl-family, held by
// the kernel, so a SIGSTOP'ped daemon still holds it and the second
// start refuses. Every scenario runs a probe under its mutation
// (comment above each `test(...)`).

import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireAndPublish, findRunningDaemon, readServeState } from "../../src/serve/serve-state.ts";

const cliBin = resolve(import.meta.dirname, "..", "..", "bin", "revkit.js");

function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "revkit-lock-e2e-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "revkit", private: true, type: "module" }));
  return root;
}

/** Spawn a `revkit serve --port 0 --dir <root>` subprocess. Returns
 * when stdout advertises "listening on http://…" — or throws on
 * exit / timeout. The `env` override supports the HTTP_PROXY test. */
async function spawnDaemon(root: string, env: NodeJS.ProcessEnv = {}): Promise<{ proc: ChildProcess; port: number; stdout: string; stderr: string }> {
  const proc = spawn("bun", [cliBin, "serve", "--port", "0", "--dir", root], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  const buffers = { stdout: "", stderr: "" };
  proc.stdout?.on("data", (c: Buffer) => (buffers.stdout += c.toString("utf8")));
  proc.stderr?.on("data", (c: Buffer) => (buffers.stderr += c.toString("utf8")));
  const listen = await new Promise<{ port: number } | { error: string }>((resolveOuter) => {
    const timer = setTimeout(() => resolveOuter({ error: "spawn timeout" }), 8_000);
    const check = (): void => {
      const m = buffers.stdout.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m !== null) {
        clearTimeout(timer);
        resolveOuter({ port: Number.parseInt(m[1] ?? "0", 10) });
      }
    };
    proc.stdout?.on("data", check);
    proc.on("exit", () => {
      clearTimeout(timer);
      resolveOuter({ error: `exited: stdout=${buffers.stdout} stderr=${buffers.stderr}` });
    });
  });
  if ("error" in listen) throw new Error(listen.error);
  return { proc, port: listen.port, stdout: buffers.stdout, stderr: buffers.stderr };
}

async function waitExit(proc: ChildProcess, ms = 3000): Promise<number | null> {
  return new Promise((resolveOuter) => {
    if (proc.exitCode !== null) {
      resolveOuter(proc.exitCode);
      return;
    }
    const timer = setTimeout(() => resolveOuter(null), ms);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      resolveOuter(code);
    });
  });
}

describe("round-3 blocker-1 scenarios", () => {
  let root: string;
  beforeEach(() => {
    root = tmpRepo();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Mutation partner: drop the flock() → both spawns succeed. With
  // the flock in place, the second exits with the "already-running"
  // error message from acquireAndPublish.
  test("a second `revkit serve` while the first runs is refused", async () => {
    const first = await spawnDaemon(root);
    try {
      const second = spawn("bun", [cliBin, "serve", "--port", "0", "--dir", root], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      let stderr = "";
      second.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
      const code = await waitExit(second, 5000);
      expect(code, "second daemon should have exited").not.toBeNull();
      expect(code, `second exit code (stderr='${stderr}')`).not.toBe(0);
      expect(stderr).toContain("daemon.lock");
    } finally {
      first.proc.kill("SIGTERM");
      await waitExit(first.proc);
    }
  });

  // Mutation partner: replace `flock(2)` with a pid-alive probe →
  // SIGSTOPped daemon is misclassified as dead and the second
  // spawn wins the lock. `flock(2)` is held by the kernel even
  // through SIGSTOP, so this scenario proves the lock property.
  test("a second `revkit serve` while the first is SIGSTOPped is refused", async () => {
    const first = await spawnDaemon(root);
    try {
      first.proc.kill("SIGSTOP");
      // Give the OS a moment to stop the process.
      await new Promise((r) => setTimeout(r, 200));
      const second = spawn("bun", [cliBin, "serve", "--port", "0", "--dir", root], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      let stderr = "";
      second.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
      const code = await waitExit(second, 5000);
      expect(code, "second should have exited while first is SIGSTOPped").not.toBeNull();
      expect(code).not.toBe(0);
      expect(stderr).toContain("daemon.lock");
    } finally {
      // Resume then kill so afterEach cleanup does not race.
      first.proc.kill("SIGCONT");
      first.proc.kill("SIGKILL");
      await waitExit(first.proc);
    }
  });

  // Mutation partner: replace `flock(2)` with pid-check + serve.json
  // → the kernel drops the lock on SIGKILL but stale serve.json /
  // pid may confuse the next start. With `flock(2)`, the second
  // spawn simply acquires the (now-free) lock.
  test("a start after the first is SIGKILLed succeeds", async () => {
    const first = await spawnDaemon(root);
    first.proc.kill("SIGKILL");
    await waitExit(first.proc);
    // SIGKILL bypasses shutdown so serve.json is left behind. The
    // second start must acquire the lock (kernel released it) and
    // overwrite serve.json.
    const second = await spawnDaemon(root);
    try {
      expect(second.port).toBeGreaterThan(0);
    } finally {
      second.proc.kill("SIGTERM");
      await waitExit(second.proc);
    }
  });

  // Mutation partner: `probeDaemon` sends the fetch through
  // HTTP_PROXY → 127.0.0.1 does not answer as the daemon (goes
  // through the proxy at 127.0.0.1:9 which refuses) → old code
  // treats as stale and lets the second in. With `flock(2)` there
  // is no probe: HTTP_PROXY is irrelevant.
  test("HTTP_PROXY set on the second start does not defeat the lock", async () => {
    const first = await spawnDaemon(root);
    try {
      const second = spawn("bun", [cliBin, "serve", "--port", "0", "--dir", root], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          HTTP_PROXY: "http://127.0.0.1:9",
          HTTPS_PROXY: "http://127.0.0.1:9",
          NO_PROXY: "",
        },
      });
      let stderr = "";
      second.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
      const code = await waitExit(second, 5000);
      expect(code).not.toBe(0);
      expect(stderr).toContain("daemon.lock");
    } finally {
      first.proc.kill("SIGTERM");
      await waitExit(first.proc);
    }
  });

  // Mutation partner: `removeServeState()` unlinks unconditionally
  // → daemon A's shutdown deletes daemon B's serve.json when B has
  // taken over. With ownership-checked `release()`, A only unlinks
  // if the on-disk instanceId still matches its own.
  test("shutdown of daemon A does not remove daemon B's serve.json", async () => {
    // Impossible to actually get A and B running at the same time
    // once the lock is in place, so this test exercises the
    // ownership check on `acquireAndPublish` release() directly.
    // (The scenario the reviewer described only occurs if the
    // lock is bypassed; the ownership check is the belt to the
    // lock's braces.)
    const publishA = acquireAndPublish(root, sample("A"));
    if (publishA.kind !== "ok") throw new Error("A should have acquired");
    // Overwrite serve.json with a foreign instanceId.
    writeFileSync(
      join(root, ".revkit", "serve.json"),
      JSON.stringify(sample("B", 40001), null, 2) + "\n",
    );
    publishA.release();
    const survivor = readServeState(root);
    expect(survivor?.instanceId, "B's serve.json must survive A's shutdown").toBe("B");
  });
});

describe("round-3 blocker-1 unit tests (survivors from the mutation list)", () => {
  let root: string;
  beforeEach(() => {
    root = tmpRepo();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Mutation partner: `unparsable-is-stale` case. Before: an empty
  // serve.json blocked restart with a bare JSON parse error. After:
  // the file is treated as absent by `findRunningDaemon` when the
  // lock is free (a stale advertisement).
  test("unparsable serve.json with no held lock → findRunningDaemon returns undefined", () => {
    require("node:fs").mkdirSync(join(root, ".revkit"), { recursive: true });
    writeFileSync(join(root, ".revkit", "serve.json"), "{ broken");
    // Touch the lock file too so `findRunningDaemon` reaches the
    // acquire step.
    writeFileSync(join(root, ".revkit", "daemon.lock"), "");
    expect(findRunningDaemon(root)).toBeUndefined();
  });
});

function sample(instanceId: string, port = 40000): import("../../src/serve/serve-state.ts").ServeState {
  return {
    pid: process.pid,
    port,
    url: `http://127.0.0.1:${port}`,
    agentToken: "AGENT-TOK",
    startedAt: "2026-09-30T12:00:00Z",
    version: "0.0.0-test",
    instanceId,
  };
}
