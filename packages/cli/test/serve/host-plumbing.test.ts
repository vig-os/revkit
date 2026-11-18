// #245 — four gaps the #281 review flagged in the shared request
// handler, now closed. Each test covers one acceptance criterion and
// MUST fail against the pre-#245 handler:
//
//   - **Base path.** `stripBasePath` strips the configured prefix
//     before routing, so a sub-path deployment serves the API,
//     `/events`, `/-/rail.js` and the site root. Confusion probes
//     (`/reviewer` against `/review`; `/reviewapi/*`; encoded slash)
//     stay 404.
//   - **Transport peer.** The real `Bun.serve` socket's peer address
//     reaches the `AuthProvider` — a `trusted-proxy` peer allowlist
//     enforces end-to-end, through the real listener, not a stub.
//   - **403 vs 401.** An untrusted peer gets 403; a missing subject
//     gets 401. The dispatcher no longer collapses every provider
//     refusal to 401.
//   - **CSP from the public origin.** `Content-Security-Policy` on
//     HTML responses under the host policy names the configured
//     public origin, not a loopback port, and prefixes script paths
//     with the base path on a sub-path deployment.
//
// The handler lives behind `startDaemon` — these tests compose it
// through the ADR-0026 seams exposed by `@revkit/cli/serve`, so no
// new listener is introduced yet (#245 host entry/CLI lands in a
// follow-up). The real `Bun.serve` binds to 127.0.0.1, which is the
// peer address the trusted-proxy allowlist is tested against.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTrustedProxyAuthProvider } from "@revkit/review-core";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";
import {
  createPublicOriginGuardPolicy,
  createStaticIdentityResolver,
  HOST_TARGET_ROUTE_GROUPS,
  createAuthProviderIdentityResolver,
} from "../../src/serve/index.ts";

const STUB_ACTOR = Object.freeze({
  kind: "local" as const,
  id: "stub-subject",
  displayName: "Stub Reviewer",
});

interface Ctx {
  handle: DaemonHandle;
  root: string;
  /** Configured public origin — may include a base path (e.g.
   * `http://review.example.com/review`). The policy derives the
   * basePath from this. */
  publicOrigin: string;
  /** `Origin` header the browser actually sends — scheme + host
   * only, no path (ADR-0026 §Request checks matches Origin's
   * no-path shape). */
  originHeader: string;
  publicHost: string;
}

async function startSubPath(publicOrigin: string, publicHost: string, extra: Partial<Parameters<typeof startDaemon>[0]> = {}): Promise<Ctx> {
  const root = mkdtempSync(join(tmpdir(), "revkit-245-"));
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  // Seed index.html with absolute-path references the rewrite will
  // pick up: a rail-adjacent script tag plus an inline JS literal.
  // The `<head>` is required for `injectRail` to attach the rail
  // bundle tag (HTMLRewriter's `head` selector).
  writeFileSync(
    join(dist, "index.html"),
    "<!doctype html><html><head><title>revkit-245</title></head><body>"
      + "<link rel=\"stylesheet\" href=\"/styles.css\">"
      + "<script>fetch(\"/api/threads\")</script>"
      + "<h1>root</h1>"
      + "</body></html>",
  );
  const parsed = new URL(publicOrigin);
  const originHeader = `${parsed.protocol}//${parsed.host}`;
  const handle = await startDaemon({
    dir: dist,
    repoRoot: root,
    port: 0,
    sqlitePath: ":memory:",
    version: "0.0.0-245-test",
    localUserId: "245-local",
    installSignalHandlers: false,
    logSink: { write: () => {} },
    guardPolicy: createPublicOriginGuardPolicy({ publicOrigin }),
    routeGroups: HOST_TARGET_ROUTE_GROUPS,
    identityResolver: createStaticIdentityResolver({ actor: STUB_ACTOR }),
    enableBackgroundBuild: false,
    ...extra,
  });
  return { handle, root, publicOrigin, originHeader, publicHost };
}

async function stop(ctx: Ctx): Promise<void> {
  await ctx.handle.stop();
  rmSync(ctx.root, { recursive: true, force: true });
}

describe("#245 — base-path stripping (sub-path deployment)", () => {
  // Fresh ctx per test — each exercises its own deployment URL.
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await startSubPath("http://review.example.com/review", "review.example.com");
  });
  afterEach(async () => {
    await stop(ctx);
  });

  test("routes GET under the prefix after stripping", async () => {
    // Without the strip this request lands in the static branch and
    // 404s (no file at /review/api/threads). The pre-#245 gate let it
    // in but failed to rewrite `url.pathname`, so every dispatch
    // check against `/api/threads` missed. 200 now.
    const response = await fetch(`${ctx.handle.url}/review/api/threads`, {
      headers: { host: ctx.publicHost, origin: ctx.originHeader },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { threads: unknown[]; head: number };
    expect(Array.isArray(body.threads)).toBe(true);
  });

  test("routes SSE under the prefix", async () => {
    const response = await fetch(`${ctx.handle.url}/review/events?since=0`, {
      headers: { host: ctx.publicHost, origin: ctx.originHeader },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    // Read one frame to confirm the stream is live.
    const chunk = await reader!.read();
    expect(chunk.done).toBe(false);
    await reader!.cancel();
  });

  test("serves assets under the prefix", async () => {
    // The rail bundle is served by the daemon at `/-/rail.js`; the
    // host listener exposes it at `/review/-/rail.js`. The strip is
    // what routes it to `handleRailAsset`.
    const response = await fetch(`${ctx.handle.url}/review/-/rail.js`, {
      headers: { host: ctx.publicHost, origin: ctx.originHeader },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
  });

  test("serves the site root under the prefix (and rewrites absolute paths)", async () => {
    const response = await fetch(`${ctx.handle.url}/review/`, {
      headers: { host: ctx.publicHost, origin: ctx.originHeader },
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    // Absolute-path references are prefixed with `/review` so the
    // browser resolves them against the proxy's one base URL. The
    // rewrite must be idempotent — no double prefix.
    expect(body).toContain("href=\"/review/styles.css\"");
    expect(body).not.toContain("href=\"/styles.css\"");
    expect(body).not.toContain("/review/review/");
    // The rail bundle `<script>` tag is injected on HTML — its src
    // must carry the prefix too.
    expect(body).toMatch(/src="\/review\/-\/rail\.js"/);
  });

  test("trailing slash on the prefix maps to the root", async () => {
    // `/review/` is handled by the trailing-slash branch of
    // `stripBasePath`; the response status is what matters here, not
    // the body — covered in the previous case.
    const response = await fetch(`${ctx.handle.url}/review/`, {
      headers: { host: ctx.publicHost, origin: ctx.originHeader },
    });
    expect(response.status).toBe(200);
    await response.body?.cancel();
  });

  test("bare prefix (no trailing slash) maps to the root", async () => {
    // `/review` (exact) is the first branch of `stripBasePath`.
    const response = await fetch(`${ctx.handle.url}/review`, {
      headers: { host: ctx.publicHost, origin: ctx.originHeader },
    });
    expect(response.status).toBe(200);
    await response.body?.cancel();
  });

  test("prefix confusion probe `/reviewer` is 404", async () => {
    // Pre-#245 the gate accepted `/reviewer` as "inside the prefix"
    // if the implementation used `.startsWith(basePath)`; the
    // exact-or-slash rule refuses it.
    const response = await fetch(`${ctx.handle.url}/reviewer/api/threads`, {
      headers: { host: ctx.publicHost, origin: ctx.originHeader },
    });
    expect(response.status).toBe(404);
  });

  test("prefix confusion probe `/reviewapi` is 404", async () => {
    const response = await fetch(`${ctx.handle.url}/reviewapi/threads`, {
      headers: { host: ctx.publicHost, origin: ctx.originHeader },
    });
    expect(response.status).toBe(404);
  });

  test("encoded slash `%2F` does not bypass the prefix check", async () => {
    // `/review%2Fapi/threads` keeps `%2F` in the WHATWG URL pathname,
    // so `startsWith("/review/")` fails and the request 404s
    // instead of being decoded into a routed prefix match.
    const response = await fetch(`${ctx.handle.url}/review%2Fapi/threads`, {
      headers: { host: ctx.publicHost, origin: ctx.originHeader },
    });
    expect(response.status).toBe(404);
  });
});

describe("#245 — rail bundle body rewrite under a sub-path deployment", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await startSubPath("http://review.example.com/review", "review.example.com");
  });
  afterEach(async () => {
    await stop(ctx);
  });

  test("absolute-path references in rail.js carry the base-path prefix", async () => {
    const response = await fetch(`${ctx.handle.url}/review/-/rail.js`, {
      headers: { host: ctx.publicHost, origin: ctx.originHeader },
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    // The rail bundle contains runtime references like
    // `fetch("/api/events-head")` and `new EventSource("/events")`.
    // Under a sub-path deployment the browser opens
    // `${publicOrigin}/review/...`, so those absolute paths must
    // carry `/review`. Idempotent — no `//` or `/review/review/`.
    expect(body).toContain("/review/api/threads");
    expect(body).toContain("/review/api/events-head");
    expect(body).toContain("/review/events");
    expect(body).not.toContain("/review/review/");
  });
});

describe("#245 — CSP derives from the public origin, not the loopback port", () => {
  async function fetchCspUnder(basePath: string): Promise<string> {
    const ctx = await startSubPath(
      `http://review.example.com${basePath}`,
      "review.example.com",
    );
    try {
      const path = basePath === "" ? "/" : `${basePath}/`;
      const response = await fetch(`${ctx.handle.url}${path}`, {
        headers: { host: ctx.publicHost, origin: ctx.originHeader },
      });
      expect(response.status).toBe(200);
      const csp = response.headers.get("content-security-policy") ?? "";
      await response.body?.cancel();
      return csp;
    } finally {
      await stop(ctx);
    }
  }

  test("vhost deployment — script-src names the configured public origin", async () => {
    const csp = await fetchCspUnder("");
    // The policy exposes http://review.example.com — the CSP must
    // name it. The old port-derived CSP named a loopback port the
    // browser never reaches under a reverse proxy.
    expect(csp).toContain("http://review.example.com/-/rail.js");
    expect(csp).toContain("http://review.example.com/_astro/");
    expect(csp).toContain("http://review.example.com/pagefind/");
    // No loopback leak.
    expect(csp).not.toMatch(/http:\/\/127\.0\.0\.1:/);
    expect(csp).not.toMatch(/http:\/\/localhost:/);
    // connect-src includes the ws:// twin (older WebKit builds; the
    // same rule the loopback side carried, re-keyed to the host
    // origin).
    expect(csp).toContain("ws://review.example.com");
  });

  test("sub-path deployment — script-src paths carry the base-path prefix", async () => {
    const csp = await fetchCspUnder("/review");
    // `/review/-/rail.js`, not `/-/rail.js` — the browser requests
    // the prefixed path, so CSP must match it or the browser refuses
    // the script.
    expect(csp).toContain("http://review.example.com/review/-/rail.js");
    expect(csp).toContain("http://review.example.com/review/_astro/");
    expect(csp).toContain("http://review.example.com/review/pagefind/");
    // worker-src must cover `/review/pagefind/` too.
    expect(csp).toContain("worker-src http://review.example.com/review/pagefind/");
  });
});

describe("#245 — transport peer flows through the real listener; 403 vs 401", () => {
  // These tests spin the daemon up on 127.0.0.1 and drive it with
  // the real `trusted-proxy` provider. The listener's peer address
  // is 127.0.0.1, so the allowlist decisions are exercised through
  // the actual Bun.serve socket — not a unit-level stub.

  test("trusted peer + subject header → 200 (peer address flows end-to-end)", async () => {
    const provider = createTrustedProxyAuthProvider({
      headers: { subject: "x-auth-user", displayName: "x-auth-name" },
      trust: { kind: "peers", peers: ["127.0.0.1", "::1"] },
    });
    const ctx = await startSubPath(
      "http://review.example.com",
      "review.example.com",
      { identityResolver: createAuthProviderIdentityResolver({ provider }) },
    );
    try {
      const response = await fetch(`${ctx.handle.url}/api/threads`, {
        headers: {
          host: ctx.publicHost,
          origin: ctx.originHeader,
          "x-auth-user": "alice",
          "x-auth-name": "Alice Example",
        },
      });
      expect(response.status).toBe(200);
      await response.body?.cancel();
    } finally {
      await stop(ctx);
    }
  });

  test("untrusted peer → 403 (NOT 401) via the real listener", async () => {
    // The daemon binds to 127.0.0.1, which is not on the allowlist.
    // The provider refuses with `untrusted-peer` / 403 BEFORE the
    // subject header is read. Pre-#245 the dispatcher collapsed
    // this to 401 (`identifyActor` discarded the status), hiding a
    // misconfigured allowlist as a missing-credential outage.
    const provider = createTrustedProxyAuthProvider({
      headers: { subject: "x-auth-user" },
      trust: { kind: "peers", peers: ["192.0.2.10"] },
    });
    const ctx = await startSubPath(
      "http://review.example.com",
      "review.example.com",
      { identityResolver: createAuthProviderIdentityResolver({ provider }) },
    );
    try {
      const response = await fetch(`${ctx.handle.url}/api/threads`, {
        headers: {
          host: ctx.publicHost,
          origin: ctx.originHeader,
          "x-auth-user": "alice",
        },
      });
      expect(response.status).toBe(403);
      await response.body?.cancel();
    } finally {
      await stop(ctx);
    }
  });

  test("trusted peer + missing subject header → 401 (NOT 403) via the real listener", async () => {
    const provider = createTrustedProxyAuthProvider({
      headers: { subject: "x-auth-user" },
      trust: { kind: "peers", peers: ["127.0.0.1", "::1"] },
    });
    const ctx = await startSubPath(
      "http://review.example.com",
      "review.example.com",
      { identityResolver: createAuthProviderIdentityResolver({ provider }) },
    );
    try {
      const response = await fetch(`${ctx.handle.url}/api/threads`, {
        headers: { host: ctx.publicHost, origin: ctx.originHeader },
      });
      expect(response.status).toBe(401);
      await response.body?.cancel();
    } finally {
      await stop(ctx);
    }
  });

  test("peer-less resolver call fails closed (`no-peer`)", async () => {
    // A dispatcher that never passed a peer into resolve() — or a
    // resolver constructed without a fallback peer — must refuse
    // rather than default to a transport the provider may trust.
    // This is pinned at the resolver level too (`identity-resolver.ts`),
    // but driving it through the dispatcher proves the default
    // `peerFor` in daemon.ts does supply a peer to every call, so
    // production code never triggers this branch inadvertently.
    const provider = createTrustedProxyAuthProvider({
      headers: { subject: "x-auth-user" },
      trust: { kind: "peers", peers: ["127.0.0.1"] },
    });
    const resolver = createAuthProviderIdentityResolver({ provider });
    const outcome = await resolver.resolve(
      new Request("http://review.example.com/api/threads", {
        headers: { "x-auth-user": "alice" },
      }),
    );
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.status).toBe(401);
      expect(outcome.reason).toBe("no-peer");
    }
  });
});
