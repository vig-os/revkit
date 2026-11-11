// Issue #46 item 5: channel-server handles `kind: "unanchored"` and
// `status: "orphaned"` without emitting `L:undefined-undefined` or
// including orphaned threads in the catch-up summary.
//
// The reviewer's live example: an imported thread whose source
// content couldn't be fetched arrives with `anchor.kind ===
// "unanchored"` and no `startLine`/`endLine`. Before this PR the
// summary formatter interpolated `L${undefined}-${undefined}` on
// the wire.

import { describe, expect, test } from "bun:test";
import { formatCatchupSummary, formatChannelPayload } from "../../src/mcp/channel-server.ts";

const HUMAN_COMMENT = {
  id: "C1",
  body: "please look",
  author: { kind: "gh-user" as const, id: "alice" },
  createdAt: "2026-09-30T00:00:00.000Z",
};

const AGENT_COMMENT = {
  id: "C2",
  body: "ack",
  author: { kind: "agent" as const, id: "bot" },
  createdAt: "2026-09-30T00:00:01.000Z",
};

describe("formatCatchupSummary — issue #46 item 5", () => {
  test("open line-anchored thread → renders `path:start-end`", () => {
    const payload = formatCatchupSummary([
      {
        id: "T1",
        status: "open",
        anchor: { path: "docs/x.mdx", startLine: 3, endLine: 5 },
        comments: [HUMAN_COMMENT],
      },
    ]);
    expect(payload).toBeDefined();
    expect(payload!.content).toContain("docs/x.mdx:3-5");
    expect(payload!.content).not.toContain("undefined");
  });

  test("open unanchored thread → renders `path (file-level)`, never `Lundefined`", () => {
    const payload = formatCatchupSummary([
      {
        id: "T1",
        status: "open",
        anchor: { kind: "unanchored", path: "docs/x.mdx" },
        comments: [HUMAN_COMMENT],
      },
    ]);
    expect(payload).toBeDefined();
    expect(payload!.content).toContain("docs/x.mdx (file-level)");
    // Never `undefined`, never `L:undefined-undefined`.
    expect(payload!.content).not.toContain("undefined");
  });

  test("orphaned thread is NOT included in the waiting-summary (rail owns it)", () => {
    // An orphaned thread doesn't wait on the agent — the human
    // decides whether to resolve it. The channel skips it so the
    // agent isn't spammed with a catchup for imported orphans.
    const payload = formatCatchupSummary([
      {
        id: "T1",
        status: "orphaned",
        anchor: { kind: "unanchored", path: "docs/x.mdx" },
        comments: [HUMAN_COMMENT],
      },
    ]);
    expect(payload).toBeUndefined();
  });

  test("resolved threads are already skipped (existing behaviour preserved)", () => {
    const payload = formatCatchupSummary([
      {
        id: "T1",
        status: "resolved",
        anchor: { path: "docs/x.mdx", startLine: 1, endLine: 1 },
        comments: [HUMAN_COMMENT],
      },
    ]);
    expect(payload).toBeUndefined();
  });

  test("last-commenter-is-agent threads are skipped (existing behaviour)", () => {
    const payload = formatCatchupSummary([
      {
        id: "T1",
        status: "open",
        anchor: { path: "docs/x.mdx", startLine: 1, endLine: 1 },
        comments: [HUMAN_COMMENT, AGENT_COMMENT],
      },
    ]);
    expect(payload).toBeUndefined();
  });

  test("mixed batch: only the line-anchored open one is summarised, and never `undefined`", () => {
    const payload = formatCatchupSummary([
      {
        id: "T1",
        status: "open",
        anchor: { path: "docs/a.mdx", startLine: 3, endLine: 3 },
        comments: [HUMAN_COMMENT],
      },
      {
        id: "T2",
        status: "orphaned",
        anchor: { kind: "unanchored", path: "docs/b.mdx" },
        comments: [HUMAN_COMMENT],
      },
      {
        id: "T3",
        status: "open",
        anchor: { kind: "unanchored", path: "docs/c.mdx" },
        comments: [HUMAN_COMMENT],
      },
    ]);
    expect(payload).toBeDefined();
    expect(payload!.content).toContain("T1 at docs/a.mdx:3-3");
    // T3 is unanchored but open → file-level.
    expect(payload!.content).toContain("T3 at docs/c.mdx (file-level)");
    // T2 is orphaned → excluded.
    expect(payload!.content).not.toContain("T2");
    expect(payload!.content).not.toContain("undefined");
    // "N review threads waiting" — 2 of 3.
    expect(payload!.content).toMatch(/^2 review threads/);
  });
});

describe("formatChannelPayload — M2 item 9 (story A4)", () => {
  test("doc.published is filtered out of the channel (agent-only event, not a review transition)", () => {
    // The channel is the agent's LIVE inbox for review activity by
    // the human. `doc.published` is emitted BY the agent and would
    // otherwise be a loopback echo. The channel's `relevantKinds`
    // allowlist excludes it. Regression: this test flips red if a
    // future change accidentally lets doc.published leak onto the
    // channel (which would fire spurious notifications after every
    // publish and re-arm the "N threads waiting" summary with
    // events that don't require attention).
    const payload = formatChannelPayload({
      seq: 42,
      ts: "2026-09-30T00:00:00.000Z",
      kind: "doc.published",
      actor: { kind: "agent", id: "revkit-live" },
      path: "docs/adr/0999-test.md",
      revision: "f".repeat(64),
      route: "/adr/0999-test/",
    } as unknown as Parameters<typeof formatChannelPayload>[0]);
    expect(payload).toBeUndefined();
  });
});

describe("formatChannelPayload — issue #46 item 5", () => {
  test("comment.created on an unanchored anchor still formats safely (no `undefined-undefined`)", () => {
    const payload = formatChannelPayload({
      seq: 1,
      ts: "2026-09-30T00:00:00.000Z",
      kind: "comment.created",
      actor: { kind: "gh-user", id: "alice" },
      threadId: "T1",
      commentId: "C1",
      anchor: { kind: "unanchored", path: "docs/x.mdx" },
      body: "imported",
    });
    // Payload is emitted (comment.created is a relevant kind).
    expect(payload).toBeDefined();
    // Never `undefined-undefined`; the `?-?` fallback is the
    // documented shape.
    expect(payload!.content).not.toContain("undefined-undefined");
    expect(payload!.content).not.toContain("Lundefined");
  });
});
