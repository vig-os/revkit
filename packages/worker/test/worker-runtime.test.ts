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
import { previewScopePath, scopedThreadsPath } from "../src/router.ts";
import { TEST_INVITE_TOKEN_HMAC_KEY, seedLogEvents } from "./harness.ts";
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

/** Cloudflare's documented per-Worker size limit, uncompressed: 64 MiB on
 * both the Free and Paid plans (developers.cloudflare.com/workers/platform/
 * limits/, read 2026-10-04). Only the uncompressed size counts. Held as a
 * named constant so the test can show the distance between revkit's own budget
 * and the platform's limit rather than asserting a number nobody can trace. */
const WORKER_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

/** revkit's own budget for the shipped entry, as a CEILING.
 *
 * Why 2 MiB and not the platform's 64 MiB: this is not a "will Cloudflare
 * accept it" check — at 64 MiB the answer is yes and the Worker is unusable.
 * The binding platform limit for a large graph is the **1-second startup**
 * limit (error 10021: a Worker must parse and execute its global scope within
 * one second), and the honest position is that this number cannot be measured
 * here: the only tool that reports startup time is `wrangler deploy
 * --dry-run`, which is out of bounds for this task. So the ceiling is a growth
 * budget, not a proxy for a limit somebody measured.
 *
 * The number is derived rather than chosen: `toBeGreaterThan(2)` in the case
 * below asserts today's graph is at most half of it, so raising it is a
 * deliberate act with a visible ratio, and lowering it below today's size fails
 * the floor. Measured today: ~807 KB, so 2 MiB is ~2.6x headroom. Crossing it
 * means the shared core roughly doubled and someone should look at what went
 * in before it reaches a ceiling nobody would notice. */
const BUNDLE_CEILING_BYTES = 2 * 1024 * 1024;

/**
 * The review the seeded log belongs to, and the ONE URL that reads it.
 *
 * **Slice 5:** the read moved from `/api/threads` — which named no repository,
 * so ADR-0012's per-call scope check had nothing to select on — to
 * `<repo>/pr-<n>/api/threads`, with the scope in the PATH. The log key is
 * built by the same `previewScopePath` a route's scope uses, so this file and
 * the router cannot disagree about which log a URL names.
 */
const LOG_KEY = previewScopePath("revkit", 7);
const READ_PATH = scopedThreadsPath("revkit", 7);

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
  // 1, 2, 3 and then 7: the GAP is the point and it is slice 1's fixture, kept
  // deliberately (ADR-0006 blesses gaps; consumers use `since(lastSeen)` and
  // never assume contiguity), so a hosted read that renumbered 7 to 4, or that
  // served `since=2` as two events, would be wrong in a way a contiguous
  // fixture cannot detect. The #76 review found exactly that bug through here.
  await seedLogEvents(db, LOG_KEY, 3, { prefix: "th-closed", from: 1, body: SEED_BODY });
  await seedLogEvents(db, LOG_KEY, 1, { prefix: "th-closed", from: 7, body: SEED_BODY });
}

describe("ADR-0025 runtime gate", () => {
  let harness: Harness;
  let probe: Harness;

  let broken: Harness;
  beforeAll(async () => {
    // Sequential on purpose: both bundles are built before either
    // miniflare starts, so the two `Bun.build` calls never overlap.
    const workerScript = await workerBundle();
    const probeScript = await probeBundle();
    harness = await startWorker({ script: workerScript });
    probe = await startWorker({ script: probeScript });
    // ONE misconfigured deploy, shared by every case that needs it.
    //
    // `vars: null` plus `inviteTokenKey: null` binds NOTHING, so this
    // instance has neither `REVKIT_VERSION` nor `INVITE_TOKEN_HMAC_KEY`.
    //
    // `inviteTokenKey: null` is REQUIRED and was the reason this describe's
    // missing-key case measured the wrong error: `vars: null` alone leaves the
    // key bound, because the harness supplies it through `bindings` rather
    // than through `vars`. So the instance had a key and no `REVKIT_VERSION`,
    // `revkitBundlePath(undefined)` threw first, and the log line said
    // `Cannot read properties of undefined (reading 'length')` — a real
    // message about a real fault, just not the one under test.
    //
    // The two bindings are absent TOGETHER on purpose: the missing-key check
    // is deliberately the first statement in `fetch`, so on this instance it
    // is what fires, and a deployment missing `REVKIT_VERSION` alone would
    // report the same thing. `revkitBundlePath`'s own refusal is covered
    // directly in `test/headers.test.ts`.
    //
    // And since slice 3's
    // review the missing-secret refusal is checked HERE, on the same instance,
    // rather than from a second one in `invites.test.ts`. Sharing it is the
    // right shape for the same reason `harness` is reused as the healthy
    // control below: two `Miniflare` instances are not obviously running the
    // same bytes, and this host has a measured cliff on how many workerd
    // instances one `bun test` process holds (see `test/harness.ts`).
    broken = await startWorker({ script: workerScript, vars: null, inviteTokenKey: null });
  });

  afterAll(async () => {
    await harness.dispose();
    await probe.dispose();
    await broken.dispose();
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

  test("A4: the bundle has a CEILING as well as a floor — a floor cannot catch unbounded growth", async () => {
    // The floor exists because slice 1's scan was vacuous over a tree-shaken
    // 20 KB artefact. The ceiling is its counterpart, and its absence was a real
    // gap: a floor is a LOWER bound, so a future dependency that doubled or
    // tripled the graph would sail past it and the only signal would be
    // `wrangler deploy` failing on someone else's machine.
    const bundle = await workerBundle();
    const bytes = Buffer.byteLength(bundle, "utf8");
    expect(bytes).toBeLessThan(BUNDLE_CEILING_BYTES);
    // And the ceiling is stated as a budget with its headroom, so the number is
    // a decision rather than a vibe: how many times today's graph it allows.
    expect(BUNDLE_CEILING_BYTES / bytes).toBeGreaterThan(2);
    // The documented platform limit, so the gap between "our budget" and "the
    // platform's limit" is visible in one place. 64 MiB uncompressed, both
    // plans (developers.cloudflare.com/workers/platform/limits/, read
    // 2026-10-04); only the uncompressed size counts and there is no compressed
    // limit. NOTE the ceiling that actually bites first is the 1-SECOND
    // STARTUP limit (error 10021) — larger bundles take longer to parse — and
    // this test deliberately does NOT claim to measure startup time, because
    // the only tool that reports it is `wrangler deploy --dry-run`, which is
    // out of bounds for this task.
    expect(BUNDLE_CEILING_BYTES).toBeLessThan(WORKER_SIZE_LIMIT_BYTES / 16);
  });

  test("A4: the SHIPPED Worker entry bundle has no Node or Bun escape hatches", async () => {
    const bundle = await workerBundle();
    // Magnitude guards FIRST, and they are load-bearing in both directions.
    // Slice 2 re-opened the thread read, so this artefact went from ~20 KB
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
  test("the scoped read answers 200 with a session and the real projection", async () => {
    // The transition slice 1 existed for. Slice 1 answered 501 for every
    // verb because ADR-0012 requires authorization per request and there was
    // no session; this is the same route with a session, reading the SAME
    // seeded log (seqs 1, 2, 3, 7 — a gap, which ADR-0006 permits and the
    // reducer must survive).
    await seedClosedLog(harness.db);
    const issued = await issueTestSession(harness.db);
    const response = await harness.dispatch(`http://localhost${READ_PATH}`, {
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
    const raw = await harness.db
      .prepare("SELECT payload FROM review_logs WHERE log_key = ? AND seq = 1")
      .bind(LOG_KEY)
      .first<{ payload: string }>();
    expect(JSON.parse(raw?.payload ?? "{}")).toMatchObject({ body: SEED_BODY });
  });

  test("the scoped read with ?since=2 returns exactly the events after 2, over the gap", async () => {
    const issued = await issueTestSession(harness.db);
    const response = await harness.dispatch(`http://localhost${READ_PATH}?since=2`, {
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
    const response = await harness.dispatch(`http://localhost${READ_PATH}?since=7`, {
      headers: { cookie: cookieHeader(issued.sessionId) },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { head: number; events: unknown[] };
    expect(body.head).toBe(7);
    expect(body.events).toEqual([]);
  });

  test("the removed unscoped read, and a trailing-slash variant, are DISTINCT paths and 404 — no alias", async () => {
    // The same rule ADR-0012 states for `/_revkit/`: a trailing-slash alias is a
    // second spelling of one resource, and aliases are how a gated route quietly
    // reopens. Both 404 even WITH a valid session, so no alias can be reached by
    // any credential at all — and `/api/threads` itself 404s because slice 5
    // removed it (it named no review, so it could only ever answer org-wide).
    const issued = await issueTestSession(harness.db);
    for (const spelling of ["/api/threads", "/api/threads/", "/API/threads", "/api//threads"]) {
      const response = await harness.dispatch(`http://localhost${spelling}`, {
        headers: { cookie: cookieHeader(issued.sessionId) },
      });
      expect(response.status, spelling).toBe(404);
      expect(response.headers.get("location"), spelling).toBeNull();
      expect(await response.text(), spelling).not.toContain("th-closed");
    }
    // The scoped read itself is unaffected, and carries no `Location` either.
    const scoped = await harness.dispatch(`http://localhost${READ_PATH}`, {
      headers: { cookie: cookieHeader(issued.sessionId) },
    });
    expect(scoped.status).toBe(200);
    expect(scoped.headers.get("location")).toBeNull();
  });

  test("POST on the scoped read is still 501 — and it gets past the gate to say so", async () => {
    // The status is unchanged from slice 1 and the REASON is not: this call
    // now carries a valid session, a valid per-session CSRF token and
    // `application/json`, so ADR-0012's three state-changing checks all PASS
    // before the route answers. That is the honest distinction — the write is
    // missing (slice 4), the authorization is not.
    const issued = await issueTestSession(harness.db);
    const response = await harness.dispatch(`http://localhost${READ_PATH}`, {
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
    const counted = await harness.db
      .prepare("SELECT COUNT(*) AS n FROM review_logs WHERE log_key = ?")
      .bind(LOG_KEY)
      .first<{ n: number }>();
    expect(counted?.n).toBe(4);
  });

  test("PUT on the scoped read is 405, not 401 — a session is present, the verb is wrong", async () => {
    // Order matters and is asserted: authorization first (unconditionally),
    // then the verb. Without a session the SAME request is 401, which
    // `authorization.test.ts` drives — so a 405 here is evidence the gate
    // let a known caller through, not evidence the route ignores verbs.
    const issued = await issueTestSession(harness.db);
    const response = await harness.dispatch(`http://localhost${READ_PATH}`, {
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
      [READ_PATH, "GET"],
      [READ_PATH, "POST"],
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
    const refused = await harness.dispatch(`http://localhost${READ_PATH}`);
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
    // The shared misconfigured instance from this describe's `beforeAll`.

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
  });

  // ── the catch block, actually entered ─────────────────────────────────

  // ── the missing HMAC key, and what the error boundary logs ───────────
  test("a deployment with no INVITE_TOKEN_HMAC_KEY refuses EVERY route, /healthz included", async () => {
    // There is no fallback key: a missing secret is a hard failure rather than a
    // silent one, because a zero-filled key produces a VALID, WRONG digest,
    // which is worse than no key. `/healthz` is included deliberately — a
    // deployment that cannot hash an invite token cannot redeem one, so a
    // liveness probe that reported it healthy would be lying. `src/invite-token.ts`
    // has the full argument, including why a Workers module has no "start" at
    // which to refuse and why this first-line check is the equivalent.
    for (const [path, method] of [
      ["/healthz", "GET"],
      [READ_PATH, "GET"],
      ["/invite/redeem", "POST"],
      [`/invite/${"A".repeat(43)}`, "GET"],
      ["/nope", "GET"],
    ] as const) {
      const response = await broken.dispatch(`http://localhost${path}`, { method });
      expect(response.status, `${method} ${path}`).toBe(500);
      expect(await response.text()).toBe("internal error\n");
    }
  });

  test("the error boundary logs the MESSAGE, not the class name", async () => {
    // Slice 3 logged `error.name` and justified it by hand. The redactor is the
    // control for "a message can carry a SQL fragment or a store path", and it
    // was never applied to a field the call site chose not to fill — so the
    // strongest available claim about the Worker's logs was untested on the one
    // path that matters. With `error.name` the field below would be the bare
    // class name, so the two are distinguishable rather than interchangeable.
    // The line is forwarded by miniflare over its own wire, so it reaches the
    // HOST after the response resolves — restoring `console.log` the moment
    // `dispatch` returns truncates the capture at an unpredictable point, and
    // this test measured exactly that (it failed whenever the suite ran under
    // load, with zero lines). So: poll for the line on a bounded budget, which
    // is what `test/logger.test.ts` does for the same reason. A line that never
    // arrives still fails, just after the budget rather than immediately.
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: unknown) => { lines.push(String(line)); };
    let response;
    try {
      response = await broken.dispatch("http://localhost/healthz");
      const deadline = Date.now() + 2_000;
      while (
        !lines.some((line) => line.includes('"request.error"')) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      console.log = original;
    }
    expect(response.status).toBe(500);
    const errors = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((parsed) => parsed["msg"] === "request.error");
    expect(errors.length).toBeGreaterThan(0);
    for (const line of errors) {
      expect(line["error"]).toBe(
        "MissingInviteTokenKeyError: env.INVITE_TOKEN_HMAC_KEY is absent or shorter than 32 characters; " +
          "invite tokens cannot be hashed or verified.",
      );
      expect(line["error"]).not.toBe("MissingInviteTokenKeyError");
      // It names the BINDING, which is a fixed identifier, and no value.
      expect(String(line["error"])).toContain("INVITE_TOKEN_HMAC_KEY");
      expect(String(line["error"])).not.toContain(TEST_INVITE_TOKEN_HMAC_KEY);
    }
    for (const line of lines) expect(line).not.toContain(TEST_INVITE_TOKEN_HMAC_KEY);
  });
});
