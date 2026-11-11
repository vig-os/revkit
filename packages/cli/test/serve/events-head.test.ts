// `GET /api/events-head` at the HTTP boundary (M2 item 9, story A4).
//
// This file exists because the previous round shipped the endpoint
// DEAD. The handler was written inside `handleApi`, but the
// dispatcher only routes `/api/threads` and `/api/threads/*` there,
// so every request for `/api/events-head` fell through to the 404
// branch. The rail's head probe therefore always failed and it fell
// back to `since=0` — a full log replay on every cold tab, which is
// the condition the reload-loop fix was meant to remove.
//
// The lesson, which is why this is a wire test and not a unit test of
// a helper: the helper was correct and the ROUTE was missing, and no
// test that stopped at the helper could have noticed. Every assertion
// here issues a real `fetch` against a real daemon.
//
// Auth / Origin posture mirrors the sibling rail-facing reads: the
// rail holds the session cookie and is same-origin, so a session
// cookie plus a matching Origin is accepted, and a cross-origin
// browser is refused.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";
import type { LineSink } from "../../src/serve/logger.ts";

interface Ctx {
  handle: DaemonHandle;
  root: string;
  cookie: string;
}

let ctx: Ctx;

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), "revkit-events-head-"));
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

describe("GET /api/events-head", () => {
  test("is ROUTED: a session cookie gets 200 and `{ head: number }`", async () => {
    // RED on the rejected head: 404 Not Found. The dispatcher had no
    // branch for this path, so nothing ever reached the handler.
    const response = await fetch(`${ctx.handle.url}/api/events-head`, {
      headers: { cookie: ctx.cookie, origin: ctx.handle.url, accept: "application/json" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { head?: unknown };
    expect(typeof body.head).toBe("number");
    expect(Number.isInteger(body.head)).toBe(true);
    expect(body.head as number).toBeGreaterThanOrEqual(0);
  });

  test("reports the log's CURRENT tip, and it ADVANCES as events land", async () => {
    const head = async (): Promise<number> => {
      const response = await fetch(`${ctx.handle.url}/api/events-head`, {
        headers: { cookie: ctx.cookie, origin: ctx.handle.url, accept: "application/json" },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { head: number };
      return body.head;
    };

    const before = await head();
    // Append one real event through the agent API, then re-read.
    const appended = await fetch(`${ctx.handle.url}/api/delivery-mode`, {
      method: "POST",
      headers: { cookie: ctx.cookie, origin: ctx.handle.url, "content-type": "application/json" },
      body: JSON.stringify({ mode: "live" }),
    });
    expect(appended.status).toBe(200);
    const after = await head();
    expect(after).toBeGreaterThan(before);

    // And it MATCHES what `/api/threads` reports as `head`, because
    // both are `store.head()` — a divergence would silently give the
    // rail a resume point the daemon disagrees with.
    const threads = await fetch(`${ctx.handle.url}/api/threads`, {
      headers: { cookie: ctx.cookie, origin: ctx.handle.url, accept: "application/json" },
    });
    expect(threads.status).toBe(200);
    const threadsBody = (await threads.json()) as { head: number };
    expect(await head()).toBe(threadsBody.head);
  });

  test("is accepted with an agent bearer too (the MCP side may read it)", async () => {
    // Not required by the rail today, but the endpoint is a pure
    // position read with no content in it, and the agent's own
    // subscriber uses the same `since` contract. Asserting it keeps
    // the posture from silently narrowing later.
    const response = await fetch(`${ctx.handle.url}/api/events-head`, {
      headers: { authorization: `Bearer ${ctx.handle.agentToken}`, accept: "application/json" },
    });
    expect(response.status).toBe(200);
    expect(typeof ((await response.json()) as { head?: unknown }).head).toBe("number");
  });

  test("a CROSS-ORIGIN browser is refused", async () => {
    // Defence in depth, consistent with `/api/threads` and `/events`:
    // a cookie-authenticated read must not be reachable from another
    // loopback port, because the cookie rides along automatically.
    const response = await fetch(`${ctx.handle.url}/api/events-head`, {
      headers: { cookie: ctx.cookie, origin: "http://127.0.0.1:1", accept: "application/json" },
    });
    expect(response.status).not.toBe(200);
  });

  test("a caller with NO credentials at all is refused", async () => {
    const response = await fetch(`${ctx.handle.url}/api/events-head`, { headers: { accept: "application/json" } });
    expect(response.status).not.toBe(200);
  });

  test("a non-GET method is refused", async () => {
    // Read-only endpoint: the daemon answers POST here with 405
    // rather than treating the body as a publish. NOTE this does not
    // by itself prove the path is routed — an unrouted path also
    // refuses a POST — so the routing proof lives in the GET tests
    // above, which assert 200 and a JSON body.
    const response = await fetch(`${ctx.handle.url}/api/events-head`, {
      method: "POST",
      headers: { cookie: ctx.cookie, origin: ctx.handle.url, "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(405);
  });

  test("the response is JSON, not the static-file 404 page", async () => {
    // A bare `expect(status).toBe(200)` could in principle pass
    // against a future handler that answers 200 with HTML. Pin the
    // content type so the shape assertion above is meaningful.
    const response = await fetch(`${ctx.handle.url}/api/events-head`, {
      headers: { cookie: ctx.cookie, origin: ctx.handle.url, accept: "application/json" },
    });
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});
