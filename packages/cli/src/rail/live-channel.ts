// The rail's live-channel controller (issue #277).
//
// **Why this exists.** The rail subscribes to `/events` from a page
// that stays open for hours while a reverse proxy, a sleeping laptop
// or a browser tab-freeze can quietly tear down the underlying TCP
// stream. `EventSource.onerror` fires when the browser notices — but
// a tab-freeze can leave the socket in an ambiguous state, "open" on
// the client side while the server has long since forgotten it.
//
// This module owns the reconnect state machine:
//
//   - Exponential backoff on `onerror` (500 ms → 1 s → 2 s … 30 s cap).
//   - A `wake()` entry point the rail calls from `visibilitychange`
//     (tab came back to the foreground) and `online` (network came
//     back) — forces a reconnect NOW instead of waiting for the next
//     scheduled attempt or for the browser to volunteer an `error`.
//     This is the diagnosis for issue #277: a page open for hours
//     could sit in a zombie-open state after a proxy idle-reaped the
//     stream; the rail never learned about the drop. `wake()` closes
//     this gap at every event that reliably fires on real pages
//     (tab visibility, network transitions).
//   - Three observable `state`s — `connecting`, `open`, `reconnecting`
//     — so the rail can render a visible "live updates paused"
//     indicator (an invisible drop is the bug the reporter filed).
//
// Kept in its own module (rather than inline in `rail.tsx`) so unit
// tests can drive the state machine with fake timers and a fake
// EventSource factory. `rail.tsx` runs side effects on import and
// imports DOM-only Solid helpers; this module has no DOM dependency.

/** The three states a live subscription can be in.
 *
 * `connecting` is the initial attempt and any attempt that has not
 * yet reported `onopen` or `onerror`. The rail doesn't badge this
 * state: on a cold page the EventSource almost always opens within a
 * frame, and a badge that flashes on every page load is noise, not
 * signal.
 *
 * `open` is "a stream is up and delivering frames". The rail hides
 * any indicator it had shown.
 *
 * `reconnecting` is "the previous stream errored; we are waiting out
 * backoff before the next attempt". The rail shows the indicator so
 * the reviewer knows the live feed is paused and that a manual
 * refresh is advisable before trusting the current list. */
export type LiveState = "connecting" | "open" | "reconnecting";

/** The minimal shape a live source must expose to this controller.
 * The rail passes a real `EventSource`; a unit test passes a fake
 * whose `close` is a spy. The three callbacks are wired by the
 * `open` factory, not the controller — the factory hooks them onto
 * the real EventSource's `onopen` / `onmessage` / `onerror`. */
export interface LiveSource {
  close(): void;
}

/** Callbacks the controller wires through the `open` factory. The
 * factory hooks `onOpen` onto the EventSource's `onopen` and
 * `onError` onto `onerror`; `onMessage` goes direct to the rail's
 * parser and does not pass through the controller — the controller
 * cares about connection state, not frame content. Exactly one call
 * of `onOpen` per successful connection; `onError` fires on
 * transport failure (including the server closing the stream). */
export interface LiveSourceCallbacks {
  onOpen(): void;
  onError(): void;
}

/** Clock dependency injection — unit tests pass a fake with
 * controlled `advance()`. Default is `globalThis.setTimeout` /
 * `clearTimeout`. */
export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Options for `createLiveChannel`. */
export interface LiveChannelOptions {
  /** Open a fresh source. Called on first attach, on every reconnect
   * after `onError`, and on `wake()` when the controller is not
   * already open. Must return a `LiveSource` whose `close()` tears
   * down the underlying transport. The three callbacks are the
   * controller's own methods; wire them to the real EventSource. */
  readonly open: (callbacks: LiveSourceCallbacks) => LiveSource;
  /** Called on every state transition — the rail hooks this to a
   * Solid signal that renders the indicator. */
  readonly onStateChange?: (state: LiveState) => void;
  /** First backoff after an error. Defaults to 500 ms — kept small
   * so a fast transient (TCP RST, ephemeral proxy hiccup) recovers
   * within one frame. */
  readonly initialBackoffMs?: number;
  /** Cap on backoff. Defaults to 30 s — a longer wait provides no
   * value on a page whose whole purpose is to see live updates. */
  readonly maxBackoffMs?: number;
  /** Clock. Defaults to `globalThis`. Passed by tests. */
  readonly clock?: Clock;
}

/** Controller handle — the rail keeps this for the lifetime of the
 * subscription and calls `wake()` from visibility / online events,
 * `stop()` on component unmount. */
export interface LiveChannelController {
  /** Current state. Exposed for tests; the rail reads state via
   * `onStateChange` instead. */
  state(): LiveState;
  /** Force a reconnect NOW. No-op when the state is already `open`
   * on the TCP side AND we have no reason to suspect the stream is
   * stale — but we cannot distinguish a live-and-well socket from a
   * zombie-open one, so `wake()` tears the current one down and
   * opens a fresh one every time. The cost of a redundant reconnect
   * (one roundtrip + a re-prime) is negligible compared to the cost
   * of a missed comment. Cancels any pending backoff timer. */
  wake(): void;
  /** Detach: stop the current source, cancel timers, and refuse any
   * further reconnects. Idempotent. */
  stop(): void;
}

const DEFAULT_INITIAL_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

/** Pure next-backoff calculation. Exported so a test can pin the
 * schedule without instantiating the controller. */
export function nextBackoffMs(
  currentMs: number,
  initialMs = DEFAULT_INITIAL_BACKOFF_MS,
  maxMs = DEFAULT_MAX_BACKOFF_MS,
): number {
  if (!Number.isFinite(currentMs) || currentMs <= 0) return initialMs;
  return Math.min(currentMs * 2, maxMs);
}

/** Build a controller. The first `open` call fires synchronously so
 * the subscription is attached before this returns — a caller that
 * immediately calls `wake()` on the handle (e.g. from an initial
 * `visibilitychange` listener registration) will not race. */
export function createLiveChannel(
  options: LiveChannelOptions,
): LiveChannelController {
  const initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const clock: Clock = options.clock ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]),
  };

  // Seeded as undefined so the first `setState("connecting")` fires
  // the callback — a caller that renders a "connecting" placeholder
  // on mount needs to hear about it.
  let currentState: LiveState | undefined;
  let source: LiveSource | undefined;
  let backoffMs = initialBackoffMs;
  let retryTimer: unknown;
  let stopped = false;
  // Monotonic connection id — guards against a stale callback from
  // an already-replaced source firing after `close()` (the browser
  // can drain a final `onerror` after we close an EventSource).
  let connectionId = 0;

  const setState = (next: LiveState): void => {
    if (currentState === next) return;
    currentState = next;
    try {
      options.onStateChange?.(next);
    } catch {
      // A broken rail hook must not take down the subscription.
    }
  };

  const clearTimer = (): void => {
    if (retryTimer !== undefined) {
      clock.clearTimeout(retryTimer);
      retryTimer = undefined;
    }
  };

  const closeCurrent = (): void => {
    if (source !== undefined) {
      try {
        source.close();
      } catch {
        // A source whose close() throws is a bug in the factory, not
        // something we recover from — swallow rather than fail the
        // whole subscription.
      }
      source = undefined;
    }
  };

  const openNow = (): void => {
    if (stopped) return;
    closeCurrent();
    const myConnectionId = ++connectionId;
    source = options.open({
      onOpen: (): void => {
        if (stopped || myConnectionId !== connectionId) return;
        // A successful open resets the backoff schedule — a flaky
        // path should not lock us into the 30 s ceiling after one
        // stable stream.
        backoffMs = initialBackoffMs;
        setState("open");
      },
      onError: (): void => {
        if (stopped || myConnectionId !== connectionId) return;
        // Close the current source BEFORE scheduling — otherwise
        // the browser's own EventSource auto-reconnect runs on top
        // of our schedule, producing two concurrent reconnect
        // loops. Bump `connectionId` so any further late callback
        // from this source is ignored.
        closeCurrent();
        connectionId++;
        // Schedule a reconnect at the current backoff and advance
        // the schedule for the NEXT error. State flips to
        // `reconnecting` so the rail shows its indicator.
        setState("reconnecting");
        const delay = backoffMs;
        backoffMs = nextBackoffMs(backoffMs, initialBackoffMs, maxBackoffMs);
        clearTimer();
        retryTimer = clock.setTimeout(() => {
          retryTimer = undefined;
          if (stopped) return;
          setState("connecting");
          openNow();
        }, delay);
      },
    });
  };

  // First attach is synchronous — an `onStateChange(connecting)` is
  // emitted before this function returns.
  setState("connecting");
  openNow();

  return {
    state(): LiveState {
      // `openNow()` has already run and emitted `connecting`, so
      // `currentState` is always defined by the time a caller can
      // reach into the returned handle.
      return currentState ?? "connecting";
    },
    wake(): void {
      if (stopped) return;
      // Cancel any pending backoff — we are reconnecting NOW, not
      // on the schedule's timetable. A `wake()` from the visibility
      // handler is the strongest signal we can get that the user
      // expects live updates again.
      clearTimer();
      backoffMs = initialBackoffMs;
      setState("connecting");
      openNow();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearTimer();
      closeCurrent();
    },
  };
}
