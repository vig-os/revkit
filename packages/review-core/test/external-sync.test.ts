import { describe, expect, test } from "bun:test";
import { reduce, reviewEventSchema, type ReviewEvent } from "../src/index.ts";

const actor = { kind: "local" as const, id: "reviewer", displayName: "Reviewer" };
const anchor = {
  path: "docs/index.md",
  startLine: 1,
  endLine: 1,
  quote: { exact: "hello", prefix: "", suffix: "" },
  revision: "a".repeat(64),
};

function baseEvents(): ReviewEvent[] {
  return [
    reviewEventSchema.parse({
      kind: "comment.created",
      seq: 1,
      ts: "2026-10-01T00:00:00.000Z",
      actor,
      threadId: "thread-1",
      commentId: "comment-1",
      anchor,
      body: "hello",
      external: { provider: "github", threadId: "PRRT_1", resolved: false },
    }),
    reviewEventSchema.parse({
      kind: "thread.resolved",
      seq: 2,
      ts: "2026-10-01T00:00:01.000Z",
      actor,
      threadId: "thread-1",
    }),
  ];
}

describe("thread.external_synced", () => {
  test("records the last observed GitHub resolve state independently from local intent", () => {
    const events = baseEvents();
    events.push(reviewEventSchema.parse({
      kind: "thread.external_synced",
      seq: 3,
      ts: "2026-10-01T00:00:02.000Z",
      actor,
      threadId: "thread-1",
      resolved: true,
      resolvedByLogin: "reviewer",
    }));

    const thread = reduce(events).get("thread-1");
    expect(thread?.status).toBe("resolved");
    expect(thread?.external).toEqual({
      provider: "github",
      threadId: "PRRT_1",
      resolved: true,
      resolvedByLogin: "reviewer",
    });
  });

  test("records a remote reopen without changing the local lifecycle transition", () => {
    const events = baseEvents();
    events.push(reviewEventSchema.parse({
      kind: "thread.reopened",
      seq: 3,
      ts: "2026-10-01T00:00:02.000Z",
      actor,
      threadId: "thread-1",
    }));
    events.push(reviewEventSchema.parse({
      kind: "thread.external_synced",
      seq: 4,
      ts: "2026-10-01T00:00:03.000Z",
      actor,
      threadId: "thread-1",
      resolved: false,
    }));

    const thread = reduce(events).get("thread-1");
    expect(thread?.status).toBe("open");
    expect(thread?.external?.resolved).toBe(false);
    expect(thread?.external?.resolvedByLogin).toBeUndefined();
  });
});
