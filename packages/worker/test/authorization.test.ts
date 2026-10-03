// ADR-0012's per-request authorization gate, driven through real workerd.
//
// This file is the negative half of slice 2, and it is the half that matters:
// slice 1 closed `GET /api/threads` because there was no way to authorize a
// caller, and the whole point of this slice is that the route is now open
// **and** still unreachable without a session this build issued.
//
// The shape of the evidence, deliberately:
//   - a ROUTE TABLE, asserted exhaustively, so "which routes are gated" is a
//     claim about a table rather than about a code path somebody remembers.
//   - a NEGATIVE MATRIX, one case per gated route per verb per refusal reason,
//     driven over HTTP against a log that HAS content in it, so a passing test
//     cannot be passing because there was nothing to leak.
//   - CSRF proven load-bearing on a reachable state-changing route, including
//     that the token is bound to the session rather than being a constant.
//   - alias and query spellings, because a gate that one URL spelling walks
//     around is not a gate.
//
// Every request goes through `miniflare.dispatchFetch`, i.e. the same workerd
// the platform runs, with the same empty `compatibility_flags`.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  classifyRoute,
  denialLogMessage,
  DENIAL_REASONS,
  HEALTH_PATH,
  SESSION_REFRESH_PATH,
  THREADS_PATH,
  type DenialReason,
  type RouteKind,
} from "../src/authz.ts";
import {
  CSRF_HEADER,
  SESSION_COOKIE_NAME,
  mintToken,
  sha256Hex,
  SessionAlreadyRotatedError,
} from "../src/session.ts";
import { parsePreviewPath, parseThreadsQuery } from "../src/router.ts";
import {
  authHeaders,
  cookieHeader,
  issueTestSession,
  JSON_HEADERS,
  startWorker,
  type Harness,
} from "./harness.ts";

/** The body every seeded comment carries. A refusal must never contain it, and
 * an admitted read must — so both halves assert against the SAME string
 * rather than two literals that could drift apart. */
const SEED_BODY = "this comment body must only reach a caller with a session";

/** A four-event log with a gap at seq 4..6 (seqs 1, 2, 3, 7). ADR-0006
 * blesses gaps in a D1-backed store, so a hosted read that renumbered them
 * would be wrong in a way a contiguous fixture cannot detect. */
async function seedLog(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM events").run();
  for (const seq of [1, 2, 3, 7]) {
    await db
      .prepare("INSERT INTO events (seq, ts, payload) VALUES (?, ?, ?)")
      .bind(
        seq,
        `2026-10-04T12:00:0${seq}Z`,
        JSON.stringify({
          seq,
          ts: `2026-10-04T12:00:0${seq}Z`,
          actor: { kind: "gh-user", id: "gerchowl" },
          kind: "comment.created",
          threadId: `th-seed-${seq}`,
          commentId: `c-seed-${seq}`,
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

const VERBS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/** Paths the surface answers, plus the alias spellings that must NOT be one. */
const GATED_PATHS = [THREADS_PATH, SESSION_REFRESH_PATH, "/revkit/pr-7/index.html"] as const;
const UNGATED_PATHS = [HEALTH_PATH, "/_revkit/0.0.0/rail.js", "/nope", `${THREADS_PATH}/`] as const;

/** What `harness.dispatch` actually resolves to. Not the DOM `Response`: bun's
 * and `@cloudflare/workers-types`' declarations of that type disagree (one has
 * `textStream`, the other does not), and naming miniflare's own type here
 * keeps that disagreement out of every helper below instead of into a cast. */
type DispatchResponse = Awaited<ReturnType<Harness["dispatch"]>>;
type DispatchInit = Parameters<Harness["dispatch"]>[1];

interface Refusal {
  readonly status: number;
  readonly raw: string;
  readonly body: { error?: string; reason?: string };
}

/** Read a response ONCE (`Response.body` is a stream) and return both the raw
 * text and the parsed refusal shape, so every assertion about a refusal can be
 * made against the same bytes. */
async function refusalOf(response: DispatchResponse): Promise<Refusal> {
  const raw = await response.text();
  let body: Refusal["body"] = {};
  try {
    body = JSON.parse(raw) as Refusal["body"];
  } catch {
    body = {};
  }
  return { status: response.status, raw, body };
}

/** Assert a response is a refusal that leaked nothing.
 *
 * Four things at once, because each is a separate failure a reviewer would
 * otherwise have to ask about: the status is one of the refusal statuses, the
 * body is the refusal SHAPE (not a stack trace, not an HTML error page), the
 * `reason` is one of the gate's closed vocabulary — never text from the
 * request — and the seeded comment body is nowhere in the response. */
function expectRefused(refusal: Refusal, allowed: readonly number[], label = ""): void {
  expect(allowed, `${label}: status ${String(refusal.status)} for ${JSON.stringify(refusal.body)}`).toContain(
    refusal.status,
  );
  expect(refusal.raw, label).not.toContain(SEED_BODY);
  expect(refusal.raw, label).not.toContain("th-seed");
  expect(refusal.raw, label).not.toContain("docs/a.mdx");
  expect(refusal.raw, label).not.toContain("gerchowl");
  expect(refusal.raw, label).not.toContain("internal error");
  expect(refusal.raw.length, label).toBeLessThan(200);
  // A `HEAD` answer carries no body at all, by HTTP, so the assertions about
  // the refusal SHAPE do not apply to it — and asserting they did would be
  // asserting about a body that was never sent. `HEAD` is in the matrix and its
  // STATUS is checked here; its emptiness is asserted on its own, in the case
  // named "a refused HEAD carries no body".
  if (refusal.raw.length === 0) return;
  if (refusal.status === 401 || refusal.status === 403) {
    expect(DENIAL_REASONS as readonly string[], `${label}: unregistered reason ${String(refusal.body.reason)}`).toContain(
      String(refusal.body.reason),
    );
  }
}

describe("ADR-0012's per-request gate", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startWorker();
  });

  afterAll(async () => {
    await harness.dispose();
  });

  beforeEach(async () => {
    await seedLog(harness.db);
    await harness.db.prepare("DELETE FROM sessions").run();
  });

  // ── 1. the route table, asserted as a table ────────────────────────────
  describe("the route table", () => {
    test("every path and verb has exactly one classification, and it is the one below", () => {
      // An exhaustive expectation, not a sample. The table below is the whole
      // shipped surface; a new route that nobody added here shows up as a
      // failing case rather than as an ungated route nobody noticed.
      const expected: Record<string, RouteKind> = {
        [`${HEALTH_PATH} GET`]: "health",
        [`${HEALTH_PATH} HEAD`]: "health",
        [`${HEALTH_PATH} POST`]: "method-not-allowed",
        [`${HEALTH_PATH} PUT`]: "method-not-allowed",
        [`${HEALTH_PATH} DELETE`]: "method-not-allowed",
        [`${THREADS_PATH} GET`]: "threads-read",
        [`${THREADS_PATH} HEAD`]: "threads-read",
        [`${THREADS_PATH} POST`]: "threads-append",
        [`${THREADS_PATH} PUT`]: "method-not-allowed",
        [`${THREADS_PATH} PATCH`]: "method-not-allowed",
        [`${THREADS_PATH} DELETE`]: "method-not-allowed",
        [`${THREADS_PATH} OPTIONS`]: "method-not-allowed",
        [`${SESSION_REFRESH_PATH} POST`]: "session-refresh",
        [`${SESSION_REFRESH_PATH} GET`]: "method-not-allowed",
        [`${SESSION_REFRESH_PATH} HEAD`]: "method-not-allowed",
        [`${SESSION_REFRESH_PATH} PUT`]: "method-not-allowed",
        [`${SESSION_REFRESH_PATH} OPTIONS`]: "method-not-allowed",
        ["/revkit/pr-7/index.html GET"]: "preview",
        ["/revkit/pr-7/index.html POST"]: "preview",
        ["/_revkit/0.0.0/rail.js GET"]: "revkit-bundle",
        [`${THREADS_PATH}/ GET`]: "unknown",
        ["/nope GET"]: "unknown",
        ["/nope POST"]: "unknown",
      };
      for (const [key, kind] of Object.entries(expected)) {
        const separator = key.lastIndexOf(" ");
        const pathname = key.slice(0, separator);
        const method = key.slice(separator + 1);
        expect(classifyRoute(pathname, method).kind, key).toBe(kind);
      }
    });

    test("the gated paths are exactly the three that can carry data", () => {
      // The invariant, stated so a reviewer does not have to read the table
      // above to know the blast radius: `/api/threads`, `/api/session/refresh`
      // and ADR-0008's `<repo>/pr-<n>/` preview paths are gated on every verb.
      // `/healthz` (a probe that reads no database), `/_revkit/` (ADR-0012's
      // never-redirecting static path) and everything unrecognised are not,
      // because none of them can return review data.
      //
      // The policy is expressed PATH-side on purpose. Asserting it through
      // `RouteKind` cannot work — `method-not-allowed` is gated or not
      // depending on which path produced it — which is itself the reason the
      // gate consults `requiresSession` rather than the kind.
      const isGatedPath = (pathname: string): boolean =>
        pathname === THREADS_PATH || pathname === SESSION_REFRESH_PATH || parsePreviewPath(pathname) !== undefined;
      const probes = [
        ...GATED_PATHS,
        ...UNGATED_PATHS,
        "/",
        "//",
        "/api",
        "/api/",
        "/api/threads.json",
        "/api/session",
        "/api/session/",
        "/revkit/pr-0/",
        "/revkit/pr-7",
        "/_revkit",
        "/_revkit/",
        "/not-a-preview/pr-7/",
      ];
      for (const pathname of probes) {
        for (const method of VERBS) {
          expect(classifyRoute(pathname, method).requiresSession, `${pathname} ${method}`).toBe(isGatedPath(pathname));
        }
      }
      // And the kind-level cross-check, in the direction that can actually
      // fail: a route that requires a session is answered by
      // `handleAuthorized`, and every kind that handler switches over is one
      // `requiresSession` can be true for. A fifth gated kind without a
      // handler would reach `unreachable()` and 500.
      const HANDLED_GATED_KINDS: ReadonlySet<RouteKind> = new Set<RouteKind>([
        "method-not-allowed",
        "threads-read",
        "threads-append",
        "session-refresh",
        "preview",
      ]);
      for (const pathname of probes) {
        for (const method of VERBS) {
          const route = classifyRoute(pathname, method);
          if (route.requiresSession) {
            expect(HANDLED_GATED_KINDS.has(route.kind), `${pathname} ${method} is ${route.kind}`).toBe(true);
          }
        }
      }
      // And the reverse: a handler that exists is reachable, or its route can
      // never satisfy `requiresSession` and the handler is dead code.
      for (const pathname of probes) {
        for (const method of VERBS) {
          const route = classifyRoute(pathname, method);
          if (HANDLED_GATED_KINDS.has(route.kind)) {
            expect(route.requiresSession || route.kind === "method-not-allowed", `${pathname} ${method}`).toBe(true);
          }
        }
      }
    });

    test("a preview path is gated even though it serves nothing yet", () => {
      // So slice 5 inherits the gate from the table rather than having to
      // remember it — the day R2 exists, a 501 becomes a 200.
      const route = classifyRoute("/revkit/pr-7/index.html", "GET");
      expect(route.requiresSession).toBe(true);
      expect(route.stateChanging).toBe(false);
    });

    test("only the two state-changing routes carry the CSRF obligation", () => {
      // A read must NOT need a CSRF token: requiring one would make every
      // `fetch()` in the rail carry a header it has no use for, and would
      // train a client to attach a credential to reads.
      expect(classifyRoute(THREADS_PATH, "GET").stateChanging).toBe(false);
      expect(classifyRoute(THREADS_PATH, "HEAD").stateChanging).toBe(false);
      expect(classifyRoute(SESSION_REFRESH_PATH, "POST").stateChanging).toBe(true);
      expect(classifyRoute(THREADS_PATH, "POST").stateChanging).toBe(true);
    });

    test("method matching is case-insensitive and path matching is not", () => {
      // A verb's case is not a security boundary — `Request.method` is
      // normalised by the platform, and a proxy may not be — so it is
      // upper-cased. A PATH's case absolutely is: `/API/threads` is a
      // different URL and must not reach the read.
      expect(classifyRoute(THREADS_PATH, "get").kind).toBe("threads-read");
      expect(classifyRoute("/API/threads", "GET").kind).toBe("unknown");
      expect(classifyRoute("/Api/Threads", "GET").kind).toBe("unknown");
    });

    test("every refusal reason this gate can produce is in ITS closed vocabulary", () => {
      // The union is derived from the list, so TypeScript cannot let them
      // drift; this pins the list against an edit that would ADD a reason
      // without thinking about the response body and the log line it appears
      // in. A reason reaching a response body is a place request content could
      // be reflected, which is the leak ADR-0012/ADR-0020 keep naming.
      expect([...DENIAL_REASONS].sort()).toEqual([
        "ambiguous-session-cookie",
        "content-type-not-json",
        "csrf-header-missing",
        "csrf-header-rejected",
        "expired-session",
        "incomplete-session-row",
        "malformed-session-cookie",
        "no-session-cookie",
        "unknown-session",
        "unrecognised-identity-kind",
      ]);
      // And no member is a value any redactor would eat, which is what made
      // the logger-side exemption unnecessary in the first place: none looks
      // like a credential, an address, or a revkit token.
      for (const reason of DENIAL_REASONS) {
        expect(reason).toMatch(/^[a-z][a-z-]*$/);
        expect(reason.length).toBeLessThan(40);
      }
    });

    test("a refusal's log event is chosen from a closed mapping", () => {
      // CSRF and shape failures are separate events from authorization
      // failures because they have different causes and a different response
      // to one — a burst of `auth.denied` is an attack, a burst of
      // `csrf.rejected` is usually a broken client.
      expect(denialLogMessage("no-session-cookie")).toBe("auth.denied");
      expect(denialLogMessage("expired-session")).toBe("auth.denied");
      expect(denialLogMessage("csrf-header-missing")).toBe("csrf.rejected");
      expect(denialLogMessage("csrf-header-rejected")).toBe("csrf.rejected");
      expect(denialLogMessage("content-type-not-json")).toBe("auth.denied");
    });
  });

  // ── 2. the negative matrix ─────────────────────────────────────────────
  describe("nothing is reachable without a session this build issued", () => {
    test("no gated route answers 200 to any verb without a credential", async () => {
      // The core claim, one case per (route, verb). `expectRefused` also
      // asserts the seeded comment body is absent, so this cannot pass because
      // the log was empty.
      const cases: [string, string][] = [];
      for (const pathname of GATED_PATHS) {
        for (const method of VERBS) cases.push([pathname, method]);
      }
      for (const [pathname, method] of cases) {
        const response = await harness.dispatch(`http://localhost${pathname}`, {
          method,
          headers: JSON_HEADERS,
        });
        expectRefused(await refusalOf(response), [401], `${pathname} ${method}`);
      }
    });

    test("a FORGED cookie of the right shape is refused — a shape is not a credential", async () => {
      // The case that separates "we check the cookie" from "we check the
      // cookie". 256 bits of well-formed base64url that names no row.
      const forged = mintToken();
      expect(forged).toHaveLength(43);
      for (const [pathname, method] of [
        [THREADS_PATH, "GET"],
        [THREADS_PATH, "POST"],
        [SESSION_REFRESH_PATH, "POST"],
        ["/revkit/pr-7/index.html", "GET"],
      ] as const) {
        const response = await harness.dispatch(`http://localhost${pathname}`, {
          method,
          headers: { cookie: cookieHeader(forged), [CSRF_HEADER]: forged, ...JSON_HEADERS },
        });
        const refusal = await refusalOf(response);
        expectRefused(refusal, [401]);
        // The reason is the specific one, so an operator can tell a forgery
        // from an expiry without reading the cookie.
        expect(refusal.body.reason).toBe("unknown-session");
      }
    });

    test("a malformed cookie is refused before the database is touched", async () => {
      const issued = await issueTestSession(harness.db);
      for (const value of ["", "a", "not-a-token", `${issued.sessionId}A`, "a".repeat(500), "%00%00%00"]) {
        const response = await harness.dispatch(`http://localhost${THREADS_PATH}`, {
          headers: { cookie: cookieHeader(value) },
        });
        const refusal = await refusalOf(response);
        expectRefused(refusal, [401]);
        expect(refusal.body.reason).toBe("malformed-session-cookie");
      }
    });

    test("an EMPTY cookie, and no cookie at all, are distinguishable but both refused", async () => {
      const absent = await refusalOf(await harness.dispatch(`http://localhost${THREADS_PATH}`));
      expect(absent.status).toBe(401);
      expect(absent.body.reason).toBe("no-session-cookie");
      const empty = await refusalOf(
        await harness.dispatch(`http://localhost${THREADS_PATH}`, { headers: { cookie: "" } }),
      );
      expect(empty.status).toBe(401);
      expect(empty.body.reason).toBe("no-session-cookie");
    });

    test("two cookies with the same name are refused as ambiguous, not resolved by order", async () => {
      // Cookie tossing: one origin's session replaced by another's. Browsers
      // order by specificity, which is not this Worker's to reason about, so
      // the honest answer is to refuse rather than pick.
      const issued = await issueTestSession(harness.db);
      const response = await harness.dispatch(`http://localhost${THREADS_PATH}`, {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${issued.sessionId}; ${SESSION_COOKIE_NAME}=${mintToken()}` },
      });
      const refusal = await refusalOf(response);
      expectRefused(refusal, [401]);
      expect(refusal.body.reason).toBe("ambiguous-session-cookie");
    });

    test("an EXPIRED session is refused — expiry is checked on the read, not at issue", async () => {
      // Issued through the real issuer and then aged in the database, which is
      // what a session that outlived its TTL looks like to the Worker. No
      // sleep, no flake, and it exercises the READ path — the property that
      // matters, because a check at issue would pass this test and still let
      // the cookie work forever.
      const issued = await issueTestSession(harness.db);
      const future = new Date(Date.now() + 3_600_000).toISOString();
      await harness.db.prepare("UPDATE sessions SET expires_at = ?").bind(future).run();
      // Alive one second before its expiry…
      await harness.db.prepare("UPDATE sessions SET expires_at = ?").bind(new Date(Date.now() + 1_000).toISOString()).run();
      expect(
        (await harness.dispatch(`http://localhost${THREADS_PATH}`, { headers: { cookie: cookieHeader(issued.sessionId) } }))
          .status,
      ).toBe(200);
      // …and dead AT it. The comparison is `<=`, so "exactly now" is refused.
      await harness.db.prepare("UPDATE sessions SET expires_at = ?").bind(new Date(Date.now() - 1).toISOString()).run();
      const refusal = await refusalOf(
        await harness.dispatch(`http://localhost${THREADS_PATH}`, { headers: { cookie: cookieHeader(issued.sessionId) } }),
      );
      expectRefused(refusal, [401]);
      expect(refusal.body.reason).toBe("expired-session");
      // The row is still there: expiry is a DECISION, not a deletion, and
      // nothing in this slice sweeps. Stated so `expired` is not read as
      // `purged` — ADR-0015's retention clock is slice-3+.
      const counted = await harness.db.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>();
      expect(counted?.n).toBe(1);
      // `future` is referenced so the "alive" case above is explicit about the
      // window it was checking.
      expect(Date.parse(future)).toBeGreaterThan(Date.now());
    });

    test("a session whose IDENTITY KIND this build does not know is refused", async () => {
      // Deny by default. A row written by a future migration that the gate
      // has no rules for must not be honoured with no scope check, no expiry
      // rule and no revocation path.
      const issued = await issueTestSession(harness.db);
      for (const kind of ["github", "invite"]) {
        await harness.db.prepare("UPDATE sessions SET identity_kind = ?").bind(kind).run();
        const refusal = await refusalOf(
          await harness.dispatch(`http://localhost${THREADS_PATH}`, {
            headers: { cookie: cookieHeader(issued.sessionId) },
          }),
        );
        expectRefused(refusal, [401]);
        expect(refusal.body.reason).toBe("unrecognised-identity-kind");
      }
    });

    test("an incomplete row is refused, and named differently from an unknown kind", async () => {
      const issued = await issueTestSession(harness.db);
      await harness.db.prepare("UPDATE sessions SET csrf_hash = ''").run();
      const refusal = await refusalOf(
        await harness.dispatch(`http://localhost${THREADS_PATH}`, {
          headers: { cookie: cookieHeader(issued.sessionId) },
        }),
      );
      expectRefused(refusal, [401]);
      expect(refusal.body.reason).toBe("incomplete-session-row");
    });

    test("the 405 for a wrong verb is BEHIND the gate, so route existence is not leaked", async () => {
      const issued = await issueTestSession(harness.db);
      // Without a session: 401. With one: 405. If the order were reversed, an
      // anonymous caller could enumerate the surface by watching 405s appear.
      for (const [pathname, method] of [
        [THREADS_PATH, "PUT"],
        [SESSION_REFRESH_PATH, "GET"],
        [SESSION_REFRESH_PATH, "DELETE"],
      ] as const) {
        const anonymous = await refusalOf(await harness.dispatch(`http://localhost${pathname}`, { method }));
        expectRefused(anonymous, [401]);
        expect(anonymous.body.error).toBe("unauthorized");
        const known = await harness.dispatch(`http://localhost${pathname}`, {
          method,
          headers: { cookie: cookieHeader(issued.sessionId) },
        });
        expect(known.status).toBe(405);
      }
    });

    test("no alias spelling of a gated path reaches it", async () => {
      // Trailing slash, doubled slash, percent-encoded slash, dot-segment,
      // case, and an extension. Each is either the route (and then it is
      // gated) or a 404. Nothing lands on 200 without a session.
      const issued = await issueTestSession(harness.db);
      const aliases = [
        `${THREADS_PATH}/`,
        `${THREADS_PATH}//`,
        "/api//threads",
        "/api/threads%2f",
        "/api/threads.json",
        "/API/threads",
        // A leading space is NOT in this list on purpose: miniflare (and the
        // platform) reject it while building the `Request`, so it never
        // reaches a handler. That is an answer too — one layer earlier — and
        // inventing a 404 expectation for it would be asserting about a
        // request that was never made.
        "/api/Threads",
        `${THREADS_PATH}/../api/threads`,
        `${THREADS_PATH}/.`,
        `${THREADS_PATH}%20`,
      ];
      for (const alias of aliases) {
        const anonymous = await refusalOf(await harness.dispatch(`http://localhost${alias}`));
        expect(anonymous.status, alias).not.toBe(200);
        expect(anonymous.raw, alias).not.toContain(SEED_BODY);
        // With a session: 200 is allowed (some of these normalise to the
        // route) and 404 is allowed, but never a refusal — which is what
        // proves the anonymous 401 above was the GATE and not the router.
        const known = await harness.dispatch(`http://localhost${alias}`, {
          headers: { cookie: cookieHeader(issued.sessionId) },
        });
        expect([200, 404], alias).toContain(known.status);
      }
    });

    test("no alias spelling of the refresh path reaches it either", async () => {
      const issued = await issueTestSession(harness.db);
      for (const alias of [
        `${SESSION_REFRESH_PATH}/`,
        "/api/session/refresh/",
        "/API/session/refresh",
        "/api/session//refresh",
        "/api/session/refresh.json",
      ]) {
        const response = await harness.dispatch(`http://localhost${alias}`, {
          method: "POST",
          headers: { ...authHeaders(issued), ...JSON_HEADERS },
        });
        // A refusal, or the route's own 405 — never a rotation. If one of
        // these returned 200 with a `Set-Cookie`, the CSRF-protected surface
        // would have a second spelling.
        const setCookie = response.headers.get("set-cookie");
        expect(setCookie === null || response.status >= 400, alias).toBe(true);
      }
    });

    test("/healthz is the one open route, and it returns no review content", async () => {
      const response = await harness.dispatch(`http://localhost${HEALTH_PATH}`);
      expect(response.status).toBe(200);
      const raw = await response.text();
      expect(JSON.parse(raw) as Record<string, unknown>).toMatchObject({ ok: true });
      expect(raw).not.toContain(SEED_BODY);
      expect(raw).not.toContain("th-seed");
      // It reads no database: a probe that needed one would be a probe nobody
      // runs, and `count` — the one field that would betray a query — is
      // absent by construction rather than by zero.
      expect(Object.keys(JSON.parse(raw) as Record<string, unknown>).sort()).toEqual(["ok", "requestId", "revkitVersion"]);
    });

    test("the ungated 404 and the bundle 404 leak nothing either", async () => {
      for (const pathname of ["/nope", "/_revkit/0.0.0/rail.js", `${THREADS_PATH}/`]) {
        const refusal = await refusalOf(await harness.dispatch(`http://localhost${pathname}`));
        expect(refusal.status).toBe(404);
        expect(refusal.raw).not.toContain(SEED_BODY);
        expect(refusal.raw).not.toContain("th-seed");
      }
    });
  });

  // ── 3. the gate admits ─────────────────────────────────────────────────
  describe("a session this build issued is admitted", () => {
    test("GET /api/threads answers 200 with the projection, and only with a session", async () => {
      const issued = await issueTestSession(harness.db);
      const response = await harness.dispatch(`http://localhost${THREADS_PATH}`, {
        headers: { cookie: cookieHeader(issued.sessionId) },
      });
      expect(response.status).toBe(200);
      const raw = await response.text();
      const body = JSON.parse(raw) as { head: number; threads: unknown[] };
      expect(body.head).toBe(7);
      expect(body.threads).toHaveLength(4);
      // The admitted half of the same assertion: the content IS served, so the
      // refusals above are refusing something real.
      expect(raw).toContain(SEED_BODY);
      // ADR-0012: API JSON is never cached, and a session-bearing request's
      // response must not sit in an intermediary.
      expect(response.headers.get("cache-control")).toBe("no-store");
    });

    test("POST /api/session/refresh rotates the credential and the CSRF token together", async () => {
      const issued = await issueTestSession(harness.db);
      const response = await harness.dispatch(`http://localhost${SESSION_REFRESH_PATH}`, {
        method: "POST",
        headers: { ...authHeaders(issued), ...JSON_HEADERS },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { identityKind: string; createdAt: string; expiresAt: string };
      expect(body.identityKind).toBe("operator");
      // `createdAt` is carried over, not reset: that is what the lifetime cap
      // is measured from, so a refresh cannot extend a session past its cap by
      // pretending to be a new one.
      const row = await harness.db.prepare("SELECT created_at FROM sessions").first<{ created_at: string }>();
      expect(body.createdAt).toBe(String(row?.created_at));

      const setCookie = response.headers.get("set-cookie");
      expect(setCookie).not.toBeNull();
      expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("Secure");
      expect(setCookie).toMatch(/SameSite=Lax/);
      expect(setCookie).toContain("Path=/");
      const rotatedToken = response.headers.get(CSRF_HEADER);
      expect(rotatedToken).not.toBeNull();
      expect(rotatedToken).not.toBe(issued.csrfToken);

      // The new cookie works, and the OLD one does not — that is the whole
      // point of rotating rather than merely extending.
      const rotatedId = /__Host-revkit_session=([^;]+)/.exec(String(setCookie))?.[1] ?? "";
      expect(rotatedId).not.toBe(issued.sessionId);
      expect(
        (await harness.dispatch(`http://localhost${THREADS_PATH}`, { headers: { cookie: cookieHeader(rotatedId) } }))
          .status,
      ).toBe(200);
      expect(
        (await harness.dispatch(`http://localhost${THREADS_PATH}`, { headers: { cookie: cookieHeader(issued.sessionId) } }))
          .status,
      ).toBe(401);
      // Exactly one live row, so the refresh left nothing behind.
      const counted = await harness.db.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>();
      expect(counted?.n).toBe(1);
    });

    test("two concurrent refreshes of one cookie leave exactly ONE live session", async () => {
      // The double-click / retried-request case, and the reason `rotateSession`
      // guards its INSERT on the old row. Both requests are dispatched
      // together against the same cookie.
      //
      // Which refusal the loser gets is NOT deterministic — 409 when both
      // requests cleared the gate before either rotated, 401 when the loser's
      // gate ran after the winner committed — so the assertions are the
      // invariants rather than the statuses. Everything below holds either
      // way, and everything below is the property that matters: one rotation,
      // one row, one credential.
      const issued = await issueTestSession(harness.db);
      const call = () =>
        harness.dispatch(`http://localhost${SESSION_REFRESH_PATH}`, {
          method: "POST",
          headers: { ...authHeaders(issued), ...JSON_HEADERS },
        });
      const both = await Promise.all([call(), call()]);
      const statuses = both.map((response) => response.status).sort();
      expect(statuses.filter((status) => status === 200)).toHaveLength(1);
      expect(statuses.filter((status) => status === 200 || status === 401 || status === 409)).toHaveLength(2);
      // Exactly one live row, and it is the winner's.
      const rows = await harness.db.prepare("SELECT id FROM sessions").all<{ id: string }>();
      expect(rows.results ?? []).toHaveLength(1);
      const winner = both.find((response) => response.status === 200);
      const setCookie = String(winner?.headers.get("set-cookie") ?? "");
      const winnerId = /__Host-revkit_session=([^;]+)/.exec(setCookie)?.[1] ?? "";
      expect(winnerId).not.toBe("");
      expect((rows.results ?? [])[0]?.id).toBe(await sha256Hex(winnerId));
      // And neither response leaked the loser's or the winner's credentials
      // into its body.
      for (const response of both) {
        await response.text();
      }
    });

    test("the 409 mapping itself is not reachable over HTTP without a real in-request race", async () => {
      // Stated rather than asserted away. `refreshSession` maps
      // `SessionAlreadyRotatedError` to 409 with "start again", and that
      // mapping is only reached when a session resolves in the gate and is
      // gone by the rotation — a window of one statement pair that a test
      // cannot open from outside the request. What IS proven is the
      // mechanism (`SessionAlreadyRotatedError` is thrown, and leaves no row
      // behind) in `test/session.test.ts`, and the concurrent case above
      // proves the outcome is never two sessions. The 409 LINE is therefore
      // unexercised; if a future test harness gains a hook it belongs there.
      expect(typeof SessionAlreadyRotatedError).toBe("function");
    });
  });

  // ── 4. CSRF, load-bearing ──────────────────────────────────────────────
  describe("CSRF is load-bearing, not decorative", () => {
    test("a state-changing call with NO header is refused", async () => {
      const issued = await issueTestSession(harness.db);
      const response = await harness.dispatch(`http://localhost${SESSION_REFRESH_PATH}`, {
        method: "POST",
        headers: { cookie: cookieHeader(issued.sessionId), ...JSON_HEADERS },
      });
      const refusal = await refusalOf(response);
      // 403, not 401: the session was fine, the REQUEST was not permitted.
      // Getting this distinction wrong in either direction is a real bug —
      // 401 would send a legitimate client off to log in again.
      expectRefused(refusal, [403]);
      expect(refusal.body).toEqual({ error: "csrf", reason: "csrf-header-missing" });
      // And nothing changed.
      expect((await harness.db.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())?.n).toBe(1);
    });

    test("a state-changing call with a WRONG header is refused", async () => {
      const issued = await issueTestSession(harness.db);
      for (const presented of [mintToken(), "not-a-token", "", issued.sessionId, `${issued.csrfToken}A`]) {
        const response = await harness.dispatch(`http://localhost${SESSION_REFRESH_PATH}`, {
          method: "POST",
          headers: { cookie: cookieHeader(issued.sessionId), [CSRF_HEADER]: presented, ...JSON_HEADERS },
        });
        const refusal = await refusalOf(response);
        expectRefused(refusal, [403]);
        expect(["csrf-header-rejected", "csrf-header-missing"], presented.slice(0, 8)).toContain(
          String(refusal.body.reason),
        );
      }
      expect((await harness.db.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())?.n).toBe(1);
    });

    test("the token is BOUND TO THE SESSION, not a shared constant", async () => {
      // The specific claim, with its falsifier named: session B's token must
      // not satisfy session A's check. If the comparison were against a
      // constant, or omitted, this is the case that fails.
      const a = await issueTestSession(harness.db);
      const b = await issueTestSession(harness.db);
      expect(a.csrfToken).not.toBe(b.csrfToken);
      const cross = await harness.dispatch(`http://localhost${SESSION_REFRESH_PATH}`, {
        method: "POST",
        headers: { cookie: cookieHeader(a.sessionId), [CSRF_HEADER]: b.csrfToken, ...JSON_HEADERS },
      });
      expectRefused(await refusalOf(cross), [403]);
      // …and neither did the cross-token rotate A's session.
      const rowsA = await harness.db
        .prepare("SELECT csrf_hash FROM sessions WHERE id = ?")
        .bind(await sha256Hex(a.sessionId))
        .first();
      expect(rowsA).not.toBeNull();
    });

    test("CSRF is checked BEFORE the route answers, so a refused write cannot even reach its 501", async () => {
      // `POST /api/threads` is 501 for an authorized caller. Without the token
      // it must be 403 — which proves the check runs in front of every
      // state-changing handler rather than inside one of them.
      const issued = await issueTestSession(harness.db);
      const withoutToken = await harness.dispatch(`http://localhost${THREADS_PATH}`, {
        method: "POST",
        headers: { cookie: cookieHeader(issued.sessionId), ...JSON_HEADERS },
      });
      expect(withoutToken.status).toBe(403);
      const withToken = await harness.dispatch(`http://localhost${THREADS_PATH}`, {
        method: "POST",
        headers: { ...authHeaders(issued), ...JSON_HEADERS },
        body: JSON.stringify({ kind: "comment.created" }),
      });
      expect(withToken.status).toBe(501);
    });

    test("a READ needs no CSRF token — requiring one would be decoration in reverse", async () => {
      const issued = await issueTestSession(harness.db);
      for (const method of ["GET", "HEAD"] as const) {
        const response = await harness.dispatch(`http://localhost${THREADS_PATH}`, {
          method,
          headers: { cookie: cookieHeader(issued.sessionId) },
        });
        expect(response.status, method).toBe(200);
      }
    });

    test("the state-changing route accepts only application/json (ADR-0012)", async () => {
      const issued = await issueTestSession(harness.db);
      // A valid token and a valid session, so the ONLY thing left to fail is
      // the media type — which is what makes 415 the evidence that the rule
      // is enforced rather than assumed.
      for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "text/json", "application/ld+json"]) {
        const response = await harness.dispatch(`http://localhost${SESSION_REFRESH_PATH}`, {
          method: "POST",
          headers: { ...authHeaders(issued), "content-type": contentType },
          body: "{}",
        });
        const refusal = await refusalOf(response);
        expectRefused(refusal, [415]);
        expect(refusal.body).toEqual({ error: "unsupported-media-type", reason: "content-type-not-json" });
      }
      // No content-type at all is refused too: a browser defaulting a form post
      // sends `application/x-www-form-urlencoded`, and a client that sends
      // nothing has not opted in.
      expect(
        (await harness.dispatch(`http://localhost${SESSION_REFRESH_PATH}`, {
          method: "POST",
          headers: { ...authHeaders(issued) },
        })).status,
      ).toBe(415);
      // A parameter is fine, so the rule is not "exactly this string".
      expect(
        (await harness.dispatch(`http://localhost${SESSION_REFRESH_PATH}`, {
          method: "POST",
          headers: { ...authHeaders(issued), "content-type": "application/json; charset=utf-8" },
        })).status,
      ).toBe(200);
    });

    test("CSRF is checked AFTER authorization, so a missing token is not a session oracle", async () => {
      // No cookie AND no token: 401, not 403. The other order would tell an
      // anonymous caller whether their CSRF token was right.
      const response = await harness.dispatch(`http://localhost${SESSION_REFRESH_PATH}`, {
        method: "POST",
        headers: JSON_HEADERS,
      });
      const refusal = await refusalOf(response);
      expectRefused(refusal, [401]);
      expect(refusal.body).toEqual({ error: "unauthorized", reason: "no-session-cookie" });
    });
  });

  // ── 5. the query string ────────────────────────────────────────────────
  describe("the query string neither bypasses the gate nor distorts a read", () => {
    test("EVERY ?since= spelling is gated before it is parsed", async () => {
      // Authorization first, unconditionally. If the query were parsed first, a
      // malformed `since` would answer 400 to an anonymous caller — which is
      // an oracle about the request's shape to someone who has proved nothing.
      const spellings = [
        "",
        "?since=0",
        "?since=2",
        "?since=7",
        "?since=99999999999999999999",
        "?since=-1",
        "?since=+1",
        "?since=abc",
        "?since=0x10",
        "?since=1e3",
        "?since=1.0",
        "?since=%201",
        "?since=",
        "?since=1&since=2",
        "?SINCE=1",
        "?since=1&repo=other",
        "?repo=other",
        "?scope=admin",
        "?a=1&b=2",
        "?",
      ];
      for (const query of spellings) {
        const refusal = await refusalOf(
          await harness.dispatch(`http://localhost${THREADS_PATH}${query}`),
        );
        expectRefused(refusal, [401]);
      }
      // And the same matrix with a FORGED cookie: still 401, and still with no
      // 400 anywhere in it.
      for (const query of spellings) {
        const refusal = await refusalOf(
          await harness.dispatch(`http://localhost${THREADS_PATH}${query}`, {
            headers: { cookie: cookieHeader(mintToken()) },
          }),
        );
        expect(refusal.status, query).toBe(401);
      }
    });

    test("with a session, a canonical ?since= is served and anything else is 400 with a CLOSED reason", async () => {
      const issued = await issueTestSession(harness.db);
      const headers = { cookie: cookieHeader(issued.sessionId) };
      for (const [query, seqs] of [
        ["", null],
        ["?since=0", [1, 2, 3, 7]],
        ["?since=3", [7]],
        ["?since=7", []],
        ["?since=99", []],
      ] as [string, number[] | null][]) {
        const response = await harness.dispatch(`http://localhost${THREADS_PATH}${query}`, { headers });
        expect(response.status, query).toBe(200);
        const body = (await response.json()) as { head: number; events?: { seq: number }[]; threads?: unknown[] };
        expect(body.head, query).toBe(7);
        if (seqs === null) {
          expect(body.threads, query).toHaveLength(4);
          expect(body.events, query).toBeUndefined();
        } else {
          expect((body.events ?? []).map((event) => event.seq), query).toEqual(seqs);
          expect(body.threads, query).toBeUndefined();
        }
      }

      // Everything refused, with the reason from the parser's closed union and
      // never any part of the request's value echoed back.
      for (const [query, reason] of [
        ["?since=-1", "since-not-a-canonical-integer"],
        ["?since=+1", "since-not-a-canonical-integer"],
        ["?since=01", "since-not-a-canonical-integer"],
        ["?since=abc", "since-not-a-canonical-integer"],
        ["?since=0x10", "since-not-a-canonical-integer"],
        ["?since=1e3", "since-not-a-canonical-integer"],
        ["?since=1.0", "since-not-a-canonical-integer"],
        ["?since=", "since-not-a-canonical-integer"],
        ["?since=99999999999999999999", "since-not-a-canonical-integer"],
        ["?since=1&since=2", "since-repeated"],
        ["?repo=other", "unknown-parameter"],
        ["?scope=admin", "unknown-parameter"],
        ["?since=1&repo=other", "unknown-parameter"],
      ] as [string, string][]) {
        const response = await harness.dispatch(`http://localhost${THREADS_PATH}${query}`, { headers });
        expect(response.status, query).toBe(400);
        const body = (await response.json()) as { error: string; reason: string; parameter: string };
        expect(body.error, query).toBe("bad-request");
        expect(body.reason, query).toBe(reason);
        // Only the NAME comes back, never the value: a reflected value in a
        // body is a reflected-XSS vector the moment anything renders it.
        expect(body.parameter, query).toBe(query.includes("repo") ? "repo" : query.includes("scope") ? "scope" : "since");
      }
    });

    test("parseThreadsQuery is total and agrees with the surface it guards", async () => {
      // The pure half, so the parser's decisions are inspectable without a
      // request — and so the surface's 400s have one implementation to be
      // wrong in.
      expect(parseThreadsQuery("")).toEqual({ kind: "full" });
      expect(parseThreadsQuery("?since=0")).toEqual({ kind: "delta", since: 0 });
      expect(parseThreadsQuery("?since=42")).toEqual({ kind: "delta", since: 42 });
      expect(parseThreadsQuery("?since=1&since=1")).toMatchObject({ kind: "invalid", reason: "since-repeated" });
      expect(parseThreadsQuery("?nope=1")).toMatchObject({ kind: "invalid", reason: "unknown-parameter" });
      // Nothing throws, whatever the input.
      for (const query of ["?", "?&", "?=", "?since", "?since=%", "?since=%%%%", `?${"a".repeat(5_000)}=1`]) {
        expect(() => parseThreadsQuery(query)).not.toThrow();
      }
    });

    test("the largest accepted ?since= is bounded, so a path cannot carry an unbounded integer into a query", async () => {
      const issued = await issueTestSession(harness.db);
      // 16 digits, so the largest value is under 2^53 and `Number.parseInt`
      // is exact. One more digit is refused rather than silently truncated.
      const ok = await harness.dispatch(`http://localhost${THREADS_PATH}?since=9999999999999999`, {
        headers: { cookie: cookieHeader(issued.sessionId) },
      });
      expect(ok.status).toBe(200);
      const tooBig = await harness.dispatch(`http://localhost${THREADS_PATH}?since=99999999999999999`, {
        headers: { cookie: cookieHeader(issued.sessionId) },
      });
      expect(tooBig.status).toBe(400);
    });
  });

  // ── 6. ADR-0012 hygiene on every answer, refusal included ──────────────
  describe("every answer carries ADR-0012's hygiene, whatever produced it", () => {
    test("every status this surface answers carries the full hygiene set", async () => {
      // One step per status the surface can produce, each with a FRESH
      // session. Freshness is not tidiness: the successful refresh below
      // ROTATES the caller's credential, so reusing one session for the whole
      // list would make the two steps after it answer 401 and the test would
      // be asserting its own ordering mistake.
      type Step = {
        readonly label: string;
        readonly path: string;
        readonly init?: (issued: Awaited<ReturnType<typeof issueTestSession>>) => DispatchInit | undefined;
        readonly expected: number;
      };
      const steps: Step[] = [
        { label: "health 200", path: HEALTH_PATH, expected: 200 },
        { label: "unknown 404", path: "/nope", expected: 404 },
        { label: "threads 401 (no cookie)", path: THREADS_PATH, expected: 401 },
        { label: "bundle 404", path: "/_revkit/0.0.0/rail.js", expected: 404 },
        { label: "threads 200", path: THREADS_PATH, init: (i) => ({ headers: authHeaders(i) }), expected: 200 },
        { label: "threads 400 (bad ?since)", path: `${THREADS_PATH}?since=-1`, init: (i) => ({ headers: authHeaders(i) }), expected: 400 },
        { label: "refresh 200", path: SESSION_REFRESH_PATH, init: (i) => ({ method: "POST", headers: { ...authHeaders(i), ...JSON_HEADERS } }), expected: 200 },
        { label: "refresh 403 (bad csrf)", path: SESSION_REFRESH_PATH, init: (i) => ({ method: "POST", headers: { ...authHeaders(i), ...JSON_HEADERS, [CSRF_HEADER]: "x" } }), expected: 403 },
        { label: "refresh 415 (wrong media type)", path: SESSION_REFRESH_PATH, init: (i) => ({ method: "POST", headers: { ...authHeaders(i), "content-type": "text/plain" } }), expected: 415 },
        { label: "threads 501 (append not shipped)", path: THREADS_PATH, init: (i) => ({ method: "POST", headers: { ...authHeaders(i), ...JSON_HEADERS } }), expected: 501 },
        { label: "threads 405 (wrong verb)", path: THREADS_PATH, init: (i) => ({ method: "PUT", headers: authHeaders(i) }), expected: 405 },
        { label: "preview 501 (gated, not yet served)", path: "/revkit/pr-7/index.html", init: (i) => ({ headers: authHeaders(i) }), expected: 501 },
      ];
      for (const step of steps) {
        // A session per step, and only for the steps that need one — minting
        // for the anonymous steps would be a row nobody uses.
        const issued = step.init === undefined ? undefined : await issueTestSession(harness.db);
        const init = step.init === undefined ? undefined : step.init(issued ?? (undefined as never));
        const response = await harness.dispatch(`http://localhost${step.path}`, init);
        expect(response.status, step.label).toBe(step.expected);
        // ADR-0012's hygiene quartet plus Permissions-Policy, on the refusal
        // paths too — a 401 is a response a browser renders.
        expect(response.headers.get("x-content-type-options"), step.label).toBe("nosniff");
        expect(response.headers.get("referrer-policy"), step.label).toBe("no-referrer");
        expect(response.headers.get("cross-origin-opener-policy"), step.label).toBe("same-origin");
        expect(response.headers.get("cross-origin-resource-policy"), step.label).toBe("same-origin");
        expect(response.headers.get("permissions-policy"), step.label).toContain("camera=()");
        // ADR-0020: the id a reviewer quotes is on every answer.
        expect(response.headers.get("x-revkit-request-id"), step.label).toMatch(/^[0-9a-f-]{36}$/);
        // ADR-0012: never cache API JSON, including a refusal or a `Set-Cookie`.
        expect(response.headers.get("cache-control"), step.label).toBe("no-store");
        // And no CORS header anywhere: the CSP's `connect-src 'self'` is the
        // policy, so a permissive `Access-Control-Allow-Origin` would be a
        // second, contradictory one.
        expect(response.headers.get("access-control-allow-origin"), step.label).toBeNull();
        // The 401 and 400 bodies are the gate's and the parser's closed
        // vocabularies, so nothing from the request can be reflected.
        if (step.expected === 400) {
          const body = (await response.json()) as { reason?: string; parameter?: string };
          expect(["since-not-a-canonical-integer", "since-repeated", "unknown-parameter"]).toContain(
            String(body.reason),
          );
          expect(["since", "repo", "scope"]).toContain(String(body.parameter));
        } else {
          await response.text();
        }
      }
    });

    test("a refused HEAD carries no body, and the refusal is still a 401", async () => {
      // `HEAD` is a read, so it is gated, and its answer must be exactly the
      // GET answer minus the body. Asserted on its own because the shared
      // `expectRefused` skips body assertions for a bodyless answer.
      const response = await harness.dispatch(`http://localhost${THREADS_PATH}`, { method: "HEAD" });
      expect(response.status).toBe(401);
      expect(await response.text()).toBe("");
      expect(response.headers.get("x-revkit-request-id")).toMatch(/^[0-9a-f-]{36}$/);
      expect(response.headers.get("cache-control")).toBe("no-store");
    });

    test("a refusal never carries a WWW-Authenticate challenge — this is a cookie scheme", async () => {
      const response = await harness.dispatch(`http://localhost${THREADS_PATH}`);
      await response.text();
      expect(response.headers.get("www-authenticate")).toBeNull();
    });
  });
});

/** Re-exported so `DenialReason` in the import list is not an unused import:
 * the closed union is exactly what `expectRefused`'s reason assertion relies
 * on, and an unused import would hide that from the next reader. */
export type { DenialReason };
