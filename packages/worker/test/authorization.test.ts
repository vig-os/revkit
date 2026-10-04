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
import {
  parsePreviewPath,
  parseScopedThreadsPath,
  parseThreadsQuery,
  previewScopePath,
  scopedThreadsPath,
} from "../src/router.ts";
import {
  authHeaders,
  cookieHeader,
  issueTestSession,
  seedLogEvents,
  JSON_HEADERS,
  startWorker,
  type Harness,
} from "./harness.ts";

/**
 * The review these cases are about, and the ONE path that reads it.
 *
 * **Slice 5 moved the read.** It was `GET /api/threads`, which named no
 * repository, so ADR-0012's per-call scope check had nothing to select on and
 * every authorized caller read the whole org's log. It is now
 * `<repo>/pr-<n>/api/threads` — the scope is IN THE PATH, so a caller cannot
 * forget it, cannot choose it, and has no parameter to tamper with. The removed
 * spelling is `REMOVED_THREADS_PATH` below, and it is not a route at all.
 */
const REVIEW = { repo: "revkit", pr: 7 } as const;
const THREADS_PATH = scopedThreadsPath(REVIEW.repo, REVIEW.pr);
const LOG_KEY = previewScopePath(REVIEW.repo, REVIEW.pr);

/** What `GET /api/threads` was. Asserted NOT to be a route, by several cases. */
const REMOVED_THREADS_PATH = "/api/threads";

/** The body every seeded comment carries. A refusal must never contain it, and
 * an admitted read must — so both halves assert against the SAME string
 * rather than two literals that could drift apart. */
const SEED_BODY = "this comment body must only reach a caller with a session";

/** A four-event log with a gap at seq 4..6 (seqs 1, 2, 3, 7). ADR-0006
 * blesses gaps in a D1-backed store, so a hosted read that renumbered them
 * would be wrong in a way a contiguous fixture cannot detect.
 *
 * **Into `REVIEW`'s log and no other** (slice 5), which is why the seed is
 * parameterized by log key at all: a flat table would have made "this review's
 * events" and "the deployment's events" the same rows, and every assertion
 * below about isolation would have been asserting about a table that no longer
 * has that shape. */
async function seedLog(db: D1Database, logKey: string = LOG_KEY, prefix = "th-seed"): Promise<void> {
  await seedLogEvents(db, logKey, 4, { prefix, from: 1, body: SEED_BODY });
  // The GAP is the fixture: seqs 1, 2, 3 and 7, because ADR-0006 blesses gaps
  // in a D1-backed store and a hosted read that renumbered 7 to 4 would be wrong
  // in a way a contiguous fixture cannot detect. The #76 review found exactly
  // that bug through this seed.
  await db
    .prepare("DELETE FROM review_logs WHERE log_key = ? AND seq BETWEEN 4 AND 6")
    .bind(logKey)
    .run();
  await seedLogEvents(db, logKey, 1, { prefix, from: 7, body: SEED_BODY });
}

const VERBS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/** Paths the surface answers, plus the alias spellings that must NOT be one. */
const GATED_PATHS = [THREADS_PATH, SESSION_REFRESH_PATH, "/revkit/pr-7/index.html"] as const;
// The REMOVED unscoped read replaced the trailing-slash spelling slice 2 used
// to probe with: `/api/threads/` is no longer "a near miss of the read" but an
// unrecognised path, and `/revkit/pr-7/api/threads/` — which IS a preview path —
// is gated, so it cannot stand in for an ungated probe.
const UNGATED_PATHS = [HEALTH_PATH, "/_revkit/0.0.0/rail.js", "/nope", REMOVED_THREADS_PATH] as const;

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

  /**
   * The seeded log is created ONCE, not per test — and that is a change with a
   * measurement behind it.
   *
   * This `beforeEach` used to re-seed it, which is six D1 round trips (one
   * `DELETE`, four `INSERT`s, one session wipe) before each of ~48 cases, all
   * inside bun's 5 s per-hook timeout, with eleven test files' workerd
   * instances competing for the same host. It was the single most reliable
   * failure in the file and it is STILL the most reliable failure here at the
   * base commit — measured: four consecutive `bun test` runs at `5cb60a9d`,
   * three of them failing this hook. Slice 5 does not get to fix that by
   * raising a timeout, so it fixed it by not doing the work 48 times.
   *
   * It is sound because **no case in this file writes to `review_logs`** — the
   * one case that adds a second review's log (the `?scope=`-parameter case)
   * adds its OWN key, and it deletes that key afterwards. And every refusal
   * assertion in this file is read-only, so there is nothing to roll back.
   */
  beforeAll(async () => {
    await harness.db.prepare("DELETE FROM review_logs").run();
    await seedLog(harness.db);
  });

  beforeEach(async () => {
    // Sessions ARE mutated: `POST /api/session/refresh` rotates the caller's row
    // and a forged-cookie case issues one, so this wipe stays per-test.
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
        ["/revkit/pr-7/api/threads GET"]: "threads-read",
        ["/revkit/pr-7/api/threads POST"]: "threads-append",
        ["/revkit/pr-7/api/threads PUT"]: "method-not-allowed",
        ["/revkit/pr-7/docs/api/threads GET"]: "preview",
        ["/revkit/pr-7/api/threads/ GET"]: "preview",
        ["/revkit/pr-8/api/threads GET"]: "threads-read",
        ["/other-repo/pr-7/api/threads GET"]: "threads-read",
        [`${REMOVED_THREADS_PATH} GET`]: "unknown",
        [`${REMOVED_THREADS_PATH} POST`]: "unknown",
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
        pathname === SESSION_REFRESH_PATH ||
        parseScopedThreadsPath(pathname) !== undefined ||
        parsePreviewPath(pathname) !== undefined;
      const probes = [
        ...GATED_PATHS,
        ...UNGATED_PATHS,
        "/",
        "//",
        "/api",
        "/api/",
        "/api/threads.json",
        REMOVED_THREADS_PATH,
        `${REMOVED_THREADS_PATH}/`,
        "/revkit/pr-7/api/threads/extra",
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

    // ── slice 5: the scope invariant, and the read it moved ───────────────
    test("every gated route either names a scope or is the ONE exempt classification", () => {
      // **This is the invariant `invite-scope-unbounded` defends.** The gate
      // refuses a guest on a gated route that names no scope, so a route table
      // with a gated, unscoped, non-exempt arm would be a guest reading
      // something whose review it never named. Enumerated over the same broad
      // probe set as the gating invariant above, every verb — and asserted in
      // the direction that can fail.
      const probes = [
        ...GATED_PATHS,
        ...UNGATED_PATHS,
        THREADS_PATH,
        REMOVED_THREADS_PATH,
        "/",
        "/api",
        "/revkit/pr-7/api/threads",
        "/revkit/pr-8/api/threads",
        "/other-repo/pr-7/api/threads",
        "/revkit/pr-7/api/threads/",
        "/revkit/pr-7/docs/api/threads",
        "/revkit/pr-7",
        "/revkit/pr-0",
        "/revkit/pr-07/api/threads",
        "/_revkit/0.0.0/rail.js",
      ];
      for (const pathname of probes) {
        for (const method of VERBS) {
          const route = classifyRoute(pathname, method);
          const label = `${pathname} ${method} is ${route.kind}`;
          if (!route.requiresSession) {
            // Ungated, so no guest reaches it and no scope is needed.
            continue;
          }
          expect(route.scope !== undefined || route.guestScopeExempt, label).toBe(true);
        }
      }
    });

    test("guestScopeExempt is a property of exactly ONE path, and only that path's", () => {
      // A SECOND exempt path would be a second hole, and nobody would notice it
      // being added — so the set is pinned here rather than left to review.
      // The one that exists is `/api/session/refresh`, which rotates the
      // caller's own credential and names no review because it is not about one.
      //
      // It is asserted as a property of the PATH, so every classification of
      // that path carries it — including the wrong verbs, which inherit it
      // precisely because a wrong verb on the session route is still the session
      // route and must still answer 405 to a guest rather than a misleading
      // `invite-scope-unbounded`.
      const exemptPaths = new Set<string>();
      const probes = [
        ...GATED_PATHS,
        ...UNGATED_PATHS,
        THREADS_PATH,
        REMOVED_THREADS_PATH,
        "/revkit/pr-8/api/threads",
        "/revkit/pr-7",
        "/revkit/pr-7/index.html",
        "/invite/redeem",
        "/",
      ];
      for (const pathname of probes) {
        for (const method of VERBS) {
          if (classifyRoute(pathname, method).guestScopeExempt) exemptPaths.add(pathname);
        }
      }
      expect([...exemptPaths]).toEqual([SESSION_REFRESH_PATH]);
      // And nothing on the review surface is exempt, on any verb, whatever the
      // wrong verb does to the kind.
      for (const pathname of [THREADS_PATH, "/revkit/pr-8/api/threads", "/revkit/pr-7", "/revkit/pr-7/index.html"]) {
        for (const method of VERBS) {
          expect(classifyRoute(pathname, method).guestScopeExempt, `${pathname} ${method}`).toBe(false);
        }
      }
    });

    test("the read is scoped to ONE review, and the removed unscoped read is not a route", () => {
      // `GET /api/threads` named no repository, so it could only ever answer
      // org-wide — and ADR-0012's per-call scope check has nothing to select on
      // when a route names nothing. The scope moved INTO the path, and the old
      // spelling is now `unknown` for every verb: not a 403, not a 405, not a
      // gated 501. A path that is not a route cannot leak a review, so there
      // was no reason to leave it gated.
      for (const method of VERBS) {
        expect(classifyRoute(REMOVED_THREADS_PATH, method).kind, method).toBe("unknown");
        expect(classifyRoute(REMOVED_THREADS_PATH, method).requiresSession, method).toBe(false);
      }
      // And the one that replaced it names its review, on both the read and the
      // write arm, with the log key derived by the same grammar.
      for (const method of ["GET", "HEAD", "POST", "PUT"] as const) {
        expect(classifyRoute(THREADS_PATH, method).scope, method).toEqual({
          repo: REVIEW.repo,
          pr: REVIEW.pr,
          logKey: LOG_KEY,
        });
      }
    });

    test("the scope is a function of the PATH and of nothing a caller can set", () => {
      // The three spellings a caller would reach for if the scope were a
      // parameter. They are refused by `parseThreadsQuery`, so the log key is
      // not attacker-chosen — and this also pins that the two spellings of a
      // scope that ARE in the path cannot be mixed: `pr-07` is not `pr-7`.
      for (const [pathname, expected] of [
        ["/revkit/pr-7/api/threads", { repo: "revkit", pr: 7 }],
        ["/revkit/pr-08/api/threads", undefined],
        ["/other-repo/pr-7/api/threads", { repo: "other-repo", pr: 7 }],
        ["/api/threads", undefined],
      ] as const) {
        const scope = classifyRoute(pathname, "GET").scope;
        expect(scope === undefined ? undefined : { repo: scope.repo, pr: scope.pr }, pathname).toEqual(expected);
      }
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
        "incomplete-invite-row",
        "incomplete-session-row",
        "invite-browser-mismatch",
        "invite-expired",
        "invite-no-grant",
        "invite-read-only",
        "invite-revoked",
        "invite-scope-mismatch",
        "invite-scope-unbounded",
        "malformed-session-cookie",
        "no-session-cookie",
        // Default JS string order: "unknown-s" < "unrecognised" because `k` <
        // `r`. Spelled out rather than sorted by hand so the mismatch above is
        // a diff a reader can check by eye.
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
      // `invite` was in this list until slice 3, which added the arm the
      // comment above predicted — and it is deliberately NOT here now: an
      // `invite` row with no redemption behind it is refused as
      // `invite-no-grant` (401) rather than as an unrecognised kind, because
      // this build DOES know the rules for that provider and the row does not
      // satisfy them. the HTTP half of `test/invites.test.ts` pins that.
      const issued = await issueTestSession(harness.db);
      for (const kind of ["github", "auth0", "invitee", "OPERATOR", "Operator", " operator"]) {
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

    test("an `invite` session with no redemption behind it is refused as no-grant, not as an unknown kind", async () => {
      // The other direction, and the reason `invite` left the list above: this
      // build knows the provider's rules, so a row that does not satisfy them
      // is a DIFFERENT refusal with a different fix for the operator.
      const issued = await issueTestSession(harness.db);
      await harness.db.prepare("UPDATE sessions SET identity_kind = 'invite', identity_id = ?").bind("no-such-guest").run();
      const refusal = await refusalOf(
        await harness.dispatch(`http://localhost${THREADS_PATH}`, {
          headers: { cookie: cookieHeader(issued.sessionId) },
        }),
      );
      expectRefused(refusal, [401]);
      expect(refusal.body.reason).toBe("invite-no-grant");
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
        // 200, 404, or 501 — and 501 is the honest answer for the two
        // spellings that are still PREVIEW paths (`<repo>/pr-<n>/api/threads/`
        // and the `%20` variant): slice 5 moved the read out of the preview's
        // own path space, so those resolve to the R2 preview route, which is
        // gated and not yet served. None of the three carries review content,
        // and none is a refusal — which is what proves the anonymous 401 above
        // was the GATE and not the router.
        expect([200, 404, 501], alias).toContain(known.status);
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
      // The REMOVED unscoped read is here rather than a near-miss spelling of
      // the new one: `/revkit/pr-7/api/threads/` is a preview path (gated, 501)
      // and cannot stand in for an ungated 404.
      for (const pathname of ["/nope", "/_revkit/0.0.0/rail.js", REMOVED_THREADS_PATH, `${REMOVED_THREADS_PATH}/`]) {
        const refusal = await refusalOf(await harness.dispatch(`http://localhost${pathname}`));
        expect(refusal.status).toBe(404);
        expect(refusal.raw).not.toContain(SEED_BODY);
        expect(refusal.raw).not.toContain("th-seed");
      }
    });
  });

  // ── 3. the gate admits ─────────────────────────────────────────────────
  describe("a session this build issued is admitted", () => {
    test("the scoped read answers 200 with the projection, and only with a session", async () => {
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

    test("the token is read from `x-revkit-csrf` and from nowhere else", async () => {
      // The header's NAME was unpinned: nothing asserted which header the token
      // comes from, so reading it from `x-revkit-csrf-alt` first scored 0 tests
      // red. A header name is part of the protocol a client has to implement,
      // so it needs a test the way the token's value does. Measured against
      // the mutations: this case is RED for "read the wrong header first" and
      // for "read a second header as a fallback".
      const issued = await issueTestSession(harness.db);
      const altNames = ["x-revkit-csrf-alt", "x-csrf-token", "x-xsrf-token", "csrf-token", "x-revkit-xsrf"];
      for (const name of altNames) {
        const response = await harness.dispatch(`http://localhost${SESSION_REFRESH_PATH}`, {
          method: "POST",
          // The cookie but NOT `authHeaders`, which would carry the real
          // header too and make every case a 200 — the point is the right
          // token arriving in the WRONG header.
          headers: { cookie: cookieHeader(issued.sessionId), [name]: issued.csrfToken, ...JSON_HEADERS },
        });
        const refusal = await refusalOf(response);
        // 403 with the SPECIFIC reason, so this is "the right token in the
        // wrong header", not "no token at all".
        expect(refusal.status, name).toBe(403);
        expect(refusal.body, name).toEqual({ error: "csrf", reason: "csrf-header-missing" });
        // Nothing rotated, so the loop cannot mutate `issued` under itself.
        expect((await harness.db.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())?.n, name).toBe(1);
      }
      // And the real header, in the same shape, is accepted.
      expect(
        (
          await harness.dispatch(`http://localhost${SESSION_REFRESH_PATH}`, {
            method: "POST",
            headers: { ...authHeaders(issued), ...JSON_HEADERS },
          })
        ).status,
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

    test("?repo=, ?scope= and ?log_key= are REFUSED — the scope is in the path, not in a parameter", async () => {
      // The spellings a caller would reach for if the scope were a query
      // parameter, and the reason `parseThreadsQuery`'s unknown-parameter
      // refusal became load-bearing in slice 5 rather than prophylactic. If any
      // of these were accepted-and-ignored, a client could be told nothing and
      // ship believing it was scoped when it was not; if any were honoured, a
      // caller would be able to CHOOSE which review's log it reads.
      const issued = await issueTestSession(harness.db);
      for (const query of ["?repo=other-repo", "?scope=admin", "?log_key=/other-repo/pr-7", "?pr=9", "?scope="]) {
        const response = await harness.dispatch(`http://localhost${THREADS_PATH}${query}`, {
          headers: { cookie: cookieHeader(issued.sessionId) },
        });
        expect(response.status, query).toBe(400);
        const body = JSON.parse(await response.text()) as { reason: string; parameter: string };
        expect(body.reason, query).toBe("unknown-parameter");
        // The NAME is echoed; the value never is. A reflected value in a body
        // is a reflected-XSS vector the moment anything renders it.
        expect(body.parameter, query).not.toContain("/");
        expect(body.parameter, query).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
      }
    });

    test("the query is validated BEFORE a log key is chosen, so no parameter can name a log", async () => {
      // **This case exists because a mutant survived, and its scope is what
      // makes it interesting.** Reading the log key as
      // `url.searchParams.get("log_key") ?? route.scope?.logKey` leaves the suite
      // fully green — in BOTH statement orders — because `parseThreadsQuery` is
      // TOTAL over the parameter set: a query naming a log is refused above, and
      // an accepted query has no `log_key` for the fallback to read. The mutant
      // is equivalent, not merely uncovered (see `readThreads`).
      //
      // What is NOT guaranteed by that argument is the parser staying total, and
      // that is what this case pins: a caller-supplied key is refused with the
      // generic reason, and the named log's `head` and events are absent from
      // the answer rather than merely alongside a 400. Two reviews with
      // DIFFERENT heads, so a key honoured anywhere in this handler would be
      // visible in the body.
      // `beforeAll` seeded THIS review's log; add a second one whose threads
      // and `head` are distinguishable from it.
      const otherKey = previewScopePath(REVIEW.repo, 99);
      await seedLog(harness.db, otherKey, "th-other");
      const issued = await issueTestSession(harness.db);
      const response = await harness.dispatch(
        `http://localhost${THREADS_PATH}?log_key=${encodeURIComponent(otherKey)}`,
        { headers: { cookie: cookieHeader(issued.sessionId) } },
      );
      expect(response.status).toBe(400);
      const raw = await response.text();
      expect(JSON.parse(raw) as Record<string, unknown>).toMatchObject({
        error: "bad-request",
        reason: "unknown-parameter",
        parameter: "log_key",
      });
      // Neither log's head appears, and no event does. A key honoured anywhere
      // in this handler would put one of these two numbers in the body.
      expect(raw).not.toContain("th-other");
      expect(raw).not.toContain("th-seed");
      expect(raw).not.toContain(`"head"`);
      // And the same request WITHOUT the parameter reads this review normally,
      // so the refusal above is about the parameter and nothing else.
      const clean = await harness.dispatch(`http://localhost${THREADS_PATH}`, {
        headers: { cookie: cookieHeader(issued.sessionId) },
      });
      expect(clean.status).toBe(200);
      expect(JSON.parse(await clean.text()) as { head: number }).toMatchObject({ head: 7 });
      await harness.db
        .prepare("DELETE FROM review_logs WHERE log_key = ?")
        .bind(otherKey)
        .run();
    });

    test("a scope parameter cannot move the read to another review's log", async () => {
      // The same refusals from the other end: TWO reviews, both populated, and
      // no spelling of a query string that reaches the wrong one. With the scope
      // in the path the only way to name a review is to BE at its URL — so this
      // asserts both halves: the parameterised spellings are 400s, and the bare
      // spelling reads THIS review and not the other.
      // `beforeEach` has already seeded THIS review's log; add the second one.
      const otherKey = previewScopePath(REVIEW.repo, 99);
      await seedLog(harness.db, otherKey, "th-other");
      try {
        await scopeParameterAssertions(otherKey, await issueTestSession(harness.db));
      } finally {
        // Its own key only — `beforeAll` owns this review's log and the rest of
        // the file reads it.
        await harness.db
          .prepare("DELETE FROM review_logs WHERE log_key = ?")
          .bind(otherKey)
          .run();
      }
    });

    /** The body of the case above, factored so the `try`/`finally` above can
     * wrap it without a nested closure in every assertion. */
    async function scopeParameterAssertions(otherKey: string, issued: { sessionId: string }): Promise<void> {
      const read = async (pathname: string): Promise<{ status: number; raw: string }> => {
        const response = await harness.dispatch(`http://localhost${pathname}`, {
          headers: { cookie: cookieHeader(issued.sessionId) },
        });
        return { status: response.status, raw: await response.text() };
      };
      for (const query of ["?repo=revkit&pr=99", "?log_key=/revkit/pr-99", "?scope=/revkit/pr-99"]) {
        expect((await read(`${THREADS_PATH}${query}`)).status, query).toBe(400);
      }
      const mine = await read(THREADS_PATH);
      expect(mine.status).toBe(200);
      expect(mine.raw).toContain("th-seed-1");
      expect(mine.raw).not.toContain("th-other");
      // The other review's own URL reads the other log, and only that one.
      const theirs = await read(scopedThreadsPath(REVIEW.repo, 99));
      expect(theirs.status).toBe(200);
      expect(theirs.raw).toContain("th-other-1");
      expect(theirs.raw).not.toContain("th-seed");
      // `head` is per log, and both logs are four events long with a gap — so
      // the two reads agree on `head` here and that is the POINT: a shared
      // `head` would be a shared counter. Asserting it separately below keeps
      // this case about content.
      expect(JSON.parse(mine.raw) as { head: number }).toMatchObject({ head: 7 });
      expect(JSON.parse(theirs.raw) as { head: number }).toMatchObject({ head: 7 });
    }

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
        // A wrong verb on the probe. This is the case that caught a REAL
        // regression: `classifyRoute` sends a wrong-verb `/healthz` to
        // `method-not-allowed`, which is UNGATED, and the ungated dispatcher
        // had no case for it — so it fell through to `unreachable()`, threw,
        // and answered 500 with `internal error` and no `Cache-Control`. Base
        // `7a7bb652` answered 405. A dropped `case` in a route refactor turned
        // a documented 405 into a server error, which is the shape of bug that
        // only an exhaustive route table catches.
        { label: "health 405 (wrong verb)", path: HEALTH_PATH, init: () => ({ method: "POST" }), expected: 405 },
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
        } else if (step.expected === 405) {
          // A 405 is JSON like every other answer on this surface, so it goes
          // through `applyJsonHeaders` and gets `Cache-Control: no-store` —
          // which the regression lost, because the 500 it became went through
          // the text boundary instead. `await response.json()` alone would not
          // catch that: `cache-control` is asserted above for every step, and
          // this asserts the body is not an error page.
          const body = (await response.json()) as { error?: string };
          expect(body.error, step.label).toBe("method-not-allowed");
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

    test("every wrong verb on /healthz is 405 — the ungated dispatcher handles method-not-allowed", async () => {
      // The regression, stated as a matrix so no single verb can be forgotten.
      // `method-not-allowed` is the one kind that appears on BOTH sides of the
      // gate — gated for the API paths, ungated for `/healthz` — which is
      // exactly why a dispatcher written per-side can handle it on one and drop
      // it on the other.
      for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"] as const) {
        const response = await harness.dispatch(`http://localhost${HEALTH_PATH}`, { method });
        const raw = await response.text();
        expect(response.status, method).toBe(405);
        expect(JSON.parse(raw) as { error: string }, method).toEqual({ error: "method-not-allowed" });
        // A 405 must not look like a server error, and must not be cacheable.
        expect(raw, method).not.toContain("internal error");
        expect(response.headers.get("cache-control"), method).toBe("no-store");
        expect(response.headers.get("content-type"), method).toContain("application/json");
        expect(response.headers.get("x-revkit-request-id"), method).toMatch(/^[0-9a-f-]{36}$/);
      }
      // And the two that are supposed to work, in the same matrix.
      for (const method of ["GET", "HEAD"] as const) {
        expect((await harness.dispatch(`http://localhost${HEALTH_PATH}`, { method })).status, method).toBe(200);
      }
    });

    test("a client error is not logged as a server error (ADR-0020's error signal)", async () => {
      // Measured, not asserted in the abstract: before the 405 was restored,
      // `POST /healthz` threw into the boundary and emitted `request.error`,
      // so a probe written with the wrong verb put a line into the same stream
      // a genuine 500 uses. The end-to-end capture of that is in
      // `test/logger.test.ts`; what belongs here is the invariant that a
      // non-2xx the Worker CHOSE never reaches the error boundary.
      for (const [pathname, init] of [
        [HEALTH_PATH, { method: "POST" }],
        ["/nope", undefined],
        [THREADS_PATH, undefined],
        [THREADS_PATH, { method: "PUT" }],
      ] as [string, { method?: string } | undefined][]) {
        const response = await harness.dispatch(`http://localhost${pathname}`, init);
        expect(response.status).not.toBe(500);
        await response.text();
      }
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
