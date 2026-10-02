// `.revkit/repo-id` must be minted exactly once, under the daemon
// lock, and published by a rename (issue #63, follow-up #62).
//
// Two properties, both load-bearing for the rail's per-repo "seen"
// bucket:
//
//   1. **Single-mint under the lock.** `revkit serve` used to call
//      `readOrMintRepoId` BEFORE `acquireAndPublish`, so two starts
//      that overlapped inside the check-then-write window each minted
//      a different id and each wrote it. The lock then picked one
//      winner, but the file was left holding the loser's id — so the
//      winner's `/-/health` advertised an id that no longer existed
//      on disk, and the NEXT restart read a different one and reset
//      the reviewer's ack state. The mint now happens after the lock
//      is won, so a start that does not hold the lock never writes.
//
//   2. **Atomic publication.** The old write was an in-place
//      `writeFileSync` (O_TRUNC + write), which a concurrent reader
//      can observe as a truncated/empty file. The write now goes
//      through a 0600 temp file plus `rename(2)`, so a reader sees
//      either the old file or the new one, never a partial payload.

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";
import { repoIdPath } from "../../src/serve/serve-state.ts";
import { acquireDaemonLock } from "../../src/serve/daemon-lock.ts";
import { registerDaemonPid } from "../helpers/daemon-registry.ts";

/** The shape `.revkit/repo-id` must always have on disk: one
 * base64url token plus a single trailing newline. Anything else is a
 * payload a concurrent reader could have caught mid-write. */
const REPO_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}\n$/;

function readRepoIdFile(root: string): string | null {
  const path = repoIdPath(root);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

/** Leftover temp files from an atomic write. A clean run leaves
 * none; a crash mid-write may leave one, which is why they are named
 * apart from `repo-id` and ignored by readers. */
function leftoverRepoIdTemps(root: string): string[] {
  const dir = join(root, ".revkit");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.startsWith("repo-id") && n !== "repo-id");
}

interface Fixture {
  readonly root: string;
  readonly dist: string;
  start(): Promise<DaemonHandle>;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "revkit-repo-id-atomic-"));
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><h1>ok</h1>");
  return {
    root,
    dist,
    start: () =>
      startDaemon({
        dir: dist,
        repoRoot: root,
        port: 0,
        sqlitePath: ":memory:",
        version: "0.0.0-test",
        localUserId: "local-test",
        installSignalHandlers: false,
        // No background builds: this fixture only exercises the
        // startup identity path.
        enableBackgroundBuild: false,
        logSink: { write: () => {} },
      }),
  };
}

async function healthRepoId(handle: DaemonHandle): Promise<string> {
  const response = await fetch(`${handle.url}/-/health`, {
    headers: { host: `127.0.0.1:${handle.port}` },
  });
  if (response.status !== 200) throw new Error(`/-/health returned ${response.status}`);
  const body = (await response.json()) as { repoId?: string };
  if (typeof body.repoId !== "string") throw new Error("/-/health carried no repoId");
  return body.repoId;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe("repo-id is minted once, under the daemon lock (issue #63)", () => {
  test("the id a running daemon advertises is the id on disk", async () => {
    const fx = makeFixture();
    cleanups.push(() => rmSync(fx.root, { recursive: true, force: true }));
    const handle = await fx.start();
    cleanups.push(() => handle.stop());
    const advertised = await healthRepoId(handle);
    expect(readRepoIdFile(fx.root)).toBe(`${advertised}\n`);
  });

  test("a start that does not win the daemon lock does not mint or touch the repo-id", async () => {
    // The pre-fix code minted BEFORE trying the lock, so a losing
    // start still created or overwrote the file — the loser won the
    // race for the id while the winner won the race for the lock.
    // Modelling the "file absent while a daemon runs" state (a fresh
    // checkout the user cleaned, or an interrupted first start) is
    // the deterministic shape of that race: on the old code the loser
    // creates the file here, on the new code it cannot touch it.
    const fx = makeFixture();
    cleanups.push(() => rmSync(fx.root, { recursive: true, force: true }));
    const running = await fx.start();
    cleanups.push(() => running.stop());
    const advertised = await healthRepoId(running);
    rmSync(repoIdPath(fx.root));

    const loser = await fx.start().then(
      (h) => {
        cleanups.push(() => h.stop());
        return h;
      },
      (error: Error) => error,
    );
    expect(loser).toBeInstanceOf(Error);
    expect((loser as Error).message).toContain("daemon.lock");

    // Nothing about the id changed: no mint, no overwrite.
    expect(readRepoIdFile(fx.root)).toBeNull();
    expect(leftoverRepoIdTemps(fx.root)).toEqual([]);
    // And the running daemon still advertises its own id, so a
    // restart still resolves to the same rail bucket.
    expect(await healthRepoId(running)).toBe(advertised);
  });

  test("a lock held by another process blocks the mint even before a daemon starts", async () => {
    // The unit-level statement of the same invariant, with no HTTP
    // server in the way: while the OS lock is held elsewhere, a
    // start cannot reach the id file.
    const fx = makeFixture();
    cleanups.push(() => rmSync(fx.root, { recursive: true, force: true }));
    mkdirSync(join(fx.root, ".revkit"), { recursive: true });
    const lock = acquireDaemonLock(join(fx.root, ".revkit", "daemon.lock"));
    expect(lock).not.toBeNull();
    cleanups.push(() => lock?.release());

    const loser = await fx.start().then(
      (h) => {
        cleanups.push(() => h.stop());
        return h;
      },
      (error: Error) => error,
    );
    expect(loser).toBeInstanceOf(Error);
    expect(existsSync(repoIdPath(fx.root))).toBe(false);
  });
});

describe("repo-id is published by rename (issue #63)", () => {
  test("re-minting replaces the file rather than truncating it in place", async () => {
    // The observable difference between `writeFileSync(path)` and
    // `writeFileSync(tmp) + rename(tmp, path)`: the inode AT THE
    // PATH changes. An in-place rewrite keeps the inode, and any
    // reader that opened the file just before the write keeps
    // reading the truncated bytes.
    const fx = makeFixture();
    cleanups.push(() => rmSync(fx.root, { recursive: true, force: true }));
    const path = repoIdPath(fx.root);
    mkdirSync(join(fx.root, ".revkit"), { recursive: true });
    // A corrupt payload — the shape a torn write leaves behind, and
    // the shape `readOrMintRepoId` already refuses to trust.
    writeFileSync(path, "corrupt", { mode: 0o600 });
    const before = statSync(path);

    const handle = await fx.start();
    cleanups.push(() => handle.stop());

    const after = statSync(path);
    expect(after.ino).not.toBe(before.ino);
    expect(readRepoIdFile(fx.root)).toMatch(REPO_ID_PATTERN);
    expect(after.mode & 0o777).toBe(0o600);
    expect(leftoverRepoIdTemps(fx.root)).toEqual([]);
  });

  test("the file is never observable as a partial payload", async () => {
    const fx = makeFixture();
    cleanups.push(() => rmSync(fx.root, { recursive: true, force: true }));
    // Start / stop repeatedly, sampling the file after every start.
    // Every observation must be a complete payload: absent, or a
    // full base64url token. A truncated write could only be caught
    // by sampling, and the rename is what makes "not catchable"
    // true rather than lucky.
    for (let round = 0; round < 5; round += 1) {
      const handle = await fx.start();
      const observed = readRepoIdFile(fx.root);
      expect(observed).toMatch(REPO_ID_PATTERN);
      expect(observed?.trim()).toBe(await healthRepoId(handle));
      await handle.stop();
    }
    // Same id across every restart — the property the rail's bucket
    // keying depends on.
    const first = readRepoIdFile(fx.root);
    const handle = await fx.start();
    cleanups.push(() => handle.stop());
    expect(readRepoIdFile(fx.root)).toBe(first);
  });
});

describe("concurrent starts agree on one repo id (issue #63)", () => {
  /** The child that races the daemon lock. Kept as a fixture script
   * (not a generated one) so it is typechecked like any other source
   * and cannot drift from the daemon's real startup options. */
  const CHILD = join(import.meta.dir, "fixtures", "repo-id-race-child.ts");

  test("four simultaneous starts produce exactly one id, written once", async () => {
    const fx = makeFixture();
    cleanups.push(() => rmSync(fx.root, { recursive: true, force: true }));
    const barrier = join(fx.root, "go");
    const racers = 4;

    const children: ReturnType<typeof Bun.spawn>[] = [];
    for (let i = 0; i < racers; i += 1) {
      const child = Bun.spawn(
        [process.execPath, CHILD, fx.root, fx.dist, barrier, join(fx.root, `ready-${i}`)],
        { stdout: "pipe", stderr: "pipe" },
      );
      registerDaemonPid(child.pid);
      children.push(child);
    }
    cleanups.push(() => {
      for (const child of children) {
        try {
          child.kill();
        } catch {
          // Already exited.
        }
      }
    });

    // Release every child at once. Waiting for the ready flags first
    // is what makes the overlap real rather than "spawned in a loop".
    const deadline = Date.now() + 20_000;
    while (children.some((_, i) => !existsSync(join(fx.root, `ready-${i}`)))) {
      if (Date.now() > deadline) throw new Error("repo-id race: a child never reached the barrier");
      await Bun.sleep(5);
    }
    writeFileSync(barrier, "go");

    // Sample the id file for the whole race. On the pre-fix code each
    // child minted its own on the way to the lock, so this records
    // several distinct payloads; with the mint under the lock it
    // records one. Every sample must also be a COMPLETE payload —
    // that is the rename assertion observed from outside.
    const observed = new Set<string>();
    let sampling = true;
    const sampler = (async (): Promise<void> => {
      while (sampling) {
        const seen = readRepoIdFile(fx.root);
        if (seen !== null) observed.add(seen);
        await Bun.sleep(1);
      }
    })();

    const outcomes: Array<{ kind: string; repoId?: string; message?: string }> = [];
    for (const child of children) {
      const stdout = await new Response(child.stdout).text();
      await child.exited;
      const line = stdout.split("\n").find((l) => l.startsWith("{"));
      if (line === undefined) throw new Error(`repo-id race: a child printed no result: ${stdout}`);
      outcomes.push(JSON.parse(line) as { kind: string; repoId?: string; message?: string });
    }
    sampling = false;
    await sampler;

    const winners = outcomes.filter((o) => o.kind === "ok");
    expect(winners).toHaveLength(1);
    const losers = outcomes.filter((o) => o.kind !== "ok");
    expect(losers).toHaveLength(racers - 1);
    for (const loser of losers) expect(loser.message).toContain("daemon.lock");

    const winner = winners[0]!;
    // The id the winner serves is the id on disk — one value, one
    // writer. A start that lost the race cannot leave its own id
    // behind for the next restart to pick up.
    expect(readRepoIdFile(fx.root)).toBe(`${winner.repoId}\n`);
    // One distinct payload was ever visible on disk, and it was
    // always complete.
    expect([...observed]).toEqual([`${winner.repoId}\n`]);
    for (const seen of observed) expect(seen).toMatch(REPO_ID_PATTERN);
    expect(leftoverRepoIdTemps(fx.root)).toEqual([]);
  }, 60_000);
});
