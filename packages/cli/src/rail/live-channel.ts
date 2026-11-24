// The rail's live-channel controller (issue #277).
//
// **Why this exists.** The rail subscribes to `/events` from a page
// that stays open for hours while a reverse proxy, a sleeping laptop
// or a browser tab-freeze can quietly tear down the underlying TCP
// stream. `EventSource.onerror` fires when the browser notices — but
// a tab-freeze can leave the socket in an ambiguous state, "open" on
// the client side while the server has long since forgotten it. And
// the reported bug round-2 highlighted a second gap: a tab that stays
// VISIBLE AND ONLINE never fires `visibilitychange` or `online`, so
// `wake()` never gets a reason to run — yet the stream can still have
// silently stopped delivering frames behind a flaky intermediary.
//
// This module owns the reconnect state machine:
//
//   - Exponential backoff on `onerror` (500 ms → 1 s → 2 s … 30 s cap).
//   - A `wake()` entry point the rail calls from `visibilitychange`
//     (tab came back to the foreground), `online` (network came back)
//     AND from the "Refresh now" button on the paused indicator —
//     forces a reconnect NOW instead of waiting for the next scheduled
//     attempt or for the browser to volunteer an `error`.
//   - A client-side **watchdog** driven by heartbeat frames: every
//     named `ping` event the server sends (or any `message` event)
//     resets a timer, and if no frame arrives within
//     `heartbeatIntervalMs * watchdogMultiplier` the stream is
//     treated as stale and a reconnect is forced. This closes the
//     "visible-and-online, bytes stopped flowing" gap that made
//     issue #277 recur after the first round of fixes. EventSource
//     never surfaces SSE comment lines, so a server comment is not
//     an observable sign-of-life — only a named event is.
//   - A **connect timeout**: if an `openNow()` call never produces
//     an `onOpen` or `onError`, the controller synthesises a failure
//     after `connectTimeoutMs`. Covers the (rare) case where the
//     browser silently drops the connection without any callback.
//   - Three observable `state`s — `connecting` (initial attach only),
//     `open`, `reconnecting` (everything else between a failure and
//     the next successful open). The rail renders a visible "live
//     updates paused" indicator on `reconnecting`. State is sticky:
//     once in `reconnecting`, the controller stays there across every
//     retry attempt until a stream actually opens — no badge flicker
//     and no aria-live re-announce on every schedule tick.
//
// Kept in its own module (rather than inline in `rail.tsx`) so unit
// tests can drive the state machine with fake timers and a fake
// EventSource factory. `rail.tsx` runs side effects on import and
// imports DOM-only Solid helpers; this module has no DOM dependency.

/** The three states a live subscription can be in.
 *
 * `connecting` is the INITIAL attach only. Subsequent reconnect
 * attempts never transition back to `connecting`; they stay in
 * `reconnecting` until a stream actually opens. This is deliberate:
 * the rail's indicator is driven off state, and flashing a badge on
 * every retry tick is noise, not signal.
 *
 * `open` is "a stream is up and delivering frames". The rail hides
 * any indicator it had shown.
 *
 * `reconnecting` is "the previous stream errored or stalled; we are
 * reconnecting". The rail shows the indicator so the reviewer knows
 * the live feed is paused and that a manual refresh is advisable
 * before trusting the current list. */
export type LiveState = "connecting" | "open" | "reconnecting";

/** The minimal shape a live source must expose to this controller.
 * The rail passes a real `EventSource`; a unit test passes a fake
 * whose `close` is a spy. The three/four callbacks are wired by the
 * `open` factory, not the controller — the factory hooks them onto
 * the real EventSource's `onopen` / `onmessage` / `onerror` and the
 * named `ping` event listener. */
export interface LiveSource {
  close(): void;
}

/** Callbacks the controller wires through the `open` factory. The
 * factory hooks `onOpen` onto the EventSource's `onopen` and
 * `onError` onto `onerror`; `onHeartbeat` is called from BOTH
 * `source.onmessage` (every data frame) and
 * `source.addEventListener("ping", ...)` (named heartbeat events).
 * The rail's data parser also runs on `onmessage` but goes direct,
 * not through the controller — the controller cares about
 * connection state, not frame content. Exactly one call of `onOpen`
 * per successful connection; `onError` fires on transport failure
 * (including the server closing the stream). */
export interface LiveSourceCallbacks {
  onOpen(): void;
  onError(): void;
  /** Called by the factory for every incoming SSE frame — message or
   * named `ping`. Resets the controller's stale-stream watchdog so a
   * quiet-but-alive stream does not get reaped. */
  onHeartbeat(): void;
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
  /** Server heartbeat interval, in ms. Defaults to 15 s — matches
   * the daemon's `SSE_KEEPALIVE_INTERVAL_MS`. The stale-stream
   * watchdog fires after `heartbeatIntervalMs * watchdogMultiplier`
   * ms without any frame; a client whose daemon runs a faster or
   * slower heartbeat should tune this to match. */
  readonly heartbeatIntervalMs?: number;
  /** Watchdog multiplier. Defaults to 2.5 — generous enough that a
   * single dropped heartbeat does not kill a healthy stream, tight
   * enough that a truly-dead stream reconnects well before the next
   * expected heartbeat would have fired anyway. */
  readonly watchdogMultiplier?: number;
  /** How long to wait for `onOpen` / `onError` on a newly-opened
   * source before synthesising a failure. Defaults to 15 s — long
   * enough that a slow TLS handshake on a cold laptop network
   * finishes, short enough that a page that silently never
   * connected does not sit forever in `connecting` with no visible
   * indicator. A connect-timeout counts as `onError` for the
   * controller's purposes: it closes the source, flips to
   * `reconnecting`, and schedules a retry at the current backoff. */
  readonly connectTimeoutMs?: number;
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
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_WATCHDOG_MULTIPLIER = 2.5;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

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
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const watchdogMultiplier = options.watchdogMultiplier ?? DEFAULT_WATCHDOG_MULTIPLIER;
  const watchdogMs = Math.max(1, Math.round(heartbeatIntervalMs * watchdogMultiplier));
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
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
  let watchdogTimer: unknown;
  let connectTimer: unknown;
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

  const clearRetry = (): void => {
    if (retryTimer !== undefined) {
      clock.clearTimeout(retryTimer);
      retryTimer = undefined;
    }
  };

  const clearWatchdog = (): void => {
    if (watchdogTimer !== undefined) {
      clock.clearTimeout(watchdogTimer);
      watchdogTimer = undefined;
    }
  };

  const clearConnect = (): void => {
    if (connectTimer !== undefined) {
      clock.clearTimeout(connectTimer);
      connectTimer = undefined;
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

  /** Common failure path shared by `onError`, the connect timeout
   * and the watchdog. Advances the backoff schedule and arms the
   * retry timer. State stays `reconnecting` across every retry
   * until an actual open succeeds — no connecting-reconnecting flicker. */
  const scheduleReconnect = (): void => {
    if (stopped) return;
    closeCurrent();
    clearWatchdog();
    clearConnect();
    // Invalidate any further late callbacks from the source we just
    // closed (the browser can drain one more `onerror` after close).
    connectionId++;
    setState("reconnecting");
    const delay = backoffMs;
    backoffMs = nextBackoffMs(backoffMs, initialBackoffMs, maxBackoffMs);
    clearRetry();
    retryTimer = clock.setTimeout(() => {
      retryTimer = undefined;
      if (stopped) return;
      // No setState("connecting") here — stay in `reconnecting`
      // until a stream actually opens. See the module doc.
      openNow();
    }, delay);
  };

  const armWatchdog = (): void => {
    clearWatchdog();
    watchdogTimer = clock.setTimeout(() => {
      watchdogTimer = undefined;
      if (stopped) return;
      // No heartbeat and no data frame for 2.5× the server interval:
      // treat the stream as stale. The underlying TCP may still be up
      // (that is the issue #277 round-2 case); force a reconnect anyway.
      scheduleReconnect();
    }, watchdogMs);
  };

  const armConnectTimeout = (forConnectionId: number): void => {
    clearConnect();
    connectTimer = clock.setTimeout(() => {
      connectTimer = undefined;
      if (stopped || forConnectionId !== connectionId) return;
      // The source never opened and never errored. Treat as failure.
      scheduleReconnect();
    }, connectTimeoutMs);
  };

  const openNow = (): void => {
    if (stopped) return;
    closeCurrent();
    clearWatchdog();
    const myConnectionId = ++connectionId;
    source = options.open({
      onOpen: (): void => {
        if (stopped || myConnectionId !== connectionId) return;
        // A successful open resets the backoff schedule — a flaky
        // path should not lock us into the 30 s ceiling after one
        // stable stream.
        backoffMs = initialBackoffMs;
        clearConnect();
        armWatchdog();
        setState("open");
      },
      onError: (): void => {
        if (stopped || myConnectionId !== connectionId) return;
        scheduleReconnect();
      },
      onHeartbeat: (): void => {
        if (stopped || myConnectionId !== connectionId) return;
        // Any frame — data or named `ping` — is proof the stream is
        // alive. Restart the watchdog.
        armWatchdog();
      },
    });
    armConnectTimeout(myConnectionId);
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
      // handler (or the rail's "Refresh now" button) is the
      // strongest signal we can get that the user expects live
      // updates again.
      clearRetry();
      backoffMs = initialBackoffMs;
      // Show the indicator across the swap. We cannot promise the
      // new source will open instantly, and showing `open` while we
      // tear down the old (possibly zombie) source and wait on the
      // new one would be a lie.
      setState("reconnecting");
      openNow();
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearRetry();
      clearWatchdog();
      clearConnect();
      closeCurrent();
    },
  };
}
