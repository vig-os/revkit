// Round-2 review "ten mutations survived with no test" — one killing
// test per mutation. Each test is written to go red under exactly
// the mutation named in the review; the mutation and its expected
// failure are called out in the test's leading comment. Verified by
// hand: the mutation-partner script in the PR body runs each
// `sed`/patch, re-runs the paired test, and confirms it turns red.
//
// The tests use real filesystem calls, a real in-process daemon, or
// a real sqlite file — no mocking of the units under test.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Anchor } from "@revkit/review-core";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";
import type { LineSink } from "../../src/serve/logger.ts";
import { MAX_COMMENT_BODY_BYTES } from "../../src/serve/daemon.ts";

const anchor: Anchor = {
  path: "docs/x.md",
  startLine: 1,
  endLine: 2,
  quote: { exact: "hi", prefix: "", suffix: "" },
  revision: "a".repeat(64),
};

function loopbackHeaders(port: number, extra: Record<string, string> = {}): Record<string, string> {
  return {
    host: `127.0.0.1:${port}`,
    origin: `http://127.0.0.1:${port}`,
    ...extra,
  };
}

describe("mutation-killing tests (round-2 review)", () => {
  let root: string;
  let dist: string;
  let sqlitePath: string;
  let logs: string[];
  let handle: DaemonHandle | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "revkit-mut-"));
    dist = join(root, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<h1>ok</h1>");
    writeFileSync(join(dist, "unknown.xyz"), "should not be served");
    // Seed the anchor source (`docs/x.md`) so the daemon can compute
    // its revision server-side (PR #38 review).
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "x.md"), "# X\n\nhello\n");
    sqlitePath = join(root, ".revkit", "threads.sqlite");
    logs = [];
    handle = undefined;
  });

  afterEach(async () => {
    if (handle !== undefined) await handle.stop();
    rmSync(root, { recursive: true, force: true });
  });

  const start = async (): Promise<DaemonHandle> => {
    const sink: LineSink = { write: (line) => logs.push(line) };
    handle = await startDaemon({
      dir: dist,
      repoRoot: root,
      port: 0,
      sqlitePath,
      version: "0.0.0-test",
      localUserId: "local-mut",
      installSignalHandlers: false,
      logSink: sink,
    });
    return handle;
  };

  // #1 — 64 KiB per-comment cap. Mutation: raise the cap to
  // MAX_BODY_BYTES → this test flips 413 → 201.
  test("#1 rejects a comment body over the 64 KiB cap with 413", async () => {
    const h = await start();
    const oversized = "x".repeat(MAX_COMMENT_BODY_BYTES + 1);
    const response = await fetch(h.url + "/api/threads", {
      method: "POST",
      headers: loopbackHeaders(h.port, {
        authorization: `Bearer ${h.agentToken}`,
        "content-type": "application/json",
      }),
      body: JSON.stringify({ anchor, body: oversized }),
    });
    expect(response.status).toBe(413);
    // Ensure a body just at the cap is accepted (bracket the guard).
    const okResponse = await fetch(h.url + "/api/threads", {
      method: "POST",
      headers: loopbackHeaders(h.port, {
        authorization: `Bearer ${h.agentToken}`,
        "content-type": "application/json",
      }),
      body: JSON.stringify({ anchor, body: "x".repeat(MAX_COMMENT_BODY_BYTES) }),
    });
    expect(okResponse.status).toBe(201);
  });

  // #2 — 1 MiB whole-request cap. Mutation: remove the arrayBuffer
  // byteLength check → this test flips 413 → 400 (Zod fail) or 500
  // depending on how far it gets. Either way, not 413.
  test("#2 rejects a request over the 1 MiB whole-body cap with 413", async () => {
    const h = await start();
    // Build a body larger than 1 MiB. Padding a JSON field with a
    // string is enough — the anchor / body are legitimate; the
    // payload is inflated with a bogus large field that the schema
    // will strip (`.strict()`) if we get that far, but the size
    // cap runs first.
    const filler = "x".repeat(1_100_000);
    const body = JSON.stringify({ anchor, body: "hi", threadId: "t", commentId: "c", filler });
    expect(body.length).toBeGreaterThan(1_048_576);
    const response = await fetch(h.url + "/api/threads", {
      method: "POST",
      headers: loopbackHeaders(h.port, {
        authorization: `Bearer ${h.agentToken}`,
        "content-type": "application/json",
        "content-length": String(body.length),
      }),
      body,
    });
    expect(response.status).toBe(413);
  });

  // #3 — strict `since` parsing. Mutation: drop the `^[0-9]+$` regex
  // → `1e3`, `0x2`, `2.5` accepted → this test flips 400 → 200.
  test("#3 rejects non-decimal `since` values with 400", async () => {
    const h = await start();
    for (const bad of ["1e3", "0x2", "-1", "2.5", "abc", " 1 ", "1 2"]) {
      const url = h.url + "/events?" + new URLSearchParams({ since: bad }).toString();
      const r = await fetch(url, {
        headers: {
          host: `127.0.0.1:${h.port}`,
          authorization: `Bearer ${h.agentToken}`,
        },
      });
      expect(r.status, `since='${bad}' should be 400`).toBe(400);
      await r.body?.cancel();
    }
    // And a valid decimal succeeds — bracket the guard.
    const good = await fetch(h.url + "/events?since=0", {
      headers: {
        host: `127.0.0.1:${h.port}`,
        authorization: `Bearer ${h.agentToken}`,
      },
    });
    expect(good.status).toBe(200);
    await good.body?.cancel();
  });

  // #4 — MIME allowlist. Mutation: `contentTypeForExtension` falls
  // back to a generic `application/octet-stream` instead of null →
  // an unknown extension gets a 200 rather than a 404.
  test("#4 refuses a static file whose extension is not on the MIME allowlist", async () => {
    const h = await start();
    const r = await fetch(h.url + "/unknown.xyz");
    // 404 rather than "served as octet-stream". Body must not carry
    // the file content.
    expect(r.status).toBe(404);
    const body = await r.text();
    expect(body).not.toContain("should not be served");
  });

  // #5 — sqlite file mode is 0600. Mutation: skip the chmod → default
  // umask leaves 0644.
  test("#5 threads.sqlite is chmodded to 0600", async () => {
    await start();
    // Trigger a write so the WAL/SHM sidecars also appear.
    await fetch(handle!.url + "/api/threads", {
      method: "POST",
      headers: loopbackHeaders(handle!.port, {
        authorization: `Bearer ${handle!.agentToken}`,
        "content-type": "application/json",
      }),
      body: JSON.stringify({ anchor, body: "seed" }),
    });
    const mode = statSync(sqlitePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  // #6 — .revkit/ directory mode is 0700. Mutation: mkdir without the
  // 0700 mode / no chmod → default umask leaves 0755.
  test("#6 .revkit/ directory is 0700", async () => {
    await start();
    const mode = statSync(join(root, ".revkit")).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  // #7 — Zod validation on `?status=`. Mutation: `as ThreadStatus[]`
  // cast without the safeParse → an unknown value is silently
  // "allowed" and returns an empty list, 200. With the guard it 400s.
  test("#7 rejects a bogus ?status value with 400", async () => {
    const h = await start();
    const r = await fetch(h.url + "/api/threads?status=bogus", {
      headers: loopbackHeaders(h.port, { authorization: `Bearer ${h.agentToken}` }),
    });
    expect(r.status).toBe(400);
    // And a good value works.
    const good = await fetch(h.url + "/api/threads?status=open", {
      headers: loopbackHeaders(h.port, { authorization: `Bearer ${h.agentToken}` }),
    });
    expect(good.status).toBe(200);
  });

  // #8 — decodeURIComponent URIError → 400 rather than 500. Mutation:
  // drop the try/catch around `decodeURIComponent(match[1])` → the
  // URIError propagates as 500.
  test("#8 malformed percent-encoding on /api/threads/:id returns 400", async () => {
    const h = await start();
    // `%zz` is not a valid escape.
    const r = await fetch(h.url + "/api/threads/%zz/replies", {
      method: "POST",
      headers: loopbackHeaders(h.port, {
        authorization: `Bearer ${h.agentToken}`,
        "content-type": "application/json",
      }),
      body: JSON.stringify({ parentId: "x", body: "y" }),
    });
    expect(r.status).toBe(400);
  });

  // #9 — sqlite external-writer catch-up. Mutation: drop the BEGIN
  // IMMEDIATE catch-up block in `append` → an external writer that
  // wrote seq=1 causes the daemon's next append to fail on PK
  // (SQLITE_CONSTRAINT), which surfaces as 500. With the catch-up
  // in place, the daemon's append succeeds at seq=2.
  test("#9 daemon catches up on an external writer's row and appends at seq+1", async () => {
    const h = await start();
    // Emulate a foreign writer inserting a valid event directly.
    const foreign = Database.open(sqlitePath);
    try {
      const ts = new Date().toISOString();
      const event = {
        seq: 1,
        ts,
        actor: { kind: "local", id: "foreign" },
        kind: "comment.created",
        threadId: "t-foreign",
        commentId: "c-foreign",
        anchor,
        body: "from another writer",
      };
      foreign.prepare("INSERT INTO events (seq, ts, payload) VALUES (?, ?, ?)").run(1, ts, JSON.stringify(event));
    } finally {
      foreign.close();
    }
    // Now the daemon POSTs — it should succeed at seq=2 (not fail
    // on PK conflict).
    const r = await fetch(h.url + "/api/threads", {
      method: "POST",
      headers: loopbackHeaders(h.port, {
        authorization: `Bearer ${h.agentToken}`,
        "content-type": "application/json",
      }),
      body: JSON.stringify({ anchor, body: "daemon append" }),
    });
    expect(r.status).toBe(201);
    const payload = (await r.json()) as { seq: number };
    expect(payload.seq).toBe(2);
  });

  // #10 — WAL / SHM sidecar modes are 0600 on daemon start. Mutation:
  // skip the sidecar chmod loop entirely (or drop `-wal` / `-shm`
  // from the list) → an existing sidecar keeps its umask-default
  // mode (0644 under a normal umask). We pre-create sidecar files
  // with a bad mode BEFORE starting the daemon, then start; the
  // daemon's chmod loop must bring them to 0600.
  test("#10 threads.sqlite-wal and -shm are chmodded to 0600 by the start-up loop", async () => {
    // Pre-create the sidecar files at 0644 so the chmod loop has
    // something to fix. mkdirSync `.revkit/` first (the daemon
    // would do that anyway, but we need the dir to write into).
    mkdirSync(join(root, ".revkit"), { recursive: true });
    writeFileSync(sqlitePath, "");
    writeFileSync(sqlitePath + "-wal", "");
    writeFileSync(sqlitePath + "-shm", "");
    chmodSync(sqlitePath, 0o644);
    chmodSync(sqlitePath + "-wal", 0o644);
    chmodSync(sqlitePath + "-shm", 0o644);

    // A corrupt (empty) main file would make `SqliteThreadStore.open`
    // throw; use an actual empty sqlite instead. `bun:sqlite` treats
    // an empty file as an empty database on open, so an empty file
    // is fine to prep — but the WAL / SHM sidecars need to be
    // present at daemon start so the chmod loop reaches them.
    await start();
    for (const suffix of ["-wal", "-shm"]) {
      const path = sqlitePath + suffix;
      expect(existsSync(path), `${suffix} should have been pre-created`).toBe(true);
      const mode = statSync(path).mode & 0o777;
      expect(mode, `${suffix} should be 0600 after startup chmod`).toBe(0o600);
    }
  });
});
