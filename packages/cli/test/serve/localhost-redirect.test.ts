// Localhost → 127.0.0.1 redirect (issue #44).
//
// The daemon serves on 127.0.0.1 and accepts both loopback aliases at
// the Host check, but only 127.0.0.1 is the canonical origin. Any
// request whose Host is `localhost:<port>` is 307'd to the same path
// on `127.0.0.1:<port>` so the browser lands on ONE origin and the
// cookie jar stays coherent. This test spins up a real daemon and
// exercises the redirect from a plain fetch (no browser), so we
// verify the response header set (location, status) directly.
//
// Mutation kills:
//   - Drop the redirect branch → the request lands on the localhost
//     origin and the API returns 401 (no cookie); the assertion
//     "location starts with http://127.0.0.1" fails.
//   - Widen the redirect to include 127.0.0.1 requests → the "no
//     redirect for the canonical origin" test goes red.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";

let daemon: DaemonHandle;
let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "revkit-localhost-"));
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "index.html"), "<h1>hi</h1>");
  daemon = await startDaemon({
    dir: join(root, "dist"),
    repoRoot: root,
    port: 0,
    sqlitePath: ":memory:",
    version: "0.0.0-test",
    localUserId: "u",
    installSignalHandlers: false,
    logSink: { write: () => {} },
  });
});
afterEach(async () => {
  await daemon.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("localhost → 127.0.0.1 canonicalisation (issue #44)", () => {
  test("GET / with Host: localhost:<port> is 307'd to the 127.0.0.1 twin", async () => {
    const response = await fetch(`http://127.0.0.1:${daemon.port}/`, {
      // Force Bun's fetch to send Host: localhost:<port> even though
      // it connected to 127.0.0.1. Otherwise the round-trip would
      // hit the canonical origin already and there'd be nothing to
      // assert. `redirect: "manual"` so we observe the 307 rather
      // than automatically following it.
      headers: { host: `localhost:${daemon.port}` },
      redirect: "manual",
    });
    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toBe(`http://127.0.0.1:${daemon.port}/`);
    // Response hygiene still applies to the redirect body — the
    // browser reads these headers before following.
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("GET /-/auth?code=X with Host: localhost is redirected — the launch flow ends on 127.0.0.1", async () => {
    // A user who pastes `http://localhost:<port>/-/auth?code=…` into
    // their address bar is 307'd to `http://127.0.0.1:<port>/-/auth?code=…`
    // so the cookie set by the exchange lives on the canonical
    // origin. The launch code itself is preserved through the
    // redirect via the query string.
    const response = await fetch(
      `http://127.0.0.1:${daemon.port}/-/auth?code=${daemon.launchCode}`,
      {
        headers: { host: `localhost:${daemon.port}` },
        redirect: "manual",
      },
    );
    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toBe(
      `http://127.0.0.1:${daemon.port}/-/auth?code=${daemon.launchCode}`,
    );
  });

  test("POST /api/threads with Host: localhost is 307'd (method preserved by 307)", async () => {
    // POST-with-Host: localhost is a shape a browser typically does
    // NOT produce (the page it came from was already redirected),
    // but a hand-rolled fetch might. 307 preserves the method and
    // body per RFC 7231, so a well-behaved client re-posts on the
    // canonical origin.
    const response = await fetch(`http://127.0.0.1:${daemon.port}/api/threads`, {
      method: "POST",
      headers: {
        host: `localhost:${daemon.port}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
      redirect: "manual",
    });
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `http://127.0.0.1:${daemon.port}/api/threads`,
    );
  });

  test("MUTATION: canonical Host: 127.0.0.1 is NOT redirected — the ordinary path is served", async () => {
    // Widening the redirect to cover 127.0.0.1 too would trap every
    // request in a 307 loop. This test goes red if the redirect
    // branch drops its `hostHeader === localhost` guard.
    const response = await fetch(`http://127.0.0.1:${daemon.port}/`, {
      headers: { host: `127.0.0.1:${daemon.port}` },
      redirect: "manual",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  test("WebSocket upgrade with Host: localhost is refused with 421 (WS does not follow 307)", async () => {
    // A WebSocket upgrade request cannot follow a 307; the client
    // would silently fail. The daemon refuses with 421 Misdirected
    // Request so the caller sees a real error and can retry on the
    // canonical origin.
    const response = await fetch(`http://127.0.0.1:${daemon.port}/events`, {
      headers: {
        host: `localhost:${daemon.port}`,
        upgrade: "websocket",
        connection: "Upgrade",
      },
      redirect: "manual",
    });
    expect(response.status).toBe(421);
  });

  test("end-to-end: paste localhost URL → 307 → exchange on 127.0.0.1 → API call authenticated", async () => {
    // The whole "user pastes localhost URL" story. The launch code
    // survives the 307 (it's carried through the query string),
    // gets exchanged on 127.0.0.1, and the cookie set by /-/auth
    // is scoped to the canonical origin. This is the real
    // acceptance for #44 — the earlier assertions pin the redirect
    // shape, but only this one proves the auth flow works.
    const step1 = await fetch(
      `http://127.0.0.1:${daemon.port}/-/auth?code=${daemon.launchCode}`,
      { headers: { host: `localhost:${daemon.port}` }, redirect: "manual" },
    );
    expect(step1.status).toBe(307);
    // Follow the 307 on the canonical origin. The launch code has
    // NOT been consumed yet (the redirect returned before the
    // exchange). Exchange it now on 127.0.0.1.
    const step2 = await fetch(
      `http://127.0.0.1:${daemon.port}/-/auth?code=${daemon.launchCode}`,
      { headers: { host: `127.0.0.1:${daemon.port}` }, redirect: "manual" },
    );
    expect(step2.status).toBe(302);
    const cookieHeader = step2.headers.get("set-cookie") ?? "";
    expect(cookieHeader.length).toBeGreaterThan(0);
    const cookie = cookieHeader.split(";")[0]!.trim();
    // API call on canonical origin with the cookie succeeds.
    const apiResponse = await fetch(`http://127.0.0.1:${daemon.port}/api/threads`, {
      headers: {
        cookie,
        host: `127.0.0.1:${daemon.port}`,
        origin: daemon.url,
      },
    });
    expect(apiResponse.status).toBe(200);
  });
});
