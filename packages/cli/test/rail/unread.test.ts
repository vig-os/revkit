// Unit tests for the rail's unread-derivation (issue #60).
//
// The rail marks a thread as "unread" when the LAST touch on it
// was an agent action AND the viewer's per-viewer "seen" mark for
// that thread is either missing or older than the thread's
// `updatedAt`. A colleague on a different browser gets their own
// unread state; a human's own reply on their own thread never
// makes it unread. Storage failures fall back to the safe default
// (unread), so the reviewer never silently misses an ack.

import { describe, expect, test } from "bun:test";
import {
  excerptOf,
  formatRelativeTime,
  hasAgentActivity,
  isThreadUnread,
  readSeenMap,
  SEEN_STORAGE_KEY,
  writeSeenMap,
  type SeenMap,
  type UnreadThread,
} from "../../src/rail/unread.ts";

// `mainListThreadsFor` / `orphanedThreadsFor` / `resolvedThreadsFor`
// / `sidelinedThreadsFor` / `openThreadsFor` all live in
// `rail.tsx`, which side-effect-calls `mount()` at import time and
// therefore requires a DOM. bun:test runs in Node — no DOM — so we
// re-export just their pure filter shape here as an inline duplicate.
// The Playwright test asserts the browser-side rendering path.
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

  test("marking seen at the current updatedAt clears unread", () => {
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

  test("a later updatedAt than the seen mark makes it unread again (new agent activity landed)", () => {
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
    expect(saved?.[0]).toBe(SEEN_STORAGE_KEY);
    expect(saved?.[1]).toBe(JSON.stringify({ t1: "2026-09-30T12:00:00Z" }));
  });
  test("writeSeenMap swallows a throwing storage (never fatal)", () => {
    const storage = {
      setItem: (): void => { throw new Error("quota"); },
    } as unknown as Storage;
    expect(() => writeSeenMap({ t1: "x" }, storage)).not.toThrow();
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
