// Unit tests for the delivery-mode state (M2 item 6).
//
// Cover: default mode, mode switch, batching under handover, live /
// quiet fan-out predicates, `@agent now` bypass, idle-flush timer,
// rehydration from a log slice, persistence.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewEvent } from "@revkit/review-core";
import {
  DEFAULT_IDLE_FLUSH_MS,
  deliveryModes,
  openDeliveryState,
  parseMode,
} from "../../src/serve/delivery-modes.ts";

function fixtureEvent(overrides: Partial<ReviewEvent> & { kind: ReviewEvent["kind"] }): ReviewEvent {
  // A generic event assembled with sensible defaults; individual
  // tests override the fields that matter.
  const base = {
    seq: 1,
    ts: "2026-09-30T00:00:00.000Z",
    actor: { kind: "local", id: "local-1" },
    kind: "comment.created",
    threadId: "t-1",
    commentId: "c-1",
    anchor: {
      path: "docs/a.md",
      startLine: 1,
      endLine: 1,
      quote: { exact: "hi", prefix: "", suffix: "" },
      revision: "a".repeat(64),
    },
    body: "hi",
  } as unknown as ReviewEvent;
  return { ...base, ...overrides } as ReviewEvent;
}

describe("delivery-modes state", () => {
  let root: string;
  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  test("defaults to `handover` and persists to a mode-600 file", () => {
    root = mkdtempSync(join(tmpdir(), "revkit-delivery-"));
    const state = openDeliveryState({ repoRoot: root });
    expect(state.status().mode).toBe("handover");
    const stat = statSync(join(root, ".revkit", "delivery.json"));
    expect(stat.mode & 0o777).toBe(0o600);
    const persisted = JSON.parse(readFileSync(join(root, ".revkit", "delivery.json"), "utf8"));
    expect(persisted.mode).toBe("handover");
  });

  test("`initialMode` overrides the persisted default", () => {
    root = mkdtempSync(join(tmpdir(), "revkit-delivery-"));
    const state = openDeliveryState({ repoRoot: root, initialMode: "live" });
    expect(state.status().mode).toBe("live");
  });

  test("under handover, human comment events are batched (not fanned out)", () => {
    root = mkdtempSync(join(tmpdir(), "revkit-delivery-"));
    const state = openDeliveryState({ repoRoot: root });
    const event = fixtureEvent({ kind: "comment.created", commentId: "c-a" });
    expect(state.shouldFanOutToAgent(event, { agentNow: false })).toBe(false);
    state.onHumanEvent(event, { agentNow: false });
    expect(state.status().batched).toBe(1);
  });

  test("under live, every human event fans out", () => {
    root = mkdtempSync(join(tmpdir(), "revkit-delivery-"));
    const state = openDeliveryState({ repoRoot: root, initialMode: "live" });
    const event = fixtureEvent({ kind: "comment.created", commentId: "c-a" });
    expect(state.shouldFanOutToAgent(event, { agentNow: false })).toBe(true);
    state.onHumanEvent(event, { agentNow: false });
    expect(state.status().batched).toBe(0);
  });

  test("under quiet, no human event fans out", () => {
    root = mkdtempSync(join(tmpdir(), "revkit-delivery-"));
    const state = openDeliveryState({ repoRoot: root, initialMode: "quiet" });
    const event = fixtureEvent({ kind: "comment.created", commentId: "c-a" });
    expect(state.shouldFanOutToAgent(event, { agentNow: false })).toBe(false);
    state.onHumanEvent(event, { agentNow: false });
    // Quiet does not accumulate; the batch stays empty because
    // there is no batch under `quiet`, only pull.
    expect(state.status().batched).toBe(0);
  });

  test("agentNow overrides handover and quiet — the event fans out", () => {
    root = mkdtempSync(join(tmpdir(), "revkit-delivery-"));
    for (const initialMode of ["handover", "quiet"] as const) {
      const state = openDeliveryState({ repoRoot: root, initialMode });
      const event = fixtureEvent({ kind: "comment.created", commentId: "c-now" });
      expect(state.shouldFanOutToAgent(event, { agentNow: true })).toBe(true);
      state.onHumanEvent(event, { agentNow: true });
      // The comment bypassed the batch, so nothing is pending.
      expect(state.status().batched).toBe(0);
    }
  });

  test("agent-authored comments always fan out (they are not human comments)", () => {
    root = mkdtempSync(join(tmpdir(), "revkit-delivery-"));
    const state = openDeliveryState({ repoRoot: root, initialMode: "handover" });
    const agentReply = fixtureEvent({
      kind: "comment.replied",
      commentId: "c-agent",
      parentId: "c-a",
      actor: { kind: "agent", id: "agent" },
    } as Partial<ReviewEvent> & { kind: "comment.replied" });
    expect(state.shouldFanOutToAgent(agentReply, { agentNow: false })).toBe(true);
  });

  test("drainBatch returns the pending ids and clears the set", () => {
    root = mkdtempSync(join(tmpdir(), "revkit-delivery-"));
    const state = openDeliveryState({ repoRoot: root });
    state.onHumanEvent(fixtureEvent({ kind: "comment.created", commentId: "c-a" }), { agentNow: false });
    state.onHumanEvent(fixtureEvent({ kind: "comment.replied", commentId: "c-b" } as Partial<ReviewEvent> & { kind: "comment.replied" }), { agentNow: false });
    const drain = state.drainBatch();
    expect([...(drain?.commentIds ?? [])].sort()).toEqual(["c-a", "c-b"]);
    expect(state.status().batched).toBe(0);
    // Second drain: nothing pending → undefined.
    expect(state.drainBatch()).toBeUndefined();
  });

  test("setMode persists and updates timestamp", async () => {
    root = mkdtempSync(join(tmpdir(), "revkit-delivery-"));
    let now = 1_000;
    const state = openDeliveryState({ repoRoot: root, nowMs: () => now });
    const before = state.status().updatedAt;
    now = 2_000;
    state.setMode("live", "local");
    const after = state.status();
    expect(after.mode).toBe("live");
    expect(after.updatedAt).not.toBe(before);
    // Reopening reads the persisted mode.
    const reopened = openDeliveryState({ repoRoot: root, nowMs: () => now });
    expect(reopened.status().mode).toBe("live");
  });

  test("idle timer fires after idleFlushMs when a batched event lands", async () => {
    root = mkdtempSync(join(tmpdir(), "revkit-delivery-"));
    const scheduled: { fn: () => void; ms: number }[] = [];
    let cleared = 0;
    const state = openDeliveryState({
      repoRoot: root,
      idleFlushMs: 100,
      setTimer: (fn, ms) => {
        scheduled.push({ fn, ms });
        return { unref: () => {} };
      },
      clearTimer: () => {
        cleared++;
      },
    });
    let fired = 0;
    state.scheduleIdleFlush(() => {
      fired++;
    });
    state.onHumanEvent(fixtureEvent({ kind: "comment.created", commentId: "c-a" }), { agentNow: false });
    expect(scheduled[0]?.ms).toBe(100);
    // A rapid follow-up event resets the timer (clears + reschedules).
    state.onHumanEvent(fixtureEvent({ kind: "comment.replied", commentId: "c-b" } as Partial<ReviewEvent> & { kind: "comment.replied" }), { agentNow: false });
    expect(cleared).toBe(1); // the first handle was cleared
    expect(scheduled.length).toBe(2);
    // Firing the second scheduled timer flushes.
    scheduled[1]!.fn();
    expect(fired).toBe(1);
  });

  test("idle timer respects idleFlushMs=0 (disabled)", () => {
    root = mkdtempSync(join(tmpdir(), "revkit-delivery-"));
    let scheduled = false;
    const state = openDeliveryState({
      repoRoot: root,
      idleFlushMs: 0,
      setTimer: () => {
        scheduled = true;
        return { unref: () => {} };
      },
    });
    state.scheduleIdleFlush(() => {});
    state.onHumanEvent(fixtureEvent({ kind: "comment.created", commentId: "c-a" }), { agentNow: false });
    expect(scheduled).toBe(false);
  });

  test("rehydrate walks the log and repopulates the pending set from after the last handover", () => {
    root = mkdtempSync(join(tmpdir(), "revkit-delivery-"));
    const state = openDeliveryState({ repoRoot: root });
    const events: ReviewEvent[] = [
      fixtureEvent({ seq: 1, kind: "comment.created", commentId: "c-1" }),
      fixtureEvent({ seq: 2, kind: "comment.replied", commentId: "c-2" } as Partial<ReviewEvent> & { kind: "comment.replied" }),
      // Handover clears the pending set.
      fixtureEvent({
        seq: 3,
        kind: "handover",
        commentIds: ["c-1", "c-2"],
        revision: "e".repeat(64),
        actor: { kind: "local", id: "local-1" },
      } as Partial<ReviewEvent> & { kind: "handover" }),
      fixtureEvent({ seq: 4, kind: "comment.created", commentId: "c-3" }),
    ];
    state.rehydrate(events);
    // c-1 and c-2 were part of the last handover; c-3 is pending.
    const drain = state.drainBatch();
    expect(drain?.commentIds).toEqual(["c-3"]);
  });

  test("DEFAULT_IDLE_FLUSH_MS is 90 seconds", () => {
    // The default touches every fresh install; assert on the exact
    // constant so a mutation that flips it (10 s / 0) is caught
    // here, not silently in the field.
    expect(DEFAULT_IDLE_FLUSH_MS).toBe(90_000);
  });

  test("parseMode accepts each enum value and rejects garbage", () => {
    for (const mode of deliveryModes) {
      expect(parseMode(mode)).toBe(mode);
    }
    expect(parseMode("nope")).toBeUndefined();
    expect(parseMode(42)).toBeUndefined();
    expect(parseMode(undefined)).toBeUndefined();
  });
});
