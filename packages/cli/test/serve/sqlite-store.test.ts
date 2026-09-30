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
