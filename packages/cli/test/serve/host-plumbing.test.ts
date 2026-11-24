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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTrustedProxyAuthProvider, type AuthRequestPeer } from "@revkit/review-core";
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
  // The site build is the one responsible for prefixed URLs
  // (#245 part 1 round 3 DECISION a): under a sub-path deployment
  // Astro emits every asset href with the prefix already applied,
  // so the index fixture carries the prefix inline — the daemon
  // never rewrites the body.
  const basePrefix = new URL(publicOrigin).pathname.replace(/\/+$/u, "");
  writeFileSync(
    join(dist, "index.html"),
    "<!doctype html><html><head>"
      + `<meta name="revkit-base" content="${basePrefix}/">`
      + "<title>revkit-245</title>"
      + "</head><body>"
      + `<link rel="stylesheet" href="${basePrefix}/styles.css">`
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
  // One daemon shared across every routing probe here — these are
  // read-only GETs on an empty store, so there is no cross-test
  // leakage. A listener per test was costing ~1.5k file descriptors
  // on the `just test` fd-budget watcher in CI (growth ceiling
  // 1800); nine lifecycles tipped it over.
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await startSubPath("http://review.example.com/review", "review.example.com");
  });
  afterAll(async () => {
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

  test("serves the site root under the prefix; build-time prefixes untouched; injector prefixes its two tags", async () => {
    const response = await fetch(`${ctx.handle.url}/review/`, {
      headers: { host: ctx.publicHost, origin: ctx.originHeader },
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    // The build-time prefix (#245 round 3 DECISION a) is passed
    // through unchanged — the daemon no longer regex-rewrites
    // bodies. Idempotent by construction: no `/review/review/` or
    // any other doubled prefix can appear in the output because
    // the server never adds one.
    expect(body).toContain("href=\"/review/styles.css\"");
    expect(body).not.toContain("/review/review/");
    // The rail `<script>` and `<link>` tags are the ONE place the
    // serve path picks a path-aware href: the injector prepends
    // the policy's `basePath` on its two tags (round 3 DECISION d
    // — this is NOT a body rewrite, only tag composition).
    expect(body).toMatch(/src="\/review\/-\/rail\.js"/);
    expect(body).toMatch(/href="\/review\/-\/rail\.css"/);
    // The meta tag the Astro layout stamps at build time is
    // preserved verbatim — the rail's runtime `revkitUrl` helper
    // reads it on mount.
    expect(body).toContain('<meta name="revkit-base" content="/review/">');
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

  test("round-3: rail.js served under the prefix contains no post-build path mutation", async () => {
    // ADR-0026 §"Plain Linux host / VM" DECISION c + d: the rail
    // bundle is the SAME bytes at every deployment. Every API, SSE
    // and asset URL goes through `revkitUrl(path)`, which reads
    // `<meta name="revkit-base">` the layout stamped at BUILD time.
    // The daemon NEVER rewrites bodies — so the rail bundle served
    // under `/review/-/rail.js` contains NO `/review/` prefix.
    // Reuses this describe's shared daemon rather than a fresh one
    // (`just test` fd-budget growth meter is tight on CI).
    const response = await fetch(`${ctx.handle.url}/review/-/rail.js`, {
      headers: { host: ctx.publicHost, origin: ctx.originHeader },
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("/review/api/");
    expect(body).not.toContain("/review/events");
    expect(body).not.toContain("/review/-/");
    expect(body).toContain("/api/threads");
    expect(body).toContain("/api/events-head");
    expect(body).toContain("/events");
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

  test("dispatcher-level: null peer → 401 no-peer; StartDaemonOptions.peer override reaches the trust check", async () => {
    // Round-3 blocker 3: `peerFor` used to invent `{transport:
    // "tcp", address: "127.0.0.1"}` when `Bun.serve`'s `requestIP`
    // was null. Over a unix-socket listener that is the common
    // case, and an allowlist containing `127.0.0.0/8` would then
    // trust every socket writer — the dispatcher's `no-peer`
    // branch was unreachable. The daemon now returns `undefined`,
    // and the resolver refuses. Drive through `StartDaemonOptions
    // .peer` to inject the peer so we can cover BOTH acceptance
    // criteria in one listener (the brief's acceptance criteria
    // are two: the null-peer fail-closed path AND the
    // `StartDaemonOptions.peer` seam; the `fd-budget` on the
    // packages/cli leg is tight enough that two separate listeners
    // here push it over, see run 45460406850 — share one).
    let next: AuthRequestPeer | undefined = undefined;
    const provider = createTrustedProxyAuthProvider({
      headers: { subject: "x-auth-user" },
      // Covers both the null case (127.0.0.0/8 matches a fabricated
      // loopback peer — the exact shape that would have silently
      // trusted the pre-fix peer) and the override case (10.1.2.3).
      trust: { kind: "peers", peers: ["127.0.0.0/8", "10.1.2.3"] },
    });
    const ctx = await startSubPath(
      "http://review.example.com",
      "review.example.com",
      {
        identityResolver: createAuthProviderIdentityResolver({ provider }),
        peer: () => next,
      },
    );
    try {
      // Case 1: null peer. The allowlist would trust 127.0.0.0/8
      // if the dispatcher silently fabricated one — it must not.
      next = undefined;
      const r1 = await fetch(`${ctx.handle.url}/api/threads`, {
        headers: {
          host: ctx.publicHost,
          origin: ctx.originHeader,
          "x-auth-user": "alice",
        },
      });
      expect(r1.status).toBe(401);
      await r1.body?.cancel();

      // Case 2: `StartDaemonOptions.peer` returns a concrete peer
      // that IS on the allowlist. The identity is minted and the
      // API serves. Same listener; the override is read per
      // request.
      next = { transport: "tcp", address: "10.1.2.3" };
      const r2 = await fetch(`${ctx.handle.url}/api/threads`, {
        headers: {
          host: ctx.publicHost,
          origin: ctx.originHeader,
          "x-auth-user": "alice",
        },
      });
      expect(r2.status).toBe(200);
      await r2.body?.cancel();
    } finally {
      await stop(ctx);
    }
  });
});

describe("#245 round 3 — reply / resolve / reopen / SSE end-to-end under /review", () => {
  // The round-3 brief (DECISION a–f) requires an integration test
  // through the real listener that proves the WHOLE rail path —
  // a thread created, a reply posted, a resolve, a reopen, and
  // SSE reconnect with `since` — works under a sub-path
  // deployment. The test mirrors what the rail does at runtime:
  // it reads the base from the HTML meta, then prefixes every
  // request. If any of these stops working the host target is
  // broken, and the pre-round-3 body-rewrite shape would have
  // been caught by the template-literal case
  // (`/api/threads/${id}/replies`).
  //
  // ONE daemon shared across both tests (`beforeAll` / `afterAll`,
  // not `beforeEach`) — a fresh listener per test costs ~1.5k
  // descriptors on the `fd-budget` growth meter the `just test`
  // outer wrapper watches. Both tests here are read-mostly from
  // the daemon's perspective (GET / POST on fake ids) and do not
  // mutate cross-test state, so sharing is safe.
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await startSubPath("http://review.example.com/review", "review.example.com");
  });
  afterAll(async () => {
    await stop(ctx);
  });

  async function readBaseFromRoot(): Promise<string> {
    const response = await fetch(`${ctx.handle.url}/review/`, {
      headers: { host: ctx.publicHost, origin: ctx.originHeader },
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    // The one well-defined place (DECISION b).
    const match = body.match(/<meta name="revkit-base" content="([^"]+)"/u);
    const trailing = match?.[1];
    expect(typeof trailing).toBe("string");
    if (typeof trailing !== "string") {
      throw new Error("no revkit-base meta tag in served HTML");
    }
    // Normalise to the leading-slash-no-trailing shape the server
    // expects on a request path.
    return trailing === "/" ? "" : trailing.replace(/\/+$/u, "");
  }

  test("rail-shape URLs (template literal + SSE ?since) all reach the handler under the prefix", async () => {
    // Pre-round-3 (47d09f5), the body rewriter MISSED
    // `` `/api/threads/${id}/replies` `` — the template literal
    // reached the rail unchanged, and the browser opened
    // `${publicOrigin}/api/threads/...`, which the daemon rejected
    // as out-of-prefix (404 static). This test exercises every
    // rail-emitted URL shape the brief names (reply / resolve /
    // reopen + SSE reconnect with `?since=<n>`) through the
    // round-3 helper's resolved path, in one body — the
    // `just test` fd-budget growth meter is tight on CI (#283
    // CI run 45462173649), so folding these into one test keeps
    // socket churn low.
    //
    // What "reaches the handler" looks like: the handler returns
    // JSON with an error (the fake thread id is unknown, or the
    // body is invalid). If the request had fallen through to the
    // static branch it would have been a `text/plain` 404 with
    // body "Not Found" — the Content-Type assertion below is the
    // one that pins the routing.
    const base = await readBaseFromRoot();
    expect(base).toBe("/review");

    const commonHeaders = {
      host: ctx.publicHost,
      origin: ctx.originHeader,
      // `connection: close` on every fetch so Bun does not stash
      // the socket in its per-origin keep-alive pool after the
      // body is cancelled. The pool is one of the big contributors
      // to the packages/cli leg's fd-budget peak (one open socket
      // per fetch, lingering for the keep-alive timeout) and this
      // test fires six fetches against the shared daemon in a
      // row.
      connection: "close",
    } as const;

    // GET /api/threads is the simple positive case.
    const listResponse = await fetch(`${ctx.handle.url}${base}/api/threads`, {
      headers: { ...commonHeaders, accept: "application/json" },
    });
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as { threads: unknown[]; head: number };
    expect(Array.isArray(listBody.threads)).toBe(true);

    // Template-literal URLs with a (fake) id — the exact shape the
    // rail emits at runtime through `revkitUrl`. A JSON content
    // type on the response proves the dispatcher routed it; a
    // static 404 would be plain text. Loop keeps the three
    // endpoints symmetric and reuses one keep-alive socket per
    // target.
    const fakeId = "00000000-0000-4000-8000-000000000000";
    for (const route of ["replies", "resolve", "reopen"] as const) {
      const body = route === "replies"
        ? JSON.stringify({ parentId: fakeId, body: "x" })
        : "{}";
      const response = await fetch(
        `${ctx.handle.url}${base}/api/threads/${encodeURIComponent(fakeId)}/${route}`,
        {
          method: "POST",
          headers: { ...commonHeaders, "content-type": "application/json" },
          body,
        },
      );
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      expect(response.status).toBeGreaterThanOrEqual(400);
      await response.body?.cancel();
    }

    // SSE reconnect with `?since=<n>` under the prefix. Also a
    // template-literal URL in the rail's own shape.
    const headResponse = await fetch(`${ctx.handle.url}${base}/api/events-head`, {
      headers: { ...commonHeaders, accept: "application/json" },
    });
    expect(headResponse.status).toBe(200);
    const headBody = (await headResponse.json()) as { head: number };
    const sinceResponse = await fetch(
      `${ctx.handle.url}${base}/events?since=${encodeURIComponent(String(headBody.head))}`,
      { headers: commonHeaders },
    );
    expect(sinceResponse.status).toBe(200);
    expect(sinceResponse.headers.get("content-type")).toContain("text/event-stream");
    await sinceResponse.body?.cancel();
  });
});
