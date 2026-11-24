// #251 round 3 BLOCKER 1 — the serving daemon's flock stays held
// through a forced Bun.gc() after a completed build, isolated from
// the rest of `serve-state.test.ts` so it still compiles on the
// round-2 base (3e4ad4c) where `cleanupOrphanedStagingDirs`,
// `promoteStagingDir`, `pidIsAlive`, `newDistStagingName`,
// `listDistStagingDirs`, `DIST_STAGING_PREFIX` and
// `DIST_STAGING_RE` were not exported yet. On 3e4ad4c this file
// still parses — its imports name only symbols that existed then —
// and the assertion flips to a RED failure by `expect(refused)
// .toBeNull()` because the pre-fix `acquireStartingLock` leaks
// `lockFd` through `Bun.spawn`'s stdio and Bun's GC drops the
// serving daemon's own flock fd (#251 round 5 (e)).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDaemonLock } from "../../src/serve/daemon-lock.ts";
import { daemonLockPath } from "../../src/serve/serve-state.ts";

describe("#251 round 3 BLOCKER 1 — flock survives a forced Bun.gc()", () => {
  let repoRoot: string;
  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "revkit-gc-lock-"));
  });
  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test(
    "the lock is still held after a forced Bun.gc() following a completed build",
    async () => {
      // Pre-fix reproduction of the round-3 reviewer's duplicate-
      // daemon race.
      //
      // ROUND 2 (pre-fix, 3e4ad4c): `acquireStartingLock` opened the
      // lock with `{ inheritable: true }` and exposed `lockFd` so
      // `revkit serve` could hand it to the astro child via
      // `Bun.spawn`'s `stdio` array. Bun closes fds passed through
      // `stdio` when the Subprocess is garbage-collected, so once
      // the build completed and the Subprocess dropped, GC closed
      // the serving daemon's OWN lock fd — the kernel then released
      // the flock while the daemon was still serving, and a second
      // `revkit serve` bound on the same repo (reproduced: two
      // daemons sharing threads.sqlite).
      //
      // ROUND 3+ (post-fix): the `inheritable` option is gone and
      // `AcquiredStartingDaemon` no longer exposes `lockFd`. The
      // SIGKILL race is addressed through staging-dir promotion
      // instead. The flock is CLOEXEC-only, held by the serving
      // daemon for the life of that process — no fd ever reaches a
      // Subprocess's `stdio`, so GC of a Subprocess cannot touch
      // it.
      //
      // The dynamic require below is what lets this test compile
      // on 3e4ad4c WITHOUT importing symbols that didn't exist
      // then. On HEAD and on 3e4ad4c, `acquireStartingLock` is
      // exported; its RETURN SHAPE differs (round 2 exposes
      // `lockFd`), and the fork in the test uses that difference
      // to drive the pre-fix inheritance path when it is still
      // visible.
      const { acquireStartingLock } = require("../../src/serve/serve-state.ts");
      const acquired = acquireStartingLock(repoRoot, {
        pid: process.pid,
        version: "0.0.0-test",
        startedAt: new Date().toISOString(),
        instanceId: "gc-test",
      });
      expect(acquired.kind).toBe("ok");
      try {
        // Simulate `revkit serve`'s cold-start astro spawn. Pre-fix
        // (3e4ad4c), `serve/cli.ts` passed `inheritFds: [lockFd]`
        // which the shared `defaultSpawn` turned into a stdio entry
        // on `Bun.spawn`. If a pre-fix-shaped `lockFd` leaks
        // through the API surface, drive the real inheritance path
        // here so the pre-fix bug is proved. Post-fix the field is
        // absent and we just spawn a plain child — the lock stays
        // held because no fd was ever handed to anyone.
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
        // Drop the Subprocess reference and force several GC cycles
        // with 200 ms spacings. The round-4 falsifier saw the
        // pre-fix round-2 bug stay dormant on a single `Bun.gc(true)
        // + 50 ms` sequence and only reproduced with repeated
        // cycles — one GC cycle freed the Subprocess reference,
        // subsequent cycles ran the finalizers that closed the
        // inherited stdio fds. Five 200 ms cycles match the
        // falsifier's observed minimum.
        child = undefined;
        for (let i = 0; i < 5; i++) {
          Bun.gc(true);
          await Bun.sleep(200);
        }
        // Second acquire MUST be refused — the serving daemon
        // (this test fixture) still holds the flock. On 3e4ad4c
        // the pre-fix inheritance path has already released the
        // lock, so this expect flips to RED by assertion.
        const refused = acquireDaemonLock(daemonLockPath(repoRoot));
        expect(refused).toBeNull();
      } finally {
        acquired.release();
      }
    },
    15_000,
  );
});
