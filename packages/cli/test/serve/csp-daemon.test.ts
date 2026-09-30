// Integration tests: `revkit serve` attaches the ADR-0012 CSP and
// hygiene headers (issue #22) to every response. Each guard has a
// mutation partner in `headers.test.ts` (unit-level); this suite
// exercises the same headers END TO END on the real daemon so a
// refactor that forgets to route a branch through `withHygiene` is
// caught here.
//
// Every test starts the daemon in-process against a random port and
// a temporary dir (site/dist shape). The handle's `stop()` is
// idempotent; `finally` closes it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";
import { CSP_HASHES_ARTEFACT_PATH } from "../../src/serve/csp-hashes.ts";
import { hexToBase64 } from "../../src/serve/headers.ts";

const H_STARLIGHT = "9d53bdf1619d240e72ba9d7f30076e906a94952e8fb2e7fb249145e62916a9b4";

interface Ctx {
  handle: DaemonHandle;
  root: string;
  dist: string;
}

async function startCtx(
  hashes: readonly string[] | "no-artefact",
): Promise<Ctx> {
  const root = mkdtempSync(join(tmpdir(), "revkit-csp-daemon-"));
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><html><head><title>ok</title></head><body><h1>ok</h1></body></html>");
  writeFileSync(join(dist, "app.js"), "console.log('ok')");
  // Emit the CSP hashes artefact where the daemon looks for it, or
  // deliberately leave it missing to exercise the fail-closed path.
  if (hashes !== "no-artefact") {
    mkdirSync(join(dist, ".revkit"), { recursive: true });
    writeFileSync(
      join(dist, CSP_HASHES_ARTEFACT_PATH),
      JSON.stringify({ version: 1, algorithm: "sha256", hashes }),
    );
  }
  const handle = await startDaemon({
    dir: dist,
    repoRoot: root,
    port: 0,
    sqlitePath: ":memory:",
    version: "0.0.0-test",
    localUserId: "local-test",
    installSignalHandlers: false,
    logSink: { write: () => {} },
  });
  return { handle, root, dist };
}

async function stopCtx(ctx: Ctx): Promise<void> {
  await ctx.handle.stop();
  rmSync(ctx.root, { recursive: true, force: true });
}

let ctxRef: Ctx | undefined;

// A shared handle keeps the test file cheap: each test resets a
// piece of state on the shared daemon; only the artefact-missing
// case starts its own daemon.
beforeEach(async () => {
  ctxRef = await startCtx([H_STARLIGHT]);
});
afterEach(async () => {
  if (ctxRef !== undefined) {
    await stopCtx(ctxRef);
    ctxRef = undefined;
  }
});

describe("HTML responses carry the ADR-0012 CSP", () => {
  test("GET / carries CSP with default-src 'none', path-scoped script-src and the loaded hash", async () => {
    const ctx = ctxRef!;
    const r = await fetch(ctx.handle.url + "/", {
      headers: { host: `127.0.0.1:${ctx.handle.port}` },
    });
    expect(r.status).toBe(200);
    const csp = r.headers.get("content-security-policy");
    expect(csp).not.toBeNull();
    expect(csp!).toContain("default-src 'none'");
    expect(csp!).toContain(`http://127.0.0.1:${ctx.handle.port}/-/rail.js`);
    expect(csp!).toContain(`http://127.0.0.1:${ctx.handle.port}/_astro/`);
    // Loaded hash appears in base64 form (CSP hash-source syntax).
    expect(csp!).toContain(`'sha256-${hexToBase64(H_STARLIGHT)}'`);
  });

  test("hygiene triplet lands on the HTML response too", async () => {
    const ctx = ctxRef!;
    const r = await fetch(ctx.handle.url + "/", {
      headers: { host: `127.0.0.1:${ctx.handle.port}` },
    });
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(r.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    // Permissions-Policy denies a representative sample; the full
    // list is enforced in headers.test.ts.
    expect(r.headers.get("permissions-policy")).toContain("camera=()");
  });
});

describe("asset responses (JS, CSS, error text) skip CSP but keep hygiene", () => {
  test("GET /app.js does NOT carry CSP (browsers apply the embedding doc's CSP)", async () => {
    const ctx = ctxRef!;
    const r = await fetch(ctx.handle.url + "/app.js", {
      headers: { host: `127.0.0.1:${ctx.handle.port}` },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toBeNull();
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  test("4xx text bodies still carry the hygiene triplet (a scanner probing the daemon still gets nosniff)", async () => {
    const ctx = ctxRef!;
    const r = await fetch(ctx.handle.url + "/missing.html", {
      headers: { host: `127.0.0.1:${ctx.handle.port}` },
    });
    expect(r.status).toBe(404);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("API + launch-code + SSE cache discipline", () => {
  test("/-/health is JSON with Cache-Control: no-store", async () => {
    const ctx = ctxRef!;
    const r = await fetch(ctx.handle.url + "/-/health", {
      headers: { host: `127.0.0.1:${ctx.handle.port}` },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("/-/launch-code (POST, bearer) carries Cache-Control: no-store", async () => {
    const ctx = ctxRef!;
    const r = await fetch(ctx.handle.url + "/-/launch-code", {
      method: "POST",
      headers: {
        host: `127.0.0.1:${ctx.handle.port}`,
        authorization: `Bearer ${ctx.handle.agentToken}`,
      },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  test("/-/auth 302 carries Cache-Control: no-store on the Set-Cookie response", async () => {
    const ctx = ctxRef!;
    const r = await fetch(ctx.handle.url + "/-/auth?code=" + ctx.handle.launchCode, {
      redirect: "manual",
      headers: { host: `127.0.0.1:${ctx.handle.port}` },
    });
    expect(r.status).toBe(302);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("set-cookie")).toContain("HttpOnly");
  });

  test("/events keeps its `no-cache, no-transform` (stream-friendly), not overwritten to no-store", async () => {
    const ctx = ctxRef!;
    const r = await fetch(ctx.handle.url + "/events?for=agent", {
      headers: {
        host: `127.0.0.1:${ctx.handle.port}`,
        authorization: `Bearer ${ctx.handle.agentToken}`,
      },
    });
    expect(r.status).toBe(200);
    // Read one keepalive frame then close; otherwise the fetch
    // hangs until the daemon closes.
    const reader = r.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(r.headers.get("cache-control")).toBe("no-cache, no-transform");
  });
});

describe("fail-closed CSP: artefact missing means script-src carries no inline hashes", () => {
  test("no csp-hashes.json: the CSP header still ships, but with zero 'sha256-...' sources", async () => {
    // This subtest starts its own daemon; the shared setup already
    // wrote an artefact. Close the shared one first so the two do
    // not collide on the lock (`.revkit/daemon.lock`).
    await stopCtx(ctxRef!);
    ctxRef = await startCtx("no-artefact");
    const ctx = ctxRef;
    const r = await fetch(ctx.handle.url + "/", {
      headers: { host: `127.0.0.1:${ctx.handle.port}` },
    });
    expect(r.status).toBe(200);
    const csp = r.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("'sha256-");
  });
});
