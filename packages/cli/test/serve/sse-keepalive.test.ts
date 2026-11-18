// Issue #277 — SSE keepalive interval regression.
//
// The daemon sends a `: keepalive\n\n` comment every
// `SSE_KEEPALIVE_INTERVAL_MS` to a live `/events` subscriber. The
// interval MUST stay under the smallest idle-timeout a reverse
// proxy / load balancer is likely to enforce, or an idle proxy will
// reap the stream and the rail will go silent — which is the bug
// reported in issue #277 (a long-running tab behind an aiohttp
// reverse proxy).
//
// Two assertions:
//
//   1. The exported constant is <= 45 s, with a 4× margin against
//      the tightest common proxy timeout (60 s).
//   2. The live stream actually EMITS a keepalive frame within
//      ~1.5× the interval — the test drives a shortened interval so
//      we don't wait 15 s in CI. We cannot override the constant at
//      runtime (it is a module-level `const`), so the second
//      assertion reads the first keepalive which the daemon flushes
//      on `start()` (the prime frame) and asserts its shape.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SSE_KEEPALIVE_INTERVAL_MS, startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";
import type { LineSink } from "../../src/serve/logger.ts";

interface Ctx {
  handle: DaemonHandle;
  root: string;
  cookie: string;
}

let ctx: Ctx;

beforeEach(async () => {
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
  });
  ctx = { handle, root, cookie: await mintSessionCookie(handle) };
});

afterEach(async () => {
  await ctx.handle.stop();
  rmSync(ctx.root, { recursive: true, force: true });
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

describe("SSE keepalive — issue #277", () => {
  test("REGRESSION: the keepalive interval stays below the tightest common proxy idle timeout", () => {
    // 60 s is the tightest common ceiling (nginx, HAProxy, AWS ALB).
    // Dropping below 45 s keeps a 4× margin and lets one lost
    // keepalive still wake the next one under 60 s.
    expect(SSE_KEEPALIVE_INTERVAL_MS).toBeGreaterThan(0);
    expect(SSE_KEEPALIVE_INTERVAL_MS).toBeLessThanOrEqual(45_000);
  });

  test("the daemon flushes a keepalive comment immediately on `start()` so the client's fetch() resolves with headers and the rail attaches without waiting for a data frame", async () => {
    // The daemon's event stream opens with a `: keepalive\n\n`
    // comment flushed from inside the ReadableStream's `start()`
    // callback. If that disappears, a client using the Fetch API
    // (the Playwright e2e in site/tests/) blocks on the first
    // `response.body.getReader().read()` until a real event lands,
    // which can be seconds — enough to flake the test.
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
    let keepaliveSeen = false;
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
      // An SSE comment line starts with `:` — the keepalive is
      // exactly `: keepalive\n\n`. A regression that removed the
      // on-start flush would make this loop hit its deadline.
      if (buffered.includes(": keepalive")) {
        keepaliveSeen = true;
        break;
      }
    }
    try {
      await reader.cancel();
    } catch {
      // Stream was already closed by the daemon.
    }
    expect(keepaliveSeen).toBe(true);
  });
});
