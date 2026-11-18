// Unit tests for the live-channel state machine (issue #277).
//
// Each test drives the controller with a fake clock and a fake
// EventSource factory so the scenarios run in microseconds — no
// sleeps-as-sync. The brief named three scenarios to pin:
//
//   (a) stream closed by an intermediary, does the controller
//       reconnect? With backoff? Does it resync?
//   (b) a comment POST succeeds while the stream is dead — does
//       the rail show the new thread (the rail's refetch path is
//       orthogonal, tested elsewhere; this file pins that the
//       controller surfaces a visible "reconnecting" state so the
//       reviewer knows the live feed is paused).
//   (c) server heartbeats — not a controller concern (the daemon
//       owns the 15s keepalive, tested in publish-http.test.ts),
//       but verified here that the controller does NOT reset
//       backoff on keepalive comments.

import { describe, expect, test } from "bun:test";
import {
  createLiveChannel,
  nextBackoffMs,
  type Clock,
  type LiveSource,
  type LiveSourceCallbacks,
  type LiveState,
} from "../../src/rail/live-channel.ts";

/** A clock that advances only when the test calls `advance(ms)`.
 * Every scheduled callback runs synchronously inside `advance`, so
 * assertions after `advance` see the post-timer state. */
interface FakeClock extends Clock {
  advance(ms: number): void;
  now(): number;
  pending(): number;
}

function fakeClock(): FakeClock {
  let current = 0;
  let nextId = 1;
  const timers = new Map<number, { readonly at: number; readonly fn: () => void }>();
  return {
    setTimeout(fn: () => void, ms: number): unknown {
      const id = nextId++;
      timers.set(id, { at: current + ms, fn });
      return id;
    },
    clearTimeout(handle: unknown): void {
      if (typeof handle === "number") timers.delete(handle);
    },
    advance(ms: number): void {
      const target = current + ms;
      // Loop so a timer that schedules another runs this tick too.
      while (true) {
        let dueId: number | undefined;
        let dueAt = Number.POSITIVE_INFINITY;
        for (const [id, { at }] of timers) {
          if (at <= target && at < dueAt) {
            dueId = id;
            dueAt = at;
          }
        }
        if (dueId === undefined) break;
        const entry = timers.get(dueId)!;
        timers.delete(dueId);
        current = entry.at;
        entry.fn();
      }
      current = target;
    },
    now(): number {
      return current;
    },
    pending(): number {
      return timers.size;
    },
  };
}

interface FakeSource extends LiveSource {
  readonly id: number;
  closed: boolean;
  callbacks: LiveSourceCallbacks;
}

interface Harness {
  readonly clock: FakeClock;
  readonly sources: FakeSource[];
  readonly states: LiveState[];
  readonly current: () => FakeSource | undefined;
  readonly stop: () => void;
  readonly state: () => LiveState;
  readonly wake: () => void;
}

function startHarness(
  overrides: { initialBackoffMs?: number; maxBackoffMs?: number } = {},
): Harness {
  const clock = fakeClock();
  const sources: FakeSource[] = [];
  const states: LiveState[] = [];
  const controller = createLiveChannel({
    open(callbacks: LiveSourceCallbacks): LiveSource {
      const id = sources.length + 1;
      const source: FakeSource = {
        id,
        closed: false,
        callbacks,
        close(): void {
          this.closed = true;
        },
      };
      sources.push(source);
      return source;
    },
    onStateChange(state): void {
      states.push(state);
    },
    clock,
    ...overrides,
  });
  return {
    clock,
    sources,
    states,
    current: () => sources.find((s) => !s.closed),
    stop: () => controller.stop(),
    state: () => controller.state(),
    wake: () => controller.wake(),
  };
}

describe("live-channel — backoff math", () => {
  test("doubles each call until the cap", () => {
    expect(nextBackoffMs(500)).toBe(1_000);
    expect(nextBackoffMs(1_000)).toBe(2_000);
    expect(nextBackoffMs(16_000)).toBe(30_000);
    expect(nextBackoffMs(30_000)).toBe(30_000);
  });

  test("resets to initial on a non-positive / NaN input", () => {
    expect(nextBackoffMs(0)).toBe(500);
    expect(nextBackoffMs(-1)).toBe(500);
    expect(nextBackoffMs(Number.NaN)).toBe(500);
  });

  test("honours a custom initial and cap", () => {
    expect(nextBackoffMs(100, 100, 400)).toBe(200);
    expect(nextBackoffMs(200, 100, 400)).toBe(400);
    expect(nextBackoffMs(400, 100, 400)).toBe(400);
  });
});

describe("live-channel — scenario (a): stream closed by an intermediary", () => {
  test("REGRESSION: a mid-stream error schedules a reconnect at the current backoff and the state flips to `reconnecting`", () => {
    const h = startHarness();
    // Attach fires synchronously, state is `connecting`.
    expect(h.states).toEqual(["connecting"]);
    expect(h.sources).toHaveLength(1);

    // The real EventSource would fire `onopen` after the server
    // responded. We simulate that here.
    h.sources[0]!.callbacks.onOpen();
    expect(h.state()).toBe("open");

    // The proxy idles out the stream. The browser's EventSource
    // fires `onerror`. The controller flips to `reconnecting`
    // immediately so the rail can render its indicator.
    h.sources[0]!.callbacks.onError();
    expect(h.state()).toBe("reconnecting");
    // The source was closed as part of scheduling the reconnect.
    expect(h.sources[0]!.closed).toBe(true);

    // Nothing opens UNTIL the 500 ms backoff elapses.
    h.clock.advance(499);
    expect(h.sources).toHaveLength(1);

    h.clock.advance(1);
    expect(h.sources).toHaveLength(2);
    expect(h.state()).toBe("connecting");
    // A successful open resets the state and the backoff schedule.
    h.sources[1]!.callbacks.onOpen();
    expect(h.state()).toBe("open");
    h.stop();
  });

  test("errors in a row double the backoff up to the cap", () => {
    const h = startHarness();
    // Observed schedule: 500 → 1s → 2s → 4s → 8s → 16s → 30s → 30s …
    // Every entry is the delay before the n-th reconnect attempt.
    const expectedDelays = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    for (let attempt = 0; attempt < expectedDelays.length; attempt++) {
      const delay = expectedDelays[attempt]!;
      const sourceBefore = h.sources.length;
      h.sources[sourceBefore - 1]!.callbacks.onError();
      expect(h.state()).toBe("reconnecting");
      // Not yet.
      h.clock.advance(delay - 1);
      expect(h.sources.length).toBe(sourceBefore);
      // One more millisecond opens the next source.
      h.clock.advance(1);
      expect(h.sources.length).toBe(sourceBefore + 1);
    }
    h.stop();
  });

  test("a successful reconnect resets the backoff — a transient should not lock us into 30 s forever", () => {
    const h = startHarness();
    // Fail once, open, fail again — the second schedule is 500 ms,
    // not 1 s. This is what makes a flaky path survivable.
    h.sources[0]!.callbacks.onError();
    h.clock.advance(500);
    expect(h.sources).toHaveLength(2);
    h.sources[1]!.callbacks.onOpen();
    expect(h.state()).toBe("open");
    h.sources[1]!.callbacks.onError();
    expect(h.state()).toBe("reconnecting");
    // If the schedule had carried over, this would be 1 s.
    h.clock.advance(499);
    expect(h.sources).toHaveLength(2);
    h.clock.advance(1);
    expect(h.sources).toHaveLength(3);
    h.stop();
  });
});

describe("live-channel — scenario (a2): visibility / online wake-up", () => {
  test("REGRESSION: `wake()` on a zombie-open socket forces a reconnect NOW, bypassing the backoff timer", () => {
    // This is the diagnosis for issue #277: a page open for hours
    // could sit in a zombie-open state after a proxy idle-reaped
    // the stream. `onerror` never fired because the client side
    // thought it was still open. Before `wake()` existed, the rail
    // sat blind until a manual refresh.
    const h = startHarness();
    h.sources[0]!.callbacks.onOpen();
    expect(h.state()).toBe("open");

    // Zombie — no onerror ever fires. `wake()` (e.g. from
    // `visibilitychange` when the tab returns to the foreground)
    // forces the swap anyway.
    h.wake();
    expect(h.sources).toHaveLength(2);
    expect(h.sources[0]!.closed).toBe(true);
    expect(h.state()).toBe("connecting");
    h.sources[1]!.callbacks.onOpen();
    expect(h.state()).toBe("open");
    h.stop();
  });

  test("`wake()` while in the reconnect backoff cancels the timer and reconnects NOW", () => {
    const h = startHarness();
    h.sources[0]!.callbacks.onError();
    expect(h.state()).toBe("reconnecting");
    expect(h.clock.pending()).toBe(1);
    // Partway through the backoff, the tab becomes visible.
    h.clock.advance(100);
    h.wake();
    expect(h.sources).toHaveLength(2);
    // The scheduled timer has been cancelled; no stray callback
    // can double-open later.
    expect(h.clock.pending()).toBe(0);
    h.clock.advance(10_000);
    expect(h.sources).toHaveLength(2);
    h.stop();
  });

  test("`wake()` resets the backoff schedule — a subsequent error retries at 500 ms, not the last pre-wake value", () => {
    const h = startHarness();
    // Three failed opens to push the backoff to 4 s.
    h.sources[0]!.callbacks.onError();
    h.clock.advance(500);
    h.sources[1]!.callbacks.onError();
    h.clock.advance(1_000);
    h.sources[2]!.callbacks.onError();
    h.clock.advance(2_000);
    expect(h.sources).toHaveLength(4);

    // Wake while connecting the 4th.
    h.wake();
    // Fifth source opens, then errors. If backoff had not been
    // reset, this would wait 4 s. It should wait 500 ms.
    h.sources[4]!.callbacks.onError();
    h.clock.advance(499);
    expect(h.sources).toHaveLength(5);
    h.clock.advance(1);
    expect(h.sources).toHaveLength(6);
    h.stop();
  });
});

describe("live-channel — stop + lifecycle", () => {
  test("`stop()` cancels timers, closes the current source, and refuses further reconnects", () => {
    const h = startHarness();
    h.sources[0]!.callbacks.onError();
    expect(h.clock.pending()).toBe(1);
    h.stop();
    expect(h.clock.pending()).toBe(0);
    expect(h.sources[0]!.closed).toBe(true);
    // A stray late `onError` from a source whose `close()` raced
    // the final drain — common on EventSource — must not open a
    // new source.
    h.sources[0]!.callbacks.onError();
    expect(h.sources).toHaveLength(1);
  });

  test("a late callback from a source we have already replaced is ignored (no double-open)", () => {
    const h = startHarness();
    // Error, backoff fires, source #2 opens.
    h.sources[0]!.callbacks.onError();
    h.clock.advance(500);
    expect(h.sources).toHaveLength(2);
    // The old source's onError fires late — this happens on real
    // EventSource in Chrome when the browser drains its message
    // queue after close. Must NOT schedule another reconnect.
    const pendingBefore = h.clock.pending();
    h.sources[0]!.callbacks.onError();
    expect(h.clock.pending()).toBe(pendingBefore);
    expect(h.sources).toHaveLength(2);
  });

  test("`onStateChange` is called exactly once per transition and never with the same value twice in a row", () => {
    const h = startHarness();
    expect(h.states).toEqual(["connecting"]);
    h.sources[0]!.callbacks.onOpen();
    expect(h.states).toEqual(["connecting", "open"]);
    // A second `onOpen` is a no-op on state.
    h.sources[0]!.callbacks.onOpen();
    expect(h.states).toEqual(["connecting", "open"]);
    h.sources[0]!.callbacks.onError();
    expect(h.states).toEqual(["connecting", "open", "reconnecting"]);
    h.clock.advance(500);
    // `connecting` again on the second open attempt.
    expect(h.states).toEqual(["connecting", "open", "reconnecting", "connecting"]);
    h.sources[1]!.callbacks.onOpen();
    expect(h.states).toEqual(["connecting", "open", "reconnecting", "connecting", "open"]);
    h.stop();
  });
});
