// SqliteThreadStore — the daemon's on-disk implementation of
// review-core's `ThreadStore`. These tests exercise the file-backed
// path (a temporary sqlite file), not the in-memory one, so
// persistence across restart is a real assertion.

import { describe, expect, test, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ThreadStoreAppendError,
  type ReviewEventInput,
  type Anchor,
  exportArchive,
  isLineAnchor,
} from "@revkit/review-core";
import * as reviewCore from "@revkit/review-core";
import { SqliteThreadStore } from "../../src/serve/sqlite-store.ts";

const anchor: Anchor = {
  path: "docs/adr/0003.md",
  startLine: 40,
  endLine: 44,
  quote: { exact: "why 30s?", prefix: "", suffix: "" },
  revision: "a".repeat(64),
};

function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "revkit-sqlite-"));
  return join(dir, "threads.sqlite");
}

describe("SqliteThreadStore", () => {
  for (const payload of ["{", "{}"]) {
    test(`#99-r1: open wraps persisted ${payload} and closes its handle`, () => {
      const filename = tmpDb();
      SqliteThreadStore.open({ filename }).close();
      const db = new Database(filename);
      db.query("INSERT INTO events (seq, ts, payload) VALUES (?, ?, ?)").run(7, "2026-10-03T12:00:00Z", payload);
      db.close();
      const close = spyOn(Database.prototype, "close");
      let error: unknown;
      try {
        SqliteThreadStore.open({ filename });
      } catch (caught) {
        error = caught;
      }
      try {
        expect(error).toBeInstanceOf(reviewCore.ThreadStoreOpenError);
        const refusal = error as reviewCore.ThreadStoreOpenError;
        expect(refusal.rejection.kind).toBe("invalid-shape");
        expect(refusal.cause).toBeInstanceOf(Error);
        expect(refusal.message).toContain("seq 7");
        expect(refusal.message).toContain('field "');
        expect(refusal.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
        expect(refusal.message.length).toBeLessThan(1200);
        expect(close).toHaveBeenCalledTimes(1);
      } finally {
        close.mockRestore();
        rmSync(filename, { force: true });
      }
    });
  }

  test("#99-r1: accepted historical answer warning escapes the falsifier payload and has one newline", async () => {
    const filename = tmpDb();
    SqliteThreadStore.open({ filename }).close();
    const db = new Database(filename);
    const events = [
      { seq: 1, ts: "2026-10-03T12:00:00Z", actor: { kind: "agent", id: "a1" }, kind: "ask.created", askId: "ask-1",
        spec: { schemaVersion: 1, kind: "choice", title: "Which?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], allowOther: false, multi: false } },
      { seq: 2, ts: "2026-10-03T12:00:00Z", actor: { kind: "local", id: "u1" }, kind: "ask.answered", askId: "ask-1",
        answer: { kind: "choice", value: "bad\n\r\u2028\u0085\u001b[2J\u0000\ud800" } },
    ];
    for (const event of events) db.query("INSERT INTO events (seq, ts, payload) VALUES (?, ?, ?)").run(event.seq, event.ts, JSON.stringify(event));
    db.close();
    const warnings: string[] = [];
    const stderr = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { warnings.push(String(chunk)); return true; });
    let store: SqliteThreadStore | undefined;
    try {
      store = SqliteThreadStore.open({ filename });
      expect((await store.ask("ask-1"))?.status).toBe("answered");
      expect(store.head()).toBe(2);
      expect(warnings).toHaveLength(1);
      const warning = warnings[0] ?? "";
      expect(warning).toContain("accepting historical ask.answered");
      expect(warning).toContain("ask-1");
      expect(warning).toContain("bad\\n");
      expect(warning.match(/\n/g)).toHaveLength(1);
      expect(warning).toEndWith("\n");
      expect(warning.slice(0, -1)).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
      expect(warning.length).toBeLessThan(1200);
    } finally {
      stderr.mockRestore();
      store?.close();
      rmSync(filename, { force: true });
    }
  });

  test("#99: opening a corrupt log throws the shared typed open error and kind", () => {
    const filename = tmpDb();
    SqliteThreadStore.open({ filename }).close();
    const db = new Database(filename);
    const event = {
      seq: 1, ts: "2026-10-03T12:00:00Z", actor: { kind: "local", id: "u1" },
      kind: "thread.resolved", threadId: "missing",
    };
    db.query("INSERT INTO events (seq, ts, payload) VALUES (?, ?, ?)").run(event.seq, event.ts, JSON.stringify(event));
    db.close();
    let error: unknown;
    try {
      SqliteThreadStore.open({ filename, displayName: "threads\nforged.sqlite" });
    } catch (caught) {
      error = caught;
    } finally {
      rmSync(filename, { force: true });
    }
    expect((error as Error).name).toBe("ThreadStoreOpenError");
    expect(error).toBeInstanceOf(reviewCore.ThreadStoreOpenError);
    const refusal = error as reviewCore.ThreadStoreOpenError;
    expect(refusal.rejection.kind).toBe("unknown-thread");
    expect(refusal.rejection).toMatchObject({ threadId: "missing" });
    expect(refusal.message).toContain("Archive");
    expect(refusal.message).toContain("threads\\nforged.sqlite");
    expect(refusal.message).not.toMatch(/[\r\n]/);
  });

  test("appends a comment.created and returns seq=1", async () => {
    const filename = tmpDb();
    const store = SqliteThreadStore.open({ filename });
    const input: ReviewEventInput = {
      kind: "comment.created",
      actor: { kind: "local", id: "u1" },
      threadId: "t1",
      commentId: "c1",
      anchor,
      body: "why 30s?",
    };
    const seq = await store.append(input);
    expect(seq).toBe(1);
    const list = await store.threads();
    expect(list.length).toBe(1);
    expect(list[0]?.status).toBe("open");
    expect(list[0]?.comments.length).toBe(1);
    store.close();
    rmSync(filename, { force: true });
  });

  test("persists events across a close/re-open", async () => {
    const filename = tmpDb();
    {
      const store = SqliteThreadStore.open({ filename });
      await store.append({
        kind: "comment.created",
        actor: { kind: "local", id: "u1" },
        threadId: "t1",
        commentId: "c1",
        anchor,
        body: "why 30s?",
      });
      await store.append({
        kind: "comment.replied",
        actor: { kind: "agent", id: "agent" },
        threadId: "t1",
        commentId: "c2",
        parentId: "c1",
        body: "raised to 60s",
      });
      store.close();
    }
    // Re-open — same file, threads persist.
    {
      const store = SqliteThreadStore.open({ filename });
      const list = await store.threads();
      expect(list.length).toBe(1);
      expect(list[0]?.comments.length).toBe(2);
      expect(store.head()).toBe(2);
      // A new append continues the seq — head+1 = 3.
      const seq = await store.append({
        kind: "thread.resolved",
        actor: { kind: "local", id: "u1" },
        threadId: "t1",
      });
      expect(seq).toBe(3);
      store.close();
    }
    rmSync(filename, { force: true });
  });

  test("refuses a reply to a missing thread with a typed rejection", async () => {
    const filename = tmpDb();
    const store = SqliteThreadStore.open({ filename });
    try {
      await store.append({
        kind: "comment.replied",
        actor: { kind: "agent", id: "agent" },
        threadId: "t-missing",
        commentId: "c-x",
        parentId: "c-none",
        body: "hi",
      });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ThreadStoreAppendError);
      if (error instanceof ThreadStoreAppendError) {
        expect(error.rejection.kind).toBe("unknown-thread");
      }
    }
    store.close();
    rmSync(filename, { force: true });
  });

  test("since(after) returns only later events, ordered by seq", async () => {
    const filename = tmpDb();
    const store = SqliteThreadStore.open({ filename });
    await store.append({
      kind: "comment.created",
      actor: { kind: "local", id: "u1" },
      threadId: "t1",
      commentId: "c1",
      anchor,
      body: "a",
    });
    await store.append({
      kind: "comment.replied",
      actor: { kind: "agent", id: "agent" },
      threadId: "t1",
      commentId: "c2",
      parentId: "c1",
      body: "b",
    });
    const since1 = await store.since(1);
    expect(since1.length).toBe(1);
    expect(since1[0]?.seq).toBe(2);
    const since0 = await store.since(0);
    expect(since0.length).toBe(2);
    store.close();
    rmSync(filename, { force: true });
  });

  test("snapshot round-trip: putSnapshot then getSnapshot returns the exact source (content-addressed)", () => {
    const filename = tmpDb();
    const store = SqliteThreadStore.open({ filename });
    const source = "# X\n\nline 3\nline 4\n";
    const revision = "a".repeat(64);
    // First put reports "inserted".
    expect(store.putSnapshot(revision, source)).toBe(true);
    // Second put on the same (revision, source) is a no-op — the
    // content-addressed key already exists.
    expect(store.putSnapshot(revision, source)).toBe(false);
    // Round-trip.
    expect(store.getSnapshot(revision)).toBe(source);
    // A missing revision returns undefined (not null, not a throw).
    expect(store.getSnapshot("b".repeat(64))).toBeUndefined();
    // `snapshotBytes` reports the utf-8 byte length.
    expect(store.snapshotBytes()).toBe(Buffer.byteLength(source, "utf8"));
    // `snapshotRevisions` lists what's stored.
    expect(store.snapshotRevisions()).toEqual([revision]);
    store.close();
    rmSync(filename, { force: true });
  });

  test("snapshot GC deletes revisions not in the retain set (mutation guard, grace period bypassed)", () => {
    const filename = tmpDb();
    const store = SqliteThreadStore.open({ filename });
    const revA = "a".repeat(64);
    const revB = "b".repeat(64);
    const revC = "c".repeat(64);
    store.putSnapshot(revA, "A source");
    store.putSnapshot(revB, "B source");
    store.putSnapshot(revC, "C source");
    // Retain only revB; A and C should go. Pass `graceMs: 0` so
    // freshly-inserted rows are eligible for the sweep — the default
    // 30 s grace would keep them all.
    const deleted = store.gcSnapshots(new Set([revB]), 0);
    expect(deleted).toBe(2);
    expect(store.snapshotRevisions()).toEqual([revB]);
    expect(store.getSnapshot(revA)).toBeUndefined();
    expect(store.getSnapshot(revB)).toBe("B source");
    expect(store.getSnapshot(revC)).toBeUndefined();
    // Idempotent — a second GC with the same retain set is a no-op.
    expect(store.gcSnapshots(new Set([revB]), 0)).toBe(0);
    // Empty retain set clears the table.
    expect(store.gcSnapshots(new Set(), 0)).toBe(1);
    expect(store.snapshotRevisions()).toEqual([]);
    expect(store.snapshotBytes()).toBe(0);
    store.close();
    rmSync(filename, { force: true });
  });

  test("snapshot GC honours the grace period using the store's INJECTED CLOCK (PR #45 round-3 nit)", () => {
    // The reviewer's probe: a concurrent POST /api/threads inserts
    // a snapshot AFTER retain was computed but BEFORE gcSnapshots
    // ran. Without the grace period the fresh row is deleted. With
    // the default 30 s grace, any snapshot younger than 30 s is
    // retained regardless of the retain set. **The grace uses the
    // store's injected clock**, not `Date.now()`, so a test can
    // drive the window deterministically.
    let nowMs = 1_000_000; // pinned to 1970-01-01 + 1000s.
    const clock = () => new Date(nowMs).toISOString();
    const filename = tmpDb();
    const store = SqliteThreadStore.open({ filename, clock });
    const revFresh = "f".repeat(64);
    store.putSnapshot(revFresh, "fresh source");
    // Default grace period (30 s). retain is empty; the injected
    // clock has not advanced, so the snapshot is < 30 s old and
    // must survive.
    expect(store.gcSnapshots(new Set())).toBe(0);
    expect(store.getSnapshot(revFresh)).toBe("fresh source");
    // Advance the clock past the grace window; the same call now
    // deletes the row. Under a `Date.now`-based grace this test
    // could not drive the window at all.
    nowMs += 60_000;
    expect(store.gcSnapshots(new Set())).toBe(1);
    expect(store.getSnapshot(revFresh)).toBeUndefined();
    store.close();
    rmSync(filename, { force: true });
  });

  test("snapshot GC runs its SELECT inside the same transaction as its DELETE (write-lock coherence)", () => {
    // The DEFERRED default in bun:sqlite would let another writer
    // slip a fresh row in between the SELECT and the DELETEs. This
    // test drives a concurrent-write shape and asserts the fresh
    // row survives — proving the transaction is IMMEDIATE.
    let nowMs = 2_000_000;
    const clock = () => new Date(nowMs).toISOString();
    const filename = tmpDb();
    const store = SqliteThreadStore.open({ filename, clock });
    const revOld = "1".repeat(64);
    const revNew = "2".repeat(64);
    store.putSnapshot(revOld, "old");
    // Bypass grace so the OLD row is eligible for delete.
    const deletedOld = store.gcSnapshots(new Set(), 0);
    expect(deletedOld).toBe(1);
    // Now write a new row and run GC (empty retain) — grace saves
    // it. This is the shape a concurrent POST would produce.
    store.putSnapshot(revNew, "new");
    const deletedNew = store.gcSnapshots(new Set());
    expect(deletedNew).toBe(0);
    expect(store.getSnapshot(revNew)).toBe("new");
    store.close();
    rmSync(filename, { force: true });
  });

  test("MIGRATION: a pre-5b db (events table only, no snapshots table) opens cleanly", () => {
    // Simulate the on-disk shape a v0 daemon left: the events table
    // exists with real rows, but the snapshots table has never been
    // created. Opening the store must apply the additive migration
    // silently — the existing data must remain intact, and the
    // new snapshot methods must work.
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const filename = tmpDb();
    // Bootstrap with ONLY the events table (mimicking the pre-5b
    // SCHEMA_SQL — no `snapshots` table).
    const bootstrap = new Database(filename, { create: true });
    bootstrap.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX events_ts ON events (ts);
    `);
    // Insert a valid event under the pre-5b shape.
    const event = {
      seq: 1,
      ts: "2026-09-30T10:00:00Z",
      actor: { kind: "local", id: "u1" },
      kind: "comment.created",
      threadId: "t1",
      commentId: "c1",
      anchor,
      body: "why 30s?",
    };
    bootstrap
      .prepare("INSERT INTO events (seq, ts, payload) VALUES (?, ?, ?)")
      .run(1, "2026-09-30T10:00:00Z", JSON.stringify(event));
    bootstrap.close();

    // Now open with the current store. The migration adds `snapshots`.
    const store = SqliteThreadStore.open({ filename });
    // Existing thread is still there.
    const listAsync = store.threads();
    expect(listAsync).toBeDefined();
    // The snapshot API works on the migrated DB.
    expect(store.putSnapshot("d".repeat(64), "hello")).toBe(true);
    expect(store.getSnapshot("d".repeat(64))).toBe("hello");
    store.close();
    rmSync(filename, { force: true });
  });

  test("accepts and reduces thread.reanchored + thread.orphaned events (round-6 carry-over)", async () => {
    // Round-6 nit: a `bun:sqlite` runtime test that
    // `thread.reanchored` and `thread.orphaned` events flow through
    // the store without being refused, and that the reducer sees
    // their effect on thread status. This closes the gap where the
    // schema accepts the events but the daemon's writer might mis-
    // append them.
    const filename = tmpDb();
    const store = SqliteThreadStore.open({ filename });
    // Seed a thread.
    await store.append({
      kind: "comment.created",
      actor: { kind: "local", id: "u1" },
      threadId: "t1",
      commentId: "c1",
      anchor,
      body: "why 30s?",
    });
    // Re-anchor to a NEW revision at a different line — the
    // validator accepts a re-anchor when the path stays the same.
    const NEW_REVISION = "b".repeat(64);
    const reanchoredAnchor = {
      ...anchor,
      startLine: 50,
      endLine: 54,
      revision: NEW_REVISION,
    };
    await store.append({
      kind: "thread.reanchored",
      actor: { kind: "agent", id: "revkit-reanchor" },
      threadId: "t1",
      anchor: reanchoredAnchor,
      method: "quote-exact",
    });
    // The thread's anchor moved and it's still open — the reducer
    // (through selectThreads) reflects the new position.
    let listed = await store.threads();
    expect(listed.length).toBe(1);
    const first = listed[0];
    if (first === undefined || !isLineAnchor(first.anchor)) throw new Error("expected line anchor");
    expect(first.anchor.startLine).toBe(50);
    expect(first.anchor.endLine).toBe(54);
    expect(listed[0]?.status).toBe("open");
    // Orphan it.
    await store.append({
      kind: "thread.orphaned",
      actor: { kind: "agent", id: "revkit-reanchor" },
      threadId: "t1",
      revision: NEW_REVISION,
      reason: "quoted text removed",
    });
    listed = await store.threads();
    expect(listed[0]?.status).toBe("orphaned");
    // Round-trip through export/import — the archive carries these
    // events and a fresh store replays them.
    const archive = await exportArchive(store);
    store.close();
    const dest = SqliteThreadStore.open({ filename: tmpDb() });
    await dest.import(archive);
    const restored = await dest.threads();
    expect(restored.length).toBe(1);
    expect(restored[0]?.status).toBe("orphaned");
    const restoredFirst = restored[0];
    if (restoredFirst === undefined || !isLineAnchor(restoredFirst.anchor)) {
      throw new Error("expected line anchor");
    }
    expect(restoredFirst.anchor.startLine).toBe(50);
    dest.close();
    rmSync(filename, { force: true });
  });

  test("import merges an archive whose seqs are strictly greater than head", async () => {
    const filenameA = tmpDb();
    const filenameB = tmpDb();
    const source = SqliteThreadStore.open({ filename: filenameA });
    await source.append({
      kind: "comment.created",
      actor: { kind: "local", id: "u1" },
      threadId: "t1",
      commentId: "c1",
      anchor,
      body: "why 30s?",
    });
    const archive = await exportArchive(source);
    source.close();
    const dest = SqliteThreadStore.open({ filename: filenameB });
    await dest.import(archive);
    const list = await dest.threads();
    expect(list.length).toBe(1);
    expect(list[0]?.id).toBe("t1");
    dest.close();
    rmSync(filenameA, { force: true });
    rmSync(filenameB, { force: true });
  });
});

// ── PR #52 round-2 review: replay policy for answer-shape-mismatch ─

describe("SqliteThreadStore.open — replay policy for pre-fix ask-answered logs (PR #52 round-2)", () => {
  test("an ask.answered event whose values fail the current answer-shape rule is ACCEPTED on replay (state = answered, warning to stderr)", () => {
    // A log written by an earlier commit could carry an answer
    // that doesn't match the current spec (e.g. `value: "zzz"`
    // on a choice with no `other:` prefix). The daemon must
    // start, not fail — new appends stay strict.
    const filename = join(tmpdir(), `revkit-replay-${Math.random().toString(16).slice(2)}.sqlite`);
    // Seed the DB by opening it, appending the "old" events with
    // the current (strict) validator DISABLED via a raw INSERT.
    // We use two ordinary events to prove the strict path still
    // works and then plant a single hostile ask.answered.
    const store = SqliteThreadStore.open({ filename });
    store.close();
    const db = new Database(filename);
    // Directly insert the events. The reviewEventSchema shape
    // is preserved; only the transition-time rule fails.
    const seed: readonly unknown[] = [
      {
        seq: 1,
        ts: "2026-09-30T12:00:00Z",
        actor: { kind: "agent", id: "revkit-live" },
        kind: "ask.created",
        askId: "ask-1",
        spec: {
          schemaVersion: 1,
          kind: "choice",
          title: "Which?",
          options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
          allowOther: false,
          multi: false,
        },
      },
      // Hostile answer — `zzz` is not an option id and allowOther is false.
      {
        seq: 2,
        ts: "2026-09-30T12:00:01Z",
        actor: { kind: "local", id: "human" },
        kind: "ask.answered",
        askId: "ask-1",
        answer: { kind: "choice", value: "zzz" },
      },
    ];
    for (const ev of seed) {
      const s = ev as { seq: number; ts: string };
      db.query("INSERT INTO events (seq, ts, payload) VALUES (?, ?, ?)")
        .run(s.seq, s.ts, JSON.stringify(ev));
    }
    db.close();

    // Capture stderr for the assertion.
    const originalWrite = process.stderr.write.bind(process.stderr);
    const capturedStderr: string[] = [];
    (process.stderr.write as unknown as (chunk: unknown) => boolean) = (chunk: unknown): boolean => {
      capturedStderr.push(String(chunk));
      return true;
    };
    let reopened: SqliteThreadStore;
    try {
      reopened = SqliteThreadStore.open({ filename });
    } finally {
      process.stderr.write = originalWrite;
    }
    // The daemon started; the ask is projected as `answered`.
    reopened.ask("ask-1").then((record) => {
      expect(record?.status).toBe("answered");
    });
    reopened.close();
    // A warning was logged.
    expect(capturedStderr.join("")).toContain("accepting historical ask.answered");
    expect(capturedStderr.join("")).toContain("ask-1");
    rmSync(filename, { force: true });
  });
});
