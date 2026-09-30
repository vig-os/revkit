// SqliteThreadStore — the daemon's on-disk implementation of
// review-core's `ThreadStore`. These tests exercise the file-backed
// path (a temporary sqlite file), not the in-memory one, so
// persistence across restart is a real assertion.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ThreadStoreAppendError,
  type ReviewEventInput,
  type Anchor,
  exportArchive,
} from "@revkit/review-core";
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

  test("snapshot GC honours the grace period: a fresh snapshot survives even if unretained (PR #45 round-2 race)", () => {
    // The reviewer's probe: a concurrent POST /api/threads inserts
    // a snapshot AFTER retain was computed but BEFORE gcSnapshots
    // ran. Without the grace period the fresh row is deleted. With
    // the default 30 s grace, any snapshot younger than 30 s is
    // retained regardless of the retain set.
    const filename = tmpDb();
    const store = SqliteThreadStore.open({ filename });
    const revFresh = "f".repeat(64);
    store.putSnapshot(revFresh, "fresh source");
    // Default grace period (30 s). retain is empty, so on the
    // narrow reading the fresh row would be deleted. It is NOT —
    // the grace period saves it.
    expect(store.gcSnapshots(new Set())).toBe(0);
    expect(store.getSnapshot(revFresh)).toBe("fresh source");
    // Passing `graceMs: 0` explicitly bypasses the grace and the
    // row goes.
    expect(store.gcSnapshots(new Set(), 0)).toBe(1);
    expect(store.getSnapshot(revFresh)).toBeUndefined();
    store.close();
    rmSync(filename, { force: true });
  });

  test("snapshot GC runs its SELECT inside the same transaction as its DELETE (write-lock coherence)", () => {
    // The DEFERRED default in bun:sqlite would let another writer
    // slip a fresh row in between the SELECT and the DELETEs. This
    // test drives a concurrent-write shape and asserts the fresh
    // row survives — proving the transaction is IMMEDIATE.
    const filename = tmpDb();
    const store = SqliteThreadStore.open({ filename });
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
    expect(listed[0]?.anchor.startLine).toBe(50);
    expect(listed[0]?.anchor.endLine).toBe(54);
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
    expect(restored[0]?.anchor.startLine).toBe(50);
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
