// Delivery-mode adapter (M2 item 6 review round 3).
//
// The state is fully DERIVED from the event log — the pure
// functions live in `@revkit/review-core`. The daemon-side adapter
// keeps a **materialised incremental cache** of the derived answers
// so `/api/delivery-mode`, `/api/pending`, `/api/delivered`, the
// audit / fan-out gate and the idle-timer reconcile do NOT re-read
// the full log on every request (round-3 nit: the daemon had 15
// `store.since(0)` calls per typical request path — folding new
// events as they land drops that to zero).
//
// Correctness contract: the cache is a materialisation of the
// same pure function the tests hammer. `ingest(event)` folds one
// event into the cache; `rebuildFromLog(events)` throws the cache
// away and rebuilds from the full slice. The daemon calls
// `rebuildFromLog` at boot (paying one full read) and `ingest`
// after every `store.append`.
//
// Persistence: NONE. Mode changes are `delivery.mode_changed`
// events on the durable log; a restart re-derives everything.

import type { DeliveryMode, ReviewEvent } from "@revkit/review-core";
import {
  DEFAULT_DELIVERY_MODE,
  deliveryModeSchema,
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

/** The daemon-facing adapter. Round-3: the adapter maintains an
 * incremental cache of the derived state. */
export interface DeliveryAdapter {
  /** One-shot rebuild from the FULL log. Called by the daemon at
   * boot; a later `ingest(event)` folds one event into the cache. */
  rebuildFromLog(events: readonly ReviewEvent[]): void;
  /** Fold one event into the cache. Called after every
   * `store.append`. */
  ingest(event: ReviewEvent): void;
  /** Current derived mode. */
  currentMode(): DeliveryMode;
  /** Set of comment ids currently pending (handover-arrival, not
   * yet covered by any handover event). */
  pendingCommentIds(): ReadonlySet<string>;
  /** Set of comment ids delivered to the agent so far. */
  deliveredCommentIds(): ReadonlySet<string>;
  /** Status snapshot. Read-through cache; no full-log scan. */
  snapshot(): DeliveryModeStatus;
  /** Whether THIS event should fan out to the AGENT stream. Reads
   * only the cache and the event itself. */
  shouldFanOutToAgent(event: ReviewEvent): boolean;
  /** Re-arm (or cancel) the idle-flush timer. Reads the cache;
   * if `pending` is non-empty AND `idleFlushMs > 0`, arms the
   * timer to fire `onFire`. Idempotent. */
  reconcileIdleTimer(onFire: () => void): void;
  /** Test hook: is the idle timer currently armed? */
  isIdleTimerArmed(): boolean;
  /** Teardown: cancel the timer. */
  stop(): void;
}

/** Open the adapter. Round-3: the adapter maintains an
 * incremental cache — the log is still truth, but the daemon
 * does not re-scan it on every request. */
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

  // ── incremental cache ─────────────────────────────────────
  //
  // We track, per human comment id: arrival mode + delivered flag.
  // Mode is the current delivery mode. `lastMs` and `updatedAtMs`
  // support the status snapshot.
  interface CommentEntry {
    arrivalMode: DeliveryMode;
    delivered: boolean;
  }
  const entries = new Map<string, CommentEntry>();
  let mode: DeliveryMode = DEFAULT_DELIVERY_MODE;
  let lastMs: number | null = null;
  let updatedAtMs: number | undefined;

  const reset = (): void => {
    entries.clear();
    mode = DEFAULT_DELIVERY_MODE;
    lastMs = null;
    updatedAtMs = undefined;
  };

  const ingest: DeliveryAdapter["ingest"] = (event) => {
    switch (event.kind) {
      case "delivery.mode_changed": {
        mode = event.to;
        const parsed = Date.parse(event.ts);
        if (Number.isFinite(parsed)) updatedAtMs = parsed;
        break;
      }
      case "comment.created":
      case "comment.replied": {
        if (event.actor.kind === "agent") break;
        entries.set(event.commentId, {
          arrivalMode: mode,
          // Live arrivals are delivered as soon as they land; the
          // handover(trigger=live) bookkeeping event also comes
          // through this ingest path, so this is consistent even
          // if the log is replayed in either order.
          delivered: mode === "live",
        });
        const parsed = Date.parse(event.ts);
        if (Number.isFinite(parsed)) lastMs = parsed;
        break;
      }
      case "handover": {
        for (const id of event.commentIds) {
          const entry = entries.get(id);
          if (entry !== undefined) entry.delivered = true;
        }
        break;
      }
    }
  };

  const rebuildFromLog: DeliveryAdapter["rebuildFromLog"] = (events) => {
    reset();
    const sorted = [...events].sort((a, b) => a.seq - b.seq);
    for (const event of sorted) ingest(event);
  };

  const currentMode: DeliveryAdapter["currentMode"] = () => mode;

  const pendingSet = (): Set<string> => {
    const out = new Set<string>();
    for (const [id, e] of entries) {
      if (e.arrivalMode === "handover" && !e.delivered) out.add(id);
    }
    return out;
  };
  const deliveredSet = (): Set<string> => {
    const out = new Set<string>();
    for (const [id, e] of entries) if (e.delivered) out.add(id);
    return out;
  };

  const pendingCommentIdsFn: DeliveryAdapter["pendingCommentIds"] = () => pendingSet();
  const deliveredCommentIdsFn: DeliveryAdapter["deliveredCommentIds"] = () => deliveredSet();

  const cancelTimer = (): void => {
    if (idleHandle !== undefined) {
      clearTimer(idleHandle);
      idleHandle = undefined;
    }
  };

  const snapshot: DeliveryAdapter["snapshot"] = () => ({
    mode,
    batched: pendingSet().size,
    lastEventMsAgo: lastMs === null ? null : Math.max(0, clock() - lastMs),
    updatedAt: updatedAtMs === undefined ? new Date(0).toISOString() : new Date(updatedAtMs).toISOString(),
    idleFlushMs,
  });

  const shouldFanOutToAgent: DeliveryAdapter["shouldFanOutToAgent"] = (event) => {
    if (event.kind === "handover") {
      const trigger = event.trigger ?? "handover";
      return trigger !== "live";
    }
    if (event.kind === "delivery.mode_changed") return false;
    if (event.kind === "comment.created" || event.kind === "comment.replied") {
      if (event.actor.kind === "agent") return true;
      const entry = entries.get(event.commentId);
      return entry?.delivered === true;
    }
    return true;
  };

  const reconcileIdleTimer: DeliveryAdapter["reconcileIdleTimer"] = (onFire) => {
    cancelTimer();
    if (idleFlushMs <= 0) return;
    if (mode !== "handover") return;
    if (pendingSet().size === 0) return;
    idleHandle = setTimer(() => {
      idleHandle = undefined;
      onFire();
    }, idleFlushMs);
  };

  const isIdleTimerArmed: DeliveryAdapter["isIdleTimerArmed"] = () => idleHandle !== undefined;

  const stop: DeliveryAdapter["stop"] = () => {
    cancelTimer();
  };

  return {
    rebuildFromLog,
    ingest,
    currentMode,
    pendingCommentIds: pendingCommentIdsFn,
    deliveredCommentIds: deliveredCommentIdsFn,
    snapshot,
    shouldFanOutToAgent,
    reconcileIdleTimer,
    isIdleTimerArmed,
    stop,
  };
}
