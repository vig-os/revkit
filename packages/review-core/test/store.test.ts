// Tests for InMemoryThreadStore — the append path assigns `seq`/`ts`,
// refuses inconsistent inputs at the boundary (one rule set, shared with
// the archive parser), and `since(seq)` returns only later events in
// order. Uses a canned clock so timestamps are predictable and each test
// asserts against known values rather than against themselves.
import { describe, expect, test } from "bun:test";
import {
  InMemoryThreadStore,
  ThreadStoreAppendError,
  type AppendRejection,
  type Ask,
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

const askSpec: Ask = {
  schemaVersion: 1,
  kind: "choice",
  title: "Storage?",
  options: [
    { id: "d1", label: "D1" },
    { id: "kv", label: "KV" },
  ],
  allowOther: false,
  multi: false,
};

/** Helper: assert an append rejection with a specific `kind`. Fails the
 * test with a message that says what actually happened, so a regression
 * points at the wrong rejection instead of a bare `.toThrow()`. */
async function expectRejection(
  fn: () => Promise<unknown>,
  expectedKind: AppendRejection["kind"],
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ThreadStoreAppendError);
    if (error instanceof ThreadStoreAppendError) {
      expect(error.rejection.kind).toBe(expectedKind);
    }
    return;
  }
  throw new Error(`expected rejection '${expectedKind}' but the call resolved`);
}

describe("append — assignment and validation", () => {
  test("assigns seq starting at 1 and strictly increasing (this impl: contiguous)", async () => {
    const clock = fixedClock();
    const store = new InMemoryThreadStore({ clock: clock.next });
    expect(await store.append(create)).toBe(1);
    expect(await store.append(reply)).toBe(2);
  });

  test("stamps the injected clock's timestamp on the event", async () => {
    const clock = fixedClock();
    const store = new InMemoryThreadStore({ clock: clock.next });
    await store.append(create);
    const [only] = await store.since(0);
    expect(only?.ts).toBe(clock.instants[0]);
  });

  test("refuses an event that fails Zod validation (kind=invalid-shape)", async () => {
    const store = new InMemoryThreadStore({ clock: fixedClock().next });
    // Body is required and non-empty; an empty string trips the schema.
    await expectRejection(() => store.append({ ...create, body: "" } as ReviewEventInput), "invalid-shape");
  });
});

describe("append — log-shape rules (validateNext)", () => {
  test("refuses a second comment.created for the same thread id", async () => {
    const store = new InMemoryThreadStore({ clock: fixedClock().next });
    await store.append(create);
    await expectRejection(() => store.append(create), "duplicate-thread");
  });

  test("refuses comment.replied, thread.resolved and thread.reopened for an unknown thread", async () => {
    const store = new InMemoryThreadStore({ clock: fixedClock().next });
    await expectRejection(() => store.append(reply), "unknown-thread");
    await expectRejection(
      () => store.append({ actor: human, kind: "thread.resolved", threadId: "th-1" }),
      "unknown-thread",
    );
    await expectRejection(
      () => store.append({ actor: human, kind: "thread.reopened", threadId: "th-1" }),
      "unknown-thread",
    );
  });

  test("refuses comment.replied with an unknown parentId in an existing thread", async () => {
    const store = new InMemoryThreadStore({ clock: fixedClock().next });
    await store.append(create);
    await expectRejection(
      () => store.append({ ...reply, parentId: "c-nowhere" }),
      "unknown-parent",
    );
  });

  test("refuses a duplicate commentId within the same thread", async () => {
    const store = new InMemoryThreadStore({ clock: fixedClock().next });
    await store.append(create);
    await expectRejection(
      () => store.append({ ...reply, commentId: "c-1" }),
      "duplicate-comment-id",
    );
  });

  test("refuses a duplicate commentId across two different threads", async () => {
    const store = new InMemoryThreadStore({ clock: fixedClock().next });
    await store.append(create);
    await expectRejection(
      () =>
        store.append({
          ...create,
          threadId: "th-2",
          commentId: "c-1",
        }),
      "duplicate-comment-id",
    );
  });

  test("refuses thread.resolved twice on the same thread (kind=not-open)", async () => {
    const store = new InMemoryThreadStore({ clock: fixedClock().next });
    await store.append(create);
    await store.append({ actor: human, kind: "thread.resolved", threadId: "th-1" });
    await expectRejection(
      () => store.append({ actor: human, kind: "thread.resolved", threadId: "th-1" }),
      "not-open",
    );
  });

  test("refuses thread.reopened on an already-open thread (kind=not-resolved)", async () => {
    const store = new InMemoryThreadStore({ clock: fixedClock().next });
    await store.append(create);
    await expectRejection(
      () => store.append({ actor: human, kind: "thread.reopened", threadId: "th-1" }),
      "not-resolved",
    );
  });

  test("refuses handover naming a commentId that is not in the log", async () => {
    const store = new InMemoryThreadStore({ clock: fixedClock().next });
    await store.append(create);
    await expectRejection(
      () =>
        store.append({
          actor: human,
          kind: "handover",
          commentIds: ["c-nowhere"],
          revision: "f".repeat(64),
        }),
      "unknown-comment",
    );
  });

  test("refuses ask.answered for an unknown askId (kind=unknown-ask)", async () => {
    const store = new InMemoryThreadStore({ clock: fixedClock().next });
    await expectRejection(
      () =>
        store.append({
          actor: human,
          kind: "ask.answered",
          askId: "ask-nowhere",
          answer: { kind: "text", text: "hi" },
        }),
      "unknown-ask",
    );
  });

  test("refuses ask.answered twice for the same ask (kind=duplicate-answer)", async () => {
    const store = new InMemoryThreadStore({ clock: fixedClock().next });
    await store.append({ actor: agent, kind: "ask.created", askId: "ask-1", spec: askSpec });
    await store.append({
      actor: human,
      kind: "ask.answered",
      askId: "ask-1",
      answer: { kind: "choice", value: "d1" },
    });
    await expectRejection(
      () =>
        store.append({
          actor: human,
          kind: "ask.answered",
          askId: "ask-1",
          answer: { kind: "choice", value: "kv" },
        }),
      "duplicate-answer",
    );
  });

  test("refuses ask.created twice for the same ask (kind=duplicate-ask)", async () => {
    const store = new InMemoryThreadStore({ clock: fixedClock().next });
    await store.append({ actor: agent, kind: "ask.created", askId: "ask-1", spec: askSpec });
    await expectRejection(
      () => store.append({ actor: agent, kind: "ask.created", askId: "ask-1", spec: askSpec }),
      "duplicate-ask",
    );
  });

  test("refuses comment.linked for an unknown commentId (kind=unknown-comment)", async () => {
    const store = new InMemoryThreadStore({ clock: fixedClock().next });
    await store.append(create);
    await expectRejection(
      () =>
        store.append({
          actor: agent,
          kind: "comment.linked",
          commentId: "c-nowhere",
          external: { github: { commentId: 1 } },
        }),
      "unknown-comment",
    );
  });

  test("refuses a second comment.linked for the SAME backend on the same comment (duplicate-link)", async () => {
    const store = new InMemoryThreadStore({ clock: fixedClock().next });
    await store.append(create);
    await store.append({
      actor: agent,
      kind: "comment.linked",
      commentId: "c-1",
      external: { github: { commentId: 1 } },
    });
    await expectRejection(
      () =>
        store.append({
          actor: agent,
          kind: "comment.linked",
          commentId: "c-1",
          external: { github: { commentId: 2 } },
        }),
      "duplicate-link",
    );
  });

  test("refuses linking two different local comments to the same external github id (duplicate-external-id)", async () => {
    const store = new InMemoryThreadStore({ clock: fixedClock().next });
    await store.append(create);
    await store.append(reply);
    await store.append({
      actor: agent,
      kind: "comment.linked",
      commentId: "c-1",
      external: { github: { commentId: 42 } },
    });
    await expectRejection(
      () =>
        store.append({
          actor: agent,
          kind: "comment.linked",
          commentId: "c-2",
          external: { github: { commentId: 42 } },
        }),
      "duplicate-external-id",
    );
  });

  test("refuses ask.answered whose answer.kind mismatches the ask's kind (answer-kind-mismatch)", async () => {
    const store = new InMemoryThreadStore({ clock: fixedClock().next });
    // Create a `text` ask, then try to answer with a `scale` answer.
    await store.append({
      actor: agent,
      kind: "ask.created",
      askId: "ask-txt",
      spec: {
        schemaVersion: 1,
        kind: "text",
        title: "one-liner",
        multiline: false,
      },
    });
    await expectRejection(
      () =>
        store.append({
          actor: human,
          kind: "ask.answered",
          askId: "ask-txt",
          answer: { kind: "scale", value: 5 },
        }),
      "answer-kind-mismatch",
    );
    // Sanity: the correctly-kinded answer still works.
    const seq = await store.append({
      actor: human,
      kind: "ask.answered",
      askId: "ask-txt",
      answer: { kind: "text", text: "hi" },
    });
    expect(seq).toBeGreaterThan(0);
  });
});

describe("since — replay ordering", () => {
  test("returns only events with seq strictly greater than the cursor, in seq order", async () => {
    const store = new InMemoryThreadStore({ clock: fixedClock().next });
    await store.append(create); // seq 1
    await store.append(reply); // seq 2
    await store.append({ actor: human, kind: "thread.resolved", threadId: "th-1" }); // seq 3

    expect((await store.since(0)).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect((await store.since(1)).map((e) => e.seq)).toEqual([2, 3]);
    expect(await store.since(3)).toEqual([]);
  });
});

describe("threads — filter and ordering", () => {
  test("threads are ordered by createdSeq (not by ISO string)", async () => {
    // Two threads whose `ts` collides at the same second — createdSeq
    // still tie-breaks deterministically.
    const stuck: () => string = () => "2026-09-30T12:00:00Z";
    const store = new InMemoryThreadStore({ clock: stuck });
    await store.append(create); // seq 1
    await store.append({
      ...create,
      threadId: "th-2",
      commentId: "c-3",
      anchor: { ...anchor, path: "docs/adr/0007-agent-bridge-mcp-channel.md" },
    }); // seq 2
    const ordered = await store.threads();
    expect(ordered.map((t) => t.id)).toEqual(["th-1", "th-2"]);
    expect(ordered[0]?.createdSeq).toBeLessThan(ordered[1]?.createdSeq ?? 0);
  });

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
