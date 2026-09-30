// Delivery-mode adapter (M2 item 6 review round 2).
//
// The state is fully DERIVED from the event log — see
// `@revkit/review-core`'s `pendingCommentIds` and
// `currentDeliveryMode`. This module is a thin daemon-side wrapper
// that:
//
//   1. Caches the derived answer for cheap `/api/delivery-mode`
//      reads (rebuilt on every `store.append`, so the cache is
//      always the SAME function of the log).
//   2. Owns the idle-flush timer's callback surface — the actual
//      "should we flush now?" decision comes from the log's
//      pending set.
//
// Persistence: NONE. Mode changes are `delivery.mode_changed`
// events on the durable log; a restart re-derives everything.
// `.revkit/delivery.json` was removed (round-2 blocker fix).

import type { DeliveryMode, ReviewEvent } from "@revkit/review-core";
import {
  DEFAULT_DELIVERY_MODE,
  currentDeliveryMode,
  deliveredCommentIds,
  deliveryModeSchema,
  pendingCommentIds,
} from "@revkit/review-core";

/** Re-exported so daemon imports need only the one module. */
export { DEFAULT_DELIVERY_MODE };
export type { DeliveryMode };

/** The typed enum values (kept as a tuple for CLI --help / tests). */
export const deliveryModes = ["handover", "live", "quiet"] as const satisfies readonly DeliveryMode[];

/** Parse an unknown value into a `DeliveryMode`, or `undefined` if
 * garbage. Used at every wire-boundary (POST /api/delivery-mode,
 * `revkit mode --set`). */
export function parseMode(value: unknown): DeliveryMode | undefined {
  const result = deliveryModeSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

/** Wire shape returned by `GET /api/delivery-mode`. */
export interface DeliveryModeStatus {
  readonly mode: DeliveryMode;
  /** Number of comment events currently batched (0 in `live` /
   * `quiet`; the size of the pending set in `handover`). */
  readonly batched: number;
  /** Milliseconds since the last human comment landed, for the
   * rail's "last comment 12s ago" badge. `null` when the log has
   * no human comment yet. */
  readonly lastEventMsAgo: number | null;
  /** ISO timestamp of the last `delivery.mode_changed` event. */
  readonly updatedAt: string;
  /** Idle-flush window in ms (0 disables). */
  readonly idleFlushMs: number;
}

/** Default idle-flush window in `handover` mode (mode-6-round-2:
 * unchanged from round 1). Set to zero to disable in tests; 90 s
 * matches DESIGN §5.3. */
export const DEFAULT_IDLE_FLUSH_MS = 90_000;

/** Options for `openDeliveryAdapter`. */
export interface OpenOptions {
  /** Injected clock (ms epoch). Defaults to `Date.now`. */
  readonly nowMs?: () => number;
  /** Idle-flush window override. Set to 0 to disable in tests. */
  readonly idleFlushMs?: number;
  /** Test hook: injected `setTimeout` for the idle timer. */
  readonly setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
  /** Test hook: injected `clearTimeout` for the idle timer. */
  readonly clearTimer?: (handle: { unref?: () => void }) => void;
}

/** The daemon-facing adapter. All state accessors read the LOG
 * (via `snapshot(events)`) — the adapter itself only tracks the
 * timer handle. */
export interface DeliveryAdapter {
  /** Derive the current status from a log slice. Cheap; the daemon
   * calls this on every `GET /api/delivery-mode`. */
  snapshot(events: readonly ReviewEvent[]): DeliveryModeStatus;
  /** Whether THIS event should fan out to the AGENT stream, given
   * the log up to and including this event's `seq`. */
  shouldFanOutToAgent(event: ReviewEvent, allEvents: readonly ReviewEvent[]): boolean;
  /** Re-arm (or cancel) the idle-flush timer. Reads the current
   * pending set from the log; if it is non-empty AND
   * `idleFlushMs > 0`, arms the timer to fire `onFire`. Idempotent
   * (a second call reschedules from now). Call this after every
   * `store.append` and after restart. */
  reconcileIdleTimer(events: readonly ReviewEvent[], onFire: () => void): void;
  /** Test hook: is the idle timer currently armed? */
  isIdleTimerArmed(): boolean;
  /** Teardown: cancel the timer. */
  stop(): void;
}

/** Open the adapter. Holds no durable state — the log is truth. */
export function openDeliveryAdapter(options: OpenOptions = {}): DeliveryAdapter {
  const clock = options.nowMs ?? Date.now;
  const idleFlushMs = options.idleFlushMs ?? DEFAULT_IDLE_FLUSH_MS;
  const setTimer = options.setTimer ?? ((fn, ms) => {
    const handle = setTimeout(fn, ms);
    if (typeof (handle as unknown as { unref?: () => void }).unref === "function") {
      (handle as unknown as { unref: () => void }).unref();
    }
    return handle as unknown as { unref?: () => void };
  });
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>));

  let idleHandle: { unref?: () => void } | undefined;

  const cancelTimer = (): void => {
    if (idleHandle !== undefined) {
      clearTimer(idleHandle);
      idleHandle = undefined;
    }
  };

  const snapshot: DeliveryAdapter["snapshot"] = (events) => {
    const mode = currentDeliveryMode(events);
    const pending = pendingCommentIds(events);
    // Last human comment timestamp — the freshest human comment
    // event, whether or not it's still pending. Used only for the
    // rail's "last comment N s ago" badge.
    let lastMs: number | null = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!;
      if (event.kind !== "comment.created" && event.kind !== "comment.replied") continue;
      if (event.actor.kind === "agent") continue;
      const parsed = Date.parse(event.ts);
      if (Number.isFinite(parsed)) {
        lastMs = parsed;
        break;
      }
    }
    // Last mode-change ts.
    let updatedAt: string | undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!;
      if (event.kind === "delivery.mode_changed") {
        updatedAt = event.ts;
        break;
      }
    }
    return {
      mode,
      batched: pending.size,
      lastEventMsAgo: lastMs === null ? null : Math.max(0, clock() - lastMs),
      updatedAt: updatedAt ?? new Date(0).toISOString(),
      idleFlushMs,
    };
  };

  const shouldFanOutToAgent: DeliveryAdapter["shouldFanOutToAgent"] = (event, allEvents) => {
    // Non-comment events fan out unchanged. Handover events with
    // trigger `live` are BOOKKEEPING — the agent already saw the
    // covered `comment.created`, so a live handover frame is
    // suppressed. Every other trigger (`handover`, `agent-now`,
    // `mode-change-flush`) IS the agent's frame and fans out —
    // agent-now informs the agent that a prior BATCH was flushed
    // alongside the marker comment.
    if (event.kind === "handover") {
      const trigger = event.trigger ?? "handover";
      return trigger !== "live";
    }
    // `delivery.mode_changed` is rail-only; the agent gets no
    // notification when the reviewer flips a switch.
    if (event.kind === "delivery.mode_changed") return false;
    // Human comments: fan out iff delivered under the derived
    // rules. Delivered comment ids include live arrivals and
    // handover-covered ids.
    if (event.kind === "comment.created" || event.kind === "comment.replied") {
      if (event.actor.kind === "agent") return true;
      const delivered = deliveredCommentIds(allEvents);
      return delivered.has(event.commentId);
    }
    return true;
  };

  const reconcileIdleTimer: DeliveryAdapter["reconcileIdleTimer"] = (events, onFire) => {
    cancelTimer();
    if (idleFlushMs <= 0) return;
    const mode = currentDeliveryMode(events);
    if (mode !== "handover") return;
    const pending = pendingCommentIds(events);
    if (pending.size === 0) return;
    idleHandle = setTimer(() => {
      idleHandle = undefined;
      onFire();
    }, idleFlushMs);
  };

  const isIdleTimerArmed: DeliveryAdapter["isIdleTimerArmed"] = () => idleHandle !== undefined;

  const stop: DeliveryAdapter["stop"] = () => {
    cancelTimer();
  };

  return { snapshot, shouldFanOutToAgent, reconcileIdleTimer, isIdleTimerArmed, stop };
}
