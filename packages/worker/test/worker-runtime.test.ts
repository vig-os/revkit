// ADR-0025's runtime gate (A1, A2, A4) plus the Worker's HTTP surface.
//
// Three runtimes, one answer:
//
//   A1 — the REAL Worker, built from `src/index.ts`, answers `GET /healthz`
//        inside workerd with `compatibility_flags: []`. No `nodejs_compat`,
//        so "the core runs on the workers runtime" is enforced by the
//        platform, not by a lint.
//   A2 — `revisionOf` evaluated INSIDE workerd returns a pinned literal.
//        Pinning the literal is the point: `Anchor.revision` is what the
//        whole re-anchoring pipeline trusts, so cross-runtime determinism
//        has to be a regression test, not a claim.
//   A4 — the built bundle contains no `require(`, no `node:`, no `bun:`,
//        no `Buffer`, no `process.env`. This complements review-core's
//        `src-imports.test.ts`, which guards the core's SOURCES; this
//        guards the shipped ARTIFACT, including its dependencies.

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { revisionOf } from "@revkit/review-core";
import {
  authHeaders,
  cookieHeader,
  issueTestSession,
  JSON_HEADERS,
  probeBundle,
  scanAllForbidden,
  scanForForbidden,
  startWorker,
  workerBundle,
  type Harness,
} from "./harness.ts";

/** ADR-0006's acceptance: the revision id is the SHA-256 of the source
 * normalised to LF line endings. This literal was computed on a third
 * runtime during the M4 spike; matching it here means three independent
 * runtimes agree, and a change to the normalisation is caught here rather
 * than by a reviewer noticing that every existing thread re-anchors. */
const PINNED_REVISION = "2751a3a2f303ad21752038085e2b8c5f98ecff61a2e4ebbd43506a941725be80";

/** The comment body the seeded log carries. Named so the "an unauthorized
 * caller does not get it" and "an authorized one does" halves of this file
 * assert against the SAME string rather than against two literals that could
 * drift apart. */
const SEED_BODY = "a comment body that must never be served to an unauthorized caller";

/**
 * A four-event log with a GAP: seqs 1, 2, 3 and 7.
 *
 * The gap is the point and it is slice 1's fixture, kept deliberately.
 * ADR-0006 blesses it — a D1-backed store may hand out gaps and consumers
 * use `since(lastSeen)` and never assume contiguity — so a hosted read that
 * renumbered 7 to 4, or that served `since=2` as two events, would be wrong
 * in a way a contiguous fixture cannot detect. The #76 review found exactly
 * that bug through this seed.
 */
async function seedClosedLog(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM events").run();
  for (const seq of [1, 2, 3, 7]) {
    await db
      .prepare("INSERT INTO events (seq, ts, payload) VALUES (?, ?, ?)")
      .bind(
        seq,
        `2026-10-03T12:00:0${seq}Z`,
        JSON.stringify({
          seq,
          ts: `2026-10-03T12:00:0${seq}Z`,
          actor: { kind: "gh-user", id: "gerchowl" },
          kind: "comment.created",
          threadId: `th-closed-${seq}`,
          commentId: `c-closed-${seq}`,
          anchor: {
            path: "docs/a.mdx",
            startLine: 1,
            endLine: 1,
            quote: { exact: "x", prefix: "", suffix: "" },
            revision: "b".repeat(64),
          },
          body: SEED_BODY,
        }),
      )
      .run();
  }
}

describe("ADR-0025 runtime gate", () => {
  let harness: Harness;
  let probe: Harness;

  beforeAll(async () => {
    // Sequential on purpose: both bundles are built before either
    // miniflare starts, so the two `Bun.build` calls never overlap.
    const workerScript = await workerBundle();
    const probeScript = await probeBundle();
    harness = await startWorker({ script: workerScript });
    probe = await startWorker({ script: probeScript });
  });

  afterAll(async () => {
    await harness.dispose();
    await probe.dispose();
  });

  // ── A1 ───────────────────────────────────────────────────────────────
  test("A1: the real Worker answers GET /healthz 200 with ok:true", async () => {
    const response = await harness.dispatch("http://localhost/healthz");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; revkitVersion: string; requestId: string };
    expect(body.ok).toBe(true);
    // The version the Worker RUNS, not the repo's current CLI version:
    // a deployed Worker is pinned to the release it was deployed as.
    expect(body.revkitVersion).toBe("0.0.0");
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("A1: HEAD /healthz is the same handler without a body", async () => {
    const response = await harness.dispatch("http://localhost/healthz", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  test("A1: workerd really has no Node globals, so the flag-free claim is enforced", async () => {
    const body = (await (await probe.dispatch("http://localhost/globals")).json()) as Record<string, string>;
    // Measured from INSIDE the runtime, not asserted from a comment.
    expect(body["buffer"]).toBe("undefined");
    expect(body["process"]).toBe("undefined");
    expect(body["require"]).toBe("undefined");
    // And the two host globals the core DOES use are present natively,
    // which is why `revisionOf` works here at all.
    expect(body["cryptoRandomUUID"]).toBe("function");
    expect(body["textEncoder"]).toBe("function");
  });

  // ── A2 ───────────────────────────────────────────────────────────────
  test("A2: revisionOf evaluated INSIDE workerd equals the pinned digest", async () => {
    const body = (await (await probe.dispatch("http://localhost/revision")).json()) as { revision: string };
    expect(body.revision).toBe(PINNED_REVISION);
  });

  test("A2: the same input hashes identically in Bun — the third runtime agrees", async () => {
    expect(await revisionOf("line1\r\nline2\n")).toBe(PINNED_REVISION);
  });

  test("A2: the hosted store round trip runs inside workerd", async () => {
    // D1 append -> exportArchive -> import into a fresh in-memory store ->
    // threads(). That is `revkit threads export|import` in the Worker, and
    // it proves the Worker's OWN `d1-store.ts` executes on the runtime.
    const body = (await (await probe.dispatch("http://localhost/store")).json()) as {
      seq: number;
      archived: number;
      threads: number;
      status: string;
      startLine: number | null;
    };
    expect(body.seq).toBe(1);
    expect(body.archived).toBe(1);
    expect(body.threads).toBe(1);
    expect(body.status).toBe("open");
    expect(body.startLine).toBe(2);
  });

  // ── A4 ───────────────────────────────────────────────────────────────
  test("A4 MUTATION GUARD: the forbidden-pattern scan actually detects each pattern", async () => {
    // Without this, every A4 assertion below is unfalsifiable: a scan that
    // silently matched nothing would report "clean" for every bundle,
    // including one full of `Buffer`. Plant each pattern and require a hit.
    const fixtures: [string, string][] = [
      ["const b = Buffer.from(x)", "Buffer"],
      ['import fs from "node:fs"', "node:"],
      ['import b from "bun:test"', "bun:"],
      ["const e = process.env.TOKEN", "process.env"],
      ["require(\"y\")", "require("],
    ];
    for (const [source, expected] of fixtures) {
      const hits = scanForForbidden(source);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]).toContain(expected);
    }
    expect(scanForForbidden("const x = 1; export default x;")).toEqual([]);
  });

  test("A4: the SHIPPED Worker entry bundle has no Node or Bun escape hatches", async () => {
    const bundle = await workerBundle();
    // Magnitude guards FIRST, and they are load-bearing in both directions.
    // Slice 2 re-opened `GET /api/threads`, so this artefact went from ~20 KB
    // (tree-shaken, because nothing reachable touched the store) back to
    // ~807 KB — and the floor moves with it. A FLOOR alone would be
    // satisfied by a bundle that lost a chunk; an earlier revision of this
    // file had only a 100 KB floor, which is why it caught the
    // misattribution that made the scan vacuous in the first place.
    expect(bundle.length).toBeGreaterThan(500_000);
    // Positive markers, so "clean" cannot mean "empty". These are names that
    // exist ONLY in `@revkit/review-core`, and the read handler cannot run
    // without them: `D1ThreadStore` calls `selectThreads` and `validateNext`.
    // So this asserts, on the ARTEFACT THAT WILL BE DEPLOYED, that the
    // shared core is in it — which is ADR-0025's claim about the hosted
    // surface, and which slice 1 could only assert about the probe.
    expect(bundle).toContain("selectThreads");
    expect(bundle).toContain("ThreadStoreContendedError");
    // And only now does the scan mean anything: zero hits over an artefact
    // that demonstrably contains the graph.
    expect(scanForForbidden(bundle)).toEqual([]);
  });

  test("A4: the shipped entry reaches the store, so no route can be added that skips the gate", async () => {
    // A structural check rather than a behavioural one, and it is what makes
    // the previous case's positive markers meaningful: `D1ThreadStore` is
    // constructed ONLY inside `readThreads`, and `readThreads` takes an
    // `AuthorizedSession` whose brand symbol is private to `src/authz.ts`.
    // So "the store is in the bundle" and "the store is unreachable without
    // the gate" are the same fact read twice, and neither can drift by
    // adding a handler.
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const constructions = [...source.matchAll(/new D1ThreadStore\(/g)];
    expect(constructions).toHaveLength(1);
    // …and it is inside a function whose signature demands the gate's type.
    const readThreadsIndex = source.indexOf("async function readThreads(");
    expect(readThreadsIndex).toBeGreaterThan(-1);
    const signature = source.slice(readThreadsIndex, source.indexOf("): Promise<Response>", readThreadsIndex));
    expect(signature).toContain("authorized: AuthorizedSession");
  });

  test("A4: the PROBE bundle — the graph ADR-0025 is actually about — is clean AND non-empty", async () => {
    const bundle = await probeBundle();
    // The probe is what imports `@revkit/review-core` and `d1-store.ts`, so
    // it is the artefact a forbidden pattern in the shared core would show
    // up in. Three things matter, and the first revision of this test got
    // the third one wrong. The magnitude floor proves the scan is not
    // running over a stub, and the positive markers prove the core is
    // really in the file. Then:
    //
    //   - the scan is EXACT, not "zero hits". The probe's `/globals`
    //     route reads `typeof globalThis.Buffer` to MEASURE that the global
    //     is absent, so it necessarily contains one `Buffer` token. An
    //     earlier revision asserted zero hits over this bundle and therefore
    //     asserted something impossible; the honest form is "the only
    //     `Buffer` in the graph is the probe's own measurement of its
    //     absence", which is a STRONGER claim because a second one would
    //     mean the shared core had grown a Node dependency.
    expect(bundle.length).toBeGreaterThan(500_000);
    expect(bundle).toContain("runtime-probe");
    expect(bundle).toContain("exportArchive");
    expect(bundle).toContain("ThreadStoreContendedError");

    const hits = scanAllForbidden(bundle);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("Buffer");
    const offset = Number(hits[0]?.split("@")[1]);
    expect(bundle.slice(offset - 40, offset + 20)).toContain("globalThis.Buffer");
  });

  test("A4: the probe's one Buffer token is the measurement, so /globals still reports it absent", async () => {
    // Closes the loop on the previous case: the token is in the bundle AND
    // the runtime it is dispatched to reports the global missing. Without
    // this, "exactly one Buffer, and it is a measurement" would be a claim
    // about a string with nothing behind it.
    const body = (await (await probe.dispatch("http://localhost/globals")).json()) as Record<string, string>;
    expect(body["buffer"]).toBe("undefined");
  });

  test("A4: neither bundle carries a specifier left for the platform to resolve", async () => {
    for (const [name, get] of [
      ["worker", workerBundle],
      ["probe", probeBundle],
    ] as const) {
      const bundle = await get();
      // Bun inlines the whole graph, so a correct bundle has ZERO import
      // specifiers. A bare one would mean a dependency escaped bundling and
      // would fail at first import in production; a relative one would mean
      // the bundle is not self-contained. Either is a packaging defect, so
      // the assertion is "none of any kind" rather than "all relative".
      const specifiers = [
        ...[...bundle.matchAll(/from\s*"([^"]+)"/g)].map((m) => m[1] ?? ""),
        ...[...bundle.matchAll(/import\s*"([^"]+)"/g)].map((m) => m[1] ?? ""),
        ...[...bundle.matchAll(/import\s*\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1] ?? ""),
      ];
      expect(specifiers, `${name} bundle has unresolved specifiers`).toEqual([]);
    }
  });

  // ── the HTTP surface ─────────────────────────────────────────────────
  // ── the surface slice 2 re-opened, and the parts it did not ──────────
  // The NEGATIVE matrix for every route and verb — no cookie, forged cookie,
  // expired cookie, wrong identity kind, every alias spelling of the path and
  // of `?since=` — lives in `test/authorization.test.ts`. What is here is the
  // runtime gate's own territory: that the re-opened routes answer what they
  // claim to, through real workerd, against a real log.
  test("GET /api/threads answers 200 with a session and the real projection", async () => {
    // The transition slice 1 existed for. Slice 1 answered 501 for every
    // verb because ADR-0012 requires authorization per request and there was
    // no session; this is the same route with a session, reading the SAME
    // seeded log (seqs 1, 2, 3, 7 — a gap, which ADR-0006 permits and the
    // reducer must survive).
    await seedClosedLog(harness.db);
    const issued = await issueTestSession(harness.db);
    const response = await harness.dispatch("http://localhost/api/threads", {
      headers: { cookie: cookieHeader(issued.sessionId) },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { head: number; threads: { id: string; status: string }[] };
    // `head` is MAX(seq) read from D1 — 7, not 4. It is the resume point the
    // hosted rail needs, and getting it from the store's per-instance
    // watermark instead is the #76 bug this shape would reintroduce.
    expect(body.head).toBe(7);
    expect(body.threads).toHaveLength(4);
    expect(body.threads.map((thread) => thread.id).sort()).toEqual([
      "th-closed-1",
      "th-closed-2",
      "th-closed-3",
      "th-closed-7",
    ]);
    // And the data the projection is built from really is served to a
    // session that has one — the negative half is `authorization.test.ts`.
    const raw = await harness.db.prepare("SELECT payload FROM events WHERE seq = 1").first<{ payload: string }>();
    expect(JSON.parse(raw?.payload ?? "{}")).toMatchObject({ body: SEED_BODY });
  });

  test("GET /api/threads?since=2 returns exactly the events after 2, over the gap", async () => {
    const issued = await issueTestSession(harness.db);
    const response = await harness.dispatch("http://localhost/api/threads?since=2", {
      headers: { cookie: cookieHeader(issued.sessionId) },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { head: number; events: { seq: number }[] };
    expect(body.head).toBe(7);
    // 3 and 7 — the gap between 3 and 7 is NOT renumbered, which is
    // `store.ts:9-14`'s "a D1 store may hand out gaps and consumers use
    // `since(lastSeen)` and never assume contiguity", exercised over HTTP.
    expect(body.events.map((event) => event.seq)).toEqual([3, 7]);
  });

  test("?since=<head> is empty, so a caught-up client polls for nothing", async () => {
    const issued = await issueTestSession(harness.db);
    const response = await harness.dispatch("http://localhost/api/threads?since=7", {
      headers: { cookie: cookieHeader(issued.sessionId) },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { head: number; events: unknown[] };
    expect(body.head).toBe(7);
    expect(body.events).toEqual([]);
  });

  test("a trailing-slash variant is a DISTINCT path and 404s — no alias", async () => {
    // `/api/threads/` is not `/api/threads`, and it must not be: the same
    // rule ADR-0012 states for `/_revkit/` is that a trailing-slash alias is
    // a second spelling of one resource, and aliases are how a gated route
    // quietly reopens. It 404s even WITH a valid session, so no alias can be
    // reached by any credential at all.
    const issued = await issueTestSession(harness.db);
    const response = await harness.dispatch("http://localhost/api/threads/", {
      headers: { cookie: cookieHeader(issued.sessionId) },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
  });

  test("POST /api/threads is still 501 — and it gets past the gate to say so", async () => {
    // The status is unchanged from slice 1 and the REASON is not: this call
    // now carries a valid session, a valid per-session CSRF token and
    // `application/json`, so ADR-0012's three state-changing checks all PASS
    // before the route answers. That is the honest distinction — the write is
    // missing (slice 4), the authorization is not.
    const issued = await issueTestSession(harness.db);
    const response = await harness.dispatch("http://localhost/api/threads", {
      method: "POST",
      headers: { ...authHeaders(issued), ...JSON_HEADERS },
      body: JSON.stringify({ kind: "comment.created" }),
    });
    expect(response.status).toBe(501);
    const body = (await response.json()) as { error: string; enabledIn: string; detail: string };
    expect(body.error).toBe("not-implemented");
    expect(body.enabledIn).toContain("slice 4");
    expect(body.detail).toContain("CSRF");
    // And nothing was written.
    const counted = await harness.db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
    expect(counted?.n).toBe(4);
  });

  test("PUT /api/threads is 405, not 401 — a session is present, the verb is wrong", async () => {
    // Order matters and is asserted: authorization first (unconditionally),
    // then the verb. Without a session the SAME request is 401, which
    // `authorization.test.ts` drives — so a 405 here is evidence the gate
    // let a known caller through, not evidence the route ignores verbs.
    const issued = await issueTestSession(harness.db);
    const response = await harness.dispatch("http://localhost/api/threads", {
      method: "PUT",
      headers: { cookie: cookieHeader(issued.sessionId) },
    });
    expect(response.status).toBe(405);
  });

  test("an unknown path is 404 and /_revkit/ never redirects (ADR-0012)", async () => {
    const unknown = await harness.dispatch("http://localhost/nope");
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("location")).toBeNull();
    // A stored page that tries to load a bundle from the revkit-owned
    // path must not be redirected: a browser drops the path part of a CSP
    // source after a redirect, which would widen script-src.
    const bundle = await harness.dispatch("http://localhost/_revkit/0.0.0/rail.js");
    expect(bundle.status).toBe(404);
    expect(bundle.headers.get("location")).toBeNull();
  });

  test("a recognised preview path is 501 naming slice 5, for a caller with a session", async () => {
    // Preview paths are GATED from slice 2 even though they have nothing to
    // serve, so slice 5 inherits the gate from the route table instead of
    // having to remember it. The unauthenticated answer is 401 — driven in
    // `authorization.test.ts` — and it is the stricter one, because the day
    // R2 exists a 501 is a 200.
    const issued = await issueTestSession(harness.db);
    const response = await harness.dispatch("http://localhost/revkit/pr-7/index.html", {
      headers: { cookie: cookieHeader(issued.sessionId) },
    });
    expect(response.status).toBe(501);
    const body = (await response.json()) as { enabledIn: string };
    expect(body.enabledIn).toContain("slice 5");
  });

  test("every response carries the request id in a header, on every status", async () => {
    const issued = await issueTestSession(harness.db);
    for (const [path, method] of [
      ["/healthz", "GET"],
      ["/nope", "GET"],
      ["/api/threads", "GET"],
      ["/api/threads", "POST"],
      ["/api/session/refresh", "POST"],
      ["/_revkit/0.0.0/x.js", "GET"],
      ["/revkit/pr-1/", "GET"],
    ] as const) {
      const response = await harness.dispatch(`http://localhost${path}`, {
        method,
        headers: { ...authHeaders(issued), ...JSON_HEADERS },
      });
      expect(response.headers.get("x-revkit-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    }
    // And the refusal branch, with NO credential at all, which is the one a
    // reviewer will hit first when something is misconfigured.
    const refused = await harness.dispatch("http://localhost/api/threads");
    expect(refused.status).toBe(401);
    expect(refused.headers.get("x-revkit-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  // ── the catch block, actually entered ─────────────────────────────────
  test("a Worker deployed without REVKIT_VERSION returns a 500 that still carries ADR-0012 hygiene", async () => {
    // The #76 round-2 review found the previous version of this test
    // INERT: it built its broken Worker with
    // `.replace("options.version,", …)`, and that string does not exist in
    // the emitted bundle (verified: `includes("options.version,")` is
    // false), so the script was byte-identical to the real one. It then
    // claimed to reach the catch block via `/%` — but `new URL("http://
    // localhost/%")` is a perfectly valid URL, so the request 404s — and
    // asserted `expect([400, 404, 500]).toContain(status)`, which passes
    // on the weakest member. A test named for a 500 asserted nothing about
    // a 500.
    //
    // Now the condition is real and stated: `startWorker({ vars: null })`
    // binds NOTHING, so `env.REVKIT_VERSION` is undefined and
    // `revkitBundlePath(undefined)` throws on `version.length` while the
    // header context is being built — before any route runs. That is a
    // misconfigured deploy, which is worth keeping tested.
    const broken = await startWorker({ vars: null });
    try {
      const response = await broken.dispatch("http://localhost/healthz");
      // Exactly 500. Not a set containing 500.
      expect(response.status).toBe(500);
      // Exactly the generic body: an error string can carry a SQL fragment
      // or a stack, and this response is readable by whoever reached it.
      expect(await response.text()).toBe("internal error\n");
      // ADR-0012 hygiene on the error path, not just the happy one.
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(response.headers.get("permissions-policy")).toContain("camera=()");
      // ADR-0020: the id a reviewer quotes is in the response AND in the log.
      expect(response.headers.get("x-revkit-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await broken.dispose();
    }
  });

  test("the 500's cause is the missing var, not an unrelated fault", async () => {
    // Proves the case above is not passing for some other reason: the SAME
    // script bytes with `REVKIT_VERSION` bound answer 200, so the only
    // variable is the var.
    //
    // **The control is this file's OWN `harness`, not a freshly-spawned
    // Worker.** An earlier revision built a second healthy miniflare for
    // this, which is a weaker control AND cost a workerd spawn: two separate
    // `Miniflare` instances are not obviously running the same bytes, so a
    // difference between them could have been the cause. `harness` was built
    // from `workerBundle()` and `broken` from the same call, so the script is
    // byte-identical by construction and the only variable is `vars`. It also
    // answers `/healthz` 200 in the A1 case above, so nothing new has to be
    // believed.
    expect((await harness.dispatch("http://localhost/healthz")).status).toBe(200);
    const broken = await startWorker({ vars: null });
    try {
      expect((await broken.dispatch("http://localhost/healthz")).status).toBe(500);
    } finally {
      await broken.dispose();
    }
  });
});
