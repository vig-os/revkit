// DOM wake-up listener registration for the rail's live channel
// (issue #277).
//
// Extracted from `rail.tsx` so a unit test can assert that each
// listener added on mount is removed on unmount — the rail used to
// register `visibilitychange` on `document` and `online` on `window`
// inline inside `subscribeEvents`, which was not directly testable.
// A tab that reloads the rail (e.g. React Fast Refresh, or a long
// SPA session) relies on these listeners being removed cleanly or
// the handler count on `document` grows without bound.
//
// This function returns a teardown that MUST be called on unmount.
// Both `document` and `window` are probed defensively so the rail's
// test harness (which may run without a DOM) does not crash on import.

/** Minimal shape of the globals this helper needs. Passing them in
 * keeps the module free of a direct dependency on `document` /
 * `window` so a test can supply spies. */
export interface WakeupScope {
  readonly doc?: {
    addEventListener(type: string, listener: () => void): void;
    removeEventListener(type: string, listener: () => void): void;
    readonly visibilityState?: string;
  };
  readonly win?: {
    addEventListener(type: string, listener: () => void): void;
    removeEventListener(type: string, listener: () => void): void;
  };
}

/** Register the rail's wake-up listeners for the live channel.
 *
 * - `visibilitychange` on `document`: when the tab returns to the
 *   foreground, call `wake()`. Guarded by
 *   `document.visibilityState === "visible"` so a hide→show cycle
 *   wakes but a show→hide does not.
 * - `online` on `window`: when the network comes back, call `wake()`.
 *
 * Returns a teardown that removes BOTH listeners. Calling it twice
 * is safe: `removeEventListener` is a no-op when the listener is
 * not registered. */
export function registerLiveWakeupListeners(
  scope: WakeupScope,
  wake: () => void,
): () => void {
  const doc = scope.doc;
  const win = scope.win;

  const onVisibilityChange = (): void => {
    if (doc?.visibilityState === "visible") wake();
  };
  const onOnline = (): void => wake();

  if (doc !== undefined) doc.addEventListener("visibilitychange", onVisibilityChange);
  if (win !== undefined) win.addEventListener("online", onOnline);

  let torn = false;
  return (): void => {
    if (torn) return;
    torn = true;
    if (doc !== undefined) doc.removeEventListener("visibilitychange", onVisibilityChange);
    if (win !== undefined) win.removeEventListener("online", onOnline);
  };
}

/** The scope the rail passes at mount time — probes `document` and
 * `window` once. A `typeof` check keeps this safe in a bundle that
 * might be imported without a DOM (e.g. SSR preview). */
export function browserWakeupScope(): WakeupScope {
  return {
    ...(typeof document !== "undefined" ? { doc: document as unknown as WakeupScope["doc"] } : {}),
    ...(typeof window !== "undefined" ? { win: window as unknown as WakeupScope["win"] } : {}),
  };
}
