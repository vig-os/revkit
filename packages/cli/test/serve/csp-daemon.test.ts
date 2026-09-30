// Integration tests: `revkit serve` attaches the ADR-0012 CSP and
// hygiene headers (issue #22) to every response, and REFUSES to load
// its inline-script allowlist from anything the served dir carries
// (ADR-0012 rule "the daemon applies the allowlist of the revkit
// version it runs, never hashes found in an artifact").
//
// Every test starts the daemon in-process against a random port and
// a temporary dir (site/dist shape). The handle's `stop()` is
// idempotent; `finally` closes it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";
import { hexToBase64 } from "../../src/serve/headers.ts";
import ALLOWLIST_JSON from "../../src/dist-check-allowlist.json" with { type: "json" };

/** One of the SHA-256 hex hashes the CURRENT revkit version
 * allowlists — used to assert the daemon's CSP carries them. */
const CURRENT_ALLOWLIST_HASHES: readonly string[] = Object.keys(
  (ALLOWLIST_JSON as unknown as { sha256: Record<string, unknown> }).sha256,
);

/** A forged hash the daemon MUST NEVER honour — it appears only in a
 * fake `.revkit/csp-hashes.json` file inside the served dir, the
 * shape ADR-0012 forbids the daemon from trusting. Not a real
 * SHA-256 digest of anything; the daemon's CSP must not carry it. */
const FORGED_HEX = "deadbeef".repeat(8);

interface Ctx {
  handle: DaemonHandle;
  root: string;
  dist: string;
}

async function startCtx(opts: { withForgedArtefact?: boolean } = {}): Promise<Ctx> {
  const root = mkdtempSync(join(tmpdir(), "revkit-csp-daemon-"));
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><html><head><title>ok</title></head><body><h1>ok</h1></body></html>");
  writeFileSync(join(dist, "app.js"), "console.log('ok')");
  if (opts.withForgedArtefact === true) {
    // Plant a `.revkit/csp-hashes.json` that names a forged hex
    // digest. The daemon MUST ignore this file entirely and use its
    // committed allowlist.
    mkdirSync(join(dist, ".revkit"), { recursive: true });
    writeFileSync(
      join(dist, ".revkit", "csp-hashes.json"),
      JSON.stringify({ version: 1, algorithm: "sha256", hashes: [FORGED_HEX] }),
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

beforeEach(async () => {
  ctxRef = await startCtx();
});
afterEach(async () => {
  if (ctxRef !== undefined) {
    await stopCtx(ctxRef);
    ctxRef = undefined;
  }
});

describe("HTML responses carry the ADR-0012 CSP", () => {
  test("GET / carries CSP with default-src 'none', path-scoped script-src, and the committed inline-script hashes", async () => {
    const ctx = ctxRef!;
    const r = await fetch(ctx.handle.url + "/", {
      headers: { host: `127.0.0.1:${ctx.handle.port}` },
    });
    expect(r.status).toBe(200);
    const csp = r.headers.get("content-security-policy");
    expect(csp).not.toBeNull();
    expect(csp!).toContain("default-src 'none'");
    // Both loopback aliases must appear.
    for (const origin of [`http://127.0.0.1:${ctx.handle.port}`, `http://localhost:${ctx.handle.port}`]) {
      expect(csp!).toContain(`${origin}/-/rail.js`);
      expect(csp!).toContain(`${origin}/_astro/`);
      expect(csp!).toContain(`${origin}/pagefind/`);
    }
    // At least one of the committed hashes must appear (base64).
    for (const hex of CURRENT_ALLOWLIST_HASHES) {
      expect(csp!).toContain(`'sha256-${hexToBase64(hex)}'`);
    }
    // Path-scoped to /pagefind/ on BOTH loopback aliases (M2 item 5b
    // carry-over from #41 review — closes the "any Worker" hole).
    // The header carries a single `worker-src` directive listing
    // both origins after the prefix.
    expect(csp!).toContain(
      `worker-src http://127.0.0.1:${ctx.handle.port}/pagefind/ http://localhost:${ctx.handle.port}/pagefind/`,
    );
    // Sanity: the previous `worker-src 'self'` is gone.
    expect(csp!).not.toContain("worker-src 'self'");
    expect(csp!).toContain("'wasm-unsafe-eval'");
  });

  test("BYTE-EXACT: full CSP header on GET / matches the pinned form", async () => {
    // A byte-exact assertion catches directive-ordering drifts and
    // stray whitespace mutations. Rebuilt here from the same input
    // the daemon uses (committed allowlist) and asserted verbatim.
    const ctx = ctxRef!;
    const r = await fetch(ctx.handle.url + "/", {
      headers: { host: `127.0.0.1:${ctx.handle.port}` },
    });
    const csp = r.headers.get("content-security-policy")!;
    const port = ctx.handle.port;
    const sortedHashes = Array.from(new Set(CURRENT_ALLOWLIST_HASHES)).sort();
    const hashSources = sortedHashes.map((hex) => `'sha256-${hexToBase64(hex)}'`).join(" ");
    const expected =
      "default-src 'none'; " +
      "script-src " +
        `http://127.0.0.1:${port}/-/rail.js ` +
        `http://127.0.0.1:${port}/-/ask.js ` +
        `http://127.0.0.1:${port}/_astro/ ` +
        `http://127.0.0.1:${port}/pagefind/ ` +
        `http://localhost:${port}/-/rail.js ` +
        `http://localhost:${port}/-/ask.js ` +
        `http://localhost:${port}/_astro/ ` +
        `http://localhost:${port}/pagefind/ ` +
        "'wasm-unsafe-eval' " +
        hashSources + "; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: https://avatars.githubusercontent.com; " +
      "font-src 'self'; " +
      `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}; ` +
      `worker-src http://127.0.0.1:${port}/pagefind/ http://localhost:${port}/pagefind/; ` +
      "frame-ancestors 'none'; " +
      "base-uri 'none'; " +
      "form-action 'self'; " +
      "object-src 'none'";
    expect(csp).toBe(expected);
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
    expect(r.headers.get("permissions-policy")).toContain("camera=()");
  });
});

describe("Non-HTML responses: hygiene always applies; CSP only on document-shaped kinds (SVG, XML)", () => {
  test("GET /app.js carries NO CSP header (a Worker loading it would otherwise inherit `default-src 'none'` and its own fetch would fail — issue #22 review)", async () => {
    const ctx = ctxRef!;
    const r = await fetch(ctx.handle.url + "/app.js", {
      headers: { host: `127.0.0.1:${ctx.handle.port}` },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toBeNull();
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  test("4xx text bodies carry hygiene but no CSP (a text/plain body is not a document)", async () => {
    const ctx = ctxRef!;
    const r = await fetch(ctx.handle.url + "/missing.html", {
      headers: { host: `127.0.0.1:${ctx.handle.port}` },
    });
    expect(r.status).toBe(404);
    expect(r.headers.get("content-security-policy")).toBeNull();
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("SVG carries `default-src 'none'; frame-ancestors 'none'; sandbox` (ADR-0012 SVG handling)", async () => {
    const ctx = ctxRef!;
    writeFileSync(join(ctx.dist, "shape.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
    const r = await fetch(ctx.handle.url + "/shape.svg", {
      headers: { host: `127.0.0.1:${ctx.handle.port}` },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/svg+xml");
    expect(r.headers.get("content-security-policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'; sandbox",
    );
  });

  test("XML carries the minimal CSP (no sandbox)", async () => {
    const ctx = ctxRef!;
    writeFileSync(join(ctx.dist, "sitemap.xml"), '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>');
    const r = await fetch(ctx.handle.url + "/sitemap.xml", {
      headers: { host: `127.0.0.1:${ctx.handle.port}` },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
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
    const reader = r.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(r.headers.get("cache-control")).toBe("no-cache, no-transform");
  });
});

describe("ADR-0012 rule: the daemon IGNORES any hash artefact the served dir carries", () => {
  test("a forged `.revkit/csp-hashes.json` is NOT trusted — the CSP still names only the committed hashes", async () => {
    // Close the shared daemon and start a new one whose --dir ships
    // a hostile hash file. The forged hash MUST NOT appear in the
    // header; the committed set MUST still appear. Belt-and-braces:
    // the daemon's `.revkit/csp-hashes.json` MUST also be
    // reachable as a public asset only through the normal MIME
    // allowlist (the file is `.json`, which the allowlist covers)
    // — but the daemon must not INTERPRET it.
    await stopCtx(ctxRef!);
    ctxRef = await startCtx({ withForgedArtefact: true });
    const ctx = ctxRef;
    const r = await fetch(ctx.handle.url + "/", {
      headers: { host: `127.0.0.1:${ctx.handle.port}` },
    });
    expect(r.status).toBe(200);
    const csp = r.headers.get("content-security-policy")!;
    // Forged hash absent.
    expect(csp).not.toContain(hexToBase64(FORGED_HEX));
    // Committed hashes present.
    for (const hex of CURRENT_ALLOWLIST_HASHES) {
      expect(csp).toContain(`'sha256-${hexToBase64(hex)}'`);
    }
  });
});
