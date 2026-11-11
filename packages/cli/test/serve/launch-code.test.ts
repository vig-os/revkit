// PR #38 round-2 blocker 3 — `/-/launch-code` endpoint tests.
//
// A code minted via this endpoint must work exactly once
// (second exchange returns 403 used), expire on the same TTL as
// the startup code, be refused without the agent bearer, and not
// affect the startup codes own lifecycle.
//
// ADR-0013 (loopback + single-use launch codes) note: the agent
// sees the URL, which is acceptable ONLY because it's loopback-only
// and single-use — an attacker on the machine with the token
// already has the machine.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";

let daemon: DaemonHandle;
let root: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "revkit-lc-"));
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "index.html"), "<h1>x</h1>");
  daemon = await startDaemon({
    dir: join(root, "dist"),
    repoRoot: root,
    port: 0,
    sqlitePath: ":memory:",
    version: "0.0.0-test",
    localUserId: "local-test",
    installSignalHandlers: false,
    logSink: { write: () => {} },
    launchCodeTtlMs: 60_000,
  });
});
afterEach(async () => {
  await daemon.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("POST /-/launch-code", () => {
  test("requires the agent bearer (401 without, 401 with wrong bearer)", async () => {
    const noAuth = await fetch(daemon.url + "/-/launch-code", {
      method: "POST",
      headers: { host: `127.0.0.1:${daemon.port}` },
    });
    expect(noAuth.status).toBe(401);
    const badAuth = await fetch(daemon.url + "/-/launch-code", {
      method: "POST",
      headers: { host: `127.0.0.1:${daemon.port}`, authorization: "Bearer wrong-token-" + "x".repeat(40) },
    });
    expect(badAuth.status).toBe(401);
  });

  test("mints a fresh launch URL that redirects to `/` on first use", async () => {
    const response = await fetch(daemon.url + "/-/launch-code", {
      method: "POST",
      headers: {
        host: `127.0.0.1:${daemon.port}`,
        authorization: `Bearer ${daemon.agentToken}`,
      },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { launchUrl: string; ttlMs: number };
    expect(body.launchUrl).toContain("/-/auth?code=");
    expect(body.ttlMs).toBeGreaterThan(0);
    // First redemption → 302 to `/`.
    const redemption = await fetch(body.launchUrl, {
      redirect: "manual",
      headers: { host: `127.0.0.1:${daemon.port}` },
    });
    expect(redemption.status).toBe(302);
    expect(redemption.headers.get("location")).toBe("/");
  });

  test("MUTATION: single-use — the same URL fails on second redemption", async () => {
    const minted = await fetch(daemon.url + "/-/launch-code", {
      method: "POST",
      headers: {
        host: `127.0.0.1:${daemon.port}`,
        authorization: `Bearer ${daemon.agentToken}`,
      },
    });
    const body = (await minted.json()) as { launchUrl: string };
    // First redemption succeeds.
    const first = await fetch(body.launchUrl, {
      redirect: "manual",
      headers: { host: `127.0.0.1:${daemon.port}` },
    });
    expect(first.status).toBe(302);
    // Second redemption fails — the code was consumed.
    const second = await fetch(body.launchUrl, {
      redirect: "manual",
      headers: { host: `127.0.0.1:${daemon.port}` },
    });
    expect(second.status).toBe(403);
  });

  test("MUTATION: a code past its TTL is refused as expired", async () => {
    // Boot a fresh daemon with a very short TTL so we can exceed it
    // without a slow test.
    const shortRoot = mkdtempSync(join(tmpdir(), "revkit-lc-short-"));
    mkdirSync(join(shortRoot, "dist"), { recursive: true });
    writeFileSync(join(shortRoot, "dist", "index.html"), "<h1>x</h1>");
    let now = 0;
    const shortDaemon = await startDaemon({
      dir: join(shortRoot, "dist"),
      repoRoot: shortRoot,
      port: 0,
      sqlitePath: ":memory:",
      version: "0.0.0-test",
      localUserId: "local-test",
      installSignalHandlers: false,
      logSink: { write: () => {} },
      launchCodeTtlMs: 100,
      nowMs: () => now,
    });
    try {
      const minted = await fetch(shortDaemon.url + "/-/launch-code", {
        method: "POST",
        headers: {
          host: `127.0.0.1:${shortDaemon.port}`,
          authorization: `Bearer ${shortDaemon.agentToken}`,
        },
      });
      const body = (await minted.json()) as { launchUrl: string };
      // Advance well past the 100 ms TTL.
      now = 200_000;
      const redemption = await fetch(body.launchUrl, {
        redirect: "manual",
        headers: { host: `127.0.0.1:${shortDaemon.port}` },
      });
      expect(redemption.status).toBe(403);
    } finally {
      await shortDaemon.stop();
      rmSync(shortRoot, { recursive: true, force: true });
    }
  });

  test("deep-link: redirect honours a safe `next` path", async () => {
    // Seed a static file in the dist tree, mint a launch code with
    // `next=/deep.html`, and assert the 302 lands there.
    writeFileSync(join(root, "dist", "deep.html"), "<h1>deep</h1>");
    const minted = await fetch(daemon.url + "/-/launch-code", {
      method: "POST",
      headers: {
        host: `127.0.0.1:${daemon.port}`,
        authorization: `Bearer ${daemon.agentToken}`,
      },
    });
    const body = (await minted.json()) as { launchUrl: string };
    const url = new URL(body.launchUrl);
    url.searchParams.set("next", "/deep.html");
    const redemption = await fetch(url, {
      redirect: "manual",
      headers: { host: `127.0.0.1:${daemon.port}` },
    });
    expect(redemption.status).toBe(302);
    expect(redemption.headers.get("location")).toBe("/deep.html");
  });

  test("MUTATION: `next=` is REJECTED for open-redirect-shaped values", async () => {
    // Every hostile shape must fall back to `/` — no protocol-
    // relative, no scheme, no backslash, no control chars, no
    // path escape.
    const hostileNexts = [
      "//evil.example",           // protocol-relative
      "/\\evil.example",          // path escape
      "%2F%2Fevil",               // percent-encoded //
      "/%5Cevil",                 // percent-encoded backslash
      "https://evil.example",     // scheme
      "javascript:alert(1)",      // scheme
      "/a\\b",                    // embedded backslash
      "/x\x00null",               // control char
      "/../etc/passwd",           // path traversal
    ];
    for (const hostile of hostileNexts) {
      const minted = await fetch(daemon.url + "/-/launch-code", {
        method: "POST",
        headers: {
          host: `127.0.0.1:${daemon.port}`,
          authorization: `Bearer ${daemon.agentToken}`,
        },
      });
      const body = (await minted.json()) as { launchUrl: string };
      const url = new URL(body.launchUrl);
      url.searchParams.set("next", hostile);
      const redemption = await fetch(url, {
        redirect: "manual",
        headers: { host: `127.0.0.1:${daemon.port}` },
      });
      // If the daemon accepted (2xx/3xx to the code), the location
      // MUST be `/`. If it refused the code (single-use consumed
      // earlier), it returns 403 — also acceptable for this test's
      // point (no open-redirect leaked). Any location OTHER than
      // `/` means the guard failed.
      const location = redemption.headers.get("location");
      if (redemption.status === 302) {
        expect(location, `hostile next '${hostile}' leaked to location`).toBe("/");
      } else {
        // Non-302 is also safe: the guard refused before the
        // redirect.
        expect([400, 403]).toContain(redemption.status);
      }
    }
  });

  test("deep-link: `next=/ask/<id>` is honoured (M2 item 7 — ask page is a daemon-virtual route, not a static file)", async () => {
    // A daemon-virtual route (/ask/<id>) does not exist in the
    // static dir, so the launch-code exchange must not fall back to
    // `/`. The redirect target is validated by structural id shape
    // (idSchema) so no scary characters get through.
    const minted = await fetch(daemon.url + "/-/launch-code", {
      method: "POST",
      headers: {
        host: `127.0.0.1:${daemon.port}`,
        authorization: `Bearer ${daemon.agentToken}`,
      },
    });
    const body = (await minted.json()) as { launchUrl: string };
    const url = new URL(body.launchUrl);
    url.searchParams.set("next", "/ask/ask-example-abc");
    const redemption = await fetch(url, {
      redirect: "manual",
      headers: { host: `127.0.0.1:${daemon.port}` },
    });
    expect(redemption.status).toBe(302);
    expect(redemption.headers.get("location")).toBe("/ask/ask-example-abc");
  });

  test("MUTATION: `next=/ask/<bad-id>` falls back to `/` — idSchema still gates the target", async () => {
    // A `/ask/<...>` path with a bad-shape id must NOT be honoured.
    const minted = await fetch(daemon.url + "/-/launch-code", {
      method: "POST",
      headers: {
        host: `127.0.0.1:${daemon.port}`,
        authorization: `Bearer ${daemon.agentToken}`,
      },
    });
    const body = (await minted.json()) as { launchUrl: string };
    const url = new URL(body.launchUrl);
    // Contains a `<` — refused by idSchema.
    url.searchParams.set("next", "/ask/<script>");
    const redemption = await fetch(url, {
      redirect: "manual",
      headers: { host: `127.0.0.1:${daemon.port}` },
    });
    expect(redemption.status).toBe(302);
    expect(redemption.headers.get("location")).toBe("/");
  });

  test("startup launch code and a fresh minted code are independent (using one does not spend the other)", async () => {
    // Redeem the startup code — success.
    const startupUse = await fetch(daemon.launchUrl, {
      redirect: "manual",
      headers: { host: `127.0.0.1:${daemon.port}` },
    });
    expect(startupUse.status).toBe(302);
    // Mint a fresh one — it must still work.
    const mintedResp = await fetch(daemon.url + "/-/launch-code", {
      method: "POST",
      headers: {
        host: `127.0.0.1:${daemon.port}`,
        authorization: `Bearer ${daemon.agentToken}`,
      },
    });
    const body = (await mintedResp.json()) as { launchUrl: string };
    const fresh = await fetch(body.launchUrl, {
      redirect: "manual",
      headers: { host: `127.0.0.1:${daemon.port}` },
    });
    expect(fresh.status).toBe(302);
  });
});
