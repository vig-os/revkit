// #279 AC2 + AC3: the daemon's request handler is composable with a
// non-loopback guard policy, a stub identity resolver and a reduced
// route-group set, so the forthcoming Linux-host target (#245) can
// share the same code path as `revkit serve` (ADR-0025 one core,
// ADR-0026 §"Open questions" → "two servers sharing a handler").
//
// Two acceptance criteria are exercised here:
//
//   AC2 — the handler runs under a non-loopback guard policy with a
//   stub identity resolver, serving the thread API and SSE under an
//   injected identity. The listener is still Bun.serve on 127.0.0.1
//   (tests cannot bind arbitrary interfaces on CI), but the HANDLER
//   never consults the loopback-specific checks: the policy's
//   `Host` allowlist is the configured public origin (not
//   `127.0.0.1:<port>`), and the identity resolver mints a fixed
//   actor independent of the launch-code / session-cookie flow.
//
//   AC3 — the agent-only route groups return 404 under a non-
//   loopback policy. A request on an agent-only path (`/api/publish`,
//   `/api/asks`, `/-/launch-code`, `/-/health`, `/-/auth`,
//   `/events?for=agent`, `/api/delivery-mode`, `/api/review`) is
//   indistinguishable from a request for a path the server never
//   knew about.
//
// A failing-first evidence line: `assertRouteGroupsCompatibleWithPolicy`
// refuses `LOCAL_DAEMON_ROUTE_GROUPS` under a public-origin policy. A
// `dev` daemon that forgot to flip the route groups when adopting a
// host policy would have landed with the agent surface exposed; the
// construction-time check closes that door.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "../../src/serve/daemon.ts";
import {
  createPublicOriginGuardPolicy,
  createStaticIdentityResolver,
  HOST_TARGET_ROUTE_GROUPS,
  LOCAL_DAEMON_ROUTE_GROUPS,
  assertRouteGroupsCompatibleWithPolicy,
  createLoopbackGuardPolicy,
} from "../../src/serve/index.ts";

interface Ctx {
  handle: DaemonHandle;
  root: string;
  publicOrigin: string;
  publicHost: string;
}

const STUB_ACTOR = Object.freeze({
  kind: "local" as const,
  id: "stub-subject",
  displayName: "Stub Reviewer",
});

async function startHostCtx(): Promise<Ctx> {
  const root = mkdtempSync(join(tmpdir(), "revkit-279-host-"));
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><h1>host</h1>");
  // Seed a source for the anchor the thread API test posts against.
  mkdirSync(join(root, "docs", "adr"), { recursive: true });
  writeFileSync(join(root, "docs", "adr", "0003.md"), "# ADR 3\n\nhost body\nhost line\n");
  const publicOrigin = "http://review.example.com";
  const publicHost = "review.example.com";
  const handle = await startDaemon({
    dir: dist,
    repoRoot: root,
    port: 0,
    sqlitePath: ":memory:",
    version: "0.0.0-279-test",
    localUserId: "279-local",
    installSignalHandlers: false,
    logSink: { write: () => {} },
    guardPolicy: createPublicOriginGuardPolicy({ publicOrigin }),
    routeGroups: HOST_TARGET_ROUTE_GROUPS,
    identityResolver: createStaticIdentityResolver({ actor: STUB_ACTOR }),
    enableBackgroundBuild: false,
  });
  return { handle, root, publicOrigin, publicHost };
}

async function stop(ctx: Ctx): Promise<void> {
  await ctx.handle.stop();
  rmSync(ctx.root, { recursive: true, force: true });
}

describe("#279 composable handler under a non-loopback policy", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await startHostCtx();
  });
  afterEach(async () => {
    await stop(ctx);
  });

  test("AC2 — thread API serves a GET under the host policy with a stub identity", async () => {
    const response = await fetch(`${ctx.handle.url}/api/threads`, {
      headers: { host: ctx.publicHost, origin: ctx.publicOrigin },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { threads: unknown[]; head: number };
    expect(Array.isArray(body.threads)).toBe(true);
    expect(typeof body.head).toBe("number");
  });

  test("AC2 — thread API creates a comment under the host policy with a stub identity", async () => {
    const payload = {
      anchor: {
        path: "docs/adr/0003.md",
        startLine: 3,
        endLine: 3,
        quote: { exact: "host body", prefix: "", suffix: "" },
        revision: "a".repeat(64),
      },
      body: "comment from the composed host handler",
    };
    const response = await fetch(`${ctx.handle.url}/api/threads`, {
      method: "POST",
      headers: {
        host: ctx.publicHost,
        origin: ctx.publicOrigin,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { event: { actor: { id: string; displayName?: string } } };
    // Attribution came from the injected resolver, not from the
    // local daemon's cookie / bearer path.
    expect(body.event.actor.id).toBe(STUB_ACTOR.id);
    expect(body.event.actor.displayName).toBe(STUB_ACTOR.displayName);
  });

  test("AC2 — SSE on /events serves the resume slice under the host policy", async () => {
    // Origin set to the policy's public origin: the handler's
    // origin discipline accepts same-origin GETs under a non-
    // loopback target just as it does under the loopback one.
    const response = await fetch(`${ctx.handle.url}/events?since=0`, {
      headers: { host: ctx.publicHost, origin: ctx.publicOrigin },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    // Read the opening keepalive to confirm the stream is live. The
    // reader is cancelled right away — we only need to know the
    // handler opened an SSE channel under the host policy.
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const chunk = await reader!.read();
    expect(chunk.done).toBe(false);
    expect(new TextDecoder().decode(chunk.value)).toMatch(/^: keepalive/);
    await reader!.cancel();
  });

  test("AC2 — Host outside the policy's allowlist returns 421", async () => {
    const response = await fetch(`${ctx.handle.url}/api/threads`, {
      headers: { host: "not-allowed.example.com" },
    });
    expect(response.status).toBe(421);
  });

  test("AC3 — agent-only routes 404 under the host policy", async () => {
    const agentOnlyPaths: ReadonlyArray<readonly [string, "GET" | "POST"]> = [
      ["/-/auth?code=abc", "GET"],
      ["/-/health", "GET"],
      ["/-/launch-code", "POST"],
      ["/api/publish", "POST"],
      ["/api/asks", "GET"],
      ["/api/asks/some-id", "GET"],
      ["/ask/some-id", "GET"],
      ["/api/delivery-mode", "GET"],
      ["/api/handover", "POST"],
      ["/api/presence", "POST"],
      ["/api/delivered", "GET"],
      ["/api/pending", "GET"],
      ["/api/review", "GET"],
      ["/api/review/state", "GET"],
      ["/-/ask.js", "GET"],
      ["/-/ask.css", "GET"],
    ];
    for (const [path, method] of agentOnlyPaths) {
      const response = await fetch(`${ctx.handle.url}${path}`, {
        method,
        headers: {
          host: ctx.publicHost,
          ...(method !== "GET" ? { origin: ctx.publicOrigin, "content-type": "application/json" } : {}),
        },
        ...(method !== "GET" ? { body: "{}" } : {}),
      });
      expect([response.status, path, method]).toEqual([404, path, method]);
    }
  });

  test("AC3 — /events?for=agent returns 404 under the host policy", async () => {
    const response = await fetch(`${ctx.handle.url}/events?for=agent`, {
      headers: { host: ctx.publicHost },
    });
    expect(response.status).toBe(404);
  });

  test("AC3 — shared routes remain reachable under the host policy", async () => {
    // Exact expected statuses (#279 round-2 blocker 1): `!= 404`
    // let `/api/events-head`'s 401 under the pre-fix handler pass
    // this test, so the rail's "fetch head before opening /events"
    // dance quietly lost its resume point on a proxied reviewer.
    // Every shared endpoint MUST answer 200 under an identity the
    // resolver accepts.
    const sharedGet: ReadonlyArray<readonly [string, number]> = [
      ["/api/threads", 200],
      ["/api/events-head", 200],
      ["/events?since=0", 200],
      ["/", 200], // static index.html
      ["/-/rail.js", 200],
    ];
    for (const [path, expectedStatus] of sharedGet) {
      const response = await fetch(`${ctx.handle.url}${path}`, {
        headers: { host: ctx.publicHost, origin: ctx.publicOrigin },
      });
      expect([response.status, path]).toEqual([expectedStatus, path]);
      await response.body?.cancel();
    }
  });

  test("AC3 — a valid local agent bearer cannot smuggle bearer-origin leniency into the host target", async () => {
    // Under the host policy the agent surface is not registered at
    // all. A request that nevertheless presents an `Authorization:
    // Bearer <value>` must NOT be treated as a bearer caller by the
    // shared `/events` / `/api/threads` origin check — the host has
    // no agent bearer, so a bearer value cannot grant any extra
    // leniency. The dispatcher forces `hasValidBearer=false` on any
    // target that disables agent routes; a cross-origin POST then
    // rejects the way a cookie-less POST would.
    const response = await fetch(`${ctx.handle.url}/api/threads`, {
      method: "POST",
      headers: {
        host: ctx.publicHost,
        // A foreign Origin that is NOT the public one. If the handler
        // honoured the bearer, it would accept an absent Origin (the
        // bearer branch is lenient) OR refuse with origin-not-allowed
        // based on the bearer branch. Either way, a cross-origin POST
        // under the host policy must be 403, never anything softer.
        origin: "http://attacker.example.com",
        authorization: "Bearer any-value-at-all",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(response.status).toBe(403);
  });
});

describe("#279 route-group / policy compatibility", () => {
  test("AC3 construction — enabling agent-only groups under a non-loopback policy throws", () => {
    const hostPolicy = createPublicOriginGuardPolicy({ publicOrigin: "http://review.example.com" });
    expect(() => {
      assertRouteGroupsCompatibleWithPolicy(LOCAL_DAEMON_ROUTE_GROUPS, hostPolicy);
    }).toThrow(/agent-only route group/);
  });

  test("AC3 construction — the loopback policy accepts every route group set", () => {
    const loopback = createLoopbackGuardPolicy({ port: 1234 });
    expect(() => {
      assertRouteGroupsCompatibleWithPolicy(LOCAL_DAEMON_ROUTE_GROUPS, loopback);
    }).not.toThrow();
    expect(() => {
      assertRouteGroupsCompatibleWithPolicy(HOST_TARGET_ROUTE_GROUPS, loopback);
    }).not.toThrow();
  });

  test("AC3 construction — the host route-group set is accepted under a non-loopback policy", () => {
    const hostPolicy = createPublicOriginGuardPolicy({ publicOrigin: "http://review.example.com" });
    expect(() => {
      assertRouteGroupsCompatibleWithPolicy(HOST_TARGET_ROUTE_GROUPS, hostPolicy);
    }).not.toThrow();
  });

  test("AC3 construction — a bespoke policy with id='loopback' cannot forge agent-route access", () => {
    // #279 round-2 fix: the gate keys on `allowsAgentRoutes`, a
    // flag only the real loopback factory sets. A policy that
    // spells its id `"loopback"` but is in fact a non-loopback
    // target must be refused the agent surface. This is the
    // adversarial test the pre-fix gate would have passed.
    const spoofed = {
      ...createPublicOriginGuardPolicy({ publicOrigin: "http://review.example.com" }),
      id: "loopback",
    };
    expect(() => {
      assertRouteGroupsCompatibleWithPolicy(LOCAL_DAEMON_ROUTE_GROUPS, spoofed);
    }).toThrow(/agent-only route group/);
  });

  test("AC3 construction — the real loopback policy carries `allowsAgentRoutes: true`", () => {
    const loopback = createLoopbackGuardPolicy({ port: 1234 });
    expect(loopback.allowsAgentRoutes).toBe(true);
    const hostPolicy = createPublicOriginGuardPolicy({ publicOrigin: "http://review.example.com" });
    expect(hostPolicy.allowsAgentRoutes).toBe(false);
  });

  test("basePath — derived from the public origin's URL pathname", () => {
    expect(createPublicOriginGuardPolicy({ publicOrigin: "http://review.example.com" }).basePath).toBe("");
    expect(createPublicOriginGuardPolicy({ publicOrigin: "http://review.example.com/" }).basePath).toBe("");
    expect(createPublicOriginGuardPolicy({ publicOrigin: "http://review.example.com/review" }).basePath).toBe("/review");
    expect(createPublicOriginGuardPolicy({ publicOrigin: "http://review.example.com/review/" }).basePath).toBe("/review");
    expect(createLoopbackGuardPolicy({ port: 1234 }).basePath).toBe("");
  });
});

describe("#279 host target under a base-path deployment", () => {
  // The host policy carries the public origin AND a deployment base
  // path derived from that URL's pathname; #245 wires this into the
  // real listener. The handler refuses every URL outside the prefix
  // before it reaches route matching, so a request at the bare root
  // on a /review deployment is 404 just like an unknown path.
  // Sub-path routing INSIDE the prefix is #195 implementation scope.
  // The policy already carries the data so #245 picks it up without
  // a second config field.
  interface HostCtx {
    handle: DaemonHandle;
    root: string;
    publicHost: string;
    publicOrigin: string;
  }

  let ctx: HostCtx;
  beforeEach(async () => {
    const root = mkdtempSync(join(tmpdir(), "revkit-279-basepath-"));
    const dist = join(root, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><h1>sub-path</h1>");
    const publicOrigin = "http://review.example.com/review";
    const publicHost = "review.example.com";
    const handle = await startDaemon({
      dir: dist,
      repoRoot: root,
      port: 0,
      sqlitePath: ":memory:",
      version: "0.0.0-279-basepath-test",
      localUserId: "279-basepath-local",
      installSignalHandlers: false,
      logSink: { write: () => {} },
      guardPolicy: createPublicOriginGuardPolicy({ publicOrigin }),
      routeGroups: HOST_TARGET_ROUTE_GROUPS,
      identityResolver: createStaticIdentityResolver({ actor: STUB_ACTOR }),
      enableBackgroundBuild: false,
    });
    ctx = { handle, root, publicHost, publicOrigin };
  });
  afterEach(async () => {
    await ctx.handle.stop();
    rmSync(ctx.root, { recursive: true, force: true });
  });

  test("requests outside the base path are 404 before routing", async () => {
    // `/api/threads` is a routed path on the loopback, but the host
    // target serves at `/review/*`; a request at the bare root must
    // be refused as if the path did not exist.
    const outside = await fetch(`${ctx.handle.url}/api/threads`, {
      headers: { host: ctx.publicHost, origin: ctx.publicOrigin },
    });
    expect(outside.status).toBe(404);
  });

  test("Origin check on the base-path policy keys on the public origin", () => {
    // The policy exposes `checkOrigin`; it rejects a non-matching
    // Origin and accepts the configured public origin. Keeping this
    // at the policy level avoids coupling the assertion to the
    // sub-path routing #195 will add — the policy's own contract is
    // all we need to pin for the brief's "Origin checks use the
    // public origin" requirement.
    const policy = createPublicOriginGuardPolicy({ publicOrigin: ctx.publicOrigin });
    expect(
      policy.checkOrigin({ origin: "http://attacker.example.com", secFetchSite: null, hasValidBearer: false }).kind,
    ).toBe("refused");
    expect(
      policy.checkOrigin({ origin: "http://review.example.com", secFetchSite: "same-origin", hasValidBearer: false }).kind,
    ).toBe("ok");
    // basePath is preserved but Origin ignores it (Origin never
    // carries a path).
    expect(policy.basePath).toBe("/review");
  });
});
