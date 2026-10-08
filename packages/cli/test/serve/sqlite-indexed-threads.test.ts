import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryThreadStore,
  ThreadStoreAppendError,
  exportArchive,
  selectThreads,
  reviewEventSchema,
  revisionOf,
  type ReviewEventKind,
  type Thread,
  type Anchor,
  type ReviewEvent,
  type ReviewEventInput,
  type ThreadFilter,
} from "@revkit/review-core";
import { SqliteThreadStore } from "../../src/serve/sqlite-store.ts";

const actor = { kind: "local", id: "index-test" } as const;
const ts = "2026-10-08T00:00:00.000Z";
const paths = ["docs/a.md", "docs/b.md", "docs/c.md", "docs/\ud800.md", "docs/\udc00.md", "docs/missing.md"];
function anchor(path: string): Anchor {
  return { path, startLine: 1, endLine: 1, quote: { exact: "source", prefix: "", suffix: "" }, revision: "a".repeat(64) };
}
function created(id: string, path = paths[0]!): ReviewEventInput {
  return { kind: "comment.created", actor, threadId: id, commentId: `c-${id}`, anchor: anchor(path), body: id, external: { provider: "github", threadId: `gh-${id}`, resolved: false } };
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
async function compareFiltered(store: SqliteThreadStore, events: readonly ReviewEvent[]): Promise<void> {
  for (const path of paths) {
    const statuses: ThreadFilter["status"][] = [undefined, "open", "resolved", "orphaned", ["open", "orphaned"], ["resolved", "open", "orphaned"]];
    for (const status of statuses) {
      const filter: ThreadFilter = { path, ...(status === undefined ? {} : { status }) };
      expect(JSON.stringify(await store.threads(filter))).toBe(JSON.stringify(selectThreads(events, filter)));
    }
  }
}

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// Every union member must be generated or explicitly classified as not changing
// Thread state. New kinds fail both typechecking and the runtime coverage test.
const neutralKinds = [
  "handover", "delivery.mode_changed", "ask.created", "ask.answered", "ask.cancelled", "ask.expired",
  "doc.published", "review.opened", "review.submitted", "review.abandoned", "comment.sync_requested",
  "thread.sync_failed", "comment.sync_failed", "comment.sync_cancelled", "build.requested", "build.started", "build.succeeded", "build.failed",
] as const satisfies readonly ReviewEventKind[];
type GeneratedKind = Exclude<ReviewEventKind, typeof neutralKinds[number]>;
interface GeneratorContext {
  reference: InMemoryThreadStore;
  thread: Thread;
  commentId: string;
  path: string;
  i: number;
}
const agent = { kind: "agent", id: "draft-agent" } as const;
const generators: Record<GeneratedKind, (ctx: GeneratorContext) => Promise<void>> = {
  "comment.created": async ({ reference, path, i }) => {
    await reference.append(created(`generated-${i}`, path));
  },
  "comment.replied": async ({ reference, thread, commentId, i }) => {
    await reference.append({ kind: "comment.replied", actor: i % 2 ? agent : actor, threadId: thread.id, commentId: `reply-${i}`, parentId: commentId, body: `reply ${i}` });
  },
  "comment.edited": async ({ reference, commentId, i }) => {
    await reference.append({ kind: "comment.edited", actor, commentId, body: `edited ${i}` });
  },
  "thread.resolved": async ({ reference, thread, i }) => {
    if (thread.status === "resolved") await reference.append({ kind: "thread.reopened", actor, threadId: thread.id });
    await reference.append({ kind: "thread.resolved", actor: i % 2 ? agent : actor, threadId: thread.id });
  },
  "thread.reopened": async ({ reference, thread, i }) => {
    if (thread.status !== "resolved") await reference.append({ kind: "thread.resolved", actor, threadId: thread.id });
    await reference.append({ kind: "thread.reopened", actor: i % 2 ? agent : actor, threadId: thread.id });
  },
  "thread.reanchored": async ({ reference, thread, i }) => {
    await reference.append({ kind: "thread.reanchored", actor, threadId: thread.id, anchor: { ...anchor(thread.anchor.path), startLine: i + 1, endLine: i + 1 }, method: "quote-exact" });
  },
  "thread.orphaned": async ({ reference, thread }) => {
    if (thread.status === "resolved") await reference.append({ kind: "thread.reopened", actor, threadId: thread.id });
    if (thread.status !== "open") await reference.append({ kind: "thread.reanchored", actor, threadId: thread.id, anchor: anchor(thread.anchor.path), method: "quote-exact" });
    await reference.append({ kind: "thread.orphaned", actor, threadId: thread.id, revision: "b".repeat(64), reason: "anchored source deleted" });
  },
  "comment.linked": async ({ reference, thread, i }) => {
    const commentId = `linked-${i}`;
    await reference.append({ kind: "comment.replied", actor, threadId: thread.id, commentId, parentId: thread.comments[0]!.id, body: "to link" });
    await reference.append({ kind: "comment.linked", actor, commentId, external: { github: { commentId: i + 1 } } });
  },
  "thread.external_synced": async ({ reference, thread, i }) => {
    if (thread.status === "resolved") await reference.append({ kind: "thread.reopened", actor, threadId: thread.id });
    const intentSeq = await reference.append({ kind: "thread.resolved", actor, threadId: thread.id });
    await reference.append({ kind: "thread.external_synced", actor, threadId: thread.id, resolved: true, intentSeq, resolvedByLogin: `resolver-${i}` });
    const reopened = await reference.append({ kind: "thread.reopened", actor, threadId: thread.id });
    await reference.append({ kind: "thread.external_synced", actor, threadId: thread.id, resolved: true, intentSeq, resolvedByLogin: "stale-must-not-win" });
    await reference.append({ kind: "thread.external_synced", actor, threadId: thread.id, resolved: false, intentSeq: reopened, resolvedByLogin: `reopener-${i}` });
  },
  "draft.promoted": async ({ reference, thread, i }) => {
    const commentId = `draft-${i}`;
    const body = `draft ${i}`;
    const commentSeq = await reference.append({ kind: "comment.replied", actor: agent, threadId: thread.id, commentId, parentId: thread.comments[0]!.id, body });
    await reference.append({ kind: "draft.promoted", actor, threadId: thread.id, target: "comment", commentId, commentSeq, bodyHash: await revisionOf(body) });
    if (thread.status === "resolved") await reference.append({ kind: "thread.reopened", actor, threadId: thread.id });
    await reference.append({ kind: "thread.resolved", actor: agent, threadId: thread.id });
    await reference.append({ kind: "draft.promoted", actor, threadId: thread.id, target: "resolve" });
    await reference.append({ kind: "thread.reopened", actor: agent, threadId: thread.id });
    await reference.append({ kind: "draft.promoted", actor, threadId: thread.id, target: "reopen" });
  },
};

// Orphaning represents source deletion: no thread/comment deletion kind exists.
async function randomLog(seed: number): Promise<ReviewEvent[]> {
  const rng = random(seed);
  const reference = new InMemoryThreadStore({ clock: () => ts });
  const kinds = Object.keys(generators) as GeneratedKind[];
  for (let i = 0; i < 12; i++) {
    const input = created(`t-${i}`, paths[i % (paths.length - 1)]!);
    if (input.kind === "comment.created" && i === 0) {
      await reference.append({ ...input, anchor: { kind: "unanchored", path: paths[0]! }, orphanReason: "source deleted" });
    } else {
      await reference.append(input);
    }
  }
  for (let i = 0; i < 80; i++) {
    const threads = await reference.threads();
    const thread = threads[Math.floor(rng() * threads.length)]!;
    const comment = thread.comments[Math.floor(rng() * thread.comments.length)]!;
    await generators[kinds[i % kinds.length]!]({ reference, thread, commentId: comment.id, path: paths[Math.floor(rng() * (paths.length - 1))]!, i });
  }
  return reference.since(0);
}

describe("SqliteThreadStore indexed path reads", () => {
  test("the generator covers every thread-changing union kind and matching/stale external intents", async () => {
    const generated = (Object.keys(generators) as GeneratedKind[]).sort();
    const required = reviewEventSchema.options.map((variant) => variant.shape.kind.value)
      .filter((kind) => !neutralKinds.some((neutral) => neutral === kind)).sort();
    expect(required).toEqual(generated);
    const events = await randomLog(115);
    expect([...new Set(events.map((event) => event.kind))].sort()).toEqual(generated);
    let matching = 0;
    let stale = 0;
    for (const [i, event] of events.entries()) {
      if (event.kind !== "thread.external_synced") continue;
      const prior = events.slice(0, i);
      const currentIntent = [...prior].reverse().find((candidate) =>
        (candidate.kind === "thread.resolved" || candidate.kind === "thread.reopened") &&
        candidate.threadId === event.threadId && candidate.actor.kind === "local");
      const before = selectThreads(prior).find((thread) => thread.id === event.threadId)!;
      const after = selectThreads(events.slice(0, i + 1)).find((thread) => thread.id === event.threadId)!;
      if (event.intentSeq === currentIntent?.seq) {
        matching++;
        expect(after.external?.resolved).toBe(event.resolved);
        expect(after.external?.resolvedByLogin).toBe(event.resolvedByLogin);
      } else {
        stale++;
        expect(after).toEqual(before);
      }
    }
    expect(matching).toBeGreaterThan(0);
    expect(stale).toBeGreaterThan(0);
  });

  test("lone high/low surrogates remain distinct across append, import and reopen", async () => {
    const file = filename();
    const store = open(file);
    for (const [i, path] of ["docs/\ud800.md", "docs/\udc00.md", "docs/\ufffd.md"].entries()) {
      await store.append(created(`surrogate-${i}`, path));
      expect((await store.threads({ path })).map((thread) => thread.anchor.path)).toEqual([path]);
    }
    const events = await store.since(0);
    await compareFiltered(store, events);
    const imported = open();
    await imported.import(await exportArchive(store));
    await compareFiltered(imported, events);
    store.close();
    await compareFiltered(open(file), events);
  });

  test("legacy JSON duplicate keys use the same last-key semantics during replay and reads", async () => {
    const file = filename();
    const store = open(file);
    await store.append(created("first"));
    const db = database(file);
    const event: ReviewEvent = { kind: "comment.edited", actor, commentId: "c-first", body: "last key wins", seq: 2, ts };
    const payload = JSON.stringify(event).replace('"commentId":"c-first"', '"commentId":"missing","commentId":"c-first"');
    db.query("INSERT INTO events (seq, ts, payload) VALUES (?, ?, ?)").run(2, ts, payload);
    const events = await store.since(0);
    // An older writer does not update the checkpoint: current readers use the log
    // until a new open or write heals the index. The raw log remains untouched.
    await compareFiltered(store, events);
    const reopened = open(file);
    await compareFiltered(reopened, events);
    expect(db.query<{ payload: string }, []>("SELECT payload FROM events WHERE seq = 2").get()!.payload).toBe(payload);
    await reopened.append({ kind: "thread.resolved", actor, threadId: "first" });
    await compareFiltered(store, await reopened.since(0));
  });

  test("open remains a WAL reader during a writer transaction with current, damaged or missing indexes", async () => {
    for (const mode of ["current", "damaged", "missing"] as const) {
      const file = filename();
      const writer = open(file);
      await writer.append(created("first"));
      const db = database(file);
      const hasIndex = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_events'").get() !== null;
      if (mode === "damaged" && hasIndex) db.exec("DELETE FROM thread_events");
      if (mode === "missing" && hasIndex) db.exec("DROP TABLE thread_events; DROP TABLE thread_paths; DROP TABLE comment_threads; DROP TABLE thread_index_meta");
      db.exec("BEGIN IMMEDIATE");
      let reader: SqliteThreadStore;
      try {
        const staged: ReviewEvent = { kind: "comment.edited", actor, commentId: "c-first", body: "writer committed", seq: 2, ts };
        db.query("INSERT INTO events (seq, ts, payload) VALUES (?, ?, ?)").run(2, ts, JSON.stringify(staged));
        reader = open(file);
        expect(reader.head()).toBe(1);
        expect((await reader.threads({ path: paths[0]! }))[0]!.comments[0]!.body).toBe("first");
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      expect((await reader.threads({ path: paths[0]! }))[0]!.comments[0]!.body).toBe("writer committed");
      // Also repairs a deferred/missing index inside the new append transaction.
      await reader.append({ kind: "thread.resolved", actor, threadId: "first" });
      await compareFiltered(reader, await reader.since(0));
      await compareFiltered(open(file), await reader.since(0));
    }
  });

  test("open removes the previous routing trigger and keeps healthy projections unchanged", async () => {
    const file = filename();
    const store = open(file);
    await store.append(created("first"));
    const db = database(file);
    db.exec("CREATE TRIGGER events_thread_index AFTER INSERT ON events BEGIN SELECT RAISE(ABORT, 'obsolete routing trigger'); END");
    const reopened = open(file);
    await reopened.append(created("second", paths[1]!));
    await compareFiltered(store, await reopened.since(0));
    // A healthy reopen verifies rows without rewriting them.
    db.exec("CREATE TRIGGER refuse_rewrite BEFORE DELETE ON thread_events BEGIN SELECT RAISE(ABORT, 'unnecessary rewrite'); END");
    await compareFiltered(open(file), await reopened.since(0));
  });

  test("validation rejects globally duplicate comment ids before any routing write", async () => {
    const file = filename();
    const store = open(file);
    await store.append(created("first"));
    await store.append(created("second", paths[1]!));
    const before = await store.since(0);
    for (const input of [
      { ...created("third"), commentId: "c-first" },
      { kind: "comment.replied", actor, threadId: "second", commentId: "c-first", parentId: "c-second", body: "duplicate across threads" },
    ] as ReviewEventInput[]) {
      try {
        await store.append(input);
        throw new Error("duplicate accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(ThreadStoreAppendError);
        expect((error as ThreadStoreAppendError).rejection.kind).toBe("duplicate-comment-id");
      }
      expect(await store.since(0)).toEqual(before);
      await compareFiltered(store, before);
    }
    await store.append({ kind: "comment.replied", actor, threadId: "second", commentId: "unique", parentId: "c-second", body: "accepted" });
    await compareFiltered(store, await store.since(0));
  });

  test("selected thread histories include agent comment and lifecycle promotions", async () => {
    const file = filename();
    const store = open(file);
    const reference = new InMemoryThreadStore({ clock: () => ts });
    await reference.append(created("first"));
    const thread = (await reference.threads())[0]!;
    await generators["draft.promoted"]({ reference, thread, commentId: thread.comments[0]!.id, path: paths[0]!, i: 0 });
    const events = await reference.since(0);
    await store.import(await exportArchive(reference));
    await compareFiltered(store, events);
    // Promotion itself has no effect on Thread; this local history assertion
    // prevents its routing from being silently dropped while Thread stays equal.
    const db = database(file);
    expect(db.query<{ seq: number }, [string]>("SELECT seq FROM thread_events WHERE thread_id = ? ORDER BY seq").all(JSON.stringify("first")))
      .toEqual(events.map((event) => ({ seq: event.seq })));
  });

  test("random histories match whole-log reduction after append, import and reopen", async () => {
    for (const seed of [1, 17, 115, 0xdeadbeef]) {
      const events = await randomLog(seed);
      const file = filename();
      const store = open(file);
      for (let i = 0; i < events.length; i++) {
        const { seq: _seq, ts: _ts, ...input } = events[i]!;
        await store.append(input);
        await compareFiltered(store, events.slice(0, i + 1));
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

  test("returns only selected threads with complete histories, and none for a missing path", async () => {
    const store = open();
    for (let i = 0; i < 100; i++) {
      await store.append(created(`t-${i}`, `docs/${i}.md`));
      await store.append({ kind: "comment.edited", actor, commentId: `c-t-${i}`, body: "updated" });
      await store.append({ kind: "thread.resolved", actor, threadId: `t-${i}` });
    }
    const selected = await store.threads({ path: "docs/50.md", status: "resolved" });
    expect(selected.map((thread) => thread.id)).toEqual(["t-50"]);
    expect(selected[0]!.comments[0]!.body).toBe("updated");
    expect(await store.threads({ path: "docs/missing.md" })).toEqual([]);
    expect(await store.threads({ path: "docs/50.md", status: "open" })).toEqual([]);
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
    const before = ["events", "thread_paths", "comment_threads", "thread_events", "thread_index_meta"].map((table) => db.query(`SELECT * FROM ${table}`).all());
    db.exec(`CREATE TRIGGER refuse_path BEFORE UPDATE ON thread_paths BEGIN SELECT RAISE(ABORT, 'injected path failure'); END`);
    await expect(store.append({ kind: "thread.reanchored", actor, threadId: "first", anchor: { ...anchor(paths[0]!), revision: "b".repeat(64) }, method: "quote-exact" })).rejects.toThrow("injected path failure");
    expect(["events", "thread_paths", "comment_threads", "thread_events", "thread_index_meta"].map((table) => db.query(`SELECT * FROM ${table}`).all())).toEqual(before);
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
    const beforeMeta = db.query("SELECT * FROM thread_index_meta").all();
    db.exec(`CREATE TRIGGER refuse_second BEFORE INSERT ON thread_events WHEN NEW.seq = 2 BEGIN SELECT RAISE(ABORT, 'injected import failure'); END`);
    await expect(store.import(archive)).rejects.toThrow("injected import failure");
    for (const table of ["events", "thread_paths", "comment_threads", "thread_events"]) {
      expect(db.query(`SELECT * FROM ${table}`).all()).toEqual([]);
    }
    expect(db.query("SELECT * FROM thread_index_meta").all()).toEqual(beforeMeta);
    expect(store.head()).toBe(0);
    db.exec("DROP TRIGGER refuse_second");
    await store.import(archive);
    await compareFiltered(store, archive.events);
  });
});
