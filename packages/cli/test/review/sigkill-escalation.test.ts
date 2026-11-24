// SIGTERM → SIGKILL escalation in the shared default spawner
// (#251 round 4 BLOCKER 3; round 5 (c) adds a bounded explicit
// assertion plus deterministic cleanup).
//
// Astro installs its own SIGTERM handler that runs an orderly-
// shutdown path; a real build observed it holding the daemon lock
// for 131 s after the parent sent SIGTERM. The default `SpawnLike`
// used by `spawnAstroBuild` must escalate: send SIGTERM to the
// child's process group, then SIGKILL after a small grace period
// if the group is still alive. Pre-fix (8cfe1ef) only sent SIGTERM
// — so a child that traps the signal lives past the grace period
// and this test fails BY ASSERTION ("elapsed exceeded …") within
// the bounded wait window, never by the test's own timeout.
//
// Round 5 (c): the fake astro writes its own PID to a scratch
// file, the test races the real spawn against a bounded wait, and
// the `finally` block kills any child still breathing so a test
// failure NEVER leaks a `sleep 60` into the host.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAstroBuild } from "../../src/review/build.ts";

/** The grace window we assert the escalation respects. Hardcoded
 * so pre-fix (no SIGKILL escalation) fails here as a timing
 * assertion, not as a missing-export SyntaxError. The production
 * constant lives in `src/review/build.ts` as `SIGKILL_GRACE_MS`. */
const EXPECTED_GRACE_MS = 5_000;

/** How long we are willing to wait for the spawn to return before
 * declaring the assertion failed. Must be bigger than the grace +
 * reasonable SIGKILL-delivery slack so a post-fix run resolves
 * well inside this window (observed sub-second once SIGKILL
 * reaches the group). Pre-fix the spawn would want to wait a full
 * `sleep 60`; this bounded race turns that into an explicit
 * `expect(resolvedInsideWindow).toBe(true)` failure at ~8 s rather
 * than a bun-test timeout at 20 s. */
const BOUNDED_WAIT_MS = 8_000;

/** `kill -0` — returns true iff a pid is alive (and we may signal
 * it). Used to clean up a leaked bash wrapper after the test. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort: send SIGKILL to the whole process group of `pid`
 * (negative-pid kill) so a leaked `sleep 60` child dies with its
 * trapping bash wrapper. Swallows ESRCH / EPERM silently — the
 * only caller is a `finally` cleanup. */
function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }
}

describe("spawnAstroBuild — #251 round 4 BLOCKER 3: SIGKILL escalation on abort", () => {
  let scratch: string;
  let fakeAstroPidFile: string;
  beforeEach(() => {
    // Scratch dir under the test's tmp root (per-test, isolated).
    // Round 5 (c) requires cleanup even when an assertion fails,
    // so we also wipe in `afterEach`.
    scratch = mkdtempSync(join(tmpdir(), "revkit-sigkill-"));
    fakeAstroPidFile = join(scratch, "fake-astro.pid");
  });
  afterEach(() => {
    // Leaked child cleanup — the test's own finally handles the
    // common case; afterEach is the belt-and-braces path if an
    // unexpected throw escaped it (e.g. an assertion inside the
    // try).
    if (existsSync(fakeAstroPidFile)) {
      try {
        const pid = Number.parseInt(readFileSync(fakeAstroPidFile, "utf8").trim(), 10);
        if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) killGroup(pid);
      } catch {
        /* fine */
      }
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  test(
    "a child that traps SIGTERM is SIGKILLed after the grace period (not left running)",
    async () => {
      // A fake astro binary: a bash script that TRAPS SIGTERM, writes
      // its own PID to a scratch file (so the finally can clean up a
      // leaked child on failure), and then sleeps for a minute. The
      // production `spawnAstroBuild` invokes it with `build --config
      // … --root <root> --outDir <out>` — the script ignores every
      // argument and just sleeps while ignoring SIGTERM. Pre-fix,
      // the default spawner only signals the group and then awaits
      // proc.exited; the trap keeps the child alive past
      // BOUNDED_WAIT_MS and the bounded race below reports an
      // explicit assertion failure.
      const astroBin = join(scratch, "fake-astro");
      writeFileSync(
        astroBin,
        "#!/usr/bin/env bash\n" +
          `echo $$ > ${JSON.stringify(fakeAstroPidFile)}\n` +
          "trap '' TERM\n" +
          "sleep 60\n",
        { mode: 0o755 },
      );
      chmodSync(astroBin, 0o755);
      const astroRoot = join(scratch, "root");
      mkdirSync(astroRoot, { recursive: true });
      // Give astro.config.mjs so the existence check in
      // spawnAstroBuild passes — the fake binary ignores it.
      writeFileSync(join(astroRoot, "astro.config.mjs"), "export default {};\n");
      const outDir = join(scratch, "out");

      const ac = new AbortController();
      const started = Date.now();
      // Fire abort shortly after launch so the child is in its
      // sleep when the signal arrives.
      setTimeout(() => ac.abort(), 300);

      type Outcome = { kind: "resolved"; threw?: Error } | { kind: "timeout" };
      let bailoutTimer: ReturnType<typeof setTimeout> | undefined;
      const bounded: Promise<Outcome> = new Promise((resolve) => {
        bailoutTimer = setTimeout(() => resolve({ kind: "timeout" }), BOUNDED_WAIT_MS);
      });
      const spawnPromise: Promise<Outcome> = spawnAstroBuild({
        astroBin,
        astroRoot,
        outDir,
        signal: ac.signal,
      }).then(
        () => ({ kind: "resolved" }) as Outcome,
        (error: unknown) => ({ kind: "resolved", threw: error as Error }) as Outcome,
      );
      let outcome: Outcome;
      try {
        outcome = await Promise.race([spawnPromise, bounded]);
      } finally {
        if (bailoutTimer !== undefined) clearTimeout(bailoutTimer);
        // Deterministic cleanup: if the fake astro wrote a PID,
        // SIGKILL the whole group. Post-fix the SIGKILL escalation
        // already killed it; this is a no-op then. Pre-fix the
        // group is still alive and this is the line that keeps
        // the host clean.
        if (existsSync(fakeAstroPidFile)) {
          try {
            const pid = Number.parseInt(
              readFileSync(fakeAstroPidFile, "utf8").trim(),
              10,
            );
            if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) killGroup(pid);
          } catch {
            /* fine */
          }
        }
      }
      const elapsed = Date.now() - started;
      // Explicit assertion, not a test timeout: the bounded race
      // MUST resolve inside BOUNDED_WAIT_MS. Pre-fix this flips to
      // `kind: "timeout"` and the assertion below prints a clear
      // message naming what went wrong.
      expect(outcome.kind).toBe("resolved");
      // And the elapsed MUST be inside grace + slack. A fix that
      // waited longer than the grace would pass the resolved check
      // but fail this one.
      expect(elapsed).toBeLessThan(EXPECTED_GRACE_MS + 3_000);
      // A thrown "aborted" is the typical post-fix outcome. When
      // the spawn resolved (exit code non-zero without throwing)
      // the round-4 assertion remains silent on the message.
      if (outcome.kind === "resolved" && outcome.threw !== undefined) {
        expect(outcome.threw.message).toContain("aborted");
      }
    },
    BOUNDED_WAIT_MS + 5_000,
  );
});
