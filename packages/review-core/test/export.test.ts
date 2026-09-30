// Tests for the export/import archive shape (ADR-0006 Acceptance): the
// bytes carry `schemaVersion` (ADR-0003) and the events array is
// well-ordered (strictly ascending, unique seqs, valid under the shared
// `validateNext` transition rules). A round-trip through JSON followed
// by `InMemoryThreadStore.import` must reproduce the source store
// bit-for-bit — that is what makes the bridge `revkit threads
// export|import` between the local `bun:sqlite` backend and the hosted
// D1 backend safe.
import { describe, expect, test } from "bun:test";
import {
  CURRENT_SCHEMA_VERSION,
  InMemoryThreadStore,
  ThreadStoreAppendError,
  ThreadStoreImportError,
  exportArchive,
  parseArchive,
  reduce,
  type ReviewEventInput,
} from "../src/index.ts";

const anchor = {
  path: "docs/adr/0006-comments-anchoring-event-log.md",
  startLine: 40,
  endLine: 44,
  quote: { exact: "text-quote selector", prefix: "carries a ", suffix: " and the revision" },
  revision: "e".repeat(64),
} as const;

const human = { kind: "gh-user", id: "gerchowl" } as const;
const agent = { kind: "agent", id: "revkit-live" } as const;

function fixedClock(): () => string {
  let cursor = 0;
  return () => {
    const ts = `2026-09-30T12:00:${String(cursor).padStart(2, "0")}Z`;
    cursor += 1;
    return ts;
  };
}

async function seed(): Promise<InMemoryThreadStore> {
  const store = new InMemoryThreadStore({ clock: fixedClock() });
  const create: ReviewEventInput = {
    actor: human,
    kind: "comment.created",
    threadId: "th-1",
    commentId: "c-1",
    anchor,
    body: "why 30 s?",
  };
  const reply: ReviewEventInput = {
    actor: agent,
    kind: "comment.replied",
    threadId: "th-1",
    commentId: "c-2",
    parentId: "c-1",
    body: "raised to 60 s",
  };
  const resolve: ReviewEventInput = {
    actor: human,
    kind: "thread.resolved",
    threadId: "th-1",
  };
  await store.append(create);
  await store.append(reply);
  await store.append(resolve);
  return store;
}

describe("exportArchive → JSON → parseArchive", () => {
  test("carries the current schemaVersion", async () => {
    const archive = await exportArchive(await seed());
    expect(archive.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  test("round-trip through JSON reproduces the same events, in the same order", async () => {
    const original = await exportArchive(await seed());
    const roundTripped = parseArchive(JSON.parse(JSON.stringify(original)));
    expect(roundTripped).toEqual(original);
  });
});

describe("InMemoryThreadStore.import", () => {
  test("replays an archive into a fresh store preserving each event's seq and ts", async () => {
    const source = await seed();
    const archive = await exportArchive(source);
    const bytes = JSON.stringify(archive);

    const target = new InMemoryThreadStore({ clock: fixedClock() });
    await target.import(parseArchive(JSON.parse(bytes)));

    const originalEvents = await source.since(0);
    const importedEvents = await target.since(0);
    // The imported events keep their ORIGINAL seq/ts — not the target
    // clock's — because they are the log, not new work.
    expect(importedEvents).toEqual(originalEvents);
    // And the derived Thread view matches.
    expect([...reduce(importedEvents).entries()]).toEqual(
      [...reduce(originalEvents).entries()],
    );
  });

  test("refuses to import an archive whose first seq is not strictly greater than the store's head", async () => {
    const source = await seed(); // seqs 1..3
    const archive = await exportArchive(source);

    const target = new InMemoryThreadStore({ clock: fixedClock() });
    await target.import(archive);
    // Second import: the archive starts at seq 1, but head is now 3.
    // Refused with a ThreadStoreImportError, not a ThreadStoreAppendError.
    try {
      await target.import(archive);
      throw new Error("second import should have been refused");
    } catch (error) {
      expect(error).toBeInstanceOf(ThreadStoreImportError);
    }
  });

  test("accepts an archive whose seqs have gaps (strict-increasing, gaps allowed, D1-friendly)", async () => {
    // Hand-build a gapped log: seq 1, 5, 10 — the store must accept it
    // and `since` must return them in order.
    const t0 = "2026-09-30T12:00:00Z";
    const t1 = "2026-09-30T12:00:01Z";
    const t2 = "2026-09-30T12:00:02Z";
    const gapped = parseArchive({
      schemaVersion: 1,
      events: [
        {
          seq: 1,
          ts: t0,
          actor: human,
          kind: "comment.created",
          threadId: "th-1",
          commentId: "c-1",
          anchor,
          body: "one",
        },
        {
          seq: 5,
          ts: t1,
          actor: human,
          kind: "comment.replied",
          threadId: "th-1",
          commentId: "c-2",
          parentId: "c-1",
          body: "two",
        },
        {
          seq: 10,
          ts: t2,
          actor: human,
          kind: "thread.resolved",
          threadId: "th-1",
        },
      ],
    });

    const target = new InMemoryThreadStore({ clock: fixedClock() });
    await target.import(gapped);

    const events = await target.since(0);
    expect(events.map((e) => e.seq)).toEqual([1, 5, 10]);
    // And `since(1)` skips the seq-1 event.
    const afterFirst = await target.since(1);
    expect(afterFirst.map((e) => e.seq)).toEqual([5, 10]);
  });
});

describe("parseArchive — rejections", () => {
  test("rejects an archive missing schemaVersion", () => {
    expect(() => parseArchive({ events: [] })).toThrow();
  });

  test("rejects an archive whose events are not in ascending seq order", () => {
    const good1 = {
      seq: 1,
      ts: "2026-09-30T12:00:00Z",
      actor: human,
      kind: "comment.created",
      threadId: "th-1",
      commentId: "c-1",
      anchor,
      body: "one",
    };
    const good2 = {
      seq: 2,
      ts: "2026-09-30T12:00:01Z",
      actor: human,
      kind: "comment.replied",
      threadId: "th-1",
      commentId: "c-2",
      parentId: "c-1",
      body: "two",
    };
    expect(() =>
      parseArchive({ schemaVersion: 1, events: [good2, good1] }),
    ).toThrow(/out of order|seq/);
  });

  test("rejects an archive with a duplicated seq", () => {
    const dup = {
      seq: 1,
      ts: "2026-09-30T12:00:00Z",
      actor: human,
      kind: "comment.created",
      threadId: "th-1",
      commentId: "c-1",
      anchor,
      body: "one",
    };
    expect(() => parseArchive({ schemaVersion: 1, events: [dup, dup] })).toThrow(/duplicate seq/);
  });

  test("rejects an event whose shape is invalid (empty body)", () => {
    const bad = {
      seq: 1,
      ts: "2026-09-30T12:00:00Z",
      actor: human,
      kind: "comment.created",
      threadId: "th-1",
      commentId: "c-1",
      anchor,
      body: "",
    };
    expect(() => parseArchive({ schemaVersion: 1, events: [bad] })).toThrow();
  });

  test("rejects a log whose validateNext fails (reviewer's probe: reply to a missing thread at seq 5)", () => {
    // A shape-clean archive whose FIRST event is a reply — the archive
    // parser must play `validateNext` from an empty state and refuse.
    // `seq: 5` proves the check runs on log invariants, not on the
    // "start at 1" append-side convention.
    const probeLog = {
      schemaVersion: 1,
      events: [
        {
          seq: 5,
          ts: "2026-09-30T12:00:00Z",
          actor: human,
          kind: "comment.replied",
          threadId: "th-does-not-exist",
          commentId: "c-orphan",
          parentId: "c-not-there",
          body: "reply to nothing",
        },
      ],
    };
    expect(() => parseArchive(probeLog)).toThrow(/unknown-thread|log invariant/);
  });
});

describe("import — propagates validateNext rejections", () => {
  test("refuses an archive whose events pass one-by-one but conflict with the target store", async () => {
    // Two archives that are each self-consistent (both create thread
    // 'th-1' at seq 1) but conflict when imported into the SAME store —
    // the second import's create hits `duplicate-thread`, which the
    // shared `validateNext` catches via `ThreadStoreAppendError`.
    const source = await seed(); // seqs 1..3, thread 'th-1'
    const archive = await exportArchive(source);
    const target = new InMemoryThreadStore({ clock: fixedClock() });
    // Seed target with the same thread (append path), then try to import
    // an archive whose seqs are past the head but re-uses 'th-1'.
    // Note: import()'s "seq strictly > head" check refuses the archive
    // first, so we rebuild an archive with a bumped-seq copy to bypass
    // the monotone gate and hit the validator.
    const bumped = parseArchive({
      schemaVersion: 1,
      events: archive.events.map((e, i) => ({ ...e, seq: 100 + i })),
    });
    // Seed the target so 'th-1' already exists there.
    for (const event of archive.events) {
      // Strip the store-assigned fields so `append` re-stamps them for
      // this target; the payload stays the same log-shape.
      const { seq: _seq, ts: _ts, ...input } = event;
      void _seq;
      void _ts;
      await target.append(input as ReviewEventInput);
    }
    try {
      await target.import(bumped);
      throw new Error("import should have been refused");
    } catch (error) {
      expect(error).toBeInstanceOf(ThreadStoreAppendError);
      if (error instanceof ThreadStoreAppendError) {
        expect(error.rejection.kind).toBe("duplicate-thread");
      }
    }
  });
});
