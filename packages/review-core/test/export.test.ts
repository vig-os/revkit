// Tests for the export/import archive shape (ADR-0006 Acceptance): the
// bytes carry `schemaVersion` (ADR-0003) and the events array is
// well-ordered (strictly ascending, unique seqs). A round-trip through
// JSON must reproduce a store bit-for-bit — that is what makes the
// bridge `revkit threads export|import` between the local `bun:sqlite`
// backend and the hosted D1 backend safe.
import { describe, expect, test } from "bun:test";
import {
  CURRENT_SCHEMA_VERSION,
  InMemoryThreadStore,
  eventsFromArchive,
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

  test("re-importing the events reproduces the same Thread state (reduced identity)", async () => {
    // Archive events already carry their own seq/ts (they are the log).
    // Import means "replay through the reducer" — the store's derived
    // Thread view is the shape that must land. Round-trip JSON to prove
    // the byte form is faithful, then compare reductions.
    const source = await seed();
    const archive = await exportArchive(source);
    const bytes = JSON.stringify(archive);
    const importedEvents = eventsFromArchive(parseArchive(JSON.parse(bytes)));
    const sourceThreads = reduce(await source.since(0));
    const importedThreads = reduce(importedEvents);
    expect([...importedThreads.entries()]).toEqual([...sourceThreads.entries()]);
  });
});

describe("parseArchive — rejections", () => {
  test("rejects an archive missing schemaVersion", () => {
    expect(() => parseArchive({ events: [] })).toThrow();
  });

  test("rejects an archive whose events are not in ascending seq order", () => {
    // Build two valid events with seq 1 and 2, then swap.
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
});
