// Ephemeral presence broadcast (M2 item 6 review round 2).
//
// Presence beacons ("agent is editing docs/x.md:12-14") are NOT
// durable log events. They are the "the agent is doing something
// RIGHT NOW" signal — meaningful only while a subscriber is
// connected. Persisting them was a mistake: a restart would
// resurrect a stale "editing…" beacon that reflects nothing
// actually happening.
//
// This hub keeps the CURRENT state per-actor in memory, expires
// `editing` beacons after `ttlMs`, and broadcasts every state
// change to the daemon's `/events` fan-out — but never through the
// `ThreadStore`. New subscribers get the CURRENT state on connect
// so a page load does not start blank.
//
// Wire shape: `PresenceFrame` — same fields as the old
// `presence` durable event, minus `seq`. Consumers (rail, MCP
// channel) tell it apart from `ReviewEvent` by the absence of
// `seq`.

import type { Author, PresenceState } from "@revkit/review-core";

/** Broadcast frame — the shape delivered over the WS / SSE
 * stream. Compared with a `ReviewEvent`, it carries no `seq`
 * (presence is ephemeral) and its `kind` is fixed. */
export interface PresenceFrame {
  readonly kind: "presence";
  readonly state: PresenceState;
  readonly ts: string;
  readonly actor: Author;
  readonly path?: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

/** Options for `openPresenceHub`. `ttlMs` = 0 disables auto-idle.
 * `now` and the timer hooks are test-swappable. */
export interface OpenPresenceOptions {
  readonly ttlMs?: number;
  readonly now?: () => Date;
  readonly setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
  readonly clearTimer?: (handle: { unref?: () => void }) => void;
  readonly onBroadcast: (frame: PresenceFrame) => void;
}

/** The presence hub. */
export interface PresenceHub {
  /** Record an `editing` beacon and broadcast it. Refreshes the
   * per-actor TTL timer. */
  editing(actor: Author, location: { readonly path?: string; readonly startLine?: number; readonly endLine?: number }): PresenceFrame;
  /** Record an `idle` beacon and broadcast it. Cancels the TTL. */
  idle(actor: Author, location?: { readonly path?: string }): PresenceFrame;
  /** Current live `editing` states, one per actor. Used to prime
   * a new subscriber on connect so a fresh page-load sees the same
   * "agent is editing …" chip an existing tab does. */
  currentStates(): readonly PresenceFrame[];
  /** Teardown. Cancels every pending TTL. */
  stop(): void;
}

/** Default TTL for `editing` beacons. 30 s balances "long enough
 * for a normal tool call" against "short enough that a stalled
 * agent does not pin the badge forever". Matches the round-1
 * daemon default. */
export const DEFAULT_PRESENCE_TTL_MS = 30_000;

export function openPresenceHub(options: OpenPresenceOptions): PresenceHub {
  const ttlMs = options.ttlMs ?? DEFAULT_PRESENCE_TTL_MS;
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? ((fn, ms) => {
    const handle = setTimeout(fn, ms);
    if (typeof (handle as unknown as { unref?: () => void }).unref === "function") {
      (handle as unknown as { unref: () => void }).unref();
    }
    return handle as unknown as { unref?: () => void };
  });
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>));

  interface Entry {
    frame: PresenceFrame;
    timer?: { unref?: () => void };
  }
  const byActor = new Map<string, Entry>();
  const key = (actor: Author): string => `${actor.kind}:${actor.id}`;

  const clearTimerFor = (k: string): void => {
    const entry = byActor.get(k);
    if (entry?.timer !== undefined) {
      clearTimer(entry.timer);
      entry.timer = undefined;
    }
  };

  const editing: PresenceHub["editing"] = (actor, location) => {
    const k = key(actor);
    clearTimerFor(k);
    const frame: PresenceFrame = {
      kind: "presence",
      state: "editing",
      ts: now().toISOString(),
      actor,
      ...(location.path !== undefined ? { path: location.path } : {}),
      ...(location.startLine !== undefined ? { startLine: location.startLine } : {}),
      ...(location.endLine !== undefined ? { endLine: location.endLine } : {}),
    };
    const entry: Entry = { frame };
    if (ttlMs > 0) {
      entry.timer = setTimer(() => {
        entry.timer = undefined;
        // Auto-idle: broadcast an idle frame AND drop the entry
        // from `currentStates`. A subsequent `editing` from the
        // same actor re-creates the entry.
        const idleFrame: PresenceFrame = {
          kind: "presence",
          state: "idle",
          ts: now().toISOString(),
          actor,
          ...(location.path !== undefined ? { path: location.path } : {}),
        };
        byActor.delete(k);
        options.onBroadcast(idleFrame);
      }, ttlMs);
    }
    byActor.set(k, entry);
    options.onBroadcast(frame);
    return frame;
  };

  const idle: PresenceHub["idle"] = (actor, location) => {
    const k = key(actor);
    clearTimerFor(k);
    byActor.delete(k);
    const frame: PresenceFrame = {
      kind: "presence",
      state: "idle",
      ts: now().toISOString(),
      actor,
      ...(location?.path !== undefined ? { path: location.path } : {}),
    };
    options.onBroadcast(frame);
    return frame;
  };

  const currentStates: PresenceHub["currentStates"] = () => {
    return Array.from(byActor.values()).map((e) => e.frame);
  };

  const stop: PresenceHub["stop"] = () => {
    for (const entry of byActor.values()) {
      if (entry.timer !== undefined) clearTimer(entry.timer);
    }
    byActor.clear();
  };

  return { editing, idle, currentStates, stop };
}
