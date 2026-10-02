// Unit tests for the rail's unread-derivation (issue #60).
//
// The rail marks a thread as "unread" when it carries agent
// activity (a comment authored by an agent OR a resolve done by
// an agent) newer than the viewer's per-viewer "seen" mark.
//
// PR #62 review lesson: unread MUST NOT be derived from
// `updatedAt`. That field advances on every event, including the
// reviewer's own resolve / reopen and the re-anchor pipeline's
// `thread.reanchored` / `thread.orphaned` events, which would
// re-fire the pill after the reviewer had already acknowledged
// the ack. The derivation compares `latestAgentActivityOf`
// against the seen mark instead.

import { describe, expect, test } from "bun:test";
import {
  excerptOf,
  formatRelativeTime,
  hasAgentActivity,
  isThreadUnread,
  latestAgentActivityOf,
  migrateSeenStorage,
  pruneSeenMap,
  readSeenMap,
  SEEN_STORAGE_KEY_PREFIX,
  seenStorageKeyFor,
  writeSeenMap,
  type IterableStorage,
  type SeenMap,
  type UnreadThread,
} from "../../src/rail/unread.ts";

// Inline shims for the three status filters — the JSX now
// partitions inside a memoized `partition` (see rail.tsx), which
// is compiled with a DOM-dependent Solid render. bun:test runs in
// Node, so we assert on the pure filter shape here and cover the
// full DOM path in the Playwright spec.
function openThreadsFor<T extends { status: string }>(list: readonly T[]): readonly T[] {
  return list.filter((t) => t.status === "open");
}
function resolvedThreadsFor<T extends { status: string }>(list: readonly T[]): readonly T[] {
  return list.filter((t) => t.status === "resolved");
}
function orphanedThreadsFor<T extends { status: string }>(list: readonly T[]): readonly T[] {
  return list.filter((t) => t.status === "orphaned");
}

interface TestComment {
  readonly id: string;
  readonly parentId?: string;
  readonly author: { readonly kind: string; readonly id: string; readonly displayName?: string };
  readonly body: string;
  readonly createdAt: string;
}
interface RailThread extends Omit<UnreadThread, "comments"> {
  readonly anchor: unknown;
  readonly comments: readonly TestComment[];
  readonly resolvedAt?: string;
  readonly resumeStatus?: string;
  readonly orphanReason?: string;
}

const anchor = {
  path: "docs/adr/0006-comments-anchoring-event-log.md",
  startLine: 5,
  endLine: 5,
  quote: { exact: "hello", prefix: "", suffix: "" },
  revision: "a".repeat(64),
} as const;

const humanAuthor = { kind: "gh-user", id: "gerchowl", displayName: "Lars" } as const;
const agentAuthor = { kind: "agent", id: "revkit-live", displayName: "revkit-live" } as const;

function buildThread(patch: Partial<RailThread> & { id: string; updatedAt: string; status: RailThread["status"]; comments: RailThread["comments"] }): RailThread {
  return {
    anchor,
    ...patch,
  } as RailThread;
}

/** The minimal `UnreadThread` the unread pill fires on: one
 * agent-authored comment at `createdAt`, so the thread reads UNREAD
 * unless `seen[id]` is at least that timestamp. */
function agentTouchedThread(id: string, createdAt: string): UnreadThread {
  return {
    id,
    status: "open",
    updatedAt: createdAt,
    comments: [{ author: agentAuthor, createdAt }],
  };
}

describe("rail unread derivation (issue #60)", () => {
  test("a thread with an agent-authored last comment is unread when never seen", () => {
    const thread = buildThread({
      id: "t1",
      status: "open",
      updatedAt: "2026-09-30T12:00:00Z",
      comments: [
        { id: "c1", author: humanAuthor, body: "?", createdAt: "2026-09-30T11:59:00Z" },
        { id: "c2", parentId: "c1", author: agentAuthor, body: "answer", createdAt: "2026-09-30T12:00:00Z" },
      ],
    });
    const seen: SeenMap = {};
    expect(isThreadUnread(thread, seen)).toBe(true);
  });

  test("a thread whose last comment is by the human is NEVER unread (human sees their own reply)", () => {
    const thread = buildThread({
      id: "t2",
      status: "open",
      updatedAt: "2026-09-30T12:00:00Z",
      comments: [
        { id: "c1", author: humanAuthor, body: "self reply", createdAt: "2026-09-30T12:00:00Z" },
      ],
    });
    expect(isThreadUnread(thread, {})).toBe(false);
    expect(hasAgentActivity(thread)).toBe(false);
  });

  test("a resolved-by-agent thread is unread even when the last comment is human-authored", () => {
    // Agent may resolve a thread they didn't reply to (e.g. the
    // human's ask was answered elsewhere). `resolvedBy.kind ===
    // "agent"` still counts as agent activity.
    const thread = buildThread({
      id: "t3",
      status: "resolved",
      updatedAt: "2026-09-30T12:05:00Z",
      resolvedBy: agentAuthor,
      resolvedAt: "2026-09-30T12:05:00Z",
      resumeStatus: "open",
      comments: [
        { id: "c1", author: humanAuthor, body: "?", createdAt: "2026-09-30T11:59:00Z" },
      ],
    });
    expect(isThreadUnread(thread, {})).toBe(true);
  });

  test("a resolved-by-human thread with a human-authored last comment is NOT unread", () => {
    const thread = buildThread({
      id: "t4",
      status: "resolved",
      updatedAt: "2026-09-30T12:05:00Z",
      resolvedBy: humanAuthor,
      resolvedAt: "2026-09-30T12:05:00Z",
      resumeStatus: "open",
      comments: [
        { id: "c1", author: humanAuthor, body: "nvm", createdAt: "2026-09-30T12:04:00Z" },
      ],
    });
    expect(isThreadUnread(thread, {})).toBe(false);
  });

  test("marking seen at the latestAgentActivity clears unread", () => {
    const thread = buildThread({
      id: "t5",
      status: "resolved",
      updatedAt: "2026-09-30T12:00:00Z",
      resolvedBy: agentAuthor,
      resolvedAt: "2026-09-30T12:00:00Z",
      resumeStatus: "open",
      comments: [{ id: "c1", author: agentAuthor, body: "ack", createdAt: "2026-09-30T12:00:00Z" }],
    });
    const seen: SeenMap = { t5: "2026-09-30T12:00:00Z" };
    expect(isThreadUnread(thread, seen)).toBe(false);
  });

  test("a later agent-comment createdAt than the seen mark makes it unread again", () => {
    const thread = buildThread({
      id: "t6",
      status: "resolved",
      updatedAt: "2026-09-30T12:10:00Z",
      resolvedBy: agentAuthor,
      resolvedAt: "2026-09-30T12:10:00Z",
      resumeStatus: "open",
      comments: [{ id: "c1", author: agentAuthor, body: "final", createdAt: "2026-09-30T12:10:00Z" }],
    });
    const seen: SeenMap = { t6: "2026-09-30T12:00:00Z" };
    expect(isThreadUnread(thread, seen)).toBe(true);
  });

  test("PR #62 blocker: reviewer's own resolve does NOT retrigger unread", () => {
    // The reviewer clicked, marked the agent reply seen (seen ≥
    // agent's createdAt). Then the reviewer resolves the thread —
    // which bumps `updatedAt` but does not add any agent activity.
    // The pre-fix implementation compared to `updatedAt` and the
    // pill fired again.
    const thread = buildThread({
      id: "t7",
      status: "resolved",
      updatedAt: "2026-09-30T12:15:00Z", // Bumped by the human's resolve.
      resolvedBy: humanAuthor,
      resolvedAt: "2026-09-30T12:15:00Z",
      resumeStatus: "open",
      comments: [
        { id: "c1", author: humanAuthor, body: "?", createdAt: "2026-09-30T12:00:00Z" },
        { id: "c2", author: agentAuthor, body: "ack", createdAt: "2026-09-30T12:05:00Z" },
      ],
    });
    // Seen at the agent comment's createdAt — the reviewer read it.
    const seen: SeenMap = { t7: "2026-09-30T12:05:00Z" };
    expect(isThreadUnread(thread, seen)).toBe(false);
  });

  test("PR #62 blocker: reviewer's own reopen does NOT retrigger unread", () => {
    // Reopen re-transitions to `open`, bumps `updatedAt`, and the
    // pre-fix `updatedAt` compare would fire the pill again.
    const thread = buildThread({
      id: "t8",
      status: "open",
      updatedAt: "2026-09-30T12:20:00Z", // Bumped by the reopen.
      comments: [
        { id: "c1", author: humanAuthor, body: "?", createdAt: "2026-09-30T12:00:00Z" },
        { id: "c2", author: agentAuthor, body: "ack", createdAt: "2026-09-30T12:05:00Z" },
      ],
    });
    const seen: SeenMap = { t8: "2026-09-30T12:05:00Z" };
    expect(isThreadUnread(thread, seen)).toBe(false);
  });

  test("PR #62 blocker: re-anchor / orphan pipeline event does NOT retrigger unread", () => {
    // The re-anchor pipeline emits `thread.reanchored` /
    // `thread.orphaned`, both of which bump `updatedAt`. Neither
    // is agent activity. The reviewer's ack must survive.
    const thread = buildThread({
      id: "t9",
      status: "orphaned",
      updatedAt: "2026-09-30T12:30:00Z", // Bumped by the orphan event.
      orphanReason: "block deleted",
      comments: [
        { id: "c1", author: humanAuthor, body: "?", createdAt: "2026-09-30T12:00:00Z" },
        { id: "c2", author: agentAuthor, body: "ack", createdAt: "2026-09-30T12:05:00Z" },
      ],
    });
    const seen: SeenMap = { t9: "2026-09-30T12:05:00Z" };
    expect(isThreadUnread(thread, seen)).toBe(false);
  });
});

describe("latestAgentActivityOf (issue #60 amendment)", () => {
  test("returns undefined when no agent has touched the thread", () => {
    const thread = buildThread({
      id: "t",
      status: "open",
      updatedAt: "2026-09-30T12:00:00Z",
      comments: [{ id: "c1", author: humanAuthor, body: "?", createdAt: "2026-09-30T12:00:00Z" }],
    });
    expect(latestAgentActivityOf(thread)).toBeUndefined();
  });

  test("returns the newest agent-comment createdAt when multiple agents replied", () => {
    const thread = buildThread({
      id: "t",
      status: "open",
      updatedAt: "2026-09-30T12:10:00Z",
      comments: [
        { id: "c1", author: agentAuthor, body: "first", createdAt: "2026-09-30T12:05:00Z" },
        { id: "c2", author: humanAuthor, body: "thanks", createdAt: "2026-09-30T12:07:00Z" },
        { id: "c3", author: agentAuthor, body: "second", createdAt: "2026-09-30T12:10:00Z" },
      ],
    });
    expect(latestAgentActivityOf(thread)).toBe("2026-09-30T12:10:00Z");
  });

  test("prefers resolvedAt over agent-comment createdAt when the agent's resolve came later", () => {
    const thread = buildThread({
      id: "t",
      status: "resolved",
      updatedAt: "2026-09-30T13:00:00Z",
      resolvedBy: agentAuthor,
      resolvedAt: "2026-09-30T13:00:00Z",
      resumeStatus: "open",
      comments: [
        { id: "c1", author: agentAuthor, body: "answer", createdAt: "2026-09-30T12:00:00Z" },
      ],
    });
    expect(latestAgentActivityOf(thread)).toBe("2026-09-30T13:00:00Z");
  });

  test("ignores resolvedAt when the resolve was by a human, even if it is later than agent activity", () => {
    const thread = buildThread({
      id: "t",
      status: "resolved",
      updatedAt: "2026-09-30T13:00:00Z",
      resolvedBy: humanAuthor,
      resolvedAt: "2026-09-30T13:00:00Z",
      resumeStatus: "open",
      comments: [
        { id: "c1", author: agentAuthor, body: "answer", createdAt: "2026-09-30T12:00:00Z" },
      ],
    });
    expect(latestAgentActivityOf(thread)).toBe("2026-09-30T12:00:00Z");
  });
});

describe("rail partition helpers (issue #60)", () => {
  const openThread = buildThread({
    id: "open",
    status: "open",
    updatedAt: "2026-09-30T12:00:00Z",
    comments: [{ id: "c1", author: humanAuthor, body: "?", createdAt: "2026-09-30T12:00:00Z" }],
  });
  const resolvedThread = buildThread({
    id: "resolved",
    status: "resolved",
    updatedAt: "2026-09-30T12:05:00Z",
    resolvedBy: agentAuthor,
    resolvedAt: "2026-09-30T12:05:00Z",
    resumeStatus: "open",
    comments: [{ id: "c1", author: agentAuthor, body: "ack", createdAt: "2026-09-30T12:05:00Z" }],
  });
  const orphanThread = buildThread({
    id: "orphan",
    status: "orphaned",
    updatedAt: "2026-09-30T11:00:00Z",
    orphanReason: "block deleted",
    comments: [{ id: "c1", author: humanAuthor, body: "?", createdAt: "2026-09-30T11:00:00Z" }],
  });
  const threads = [openThread, resolvedThread, orphanThread];

  test("openThreadsFor returns only open threads", () => {
    expect(openThreadsFor(threads).map((t) => t.id)).toEqual(["open"]);
  });
  test("resolvedThreadsFor returns only resolved threads (the header count)", () => {
    expect(resolvedThreadsFor(threads).map((t) => t.id)).toEqual(["resolved"]);
  });
  test("orphanedThreadsFor returns only orphaned threads", () => {
    expect(orphanedThreadsFor(threads).map((t) => t.id)).toEqual(["orphan"]);
  });
});

describe("seen-map localStorage helpers (issue #60)", () => {
  test("readSeenMap with a missing key returns an empty map", () => {
    const storage: Pick<Storage, "getItem"> = { getItem: () => null };
    expect(readSeenMap(storage)).toEqual({});
  });
  test("readSeenMap with a non-object payload returns an empty map", () => {
    const storage: Pick<Storage, "getItem"> = { getItem: () => JSON.stringify([1, 2, 3]) };
    expect(readSeenMap(storage)).toEqual({});
  });
  test("readSeenMap discards non-string values (defensive)", () => {
    const storage: Pick<Storage, "getItem"> = {
      getItem: () => JSON.stringify({ t1: 42, t2: "2026-09-30T12:00:00Z" }),
    };
    expect(readSeenMap(storage)).toEqual({ t2: "2026-09-30T12:00:00Z" });
  });
  test("readSeenMap swallows a throwing accessor and falls back to unread-safe empty map", () => {
    const storage = { getItem: (): string => { throw new Error("blocked"); } } as unknown as Storage;
    expect(readSeenMap(storage)).toEqual({});
  });
  test("writeSeenMap sends a JSON payload under the versioned key", () => {
    let saved: [string, string] | undefined;
    const storage: Pick<Storage, "setItem"> = {
      setItem: (k: string, v: string): void => { saved = [k, v]; },
    };
    writeSeenMap({ t1: "2026-09-30T12:00:00Z" }, storage);
    expect(saved?.[0]).toBe(SEEN_STORAGE_KEY_PREFIX);
    expect(saved?.[1]).toBe(JSON.stringify({ t1: "2026-09-30T12:00:00Z" }));
  });
  test("writeSeenMap swallows a throwing storage (never fatal)", () => {
    const storage = {
      setItem: (): void => { throw new Error("quota"); },
    } as unknown as Storage;
    expect(() => writeSeenMap({ t1: "x" }, storage)).not.toThrow();
  });

  test("seenStorageKeyFor keys per-instance so a rebuild does not inherit stale marks", () => {
    // PR #62 review nit: an origin (127.0.0.1:PORT) can be
    // re-bound to a different repo. Keying by the daemon's
    // `instanceId` isolates the bucket per-start.
    expect(seenStorageKeyFor("abc123")).toBe(`${SEEN_STORAGE_KEY_PREFIX}.abc123`);
    expect(seenStorageKeyFor(undefined)).toBe(SEEN_STORAGE_KEY_PREFIX);
    expect(seenStorageKeyFor("")).toBe(SEEN_STORAGE_KEY_PREFIX);
  });

  test("readSeenMap honors a custom key", () => {
    let asked: string | undefined;
    const storage: Pick<Storage, "getItem"> = {
      getItem: (k: string): string | null => {
        asked = k;
        return JSON.stringify({ t1: "2026-09-30T12:00:00Z" });
      },
    };
    const key = seenStorageKeyFor("inst-42");
    const out = readSeenMap(storage, key);
    expect(asked).toBe(key);
    expect(out).toEqual({ t1: "2026-09-30T12:00:00Z" });
  });

  test("writeSeenMap honors a custom key", () => {
    let saved: [string, string] | undefined;
    const storage: Pick<Storage, "setItem"> = {
      setItem: (k: string, v: string): void => { saved = [k, v]; },
    };
    writeSeenMap({ t1: "2026-09-30T12:00:00Z" }, storage, seenStorageKeyFor("inst-42"));
    expect(saved?.[0]).toBe(`${SEEN_STORAGE_KEY_PREFIX}.inst-42`);
  });
});

/** Minimal in-memory storage that satisfies `IterableStorage`. */
function inMemoryStorage(seed: Record<string, string> = {}): IterableStorage & {
  readonly snapshot: () => Record<string, string>;
} {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    get length(): number {
      return map.size;
    },
    key(index: number): string | null {
      return Array.from(map.keys())[index] ?? null;
    },
    getItem(k: string): string | null {
      return map.get(k) ?? null;
    },
    setItem(k: string, v: string): void {
      map.set(k, v);
    },
    removeItem(k: string): void {
      map.delete(k);
    },
    snapshot(): Record<string, string> {
      return Object.fromEntries(map);
    },
  };
}

describe("migrateSeenStorage (issue #60 round-3)", () => {
  test("moves the bare-key bucket under the target key on first repoId arrival", () => {
    // The reviewer marked something seen before /-/health
    // responded. That mark landed under the bare key. When
    // repoId arrives, migrate must fold it into the resolved
    // bucket.
    const storage = inMemoryStorage({
      [SEEN_STORAGE_KEY_PREFIX]: JSON.stringify({ t1: "2026-09-30T12:00:00Z" }),
    });
    const target = seenStorageKeyFor("repo-abc");
    migrateSeenStorage(storage, target);
    const snap = storage.snapshot();
    // The bare bucket is gone.
    expect(snap[SEEN_STORAGE_KEY_PREFIX]).toBeUndefined();
    // The mark is under the target key.
    expect(JSON.parse(snap[target]!)).toEqual({ t1: "2026-09-30T12:00:00Z" });
  });

  test("merges two buckets, preferring the newer per-thread timestamp", () => {
    const target = seenStorageKeyFor("repo-abc");
    const storage = inMemoryStorage({
      [SEEN_STORAGE_KEY_PREFIX]: JSON.stringify({ t1: "2026-09-30T12:00:00Z", t2: "2026-09-30T11:00:00Z" }),
      [target]: JSON.stringify({ t1: "2026-09-30T11:00:00Z", t3: "2026-09-30T10:00:00Z" }),
    });
    migrateSeenStorage(storage, target);
    const snap = storage.snapshot();
    // Bare bucket removed; target has the merged, newer-per-key map.
    expect(snap[SEEN_STORAGE_KEY_PREFIX]).toBeUndefined();
    expect(JSON.parse(snap[target]!)).toEqual({
      t1: "2026-09-30T12:00:00Z", // newer from bare
      t2: "2026-09-30T11:00:00Z", // only in bare
      t3: "2026-09-30T10:00:00Z", // only in target
    });
  });

  test("reclaims buckets the LRU index cannot vouch for (orphans from previous repos)", () => {
    // Deliberately re-scoped by issue #63. The round-3 test this
    // replaces seeded two foreign buckets and asserted BOTH were
    // deleted; the mechanism it was protecting against — a growing
    // pile of stale keys on one origin — is now served by the
    // bounded index + LRU (see the `seen-state LRU` block below).
    // The assertions are unchanged because these two keys are NOT in
    // the index: a key nothing vouches for is still reclaimed. The
    // round-3 test's own scenario (a repo whose bucket the index
    // does list) is now asserted to SURVIVE below, which is the
    // behaviour issue #63 changed.
    const target = seenStorageKeyFor("repo-current");
    const storage = inMemoryStorage({
      [seenStorageKeyFor("repo-old-1")]: JSON.stringify({ t: "2026-09-29T12:00:00Z" }),
      [seenStorageKeyFor("repo-old-2")]: JSON.stringify({ t: "2026-09-28T12:00:00Z" }),
      [target]: JSON.stringify({ t: "2026-09-30T12:00:00Z" }),
      "not-a-seen-key": "some other localStorage entry",
    });
    migrateSeenStorage(storage, target);
    const snap = storage.snapshot();
    expect(snap[seenStorageKeyFor("repo-old-1")]).toBeUndefined();
    expect(snap[seenStorageKeyFor("repo-old-2")]).toBeUndefined();
    // Target bucket remains (with the folded-in marks).
    expect(snap[target]).toBeDefined();
    // Unrelated localStorage entries are left alone.
    expect(snap["not-a-seen-key"]).toBe("some other localStorage entry");
  });

  test("no-op when target key is the only bucket present", () => {
    const target = seenStorageKeyFor("repo-only");
    const storage = inMemoryStorage({
      [target]: JSON.stringify({ t1: "2026-09-30T12:00:00Z" }),
    });
    migrateSeenStorage(storage, target);
    // The bucket is untouched; only the index is (re)written.
    expect(JSON.parse(storage.snapshot()[target]!)).toEqual({ t1: "2026-09-30T12:00:00Z" });
  });

  test("undefined storage returns without throwing", () => {
    expect(() => migrateSeenStorage(undefined, seenStorageKeyFor("r"))).not.toThrow();
  });
});

// Issue #63: the round-3 migration deleted EVERY other
// `revkit.rail.seen.v1*` bucket, so with two repos served one after
// the other on the same fixed `--port` (same origin, same
// localStorage), opening repo Y wiped repo X's seen marks. The
// failure direction is fail-safe — the marks read as unread again —
// but it is still a lost ack the reviewer has to redo.
//
// The buckets are now kept in a bounded LRU tracked by an explicit
// index key, and only a key the index cannot vouch for (plus the bare
// pre-`repoId` key) is reclaimed. The literals below pin the
// localStorage key name, which is a wire format between this version
// and the next: a rename that did not migrate would silently reset
// every reviewer's ack state.
const SEEN_INDEX_KEY = "revkit.rail.seen.index.v1";
const LRU_LIMIT = 8;

describe("seen-state LRU across repos on one origin (issue #63)", () => {
  test("opening repo Y leaves repo X's bucket and its marks intact", () => {
    const keyX = seenStorageKeyFor("repo-x");
    const keyY = seenStorageKeyFor("repo-y");
    const storage = inMemoryStorage();
    // Repo X is served first on this origin and the reviewer acks a
    // thread there.
    storage.setItem(keyX, JSON.stringify({ tx: "2026-09-30T12:00:00Z" }));
    migrateSeenStorage(storage, keyX);
    // Repo Y is served next on the SAME fixed --port (same origin,
    // same localStorage) and the reviewer acks a thread there.
    storage.setItem(keyY, JSON.stringify({ ty: "2026-09-30T12:30:00Z" }));
    migrateSeenStorage(storage, keyY);
    const snap = storage.snapshot();
    // X's bucket survives, byte for byte — no marks folded across the
    // repo boundary either.
    expect(JSON.parse(snap[keyX]!)).toEqual({ tx: "2026-09-30T12:00:00Z" });
    expect(JSON.parse(snap[keyY]!)).toEqual({ ty: "2026-09-30T12:30:00Z" });
    // And X still reads as SEEN, which is the whole point.
    const xThread = agentTouchedThread("tx", "2026-09-30T12:00:00Z");
    expect(isThreadUnread(xThread, readSeenMap(storage, keyX))).toBe(false);
  });

  test("the index records LRU order, oldest first, with the target touched last", () => {
    const keyA = seenStorageKeyFor("repo-a");
    const keyB = seenStorageKeyFor("repo-b");
    const storage = inMemoryStorage({
      [keyA]: JSON.stringify({ ta: "2026-09-30T12:00:00Z" }),
      [keyB]: JSON.stringify({ tb: "2026-09-30T12:05:00Z" }),
      [SEEN_INDEX_KEY]: JSON.stringify([keyA, keyB]),
    });
    migrateSeenStorage(storage, keyB);
    expect(JSON.parse(storage.snapshot()[SEEN_INDEX_KEY]!)).toEqual([keyA, keyB]);
    // Re-opening A touches it: A becomes the most recent, B the least.
    migrateSeenStorage(storage, keyA);
    expect(JSON.parse(storage.snapshot()[SEEN_INDEX_KEY]!)).toEqual([keyB, keyA]);
  });

  test("the bound evicts oldest-first past 8 buckets", () => {
    const storage = inMemoryStorage();
    const keys: string[] = [];
    for (let i = 0; i < LRU_LIMIT + 3; i += 1) {
      const key = seenStorageKeyFor(`repo-${i}`);
      keys.push(key);
      storage.setItem(key, JSON.stringify({ [`t${i}`]: "2026-09-30T12:00:00Z" }));
      migrateSeenStorage(storage, key);
    }
    const snap = storage.snapshot();
    const surviving = keys.filter((k) => snap[k] !== undefined);
    // Exactly LRU_LIMIT buckets, the 3 oldest gone.
    expect(surviving).toEqual(keys.slice(3));
    expect(JSON.parse(snap[SEEN_INDEX_KEY]!)).toEqual(keys.slice(3));
  });

  test("an evicted bucket's marks read as unread again, never as read", () => {
    const storage = inMemoryStorage();
    const keys: string[] = [];
    for (let i = 0; i < LRU_LIMIT + 1; i += 1) {
      const key = seenStorageKeyFor(`repo-${i}`);
      keys.push(key);
      storage.setItem(key, JSON.stringify({ [`t${i}`]: "2026-09-30T12:00:00Z" }));
      migrateSeenStorage(storage, key);
    }
    const evicted = keys[0];
    const snapshot = storage.snapshot();
    // The oldest bucket is evicted by the 9th visit.
    expect(snapshot[evicted]).toBeUndefined();
    // No surviving bucket absorbed its marks — eviction must never
    // read as an ack, and must not smuggle one repo's ack into
    // another's bucket either.
    for (const key of keys.slice(1)) {
      expect(readSeenMap(storage, key)["t0"]).toBeUndefined();
    }
    // And the evicted repo's thread is back to unread when the
    // reviewer returns to that repo (empty bucket ⇒ no ack).
    const backAgain = seenStorageKeyFor("repo-0");
    storage.setItem(backAgain, JSON.stringify({}));
    expect(isThreadUnread(agentTouchedThread("t0", "2026-09-30T12:00:00Z"), readSeenMap(storage, backAgain))).toBe(
      true,
    );
  });

  test("a stale orphan bucket missing from the index is reclaimed", () => {
    const target = seenStorageKeyFor("repo-current");
    const orphan = seenStorageKeyFor("repo-orphan");
    const indexed = seenStorageKeyFor("repo-indexed");
    const storage = inMemoryStorage({
      [orphan]: JSON.stringify({ t: "2026-09-29T12:00:00Z" }),
      [indexed]: JSON.stringify({ t: "2026-09-28T12:00:00Z" }),
      [SEEN_INDEX_KEY]: JSON.stringify([indexed]),
    });
    migrateSeenStorage(storage, target);
    const snap = storage.snapshot();
    expect(snap[orphan]).toBeUndefined();
    // The indexed bucket — a live repo's — is untouched.
    expect(JSON.parse(snap[indexed]!)).toEqual({ t: "2026-09-28T12:00:00Z" });
    expect(JSON.parse(snap[SEEN_INDEX_KEY]!)).toEqual([indexed, target]);
  });

  test("an index entry whose bucket is already gone is dropped, not kept as a phantom", () => {
    const target = seenStorageKeyFor("repo-current");
    const phantom = seenStorageKeyFor("repo-deleted");
    const storage = inMemoryStorage({
      [target]: JSON.stringify({ t: "2026-09-30T12:00:00Z" }),
      [SEEN_INDEX_KEY]: JSON.stringify([phantom]),
    });
    migrateSeenStorage(storage, target);
    expect(JSON.parse(storage.snapshot()[SEEN_INDEX_KEY]!)).toEqual([target]);
  });

  test("a malformed index fails safe: marks read as unread, never as read", () => {
    // An index we cannot parse vouches for nothing, so the buckets it
    // named are reclaimed. That is the fail-safe direction — the
    // marks read as unread again. What it must NEVER do is hand a
    // mark this repo never acked into the current bucket, which
    // would read as an ack for the wrong repo.
    const target = seenStorageKeyFor("repo-current");
    const foreign = seenStorageKeyFor("repo-foreign");
    const storage = inMemoryStorage({
      [SEEN_INDEX_KEY]: "{not json at all",
      [foreign]: JSON.stringify({ tf: "2026-09-29T12:00:00Z" }),
      [target]: JSON.stringify({ tc: "2026-09-30T12:00:00Z" }),
    });
    migrateSeenStorage(storage, target);
    const snap = storage.snapshot();
    expect(snap[foreign]).toBeUndefined();
    // The index is replaced with a well-formed one naming only the
    // target, so the next mount starts from a known-good state.
    expect(JSON.parse(snap[SEEN_INDEX_KEY]!)).toEqual([target]);
    // The current repo's own marks are NOT collateral damage.
    expect(JSON.parse(snap[target]!)).toEqual({ tc: "2026-09-30T12:00:00Z" });
    // And the reclaimed thread reads unread.
    expect(
      isThreadUnread(agentTouchedThread("tf", "2026-09-29T12:00:00Z"), readSeenMap(storage, target)),
    ).toBe(true);
  });

  test("index entries that are not bucket keys are dropped (fail-safe)", () => {
    const target = seenStorageKeyFor("repo-current");
    const foreign = seenStorageKeyFor("repo-foreign");
    const storage = inMemoryStorage({
      [SEEN_INDEX_KEY]: JSON.stringify([42, null, "", SEEN_INDEX_KEY, "some-other-app.key", foreign]),
      [foreign]: JSON.stringify({ tf: "2026-09-29T12:00:00Z" }),
      [target]: JSON.stringify({ tc: "2026-09-30T12:00:00Z" }),
    });
    migrateSeenStorage(storage, target);
    const snap = storage.snapshot();
    // Only the one well-formed, live bucket survives.
    expect(JSON.parse(snap[SEEN_INDEX_KEY]!)).toEqual([foreign, target]);
    expect(JSON.parse(snap[foreign]!)).toEqual({ tf: "2026-09-29T12:00:00Z" });
    // The index key did not eat its own bucket or any foreign key.
    expect(snap[SEEN_INDEX_KEY]).toBeDefined();
  });

  test("a non-array index payload is treated as absent", () => {
    const target = seenStorageKeyFor("repo-current");
    const storage = inMemoryStorage({
      [SEEN_INDEX_KEY]: JSON.stringify({ repo: target }),
      [target]: JSON.stringify({ tc: "2026-09-30T12:00:00Z" }),
    });
    migrateSeenStorage(storage, target);
    expect(JSON.parse(storage.snapshot()[SEEN_INDEX_KEY]!)).toEqual([target]);
  });

  test("the bare pre-repoId bucket is reclaimed and folded in, never indexed", () => {
    const keyX = seenStorageKeyFor("repo-x");
    const keyY = seenStorageKeyFor("repo-y");
    const storage = inMemoryStorage({
      [SEEN_STORAGE_KEY_PREFIX]: JSON.stringify({ early: "2026-09-30T12:00:00Z" }),
      [keyX]: JSON.stringify({ tx: "2026-09-30T12:05:00Z" }),
      [SEEN_INDEX_KEY]: JSON.stringify([keyX]),
    });
    migrateSeenStorage(storage, keyY);
    const snap = storage.snapshot();
    // The bare bucket is gone (it only ever served the pre-health
    // window) and its mark moved into the resolved bucket.
    expect(snap[SEEN_STORAGE_KEY_PREFIX]).toBeUndefined();
    expect(JSON.parse(snap[keyY]!)).toEqual({ early: "2026-09-30T12:00:00Z" });
    // It is not an LRU member — only real repoId buckets are.
    expect(JSON.parse(snap[SEEN_INDEX_KEY]!)).toEqual([keyX, keyY]);
  });

  test("a bare target key (repoId unknown) is kept, not indexed", () => {
    // `migrateSeenStorage` is only called once `/-/health` resolved a
    // repoId, but the degenerate shape must not delete the very bucket
    // the rail is reading from.
    const storage = inMemoryStorage({
      [SEEN_STORAGE_KEY_PREFIX]: JSON.stringify({ t: "2026-09-30T12:00:00Z" }),
    });
    migrateSeenStorage(storage, SEEN_STORAGE_KEY_PREFIX);
    const snap = storage.snapshot();
    expect(JSON.parse(snap[SEEN_STORAGE_KEY_PREFIX]!)).toEqual({ t: "2026-09-30T12:00:00Z" });
    expect(JSON.parse(snap[SEEN_INDEX_KEY]!)).toEqual([]);
  });

  test("a throwing accessor never becomes a lost-ack or a crash", () => {
    // Every branch is wrapped: a storage failure leaves the pill to
    // re-fire rather than throwing out of mount().
    const exploding = {
      get length(): number {
        throw new Error("blocked");
      },
      key(): string | null {
        throw new Error("blocked");
      },
      getItem(): string | null {
        throw new Error("blocked");
      },
      setItem(): void {
        throw new Error("quota");
      },
      removeItem(): void {
        throw new Error("blocked");
      },
    } as unknown as IterableStorage;
    expect(() => migrateSeenStorage(exploding, seenStorageKeyFor("r"))).not.toThrow();
  });
});

describe("pruneSeenMap (issue #60 amendment)", () => {
  test("returns the same reference when nothing to drop", () => {
    const seen: SeenMap = { t1: "2026-09-30T12:00:00Z" };
    const out = pruneSeenMap(seen, ["t1"]);
    expect(out).toBe(seen);
  });
  test("drops entries whose thread id is not in the current list", () => {
    const seen: SeenMap = {
      keep: "2026-09-30T12:00:00Z",
      drop: "2026-09-30T11:00:00Z",
    };
    const out = pruneSeenMap(seen, ["keep", "other-new-thread"]);
    expect(out).toEqual({ keep: "2026-09-30T12:00:00Z" });
    expect(out).not.toBe(seen); // new reference on prune
  });
  test("empty ids drops every entry", () => {
    const seen: SeenMap = { t1: "x" };
    const out = pruneSeenMap(seen, []);
    expect(out).toEqual({});
  });
});

describe("rail excerpt / relative time helpers", () => {
  test("excerptOf collapses whitespace and hard-truncates long bodies", () => {
    expect(excerptOf("hello\n   world")).toBe("hello world");
    const long = "x".repeat(200);
    const out = excerptOf(long, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith("…")).toBe(true);
  });

  test("formatRelativeTime returns a stable label for a fixed clock", () => {
    const now = Date.parse("2026-09-30T12:10:00Z");
    // We don't pin the exact string (Intl.RelativeTimeFormat's
    // output shifts between locales); we only need to see it's a
    // non-empty string that mentions "10" or "minute" or a units
    // fallback.
    const label = formatRelativeTime("2026-09-30T12:00:00Z", now);
    expect(label.length).toBeGreaterThan(0);
  });
});
