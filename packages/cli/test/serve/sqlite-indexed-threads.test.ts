import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryThreadStore,
  exportArchive,
  selectThreads,
  type Anchor,
  type ReviewEvent,
  type ReviewEventInput,
  type ThreadFilter,
} from "@revkit/review-core";
import { SqliteThreadStore } from "../../src/serve/sqlite-store.ts";

const actor = { kind: "local", id: "index-test" } as const;
const ts = "2026-10-08T00:00:00.000Z";
const paths = ["docs/a.md", "docs/b.md", "docs/c.md", "docs/missing.md"];
function anchor(path: string): Anchor {
  return { path, startLine: 1, endLine: 1, quote: { exact: "source", prefix: "", suffix: "" }, revision: "a".repeat(64) };
}
function created(id: string, path = paths[0]!): ReviewEventInput {
  return { kind: "comment.created", actor, threadId: id, commentId: `c-${id}`, anchor: anchor(path), body: id };
}

const stores: SqliteThreadStore[] = [];
const databases: Database[] = [];
const dirs: string[] = [];
function filename(): string {
  const dir = mkdtempSync(join(tmpdir(), "revkit-index-test-"));
  dirs.push(dir);
  return join(dir, "threads.sqlite");
}
function open(file = ":memory:"): SqliteThreadStore {
  const store = SqliteThreadStore.open({ filename: file, clock: () => ts });
  stores.push(store);
  return store;
}
function database(file: string): Database {
  const db = new Database(file);
  databases.push(db);
  return db;
}
afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (databases.length) databases.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// Byte comparison pins property order as well as createdSeq and comment order.
// The spy is a structural regression guard, with no timing/CI budget assertion.
async function compareFiltered(store: SqliteThreadStore, events: readonly ReviewEvent[]): Promise<void> {
  const since = spyOn(store, "since");
  try {
    for (const path of paths) {
      const statuses: ThreadFilter["status"][] = [undefined, "open", "resolved", "orphaned", ["open", "orphaned"], ["resolved", "open", "orphaned"]];
      for (const status of statuses) {
        const filter: ThreadFilter = { path, ...(status === undefined ? {} : { status }) };
        expect(JSON.stringify(await store.threads(filter))).toBe(JSON.stringify(selectThreads(events, filter)));
      }
    }
    expect(since).not.toHaveBeenCalled();
  } finally {
    since.mockRestore();
  }
}

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// Generate accepted, interleaved histories independently with the reference
// store. Orphaning represents the deletion of anchored source; there is no
// comment/thread deletion event in the current ReviewEvent union.
async function randomLog(seed: number): Promise<ReviewEvent[]> {
  const rng = random(seed);
  const reference = new InMemoryThreadStore({ clock: () => ts });
  for (let i = 0; i < 12; i++) {
    const input = created(`t-${i}`, paths[Math.floor(rng() * 3)]!);
    if (input.kind === "comment.created" && i === 0) {
      await reference.append({ ...input, anchor: { kind: "unanchored", path: paths[0]! }, orphanReason: "source deleted" });
    } else {
      await reference.append(input);
    }
  }
  for (let i = 0; i < 180; i++) {
    const threads = await reference.threads();
    const thread = threads[Math.floor(rng() * threads.length)]!;
    const comment = thread.comments[Math.floor(rng() * thread.comments.length)]!;
    const choice = i % 6;
    if (choice === 0) {
      await reference.append({ kind: "comment.replied", actor, threadId: thread.id, commentId: `reply-${i}`, parentId: comment.id, body: `reply ${i}` });
    } else if (choice === 1) {
      await reference.append({ kind: "comment.edited", actor, commentId: comment.id, body: `edited ${i}` });
    } else if (choice === 2) {
      await reference.append({ kind: thread.status === "resolved" ? "thread.reopened" : "thread.resolved", actor, threadId: thread.id });
    } else if (choice === 3) {
      await reference.append({ kind: "thread.reanchored", actor, threadId: thread.id, anchor: { ...anchor(thread.anchor.path), startLine: i + 1, endLine: i + 1 }, method: "quote-exact" });
    } else if (choice === 4 && thread.status === "open") {
      await reference.append({ kind: "thread.orphaned", actor, threadId: thread.id, revision: "b".repeat(64), reason: "anchored source deleted" });
    } else if (choice === 5 && comment.external === undefined) {
      await reference.append({ kind: "comment.linked", actor, commentId: comment.id, external: { github: { commentId: i + 1 } } });
    }
  }
  return reference.since(0);
}

describe("SqliteThreadStore indexed path reads", () => {
  test("random histories match whole-log reduction after append, import and reopen", async () => {
    for (const seed of [1, 17, 115, 0xdeadbeef]) {
      const events = await randomLog(seed);
      const file = filename();
      const store = open(file);
      for (let i = 0; i < events.length; i++) {
        const { seq: _seq, ts: _ts, ...input } = events[i]!;
        await store.append(input);
        if (i % 30 === 0) await compareFiltered(store, events.slice(0, i + 1));
      }
      await compareFiltered(store, events);
      expect(JSON.stringify(await store.threads())).toBe(JSON.stringify(selectThreads(events)));
      expect(JSON.stringify(await store.threads({ status: "resolved" }))).toBe(JSON.stringify(selectThreads(events, { status: "resolved" })));
      const imported = open();
      await imported.import(await exportArchive(store));
      await compareFiltered(imported, events);
      store.close();
      await compareFiltered(open(file), events);
    }
  });

  test("only parses selected threads' complete histories, and no events for a missing path", async () => {
    const store = open();
    for (let i = 0; i < 100; i++) {
      await store.append(created(`t-${i}`, `docs/${i}.md`));
      await store.append({ kind: "comment.edited", actor, commentId: `c-t-${i}`, body: "updated" });
      await store.append({ kind: "thread.resolved", actor, threadId: `t-${i}` });
    }
    const parse = spyOn(JSON, "parse");
    try {
      const selected = await store.threads({ path: "docs/50.md", status: "resolved" });
      expect(selected.map((thread) => thread.id)).toEqual(["t-50"]);
      expect(selected[0]!.comments[0]!.body).toBe("updated");
      expect(parse).toHaveBeenCalledTimes(3);
      parse.mockClear();
      expect(await store.threads({ path: "docs/missing.md" })).toEqual([]);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  test("opens origin/dev's on-disk schema and indexes latest paths without changing log bytes", async () => {
    const file = filename();
    const legacy = database(file);
    // Exact origin/dev schema (including snapshots); no routing projections.
    legacy.exec(`
      CREATE TABLE events (seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX events_ts ON events (ts);
      CREATE TABLE snapshots (revision TEXT PRIMARY KEY, source TEXT NOT NULL, bytes INTEGER NOT NULL, created_at TEXT NOT NULL);
    `);
    const events = await randomLog(115);
    const insert = legacy.prepare("INSERT INTO events (seq, ts, payload) VALUES (?, ?, ?)");
    for (const event of events) insert.run(event.seq, event.ts, JSON.stringify(event));
    legacy.prepare("INSERT INTO snapshots VALUES (?, ?, ?, ?)").run("a".repeat(64), "source", 6, ts);
    const before = legacy.query("SELECT * FROM events ORDER BY seq").all();
    const store = open(file);
    await compareFiltered(store, events);
    expect(legacy.query("SELECT * FROM events ORDER BY seq").all()).toEqual(before);
    expect(store.getSnapshot("a".repeat(64))).toBe("source");
    expect(store.head()).toBe(events.length);
    expect(await store.append(created("after-migration"))).toBe(events.length + 1);
    await compareFiltered(store, await store.since(0));
  });

  test("rebuilds corrupted routing rows on open and observes a second writer's reanchors and edits", async () => {
    const file = filename();
    const store = open(file);
    await store.append(created("first"));
    const db = database(file);
    const before = await store.since(0);
    db.exec("DELETE FROM thread_events; DELETE FROM comment_threads; UPDATE thread_paths SET path = 'docs/missing.md'");
    const writer = open(file);
    expect(await writer.since(0)).toEqual(before);
    await compareFiltered(writer, before);
    await writer.append({ kind: "thread.reanchored", actor, threadId: "first", anchor: { ...anchor(paths[0]!), revision: "b".repeat(64) }, method: "quote-exact" });
    await writer.append({ kind: "comment.edited", actor, commentId: "c-first", body: "other writer" });
    await compareFiltered(store, await writer.since(0));
    const beforeRefusal = await writer.since(0);
    await expect(writer.append({ kind: "thread.reanchored", actor, threadId: "first", anchor: anchor(paths[1]!), method: "quote-exact" })).rejects.toThrow("refusing a reanchor onto a different file");
    expect(await writer.since(0)).toEqual(beforeRefusal);
    await store.append(created("second", paths[1]!));
    await compareFiltered(writer, await store.since(0));
  });

  test("a failed append rolls back both the log and all routing projections", async () => {
    const file = filename();
    const store = open(file);
    await store.append(created("first"));
    const db = database(file);
    const before = ["events", "thread_paths", "comment_threads", "thread_events"].map((table) => db.query(`SELECT * FROM ${table}`).all());
    db.exec(`CREATE TRIGGER refuse_path BEFORE UPDATE ON thread_paths BEGIN SELECT RAISE(ABORT, 'injected path failure'); END`);
    await expect(store.append({ kind: "thread.reanchored", actor, threadId: "first", anchor: { ...anchor(paths[0]!), revision: "b".repeat(64) }, method: "quote-exact" })).rejects.toThrow("injected path failure");
    expect(["events", "thread_paths", "comment_threads", "thread_events"].map((table) => db.query(`SELECT * FROM ${table}`).all())).toEqual(before);
    await compareFiltered(store, await store.since(0));
  });

  test("a mid-import projection failure leaves an empty log and permits an atomic retry", async () => {
    const source = new InMemoryThreadStore({ clock: () => ts });
    await source.append(created("first"));
    await source.append(created("second", paths[1]!));
    const archive = await exportArchive(source);
    const file = filename();
    const store = open(file);
    const db = database(file);
    db.exec(`CREATE TRIGGER refuse_second BEFORE INSERT ON thread_events WHEN NEW.seq = 2 BEGIN SELECT RAISE(ABORT, 'injected import failure'); END`);
    await expect(store.import(archive)).rejects.toThrow("injected import failure");
    for (const table of ["events", "thread_paths", "comment_threads", "thread_events"]) {
      expect(db.query(`SELECT * FROM ${table}`).all()).toEqual([]);
    }
    expect(store.head()).toBe(0);
    db.exec("DROP TRIGGER refuse_second");
    await store.import(archive);
    await compareFiltered(store, archive.events);
  });
});
