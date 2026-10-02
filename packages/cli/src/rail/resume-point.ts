// The rail's SSE resume point (M2 item 9, story A4).
//
// **Why this exists.** The rejected head opened `new EventSource("/events")`
// with no resume point, so the daemon replayed the whole durable log on
// every page load, and the rail's reload triggers fired again on each
// replay: load → replay → reload, forever (measured at 212 navigations
// in 8 s). A subscriber that RELOADS the page must therefore never
// treat a replayed event as news.
//
// Two independent mechanisms, deliberately:
//
//   1. This resume point. A warm tab resumes from the highest seq it
//      already acted on; a cold tab starts at the log's head, because
//      the page has just loaded current state and history can only
//      re-fire actions.
//   2. `handleDurableSeq` below, a monotonic guard that drops any
//      duplicate regardless of how it arrived.
//
// The resume point is the optimisation; the guard is the safety net.
// If storage is unavailable, or the head probe fails, or the daemon
// replays anyway, the guard alone still makes the page settle — after
// at most one extra reload.
//
// Kept in its own module (rather than inline in `rail.tsx`) so it is
// testable without a browser: `rail.tsx` runs side effects on import.

/** sessionStorage key. Per-TAB by construction: a newly opened tab
 * starts empty and therefore cold (resume from head), while a
 * `window.location.reload()` inside the same tab keeps the point and
 * does not re-receive the event that caused the reload. */
export const RESUME_SEQ_KEY = "revkit.rail.lastHandledSeq";

/** `name` of the `<meta>` the daemon stamps with the log head at
 * page-render time. Mirrors `RAIL_LOG_HEAD_META` in
 * `rail/injector.ts`; duplicated as a literal because the rail bundle
 * is built for the BROWSER and must not import the daemon's module
 * graph (which pulls in node:fs). A test asserts the two agree. */
export const RAIL_LOG_HEAD_META = "revkit-log-head";

/** The slice of the Web Storage API this module needs. Passing it in
 * keeps the module free of a global dependency, so a test can supply
 * a plain object and a browser supplies `window.sessionStorage`. */
export interface ResumeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readResumeSeq(storage: ResumeStorage | undefined): number {
  if (storage === undefined) return 0;
  try {
    const raw = storage.getItem(RESUME_SEQ_KEY);
    if (raw === null) return 0;
    const parsed = Number.parseInt(raw, 10);
    // Strict equality against the trimmed text: `Number.parseInt("10abc")`
    // is 10, which would silently accept a corrupt value and skip
    // every live event up to it.
    return Number.isInteger(parsed) && parsed > 0 && String(parsed) === raw.trim() ? parsed : 0;
  } catch {
    return 0;
  }
}

export function writeResumeSeq(storage: ResumeStorage | undefined, seq: number): void {
  if (storage === undefined || !Number.isInteger(seq) || seq <= 0) return;
  try {
    storage.setItem(RESUME_SEQ_KEY, String(seq));
  } catch {
    // Storage can be unavailable in private browsing contexts. The
    // in-memory guard still prevents the loop for this page's lifetime.
  }
}

/** Monotonic per-seq gate for one page's subscription.
 *
 * `accept` returns true for a durable event this page has not handled
 * before, and advances the high-water mark. It returns false for a
 * replay — which is the entire point: a replay must not bump state and
 * must not navigate. Ephemeral frames (presence) carry no seq and are
 * NOT routed through here; they are not on the log and cannot be
 * replayed.
 *
 * `initial` MUST be the page's persisted resume point. Seeding it is
 * what makes this mechanism INDEPENDENT of the `?since=` query: a page
 * that reloads mid-loop starts with its mark already at the event that
 * caused the reload, so even a full replay (`since=0`, because the head
 * probe failed) is refused. Without the seed the two mechanisms would
 * be the same mechanism twice, and the documented "worst case is one
 * extra reload" would really be "one extra reload per page load".
 *
 * The caller persists each accepted seq BEFORE acting on it, so a
 * reload the action triggers starts the next page load past it. */
export function createSeqGate(initial = 0): { accept(seq: number): boolean } {
  let high = Number.isInteger(initial) && initial > 0 ? initial : 0;
  return {
    accept(seq: number): boolean {
      if (!Number.isInteger(seq) || seq <= 0) return false;
      if (seq <= high) return false;
      high = seq;
      return true;
    },
  };
}

/** Read the log head the daemon stamped into THIS page at render time
 * (`<meta name="revkit-log-head">`, see `rail/injector.ts`). Returns 0
 * when the page has no such tag — an oversize page the injector passed
 * through untouched, or a daemon old enough not to stamp one. */
export function readPageRenderHead(doc: {
  querySelector: (selector: string) => { getAttribute: (name: string) => string | null } | null;
}): number {
  try {
    const raw = doc.querySelector(`meta[name="${RAIL_LOG_HEAD_META}"]`)?.getAttribute("content");
    if (raw === null || raw === undefined) return 0;
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed > 0 && String(parsed) === raw.trim() ? parsed : 0;
  } catch {
    return 0;
  }
}

/** Where to open `/events`.
 *
 * Three inputs, in strict priority order:
 *
 * 1. **`pageHead` — the head stamped into THIS page at render time.**
 *    Preferred because it is the only value guaranteed to be EARLIER
 *    than the window between the page's HTML GET and the stream
 *    attaching. Subscribing from it replays that window; the per-seq
 *    gate drops whatever the page already handled, so the replay costs
 *    nothing and the lost update is not lost.
 * 2. **`stored` — this tab's persisted resume point.** The fallback
 *    when the page carries no stamp (a WARM reload whose previous
 *    page did, or a page the injector passed through).
 * 3. **`probedHead` — a live read of `GET /api/events-head`.** The
 *    last resort, and the weakest: reading it at attach time cannot
 *    cover a window that closed before the probe ran. Kept so a
 *    page with neither a stamp nor a stored point still subscribes
 *    live-only rather than replaying the entire log.
 *
 * Exported so the decision is unit-testable without a DOM: the
 * alternative — asserting only that "the page settles" in a browser —
 * cannot distinguish a page-render resume point from an attach-time
 * one, and a regression in either looks identical there. */
export function sinceForSubscribe(stored: number, probedHead: number, pageHead: number): number {
  if (Number.isInteger(pageHead) && pageHead > 0) return pageHead;
  if (stored > 0) return stored;
  return Number.isInteger(probedHead) && probedHead > 0 ? probedHead : 0;
}
