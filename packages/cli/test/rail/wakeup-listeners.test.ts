// Unit test for the rail's live-channel wake-up listener wiring
// (issue #277 round 2, "test that subscribeEvents removes its
// listeners on teardown").
//
// The rail registers `visibilitychange` on `document` and `online`
// on `window` so a tab that returned to the foreground — or whose
// network just came back — forces a fresh SSE connection. On rail
// unmount (React Fast Refresh, an SPA that re-renders the rail, or
// simply a test harness cleaning up), those listeners MUST be
// removed. A missing removal would leak one more live `wake()`
// closure per remount; on a long-running tab, the handler count
// grows without bound.

import { describe, expect, test } from "bun:test";
import { registerLiveWakeupListeners, type WakeupScope } from "../../src/rail/wakeup-listeners.ts";

interface Spy {
  readonly listeners: Map<string, Set<() => void>>;
  readonly addEventListener: (type: string, listener: () => void) => void;
  readonly removeEventListener: (type: string, listener: () => void) => void;
}

function spy(): Spy {
  const listeners = new Map<string, Set<() => void>>();
  return {
    listeners,
    addEventListener(type, listener): void {
      const bag = listeners.get(type) ?? new Set<() => void>();
      bag.add(listener);
      listeners.set(type, bag);
    },
    removeEventListener(type, listener): void {
      listeners.get(type)?.delete(listener);
    },
  };
}

describe("rail wakeup-listeners — issue #277 teardown", () => {
  test("REGRESSION: `unsubscribe` removes every listener the registration added", () => {
    const docSpy = spy();
    let visibilityState = "visible";
    const doc = {
      addEventListener: docSpy.addEventListener,
      removeEventListener: docSpy.removeEventListener,
      get visibilityState(): string {
        return visibilityState;
      },
    };
    const winSpy = spy();
    const win = {
      addEventListener: winSpy.addEventListener,
      removeEventListener: winSpy.removeEventListener,
    };
    const scope: WakeupScope = { doc, win };
    let wakes = 0;
    const teardown = registerLiveWakeupListeners(scope, () => {
      wakes++;
    });

    // Both listeners are registered.
    expect(docSpy.listeners.get("visibilitychange")?.size).toBe(1);
    expect(winSpy.listeners.get("online")?.size).toBe(1);

    // Fire them — they call `wake()` once each.
    visibilityState = "visible";
    docSpy.listeners.get("visibilitychange")!.values().next().value!();
    expect(wakes).toBe(1);
    winSpy.listeners.get("online")!.values().next().value!();
    expect(wakes).toBe(2);

    // Teardown removes both.
    teardown();
    expect(docSpy.listeners.get("visibilitychange")?.size ?? 0).toBe(0);
    expect(winSpy.listeners.get("online")?.size ?? 0).toBe(0);

    // Teardown is idempotent.
    teardown();
    expect(docSpy.listeners.get("visibilitychange")?.size ?? 0).toBe(0);
    expect(winSpy.listeners.get("online")?.size ?? 0).toBe(0);
  });

  test("`visibilitychange` wakes only when the tab becomes visible, not when it becomes hidden", () => {
    const docSpy = spy();
    let visibilityState = "hidden";
    const doc = {
      addEventListener: docSpy.addEventListener,
      removeEventListener: docSpy.removeEventListener,
      get visibilityState(): string {
        return visibilityState;
      },
    };
    const scope: WakeupScope = { doc };
    let wakes = 0;
    const teardown = registerLiveWakeupListeners(scope, () => {
      wakes++;
    });

    const fire = (): void => {
      docSpy.listeners.get("visibilitychange")!.values().next().value!();
    };

    // Hidden → no wake.
    visibilityState = "hidden";
    fire();
    expect(wakes).toBe(0);

    // Visible → wake.
    visibilityState = "visible";
    fire();
    expect(wakes).toBe(1);

    teardown();
  });

  test("a missing `document` or `window` is tolerated — teardown is still a function", () => {
    // SSR / preview environments may not expose `document` or
    // `window`; the rail's bundle guards both. This test pins that
    // behaviour so a future reorg of the helper cannot
    // regress to a crash at module top level.
    const teardown = registerLiveWakeupListeners({}, () => {
      throw new Error("wake must not be called");
    });
    // No listeners to invoke; teardown is still a no-op callable.
    expect(() => teardown()).not.toThrow();
    expect(() => teardown()).not.toThrow();
  });
});
