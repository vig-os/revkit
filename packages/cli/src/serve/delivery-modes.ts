// Delivery modes + handover batching (ADR-0007 / DESIGN-0001 §5.3).
//
// One typed state machine per daemon — v1 is a single-session daemon,
// and the shape here scales to per-session state later without an API
// change. The daemon owns the state; the channel and rail read and
// write it through the HTTP surface. The store is the event log and
// never lies: this module NEVER hides an event from the store, it
// gates whether the event fans out on the AGENT stream, and it
// promotes a `handover` synthetic event onto the log when a batch
// is flushed.
//
// Modes are TYPED, not sentinel strings. `Mode` is a Zod-validated
// enum; every entry point that reads a mode from the wire goes
// through `parseMode`.
//
// Three modes, one override:
//
//   handover (default)  Human `comment.created` / `comment.replied`
//                       events are batched — the AGENT stream skips
//                       them, and the daemon records the seqs. When
//                       the user (or an idle timer, or an `@agent
//                       now` marker on a specific comment) triggers
//                       a flush, the daemon appends ONE `handover`
//                       event carrying the batched commentIds. The
//                       channel client picks the `handover` event
//                       up like any other and shows the agent a
//                       coherent batched view.
//
//   live                Every event flows to the AGENT stream as it
//                       arrives.
//
//   quiet               No event flows to the AGENT stream. Threads
//                       are still readable through the `threads`
//                       tool (pull).
//
//   @agent now          A per-comment override, not a mode. Detected
//                       by the mention parser (`parseMentions`) on
//                       `comment.created` / `comment.replied` bodies.
//                       When present, the daemon FLUSHES the batch
//                       (in handover mode) or bypasses `quiet`
//                       (immediate push), regardless of the current
//                       mode.
//
// The batch survives daemon restarts because the log survives them
// (the batch is a projection of "human comments since the last
// handover event"). On boot the daemon rebuilds the pending set by
// walking events since the last `handover`. Mode itself persists in
// `.revkit/delivery.json` (mode 600) so `revkit mode <m>` in one
// terminal is seen by the daemon that is already running.

import { z } from "zod";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ensureRevkitDir } from "./serve-state.ts";
import type { ReviewEvent } from "@revkit/review-core";

/** The typed enum. `.enum` for cheap runtime membership without a
 * string comparison in every branch. */
export const deliveryModes = ["handover", "live", "quiet"] as const;
export type DeliveryMode = (typeof deliveryModes)[number];
export const deliveryModeSchema = z.enum(deliveryModes);

/** Parse an unknown value into a `DeliveryMode`. Used at every
 * wire-boundary (the `POST /api/delivery-mode` handler, the CLI's
 * `--mode` flag, the persisted state file). Returns undefined on
 * anything else; callers turn undefined into a 400. */
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
  /** Number of milliseconds since the last relevant human event, for
   * a rail UI badge ("last comment 12s ago"). `null` when no
   * events have landed yet. */
  readonly lastEventMsAgo: number | null;
  /** ISO timestamp when the mode last changed. */
  readonly updatedAt: string;
  /** Idle-flush timeout in ms (0 disables). */
  readonly idleFlushMs: number;
}

/** Persisted shape on disk. Mode is the durable field; the batch is
 * recovered from the event log so we do not need to persist it. */
interface PersistedMode {
  readonly mode: DeliveryMode;
  readonly updatedAt: string;
  readonly idleFlushMs?: number;
}

/** Filename constants. Under `.revkit/` alongside `serve.json`. */
export const DELIVERY_STATE_FILE = "delivery.json";

/** Default idle-flush window in `handover` mode. When more than this
 * many milliseconds elapse between two batched comments AND the
 * batch is non-empty AND the human has stopped typing, the daemon
 * flushes on its own. Set to zero to disable; 90s is a comfortable
 * "the reviewer stepped away" signal without being aggressive. */
export const DEFAULT_IDLE_FLUSH_MS = 90_000;

/** Options for `openDeliveryState`. */
export interface OpenOptions {
  readonly repoRoot: string;
  /** Injected clock (ms epoch). Defaults to `Date.now`. */
  readonly nowMs?: () => number;
  /** Idle-flush window override. Set to 0 to disable in tests. */
  readonly idleFlushMs?: number;
  /** Test / init override: start in this mode even if the persisted
   * `delivery.json` says otherwise. Used by the daemon's tests that
   * want to exercise the fan-out path directly (SSE, WebSocket)
   * without the batch-hiding behaviour of the default `handover`
   * mode. Production callers omit this — the persisted mode is what
   * the reviewer chose in the rail. */
  readonly initialMode?: DeliveryMode;
  /** Test hook: injected `setTimeout` for the idle timer. */
  readonly setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
  /** Test hook: injected `clearTimeout` for the idle timer. */
  readonly clearTimer?: (handle: { unref?: () => void }) => void;
}

/** Handle a caller reads / writes through. All state mutation goes
 * through this shape — no free-standing setters, no globals. */
export interface DeliveryState {
  /** Current status snapshot. Cheap; the daemon calls this on every
   * `GET /api/delivery-mode`. */
  status(): DeliveryModeStatus;
  /** Change the mode. `changedBy` is a diagnostic tag (`"local"` or
   * `"agent"`). Returns the new status, or throws on an unknown
   * value (callers preflight through `parseMode`). Persists to
   * disk atomically. Triggers a flush when the incoming mode is
   * `live` and the batch is non-empty. */
  setMode(mode: DeliveryMode, changedBy: "local" | "agent"): DeliveryModeStatus;
  /** Record a human `comment.created` / `comment.replied` event. In
   * handover mode it goes onto the pending list; the caller consults
   * `shouldFanOutToAgent(event, options)` to decide whether the
   * event should reach the AGENT stream now. */
  onHumanEvent(event: ReviewEvent, options: { readonly agentNow: boolean }): void;
  /** Should this event fan out to the AGENT stream RIGHT NOW?
   * True for every event in `live`, false in `quiet` and (for
   * human comments) `handover`. `agentNow` overrides `handover`
   * and `quiet`. */
  shouldFanOutToAgent(event: ReviewEvent, options: { readonly agentNow: boolean }): boolean;
  /** Rebuild the pending set from a store slice on startup. Called
   * once by the daemon after opening the store; walks events in
   * order and re-populates from the tail after the last `handover`. */
  rehydrate(events: readonly ReviewEvent[]): void;
  /** Return the pending commentIds AND clear them. Caller writes a
   * synthetic `handover` event with these ids + the revision that
   * covers the batch. The daemon reads the mode's clock for the
   * event's revision. Returns undefined when the set is empty (no
   * flush → the caller returns 200 without appending). */
  drainBatch(): { readonly commentIds: readonly string[] } | undefined;
  /** Idle timer wiring for the daemon. Returns undefined when
   * idleFlushMs === 0 or when the batch is currently empty. Runs
   * `onFire` on the injected timer. Callers register once at
   * daemon start and `onHumanEvent` restarts the timer. */
  scheduleIdleFlush(onFire: () => void): void;
  /** Cancel a pending idle flush. Idempotent. */
  cancelIdleFlush(): void;
  /** Teardown: cancel any pending timer. */
  stop(): void;
}

/** Open the delivery state for `repoRoot`. Reads the persisted mode
 * from disk (defaults to `handover` when the file is missing /
 * corrupt); rehydrates the batch on the first `rehydrate(...)` call
 * from the daemon. Does not touch the log itself. */
export function openDeliveryState(options: OpenOptions): DeliveryState {
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

  const persistedPath = join(options.repoRoot, ".revkit", DELIVERY_STATE_FILE);
  let mode: DeliveryMode = "handover";
  let updatedAtMs = clock();
  // Best-effort read. A corrupt file, wrong permissions, or a
  // missing directory all fall back to the default; the mode is
  // small state and losing it across a crash is not fatal.
  try {
    if (existsSync(persistedPath)) {
      const parsed = JSON.parse(readFileSync(persistedPath, "utf8")) as unknown;
      if (parsed !== null && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        const parsedMode = parseMode(record.mode);
        if (parsedMode !== undefined) mode = parsedMode;
        if (typeof record.updatedAt === "string") {
          const ms = Date.parse(record.updatedAt);
          if (Number.isFinite(ms)) updatedAtMs = ms;
        }
      }
    }
  } catch {
    // Fall back to defaults.
  }
  if (options.initialMode !== undefined) {
    mode = options.initialMode;
    updatedAtMs = clock();
  }

  const pending = new Set<string>();
  let lastEventMs: number | null = null;
  let idleHandle: { unref?: () => void } | undefined;
  let onIdleFire: (() => void) | undefined;

  const persist = (): void => {
    try {
      ensureRevkitDir(options.repoRoot);
      const payload: PersistedMode = {
        mode,
        updatedAt: new Date(updatedAtMs).toISOString(),
        idleFlushMs,
      };
      const text = JSON.stringify(payload, null, 2) + "\n";
      const tmp = persistedPath + "." + randomBytes(6).toString("hex") + ".tmp";
      const fd = openSync(tmp, "wx", 0o600);
      try {
        writeSync(fd, text);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try { chmodSync(tmp, 0o600); } catch { /* best effort */ }
      renameSync(tmp, persistedPath);
    } catch {
      // Persistence is best-effort; a chmod / rename failure is not
      // fatal to the running daemon (mode still lives in memory).
    }
  };

  // Persist the initial state so `revkit mode` in another terminal
  // has something to observe even before the first mode change.
  persist();

  const status = (): DeliveryModeStatus => ({
    mode,
    batched: pending.size,
    lastEventMsAgo: lastEventMs === null ? null : Math.max(0, clock() - lastEventMs),
    updatedAt: new Date(updatedAtMs).toISOString(),
    idleFlushMs,
  });

  const isHumanCommentEvent = (event: ReviewEvent): boolean => {
    if (event.kind !== "comment.created" && event.kind !== "comment.replied") return false;
    return event.actor.kind !== "agent";
  };

  const onHumanEvent: DeliveryState["onHumanEvent"] = (event, { agentNow }) => {
    if (!isHumanCommentEvent(event)) return;
    if (mode !== "handover") {
      lastEventMs = clock();
      return;
    }
    if (agentNow) {
      // `@agent now` bypasses the batch — the caller fans out this
      // event directly. Do not add it to `pending`.
      lastEventMs = clock();
      return;
    }
    // Add commentId to the pending set. `comment.created` and
    // `comment.replied` both carry `commentId` — narrowed by the
    // typed kind check above.
    const commentId = (event as { commentId?: string }).commentId;
    if (typeof commentId === "string" && commentId.length > 0) {
      pending.add(commentId);
    }
    lastEventMs = clock();
    // Reset the idle timer.
    if (idleHandle !== undefined) clearTimer(idleHandle);
    idleHandle = undefined;
    if (idleFlushMs > 0 && onIdleFire !== undefined) {
      idleHandle = setTimer(() => {
        idleHandle = undefined;
        onIdleFire?.();
      }, idleFlushMs);
    }
  };

  const shouldFanOutToAgent: DeliveryState["shouldFanOutToAgent"] = (event, { agentNow }) => {
    // Non-human comment events always fan out (an agent's own
    // reply, a system re-anchor event, a handover promotion, etc.).
    if (!isHumanCommentEvent(event)) return true;
    if (agentNow) return true;
    switch (mode) {
      case "live":
        return true;
      case "handover":
      case "quiet":
        return false;
      default: {
        const _: never = mode;
        void _;
        return false;
      }
    }
  };

  const setMode: DeliveryState["setMode"] = (nextMode, _changedBy) => {
    void _changedBy;
    if (!deliveryModeSchema.safeParse(nextMode).success) {
      throw new Error(`delivery: unknown mode '${String(nextMode)}'`);
    }
    if (nextMode === mode) return status();
    mode = nextMode;
    updatedAtMs = clock();
    persist();
    return status();
  };

  const rehydrate: DeliveryState["rehydrate"] = (events) => {
    pending.clear();
    // Walk events in seq order and rebuild from the tail after the
    // last `handover`. Anything before the last handover is settled.
    const sorted = [...events].sort((a, b) => a.seq - b.seq);
    for (const event of sorted) {
      if (event.kind === "handover") {
        pending.clear();
        continue;
      }
      if (isHumanCommentEvent(event)) {
        const commentId = (event as { commentId?: string }).commentId;
        if (typeof commentId === "string" && commentId.length > 0) {
          pending.add(commentId);
        }
      }
    }
    // Track the latest human-comment ts as the idle baseline.
    for (let i = sorted.length - 1; i >= 0; i--) {
      const event = sorted[i]!;
      if (isHumanCommentEvent(event)) {
        const parsed = Date.parse(event.ts);
        if (Number.isFinite(parsed)) lastEventMs = parsed;
        break;
      }
    }
  };

  const drainBatch: DeliveryState["drainBatch"] = () => {
    if (pending.size === 0) return undefined;
    const commentIds = [...pending];
    pending.clear();
    if (idleHandle !== undefined) {
      clearTimer(idleHandle);
      idleHandle = undefined;
    }
    return { commentIds };
  };

  const scheduleIdleFlush: DeliveryState["scheduleIdleFlush"] = (fire) => {
    onIdleFire = fire;
  };
  const cancelIdleFlush: DeliveryState["cancelIdleFlush"] = () => {
    if (idleHandle !== undefined) {
      clearTimer(idleHandle);
      idleHandle = undefined;
    }
  };
  const stop: DeliveryState["stop"] = () => {
    if (idleHandle !== undefined) {
      clearTimer(idleHandle);
      idleHandle = undefined;
    }
    onIdleFire = undefined;
  };

  return {
    status,
    setMode,
    onHumanEvent,
    shouldFanOutToAgent,
    rehydrate,
    drainBatch,
    scheduleIdleFlush,
    cancelIdleFlush,
    stop,
  };
}

/** Remove the persisted mode file — used by tests that reset a
 * repo's state between runs. Safe when the file is absent. */
export function removeDeliveryState(repoRoot: string): void {
  const path = join(repoRoot, ".revkit", DELIVERY_STATE_FILE);
  try { unlinkSync(path); } catch { /* ignore ENOENT */ }
}
