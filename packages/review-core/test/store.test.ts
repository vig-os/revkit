// Tests for InMemoryThreadStore — the append path assigns `seq`/`ts`,
// refuses inconsistent inputs at the boundary, and `since(seq)` returns
// only later events in order. Uses a canned clock so timestamps are
// predictable and the test asserts against known values rather than
// against themselves.
import { describe, expect, test } from "bun:test";
import {
  InMemoryThreadStore,
  ThreadStoreAppendError,
  type ReviewEventInput,
} from "../src/index.ts";

function fixedClock(): { next: () => string; instants: string[] } {
  const instants: string[] = [];
  let cursor = 0;
  return {
    instants,
    next: () => {
      const ts = `2026-09-30T12:00:${String(cursor).padStart(2, "0")}Z`;
      instants.push(ts);
      cursor += 1;
      return ts;
    },
  };
}

const anchor = {
  path: "docs/adr/0006-comments-anchoring-event-log.md",
  startLine: 40,
  endLine: 44,
  quote: { exact: "text-quote selector", prefix: "carries a ", suffix: " and the revision" },
  revision: "b".repeat(64),
} as const;

const human = { kind: "gh-user", id: "gerchowl" } as const;
const agent = { kind: "agent", id: "revkit-live" } as const;

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

describe("append — assignment and validation", () => {
  test("assigns seq starting at 1 and strictly monotonically increasing", async () => {
    const clock = fixedClock();
    const store = new InMemoryThreadStore({ clock: clock.next });
    const seq1 = await store.append(create);
    const seq2 = await store.append(reply);
    expect(seq1).toBe(1);
    expect(seq2).toBe(2);
  });

  test("stamps the injected clock's timestamp on the event", async () => {
    const clock = fixedClock();
    const store = new InMemoryThreadStore({ clock: clock.next });
    await store.append(create);
    const [only] = await store.since(0);
    expect(only?.ts).toBe(clock.instants[0]);
  });

  test("refuses an event that fails Zod validation, with kind=invalid-shape", async () => {
    const store = new InMemoryThreadStore({ clock: fixedClock().next });
    // Body is required and non-empty; an empty string trips the schema.
    const bad = { ...create, body: "" } as ReviewEventInput;
    try {
      await store.append(bad);
      throw new Error("append should have thrown for invalid shape");
    } catch (error) {
      expect(error).toBeInstanceOf(ThreadStoreAppendError);
      if (error instanceof ThreadStoreAppendError) {
        expect(error.rejection.kind).toBe("invalid-shape");
      }
    }
  });
});

describe("append — log-shape rules", () => {
  test("refuses a second comment.created for the same thread id", async () => {
    const store = new InMemoryThreadStore({ clock: fixedClock().next });
    await store.append(create);
    try {
      await store.append(create);
      throw new Error("append should have refused a duplicate comment.created");
    } catch (error) {
      expect(error).toBeInstanceOf(ThreadStoreAppendError);
      if (error instanceof ThreadStoreAppendError) {
        expect(error.rejection.kind).toBe("duplicate-thread");
      }
    }
  });

  test("refuses comment.replied / thread.resolved / thread.reopened for an unknown thread", async () => {
    const store = new InMemoryThreadStore({ clock: fixedClock().next });
    for (const input of [
      reply,
      { actor: human, kind: "thread.resolved", threadId: "th-1" } satisfies ReviewEventInput,
      { actor: human, kind: "thread.reopened", threadId: "th-1" } satisfies ReviewEventInput,
    ]) {
      try {
        await store.append(input);
        throw new Error(`append should have refused ${input.kind} for an unknown thread`);
      } catch (error) {
        expect(error).toBeInstanceOf(ThreadStoreAppendError);
        if (error instanceof ThreadStoreAppendError) {
          expect(error.rejection.kind).toBe("unknown-thread");
        }
      }
    }
  });
});

describe("since — replay ordering", () => {
  test("returns only events with seq strictly greater than the cursor, in seq order", async () => {
    const store = new InMemoryThreadStore({ clock: fixedClock().next });
    await store.append(create); // seq 1
    await store.append(reply); // seq 2
    await store.append({ actor: human, kind: "thread.resolved", threadId: "th-1" }); // seq 3

    const all = await store.since(0);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);

    const afterFirst = await store.since(1);
    expect(afterFirst.map((e) => e.seq)).toEqual([2, 3]);

    const afterAll = await store.since(3);
    expect(afterAll).toEqual([]);
  });
});

describe("threads — filter", () => {
  test("`status` narrows the lifecycle set; `path` narrows to one file", async () => {
    const store = new InMemoryThreadStore({ clock: fixedClock().next });
    await store.append(create);
    await store.append({ actor: human, kind: "thread.resolved", threadId: "th-1" });
    await store.append({
      ...create,
      threadId: "th-2",
      commentId: "c-3",
      anchor: { ...anchor, path: "docs/adr/0007-agent-bridge-mcp-channel.md" },
    });

    const openOnly = await store.threads({ status: "open" });
    expect(openOnly.map((t) => t.id)).toEqual(["th-2"]);

    const byPath = await store.threads({ path: "docs/adr/0006-comments-anchoring-event-log.md" });
    expect(byPath.map((t) => t.id)).toEqual(["th-1"]);
  });
});
