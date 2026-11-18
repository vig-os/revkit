// SIGTERM → SIGKILL escalation in the shared default spawner
// (#251 round 4 BLOCKER 3).
//
// Astro installs its own SIGTERM handler that runs an orderly-
// shutdown path; a real build observed it holding the daemon lock
// for 131 s after the parent sent SIGTERM. The default `SpawnLike`
// used by `spawnAstroBuild` must escalate: send SIGTERM to the
// child's process group, then SIGKILL after a small grace period
// if the group is still alive. Pre-fix (8cfe1ef) only sent SIGTERM
// — so a child that traps the signal lived past the grace period
// and these assertions fail behaviourally (the spawn resolves at
// `sleep 60`'s natural exit, ~60 s, which the test's own timeout
// exceeds).

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
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

describe("spawnAstroBuild — #251 round 4 BLOCKER 3: SIGKILL escalation on abort", () => {
  test(
    "a child that traps SIGTERM is SIGKILLed after the grace period (not left running)",
    async () => {
      // A fake astro binary: a bash script that TRAPS SIGTERM
      // and then sleeps for a minute. The production
      // `spawnAstroBuild` invokes it with `build --config …
      // --root <root> --outDir <out>` — the script ignores
      // every argument and just sleeps while ignoring SIGTERM.
      // Pre-fix, the default spawner only signals the group and
      // then awaits proc.exited; the trap keeps the child alive
      // and the spawn promise never resolves until the sleep
      // ends naturally. Post-fix the spawner escalates to
      // SIGKILL after the grace window.
      const scratch = mkdtempSync(join(tmpdir(), "revkit-sigkill-"));
      const astroBin = join(scratch, "fake-astro");
      writeFileSync(
        astroBin,
        "#!/usr/bin/env bash\n" +
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
      let threw: Error | undefined;
      try {
        await spawnAstroBuild({
          astroBin,
          astroRoot,
          outDir,
          signal: ac.signal,
        });
      } catch (error) {
        threw = error as Error;
      }
      const elapsed = Date.now() - started;
      // The spawn either resolved (exit code non-zero) or threw
      // (`astro build aborted by signal`). Either way, it MUST
      // return inside grace + reasonable slack. Pre-fix: the
      // bash child stays alive and the spawn awaits `proc.exited`
      // for the full 60 s of `sleep 60` — this assertion then
      // fails because `elapsed` is ~60 000, well over the bound.
      expect(elapsed).toBeLessThan(EXPECTED_GRACE_MS + 3_000);
      // A thrown "aborted" is the typical post-fix outcome.
      if (threw !== undefined) {
        expect(threw.message).toContain("aborted");
      }
      rmSync(scratch, { recursive: true, force: true });
    },
    20_000,
  );
});
