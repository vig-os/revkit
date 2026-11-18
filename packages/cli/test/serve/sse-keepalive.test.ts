// Issue #277 — SSE heartbeat regression.
//
// The daemon emits a NAMED `ping` event (`event: ping\ndata: \n\n`)
// to a live `/events` subscriber every `SSE_KEEPALIVE_INTERVAL_MS`.
// This replaces the earlier `: keepalive` SSE comment, because
// `EventSource` never surfaces comment lines to the page — so a
// client-side watchdog could not see them, and a stream that
// stayed open but silently stopped delivering real frames (the
// reporter's case) looked indistinguishable from a live-and-well
// stream. See `packages/cli/src/rail/live-channel.ts` for the
// matching client watchdog.
//
// Three assertions:
//
//   1. The exported interval stays ≤ 45 s, with a 4× margin
//      against the tightest common proxy timeout (60 s).
//   2. The live stream EMITS a `ping` frame immediately on
//      `start()` — the on-attach flush is what resolves the
//      client's `fetch()` with headers so the rail can attach
//      before any data frame.
//   3. The PERIODIC `ping` fires at the configured interval. An
//      injected scheduler (fake `setInterval` / `clearInterval`)
//      drives the tick deterministically, with no real wait.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SSE_KEEPALIVE_INTERVAL_MS,
  startDaemon,
  type DaemonHandle,
  type SseHeartbeatScheduler,
} from "../../src/serve/daemon.ts";
import type { LineSink } from "../../src/serve/logger.ts";

interface Ctx {
  handle: DaemonHandle;
  root: string;
  cookie: string;
}

/** A capturing scheduler whose `setInterval` stores every callback
 * so the test can fire it manually. Returns the callback registry
 * so a test can invoke a specific one. */
interface CapturingScheduler extends SseHeartbeatScheduler {
  fireNext(): void;
  size(): number;
  intervals(): number[];
}

function capturingScheduler(): CapturingScheduler {
  let nextId = 1;
  const timers = new Map<number, { readonly fn: () => void; readonly ms: number }>();
  return {
    setInterval(fn: () => void, ms: number): unknown {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearInterval(handle: unknown): void {
      if (typeof handle === "number") timers.delete(handle);
    },
    fireNext(): void {
      // Fire the oldest still-registered timer once.
      const entry = [...timers.entries()][0];
      if (entry === undefined) throw new Error("no timers registered");
      entry[1].fn();
    },
    size(): number {
      return timers.size;
    },
    intervals(): number[] {
      return [...timers.values()].map((t) => t.ms);
    },
  };
}

async function startWith(scheduler: CapturingScheduler | undefined, heartbeatMs?: number): Promise<Ctx> {
  const root = mkdtempSync(join(tmpdir(), "revkit-sse-keepalive-"));
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><h1>root</h1>", "utf8");
  const logs: string[] = [];
  const sink: LineSink = { write: (line) => logs.push(line) };
  const handle = await startDaemon({
    dir: dist,
    repoRoot: root,
    port: 0,
    sqlitePath: ":memory:",
    version: "0.0.0-test",
    localUserId: "local-test",
    installSignalHandlers: false,
    logSink: sink,
    reanchor: { pollIntervalMs: 60_000, buildDebounceMs: 60_000, fileDebounceMs: 60_000 },
    enableBackgroundBuild: false,
    ...(scheduler !== undefined ? { sseHeartbeatScheduler: scheduler } : {}),
    ...(heartbeatMs !== undefined ? { sseHeartbeatIntervalMs: heartbeatMs } : {}),
  });
  return { handle, root, cookie: await mintSessionCookie(handle) };
}

let ctx: Ctx | undefined;

afterEach(async () => {
  if (ctx === undefined) return;
  await ctx.handle.stop();
  rmSync(ctx.root, { recursive: true, force: true });
  ctx = undefined;
});

async function mintSessionCookie(daemon: DaemonHandle): Promise<string> {
  const url = new URL(`${daemon.url}/-/auth`);
  url.searchParams.set("code", daemon.launchCode);
  const response = await fetch(url, { redirect: "manual", headers: { host: `127.0.0.1:${daemon.port}` } });
  if (response.status !== 302) throw new Error(`auth exchange failed: ${response.status}`);
  const setCookie = response.headers.get("set-cookie");
  if (setCookie === null) throw new Error("no set-cookie");
  return setCookie.slice(0, setCookie.indexOf(";"));
}

describe("SSE heartbeat — issue #277", () => {
  test("REGRESSION: the heartbeat interval stays below the tightest common proxy idle timeout", () => {
    // 60 s is the tightest common ceiling (nginx, HAProxy, AWS ALB).
    // Dropping below 45 s keeps a 4× margin and lets one lost
    // heartbeat still wake the next one under 60 s.
    expect(SSE_KEEPALIVE_INTERVAL_MS).toBeGreaterThan(0);
    expect(SSE_KEEPALIVE_INTERVAL_MS).toBeLessThanOrEqual(45_000);
  });

  describe("start()-flush — the first frame is a named `ping`", () => {
    beforeEach(async () => {
      ctx = await startWith(undefined);
    });

    test("the daemon flushes a named `ping` event immediately on `start()`", async () => {
      // The daemon's event stream opens with `event: ping\ndata: \n\n`
      // flushed from inside the ReadableStream's `start()` callback.
      // That is what resolves the client's `fetch()` with response
      // headers so the rail can attach without waiting for a real
      // data frame. A regression that removed the on-start flush
      // would make this loop hit its deadline.
      if (ctx === undefined) throw new Error("beforeEach did not run");
      const response = await fetch(`${ctx.handle.url}/events?since=0`, {
        headers: {
          cookie: ctx.cookie,
          origin: ctx.handle.url,
          accept: "text/event-stream",
          host: `127.0.0.1:${ctx.handle.port}`,
        },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const deadline = Date.now() + 2_000;
      let buffered = "";
      let pingSeen = false;
      while (Date.now() < deadline) {
        const readPromise = reader.read();
        const timeoutPromise = new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), Math.max(0, deadline - Date.now())),
        );
        const winner = await Promise.race([readPromise, timeoutPromise]);
        if (winner === undefined) break;
        const { value, done } = winner as ReadableStreamReadResult<Uint8Array>;
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        // A named SSE event starts with `event: <name>` and carries
        // a `data:` line. The heartbeat is `event: ping\ndata: \n\n`.
        if (buffered.includes("event: ping")) {
          pingSeen = true;
          break;
        }
      }
      try {
        await reader.cancel();
      } catch {
        // Stream was already closed by the daemon.
      }
      expect(pingSeen).toBe(true);
    });
  });

  describe("periodic heartbeat — driven by an INJECTED scheduler", () => {
    let scheduler: CapturingScheduler;

    beforeEach(async () => {
      // Round-2 fix: the periodic heartbeat is tested against an
      // injected scheduler so each tick is deterministic — no real
      // `setInterval(…, 2_000)` sleep. The interval value is still
      // passed through so a future caller who overrides the
      // interval (with a real scheduler) gets what they asked for.
      scheduler = capturingScheduler();
      // Pass a non-default interval (50 ms) so the test proves the
      // value is plumbed end-to-end, not just the default.
      ctx = await startWith(scheduler, 50);
    });

    test("REGRESSION: the periodic heartbeat is scheduled at the configured interval, and every tick emits a `ping` frame", async () => {
      // Open a subscriber and consume the on-start `ping` so the
      // read buffer is caught up to just before the first periodic
      // tick.
      if (ctx === undefined) throw new Error("beforeEach did not run");
      const response = await fetch(`${ctx.handle.url}/events?since=0`, {
        headers: {
          cookie: ctx.cookie,
          origin: ctx.handle.url,
          accept: "text/event-stream",
          host: `127.0.0.1:${ctx.handle.port}`,
        },
      });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const readOne = async (deadlineMs: number): Promise<string> => {
        let buffered = "";
        while (Date.now() < deadlineMs) {
          const readPromise = reader.read();
          const timeout = new Promise<undefined>((r) =>
            setTimeout(() => r(undefined), Math.max(0, deadlineMs - Date.now())),
          );
          const winner = await Promise.race([readPromise, timeout]);
          if (winner === undefined) return "";
          const { value, done } = winner as ReadableStreamReadResult<Uint8Array>;
          if (done) return "";
          buffered += decoder.decode(value, { stream: true });
          const at = buffered.indexOf("\n\n");
          if (at !== -1) return buffered.slice(0, at);
        }
        return "";
      };

      // 1) The on-start flush: `event: ping\ndata:`.
      const first = await readOne(Date.now() + 2_000);
      expect(first).toContain("event: ping");

      // 2) The daemon registered its periodic interval with our
      //    scheduler at the configured 50 ms. No real timer is
      //    running.
      // Give the ReadableStream's async `start` a tick to reach
      // the `setInterval` call.
      for (let i = 0; i < 20 && scheduler.size() < 1; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(scheduler.size()).toBe(1);
      expect(scheduler.intervals()).toEqual([50]);

      // 3) Firing the scheduler's callback (equivalent to time
      //    advancing by one interval) enqueues a fresh `ping`
      //    frame on the live stream.
      scheduler.fireNext();
      const second = await readOne(Date.now() + 2_000);
      expect(second).toContain("event: ping");

      // 4) And a SECOND firing emits a SECOND periodic `ping` —
      //    pinning that the daemon's interval callback stays
      //    installed across ticks.
      scheduler.fireNext();
      const third = await readOne(Date.now() + 2_000);
      expect(third).toContain("event: ping");

      try {
        await reader.cancel();
      } catch {
        // Already closed.
      }
    });
  });
});
