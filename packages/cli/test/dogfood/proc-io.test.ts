// PR-#58 round-2 review — `isAlive` treats a zombie (SIGTERMed child
// that Bun has not reaped yet) as DEAD. Without this the harness's
// teardown wait would spin for the full timeout on a healthy daemon
// that had already exited, then SIGKILL a corpse.
//
// Reproduction: spawn a short-lived child via Bun.spawn, SIGTERM it,
// then poll `isAlive` with a SYNCHRONOUS sleep (which starves Bun's
// event loop and prevents child reaping). Without the fix, the pid
// stays "alive" for the whole sleep; with the fix, /proc/<pid>/status
// reports `State: Z ...` and isAlive returns false within one poll.

import { describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { isAlive } from "../../src/dogfood/proc-io.ts";

// Bun.sleepSync (blocking) is the exact facility teardown uses.
const bunAny = Bun as unknown as { sleepSync?: (ms: number) => void };

describe("isAlive — zombie handling", () => {
  test("returns false shortly after SIGTERM even when Bun hasn't reaped", async () => {
    const proc = spawn({
      cmd: ["bash", "-c", "sleep 5"],
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    const pid = proc.pid;
    if (pid === undefined) throw new Error("no pid");
    // Let the child spin up.
    await new Promise((r) => setTimeout(r, 200));
    expect(isAlive(pid)).toBe(true);
    // SIGTERM and then poll with SYNCHRONOUS sleep — this is the loop
    // shape that used to spin for 4s.
    proc.kill("SIGTERM");
    const start = Date.now();
    let dead = false;
    for (let i = 0; i < 40; i += 1) {
      if (typeof bunAny.sleepSync === "function") bunAny.sleepSync(50);
      if (!isAlive(pid)) {
        dead = true;
        break;
      }
    }
    const elapsed = Date.now() - start;
    // Best-effort cleanup even if the test fails.
    try {
      proc.kill("SIGKILL");
    } catch {
      // best-effort
    }
    expect(dead).toBe(true);
    // A well-behaved child should be reported dead within ~500ms even
    // under the synchronous poll — much less than the 4s SIGTERM
    // timeout that the teardown escalates from.
    expect(elapsed).toBeLessThan(2_000);
  });
});
