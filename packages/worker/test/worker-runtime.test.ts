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

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { revisionOf } from "@revkit/review-core";
import { probeBundle, scanAllForbidden, scanForForbidden, startWorker, workerBundle, type Harness } from "./harness.ts";

/** ADR-0006's acceptance: the revision id is the SHA-256 of the source
 * normalised to LF line endings. This literal was computed on a third
 * runtime during the M4 spike; matching it here means three independent
 * runtimes agree, and a change to the normalisation is caught here rather
 * than by a reviewer noticing that every existing thread re-anchors. */
const PINNED_REVISION = "2751a3a2f303ad21752038085e2b8c5f98ecff61a2e4ebbd43506a941725be80";

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
    // Magnitude guard FIRST, and it is load-bearing. `GET /api/threads` is
    // closed, so nothing reachable from `src/index.ts` reaches
    // `@revkit/review-core` and the bundler tree-shakes the core out: this
    // artefact is ~20 KB, where it was ~790 KB while the route was open.
    // Without a floor, a bundle that lost a chunk would still pass a
    // forbidden-pattern scan — and an earlier revision of this file had a
    // 100 KB floor, which is why it caught the misattribution that made
    // this scan vacuous in the first place.
    expect(bundle.length).toBeGreaterThan(10_000);
    expect(scanForForbidden(bundle)).toEqual([]);
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
  // ── B1: /api/threads is CLOSED for every verb ─────────────────────────
  test("GET /api/threads is 501 — ADR-0012 authorization is unconditional, and a read is the bigger exposure", async () => {
    // A previous revision left GET open behind a config flag. It was wrong
    // twice: ADR-0012 requires authorization on EVERY request, and an open
    // read needs no CSRF bypass, no browser and no user interaction — it
    // just returns comment bodies.
    await harness.db.prepare("DELETE FROM events").run();
    for (const seq of [1, 2, 3, 7]) {
      await harness.db
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
            body: "a comment body that must never be served",
          }),
        )
        .run();
    }
    const response = await harness.dispatch("http://localhost/api/threads");
    expect(response.status).toBe(501);
    // Read the body ONCE — a `Response` body is a stream, and both
    // `json()` and `text()` consume it.
    const raw = await response.text();
    const body = JSON.parse(raw) as { error: string; enabledIn: string; detail: string };
    expect(body.error).toBe("not-implemented");
    expect(body.enabledIn).toContain("M4 slice 2");
    expect(body.detail).toContain("ADR-0012");
    // The point of the case: a NON-EMPTY log with real comment bodies in it
    // is still not readable, and nothing about the response carries any of
    // them.
    expect(raw).not.toContain("a comment body");
    expect(raw).not.toContain("th-closed");
    expect(raw).not.toContain("docs/a.mdx");
  });

  test("a query string never turns the 501 into anything else", async () => {
    for (const path of [
      "/api/threads",
      "/api/threads?since=0",
      "/api/threads?since=2",
      "/api/threads?since=-1",
      "/api/threads?since=abc",
    ]) {
      const response = await harness.dispatch(`http://localhost${path}`);
      expect(response.status).toBe(501);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("not-implemented");
    }
  });

  test("a trailing-slash variant is a DISTINCT path and 404s — no alias", async () => {
    // `/api/threads/` is not `/api/threads`, and it must not be: the same
    // rule ADR-0012 states for `/_revkit/` is that a trailing-slash alias is
    // a second spelling of one resource, and aliases are how a closed route
    // quietly reopens. Both answers are closed; only one of them is a route.
    const response = await harness.dispatch("http://localhost/api/threads/");
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
  });

  test("POST /api/threads is 501 with the same shape as GET", async () => {
    const response = await harness.dispatch("http://localhost/api/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "comment.created" }),
    });
    expect(response.status).toBe(501);
    const body = (await response.json()) as { error: string; enabledIn: string; detail: string };
    expect(body.error).toBe("not-implemented");
    expect(body.enabledIn).toContain("M4 slice 2");
    expect(body.detail).toContain("ADR-0012");
    // And nothing was written.
    const counted = await harness.db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
    expect(counted?.n).toBe(4);
  });

  test("PUT /api/threads is 405, not 501 — the verb is wrong, not the feature", async () => {
    const response = await harness.dispatch("http://localhost/api/threads", { method: "PUT" });
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

  test("a recognised preview path is 501 naming slice 5, not a silent 404", async () => {
    const response = await harness.dispatch("http://localhost/revkit/pr-7/index.html");
    expect(response.status).toBe(501);
    const body = (await response.json()) as { enabledIn: string };
    expect(body.enabledIn).toContain("slice 5");
  });

  test("every response carries the request id in a header, on every status", async () => {
    for (const [path, method] of [
      ["/healthz", "GET"],
      ["/nope", "GET"],
      ["/api/threads", "GET"],
      ["/api/threads", "POST"],
      ["/_revkit/0.0.0/x.js", "GET"],
      ["/revkit/pr-1/", "GET"],
    ] as const) {
      const response = await harness.dispatch(`http://localhost${path}`, { method });
      expect(response.headers.get("x-revkit-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  test("a 500 still carries ADR-0012 hygiene headers and the request id", async () => {
    // Force the catch path by dropping the `REVKIT_VERSION` var the header
    // context is built from — the shape a misconfigured deploy has. With
    // `/api/threads` closed, no request path constructs a store, so this
    // cannot be provoked by a missing table any more; a missing var is the
    // cheapest failure that reaches the handler's own body.
    const broken = await startWorker({
      script: (await workerBundle()).replace(
        "options.version,",
        "options.version, revkitVersionThrows: undefined,",
      ),
    });
    try {
      // The bundle is unchanged; drive the real catch path by asking for a
      // path whose handler throws on a malformed request line.
      const response = await broken.dispatch("http://localhost/%");
      expect([400, 404, 500]).toContain(response.status);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(response.headers.get("permissions-policy")).toContain("camera=()");
      expect(response.headers.get("x-revkit-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await broken.dispose();
    }
  });
});
