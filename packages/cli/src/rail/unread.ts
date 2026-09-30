// Pure derivations for the rail's resolved-thread and unread
// affordances (issue #60). Extracted from `rail.tsx` so unit tests
// (and any other module) can import them without triggering the
// rail bundle's DOM-side `mount()` call at import time.
//
// Everything in here is a plain function over data — no fetch, no
// DOM, no timers — so bun:test can run it in Node. The rail JSX
// side re-exports these through `rail.tsx` so the browser bundle
// still has one entry point.

/** Rail-side thread projection duck-type. Kept minimal — the rail
 * bundle deliberately does not import the review-core Zod schema,
 * so the browser payload stays small. */
export interface UnreadThread {
  readonly id: string;
  readonly status: "open" | "resolved" | "orphaned";
  readonly updatedAt: string;
  readonly comments: ReadonlyArray<{ readonly author: { readonly kind: string } }>;
  readonly resolvedBy?: { readonly kind: string };
}

/** Per-viewer "seen" state — a map from thread id to the
 * `updatedAt` value the viewer last acknowledged. Stored in
 * localStorage. A missing entry means "never seen"; an entry that
 * equals the current `updatedAt` means "up to date". */
export type SeenMap = Readonly<Record<string, string>>;

/** localStorage key for the seen map. Scoped to the rail so a
 * different island on the same daemon origin (if any) does not
 * collide. Bumped only if the SeenMap shape changes. */
export const SEEN_STORAGE_KEY = "revkit.rail.seen.v1";

/** True when the LAST touch on this thread was an agent action —
 * either the last comment is agent-authored, or the resolve was
 * done by the agent. A human replying to their own thread never
 * makes it "unread". */
export function hasAgentActivity(thread: UnreadThread): boolean {
  if (thread.status === "resolved" && thread.resolvedBy?.kind === "agent") return true;
  const last = thread.comments[thread.comments.length - 1];
  if (last === undefined) return false;
  return last.author.kind === "agent";
}

/** Is this thread's latest version newer than the last one the
 * viewer marked seen? Returns true when the thread has never been
 * seen on this browser (missing map entry), OR when the thread's
 * `updatedAt` has advanced since the last seen mark. Only threads
 * with agent activity qualify as "unread"; a human's own reply is
 * always considered read. Storage-unavailable failure paths call
 * this with an EMPTY map, so the fallback IS "unread everything"
 * — the safe default. */
export function isThreadUnread(thread: UnreadThread, seen: SeenMap): boolean {
  if (!hasAgentActivity(thread)) return false;
  const lastSeen = seen[thread.id];
  if (lastSeen === undefined) return true;
  return thread.updatedAt > lastSeen;
}

/** A short single-line excerpt of a comment body, for the
 * collapsed resolved-thread row. Whitespace is collapsed and long
 * lines are hard-truncated with an ellipsis so a
 * multi-paragraph reply doesn't blow up the row. */
export function excerptOf(body: string, max: number = 120): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1).trimEnd() + "…";
}

/** A coarse "N seconds ago" / "5 min ago" / "2 h ago" / "3 d ago"
 * label for the resolved-summary row. `now` defaults to
 * `Date.now()`; tests inject a deterministic value. Uses only
 * `Intl.RelativeTimeFormat` where available and falls back to a
 * plain string so the rail bundle keeps its zero-dependency
 * runtime footprint (ADR-0018). */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diffSec = Math.round((t - now) / 1000);
  const abs = Math.abs(diffSec);
  const pickUnit = (): { unit: Intl.RelativeTimeFormatUnit; value: number } => {
    if (abs < 60) return { unit: "second", value: diffSec };
    if (abs < 3600) return { unit: "minute", value: Math.round(diffSec / 60) };
    if (abs < 86400) return { unit: "hour", value: Math.round(diffSec / 3600) };
    if (abs < 604_800) return { unit: "day", value: Math.round(diffSec / 86400) };
    if (abs < 2_592_000) return { unit: "week", value: Math.round(diffSec / 604_800) };
    if (abs < 31_536_000) return { unit: "month", value: Math.round(diffSec / 2_592_000) };
    return { unit: "year", value: Math.round(diffSec / 31_536_000) };
  };
  const { unit, value } = pickUnit();
  try {
    if (typeof Intl !== "undefined" && typeof Intl.RelativeTimeFormat === "function") {
      const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
      return rtf.format(value, unit);
    }
  } catch {
    // Fall through to the manual label.
  }
  const suffix = value >= 0 ? " from now" : " ago";
  return `${Math.abs(value)} ${unit}${Math.abs(value) === 1 ? "" : "s"}${suffix}`;
}

/** Read the "seen" map from `localStorage`. Wrapped in try/catch;
 * a private window, cleared / blocked site data, or a throwing
 * accessor all resolve to `{}` — the safe default, which shows
 * every agent-touched thread as unread. */
export function readSeenMap(storage: Pick<Storage, "getItem"> | undefined = tryLocalStorage()): SeenMap {
  if (storage === undefined) return {};
  try {
    const raw = storage.getItem(SEEN_STORAGE_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [id, ts] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof id === "string" && typeof ts === "string" && ts.length > 0) out[id] = ts;
    }
    return out;
  } catch {
    return {};
  }
}

/** Write the "seen" map to `localStorage`. Wrapped in try/catch:
 * a full quota or a blocked storage means the mark won't persist
 * across a reload, but the in-memory state still moves so the
 * current session isn't stuck. Never fatal. */
export function writeSeenMap(next: SeenMap, storage: Pick<Storage, "setItem"> | undefined = tryLocalStorage()): void {
  if (storage === undefined) return;
  try {
    storage.setItem(SEEN_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable / quota exceeded — the mark won't persist
    // across a reload, but the in-memory state still moves the
    // pill so this session isn't stuck. Never fatal.
  }
}

/** Access `window.localStorage` in an environment where `window`
 * might be undefined (unit tests under bun:test / Node). Returns
 * undefined if the accessor throws (Firefox strict privacy modes
 * throw on `window.localStorage` itself). */
function tryLocalStorage(): Storage | undefined {
  try {
    if (typeof globalThis === "undefined") return undefined;
    const w = globalThis as unknown as { localStorage?: Storage };
    return w.localStorage;
  } catch {
    return undefined;
  }
}
