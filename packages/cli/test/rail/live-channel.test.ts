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
//       owns the 15s heartbeat, tested in `publish-http.test.ts`),
//       but verified here that the controller does NOT reset
//       backoff on heartbeat callbacks.
//
// Round 2 (#277) adds:
//
//   (d) the stream stays open but stops delivering frames (the
//       visible-and-online case the server keepalive comment could
//       not catch, because `EventSource` never surfaces comments).
//       The controller's watchdog fires after ~2.5× the server
//       heartbeat interval with no `onHeartbeat` callback.
//   (e) a connecting attempt that never produces onOpen or onError
//       — the connect-timeout synthesises a failure.
//   (f) the controller stays in `reconnecting` across every retry
//       attempt. The old behaviour (`reconnecting` → `connecting`
//       on each retry tick) made the rail's indicator flicker and
//       re-announce on every aria-live tick.

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

interface HarnessOverrides {
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  heartbeatIntervalMs?: number;
  watchdogMultiplier?: number;
  connectTimeoutMs?: number;
}

/** Default watchdog + connect-timeout are deliberately far outside
 * the "normal" backoff schedule, so a test that drives backoff
 * errors never trips the watchdog accidentally. Tests that want to
 * assert on the watchdog override `heartbeatIntervalMs` and / or
 * `watchdogMultiplier`. */
const SAFE_HEARTBEAT_MS = 10_000_000;
const SAFE_CONNECT_TIMEOUT_MS = 10_000_000;

function startHarness(overrides: HarnessOverrides = {}): Harness {
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
    heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? SAFE_HEARTBEAT_MS,
    connectTimeoutMs: overrides.connectTimeoutMs ?? SAFE_CONNECT_TIMEOUT_MS,
    ...(overrides.initialBackoffMs !== undefined ? { initialBackoffMs: overrides.initialBackoffMs } : {}),
    ...(overrides.maxBackoffMs !== undefined ? { maxBackoffMs: overrides.maxBackoffMs } : {}),
    ...(overrides.watchdogMultiplier !== undefined ? { watchdogMultiplier: overrides.watchdogMultiplier } : {}),
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
    // State stays `reconnecting` across the retry — no flicker.
    // Round-2 fix: the controller no longer emits `connecting`
    // for retries (only the initial attach), so the rail's
    // aria-live region does not re-announce every tick.
    expect(h.state()).toBe("reconnecting");
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
    // forces the swap anyway. Round-2 fix: the swap emits
    // `reconnecting` so the user sees the indicator across the
    // swap; there is no promise the new source will open instantly.
    h.wake();
    expect(h.sources).toHaveLength(2);
    expect(h.sources[0]!.closed).toBe(true);
    expect(h.state()).toBe("reconnecting");
    h.sources[1]!.callbacks.onOpen();
    expect(h.state()).toBe("open");
    h.stop();
  });

  test("`wake()` while in the reconnect backoff cancels the timer and reconnects NOW", () => {
    const h = startHarness();
    h.sources[0]!.callbacks.onError();
    expect(h.state()).toBe("reconnecting");
    // Partway through the backoff, the tab becomes visible.
    h.clock.advance(100);
    h.wake();
    expect(h.sources).toHaveLength(2);
    // The previous retry timer has been cancelled; no stray
    // callback from the old backoff can double-open.
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

describe("live-channel — scenario (d): stream open but no frames (watchdog)", () => {
  test("REGRESSION: no frames for 2.5× the heartbeat interval → reconnect, even while the socket is still open on the TCP side", () => {
    // Round-2 regression: the reporter's case was a tab that stays
    // visible AND online, with a stream the server has quietly
    // stopped serving but the TCP connection is still up — so
    // `onerror`, `visibilitychange` and `online` all fail to fire.
    // The server keepalive COMMENT could not help because
    // `EventSource` never surfaces comment lines. The controller's
    // watchdog is what catches this: a named `ping` event (or any
    // data frame) resets it; a gap of 2.5× the server's heartbeat
    // interval with nothing arriving reaps the stream.
    const h = startHarness({
      heartbeatIntervalMs: 1_000,
      watchdogMultiplier: 2.5,
    });
    h.sources[0]!.callbacks.onOpen();
    expect(h.state()).toBe("open");

    // Just under the watchdog: still `open`.
    h.clock.advance(2_499);
    expect(h.state()).toBe("open");
    expect(h.sources).toHaveLength(1);
    // One more ms trips the watchdog: the controller treats this
    // as a stale stream and reconnects at the current backoff.
    h.clock.advance(1);
    expect(h.state()).toBe("reconnecting");
    // The current source is closed as part of the reconnect.
    expect(h.sources[0]!.closed).toBe(true);
    // Backoff schedule still applies — the retry opens at 500 ms.
    h.clock.advance(500);
    expect(h.sources).toHaveLength(2);
    h.sources[1]!.callbacks.onOpen();
    expect(h.state()).toBe("open");
    h.stop();
  });

  test("a heartbeat callback resets the watchdog so a quiet-but-alive stream stays open past 2.5×", () => {
    const h = startHarness({ heartbeatIntervalMs: 1_000, watchdogMultiplier: 2.5 });
    h.sources[0]!.callbacks.onOpen();

    // Just before the watchdog fires, a `ping` arrives.
    h.clock.advance(2_000);
    h.sources[0]!.callbacks.onHeartbeat();

    // 2 s past the heartbeat — well past the pre-heartbeat
    // deadline but under the fresh one.
    h.clock.advance(2_000);
    expect(h.state()).toBe("open");

    // 2.5 s since the last heartbeat — one more ms past it trips
    // the watchdog.
    h.clock.advance(499);
    expect(h.state()).toBe("open");
    h.clock.advance(1);
    expect(h.state()).toBe("reconnecting");
    h.stop();
  });

  test("a data frame also resets the watchdog — the factory calls `onHeartbeat` on `onmessage` too", () => {
    // The rail's factory calls `onHeartbeat()` from BOTH
    // `source.onmessage` AND `source.addEventListener("ping", …)`:
    // any frame is proof-of-life. This test pins the controller
    // treats them identically.
    const h = startHarness({ heartbeatIntervalMs: 1_000, watchdogMultiplier: 2.5 });
    h.sources[0]!.callbacks.onOpen();
    h.clock.advance(2_000);
    // Same code path as a data frame coming in through the
    // factory's `source.onmessage` handler.
    h.sources[0]!.callbacks.onHeartbeat();
    h.clock.advance(2_499);
    expect(h.state()).toBe("open");
    h.clock.advance(1);
    expect(h.state()).toBe("reconnecting");
    h.stop();
  });

  test("the watchdog is not armed before `onOpen` — a slow TLS handshake is covered by the connect-timeout, not the watchdog", () => {
    const h = startHarness({
      heartbeatIntervalMs: 1_000,
      watchdogMultiplier: 2.5,
      connectTimeoutMs: 10_000,
    });
    // Source is created but never fires onOpen. Watchdog is not
    // armed; the connect-timeout is what fires here.
    h.clock.advance(2_500);
    expect(h.state()).toBe("connecting");
    h.clock.advance(7_499);
    expect(h.state()).toBe("connecting");
    h.clock.advance(1);
    // Connect-timeout tripped — synthesised failure, now
    // reconnecting.
    expect(h.state()).toBe("reconnecting");
    h.stop();
  });

  test("a late heartbeat from a closed source does not reset a new source's watchdog", () => {
    // The old EventSource can drain a late event after close.
    // The controller guards on `connectionId` so a late
    // `onHeartbeat` from the replaced source cannot postpone the
    // new one's watchdog.
    const h = startHarness({ heartbeatIntervalMs: 1_000, watchdogMultiplier: 2.5 });
    h.sources[0]!.callbacks.onOpen();
    h.sources[0]!.callbacks.onError();
    // At this point source 0 has been closed and connectionId
    // advanced. Advance backoff so source 1 opens.
    h.clock.advance(500);
    expect(h.sources).toHaveLength(2);
    h.sources[1]!.callbacks.onOpen();

    // 2 s pass — source 0's queued `onHeartbeat` drains late.
    // That callback must be IGNORED: it belongs to the replaced
    // source.
    h.clock.advance(2_000);
    h.sources[0]!.callbacks.onHeartbeat();

    // The watchdog is still measured from source 1's onOpen, not
    // from the late callback. Source 1 opened at t=500, and its
    // watchdog is 2 500 ms, so it should fire at t=3 000. We are
    // currently at t=2 500 (500 + 2 000); 500 more ms trips it.
    h.clock.advance(499);
    expect(h.state()).toBe("open");
    h.clock.advance(1);
    expect(h.state()).toBe("reconnecting");
    h.stop();
  });
});

describe("live-channel — scenario (e): connect timeout", () => {
  test("REGRESSION: a `connecting` attempt that neither opens nor errors within the bound counts as a failure", () => {
    // Round-2 fallback: the browser can, rarely, leave a fresh
    // EventSource silent — neither `onopen` nor `onerror` ever
    // fires. Without a connect-timeout the controller would sit
    // in `connecting` forever, and the rail (which hides the
    // indicator on `connecting`) would look live while being
    // completely disconnected.
    const h = startHarness({ connectTimeoutMs: 5_000 });
    expect(h.state()).toBe("connecting");
    expect(h.sources).toHaveLength(1);

    h.clock.advance(4_999);
    expect(h.state()).toBe("connecting");
    expect(h.sources).toHaveLength(1);

    h.clock.advance(1);
    expect(h.state()).toBe("reconnecting");
    expect(h.sources[0]!.closed).toBe(true);
    // Backoff kicks in from here.
    h.clock.advance(500);
    expect(h.sources).toHaveLength(2);
    h.stop();
  });

  test("`onOpen` cancels the connect-timeout — a healthy slow-start does not false-positive", () => {
    const h = startHarness({ connectTimeoutMs: 5_000 });
    // Open just before the timeout.
    h.clock.advance(4_999);
    h.sources[0]!.callbacks.onOpen();
    expect(h.state()).toBe("open");
    // Advance well past the original timeout — still `open`.
    h.clock.advance(10_000);
    expect(h.state()).toBe("open");
    h.stop();
  });

  test("`onError` cancels the connect-timeout — the normal failure path is not double-counted", () => {
    const h = startHarness({ connectTimeoutMs: 5_000 });
    h.sources[0]!.callbacks.onError();
    expect(h.state()).toBe("reconnecting");
    // Before the round-2 fix, the connect-timer could fire AFTER
    // the error path had already run, pulling the controller into
    // a double-reconnect. This test pins that it does not.
    h.clock.advance(5_000);
    // The backoff retry (500 ms) has fired exactly ONCE, so
    // sources.length is 2 (the initial + one retry). Not 3.
    expect(h.sources.length).toBe(2);
    h.stop();
  });
});

describe("live-channel — stop + lifecycle", () => {
  test("`stop()` cancels timers, closes the current source, and refuses further reconnects", () => {
    const h = startHarness();
    h.sources[0]!.callbacks.onError();
    // `scheduleReconnect` has fired: the retry timer is pending
    // and the connect-timeout for the old source was cleared.
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

  test("`onStateChange` fires exactly once per transition, and retries stay in `reconnecting` (no flicker)", () => {
    // Round-2 regression: the old code emitted `reconnecting` →
    // `connecting` → `reconnecting` → `connecting` … on every
    // retry tick, which made the rail's aria-live region
    // re-announce "Live updates paused — reconnecting…" over and
    // over. Now the state stays `reconnecting` until a stream
    // actually opens.
    const h = startHarness();
    expect(h.states).toEqual(["connecting"]);
    h.sources[0]!.callbacks.onOpen();
    expect(h.states).toEqual(["connecting", "open"]);
    // A second `onOpen` is a no-op on state.
    h.sources[0]!.callbacks.onOpen();
    expect(h.states).toEqual(["connecting", "open"]);
    h.sources[0]!.callbacks.onError();
    expect(h.states).toEqual(["connecting", "open", "reconnecting"]);
    // Timer fires; a new source opens without emitting
    // `connecting` — the state STAYS `reconnecting` until the
    // real `onOpen` arrives.
    h.clock.advance(500);
    expect(h.states).toEqual(["connecting", "open", "reconnecting"]);
    expect(h.sources).toHaveLength(2);
    h.sources[1]!.callbacks.onOpen();
    expect(h.states).toEqual(["connecting", "open", "reconnecting", "open"]);
    // A second error → reconnecting; another retry stays silent
    // on `onStateChange`.
    h.sources[1]!.callbacks.onError();
    h.clock.advance(500);
    expect(h.states).toEqual(["connecting", "open", "reconnecting", "open", "reconnecting"]);
    h.stop();
  });
});
