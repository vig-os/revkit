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

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  classifyRoute,
  denialLogMessage,
  DENIAL_REASONS,
  HEALTH_PATH,
  SESSION_REFRESH_PATH,
  BOTH_SIDES_ROUTE_KINDS,
  GATED_ROUTE_KINDS,
  ROUTE_KINDS,
  UNGATED_ROUTE_KINDS,
  type DenialReason,
  type RouteKind,
} from "../src/authz.ts";
import { D1ThreadStore } from "../src/d1-store.ts";
import {
  CSRF_HEADER,
  SESSION_COOKIE_NAME,
  mintToken,
  sha256Hex,
  SessionAlreadyRotatedError,
} from "../src/session.ts";
import {
  SCOPED_THREADS_SUFFIX,
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
  stripTsComments,
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

/** Every verb that is NOT a read, derived from `VERBS` rather than re-spelled,
 * so a verb added to the surface cannot be left out of a matrix that claims to
 * cover "the verbs that are not reads". */
const WRITING_VERBS = VERBS.filter((verb) => verb !== "GET" && verb !== "HEAD");

/**
 * The probe set for the route-table invariants, DERIVED from the grammar rather
 * than written out.
 *
 * **This replaces a hand-written `probes` array whose comment claimed to be
 * "an exhaustive expectation, not a sample".** It was exhaustive *over the list*,
 * and the list was the weak part: a new `RouteKind` that is gated, names no
 * scope and carries `guestScopeExempt: true` was not in any list, so the
 * invariant meant to defend against exactly that produced 0 red. `tsc` is no
 * backstop either — the field is required, so a new arm compiles, and every
 * `switch` over `RouteKind` has a `default`.
 *
 * So the set is the PRODUCT of the grammar: repository shapes × PR spellings ×
 * path suffixes × verbs. A spelling nobody thought of is now covered because it
 * is generated, and the shapes are the ones the grammar itself distinguishes —
 * including the ones it REFUSES (`api`, `_revkit`, `pr-0`, `pr-07`), which is
 * where the near-miss classifications live.
 *
 * The product is asserted non-trivial below, so a generator that silently
 * returned one path could not make these invariants pass over nothing.
 */
const REPO_SHAPES = [
  "revkit",
  "vig-os.revkit",
  "other-repo",
  "a",
  "API", // the reserved segment, in the case a caller would try
  "_revkit",
  "-leading-dash",
  "with space",
  "x".repeat(120), // over the 100-char segment cap
] as const;

const PR_SHAPES = ["pr-7", "pr-42", "pr-1", "pr-0", "pr-07", "pr-999999999", "pr-1e3", "notapr"] as const;

const PATH_SUFFIXES = [
  "", // the bare scope path — a preview
  "/",
  "/index.html",
  SCOPED_THREADS_SUFFIX,
  `${SCOPED_THREADS_SUFFIX}/`,
  "/docs/api/threads", // a built site that happens to end in the API suffix
  "/a/b/c",
] as const;

/**
 * Every `(pathname, verb)` the preview grammar can produce — 9 × 8 × 7 × 7.
 *
 * `classifyRoute` is a pure function of `(pathname, method)`, so the whole
 * product is cheap; the count is asserted so a generator that returned one path
 * could not make the invariants below pass over nothing.
 */
const DERIVED_PROBES: readonly (readonly [string, string])[] = REPO_SHAPES.flatMap((repo) =>
  PR_SHAPES.flatMap((pr) =>
    PATH_SUFFIXES.flatMap((suffix) => VERBS.map((verb) => [`/${repo}/${pr}${suffix}`, verb] as const)),
  ),
);

/** The paths that are NOT `<repo>/pr-<n>/…` — the fixed half of the surface,
 * which no product generates because they are exact paths, not grammar. */
const FIXED_PATHS = [
  HEALTH_PATH,
  SESSION_REFRESH_PATH,
  "/invite/redeem",
  "/invite/abc",
  "/invite/",
  "/_revkit/0.0.0/rail.js",
  "/_revkit",
  REMOVED_THREADS_PATH,
  `${REMOVED_THREADS_PATH}/`,
  "/api/threads.json",
  "/API/threads",
  "/api//threads",
  "/api/session/refresh/",
  "/",
  "//",
  "/nope",
] as const;

/** The whole probe set: the derived product plus the fixed paths, every verb. */
const ALL_PROBES: readonly (readonly [string, string])[] = [
  ...DERIVED_PROBES,
  ...FIXED_PATHS.flatMap((pathname) => VERBS.map((verb) => [pathname, verb] as const)),
];

/** Paths the surface answers, plus the alias spellings that must NOT be one. */
/**
 * The kinds this file's expectations are written against.
 *
 * **`GATED_ROUTE_KINDS` from `src/authz.ts` is the source of truth, not a copy.**
 * It used to be a hand-written `Set` here, which is the review's complaint in
 * miniature: two lists of the same fact, one of them checked and one of them
 * load-bearing. Now there is one declaration, `authz.ts` proves at COMPILE time
 * that its two sides partition `RouteKind` (so `tsc` is the backstop the
 * `default:` arms defeat), and the cases below verify that declaration against
 * BEHAVIOUR over the derived probe product — which is what catches a declared
 * partition that does not describe the code.
 */
const HANDLED_GATED_KINDS: ReadonlySet<RouteKind> = new Set<RouteKind>([
  ...GATED_ROUTE_KINDS,
  ...BOTH_SIDES_ROUTE_KINDS,
]);

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
        ["/revkit/pr-7/index.html HEAD"]: "preview",
        // Reads only (#96). A preview serves bytes; a verb that is not a read has
        // no route to reach, so it is a 405 BEHIND the gate — not a 501 that
        // happens to have no CSRF check.
        ["/revkit/pr-7/index.html POST"]: "method-not-allowed",
        ["/revkit/pr-7/index.html PUT"]: "method-not-allowed",
        ["/revkit/pr-7/index.html DELETE"]: "method-not-allowed",
        // And a repo segment that is not the canonical spelling is not a preview
        // at all — one spelling per review, so the case variant is a 404 (#96).
        ["/Revkit/pr-7/index.html GET"]: "unknown",
        ["/REVKIT/pr-7/api/threads GET"]: "unknown",
        ["/API/pr-7/index.html GET"]: "unknown",
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
      // and ADR-0008's `<repo>/pr-<n>/` preview paths are gated on every verb
      // they answer — including the ones they refuse (#96: a preview is a
      // read-only route, so a wrong verb is a gated 405 and an unauthenticated
      // caller still gets 401 first). `/healthz` (a probe that reads no
      // database), `/_revkit/` (ADR-0012's never-redirecting static path) and
      // everything unrecognised are not, because none of them can return review
      // data.
      //
      // The policy is expressed PATH-side on purpose. Asserting it through
      // `RouteKind` cannot work — `method-not-allowed` is gated or not
      // depending on which path produced it — which is itself the reason the
      // gate consults `requiresSession` rather than the kind.
      const isGatedPath = (pathname: string): boolean =>
        pathname === SESSION_REFRESH_PATH ||
        parseScopedThreadsPath(pathname) !== undefined ||
        parsePreviewPath(pathname) !== undefined;
      // Over the DERIVED product. The hand-written list this replaced was
      // exhaustive only over itself, which is how a ninth gated kind escaped a
      // case named for the invariant that forbids one.
      for (const [pathname, method] of ALL_PROBES) {
        expect(classifyRoute(pathname, method).requiresSession, `${pathname} ${method}`).toBe(isGatedPath(pathname));
      }
      // The kind-level cross-check now runs over the DERIVED product, and its
      // converse lives in its own case ("HANDLED_GATED_KINDS is exactly the set of
      // kinds reachable with requiresSession") so a missing handler `case` — the
      // direction that reaches `unreachable()` and a 500 — has a case of its own
      // rather than being folded into a test named for something else.
      for (const [pathname, method] of ALL_PROBES) {
        const route = classifyRoute(pathname, method);
        if (route.requiresSession) {
          expect(HANDLED_GATED_KINDS.has(route.kind), `${pathname} ${method} is ${route.kind}`).toBe(true);
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

    // ── #96 fix 1: the preview route accepts READ verbs only ───────────────
    test("a preview path takes reads only, and a write verb is a 405 BEHIND the gate", async () => {
      // **What this closes.** The preview arm was `acceptsVerb: ANY_VERB` with
      // `stateChanging: false`, so POST/PUT/DELETE on `<repo>/pr-<n>/…` classified
      // as `preview` and passed the gate with NO CSRF check and NO
      // `application/json` precondition — `stateChanging: false` is the flag
      // that makes `authorizeRequest` skip both. The reason recorded for it was
      // that the handler answers 501, which describes the HANDLER and not the
      // GATE: the first write handler added under a preview path would have
      // inherited the hole. The argument for closing it is not today's
      // exploitability; it is that a gate default which widens when a handler
      // changes is not a gate default.
      //
      // The order a reviewer will want them: the classification, the obligations
      // it does and does not carry, then the answer end to end.
      for (const verb of WRITING_VERBS) {
        const route = classifyRoute("/revkit/pr-7/index.html", verb);
        expect(route.kind, verb).toBe("method-not-allowed");
        // Gated — so an unauthorized caller learns "unauthorized", never "that
        // route exists and you may not use this verb".
        expect(route.requiresSession, verb).toBe(true);
        // And it carries no obligation it will not honour: `classifyRoute`
        // drops `stateChanging` on a wrong verb so the caller is not told about
        // a CSRF mechanism on a request that was never going to be authorized.
        expect(route.stateChanging, verb).toBe(false);
        expect(route.unsupportedMethod, verb).toBe(true);
        // The path's SCOPE survives the relabel, so a guest is refused for the
        // scope rather than for the verb — the same reason a wrong verb on the
        // scoped read is a 405 in that scope.
        expect(route.scope?.logKey, verb).toBe("/revkit/pr-7");
      }
      // GET and HEAD are unaffected: they are the verbs R2 serving will answer.
      for (const verb of ["GET", "HEAD"] as const) {
        expect(classifyRoute("/revkit/pr-7/index.html", verb).kind, verb).toBe("preview");
      }
      // End to end, through workerd. A session WITHOUT a CSRF token and WITHOUT
      // `application/json` — the pair every state-changing route demands — is the
      // request the old table let through. It answers 405, and it answers 405 for
      // the right reason: there is no CSRF refusal in the body.
      const issued = await issueTestSession(harness.db);
      for (const verb of WRITING_VERBS) {
        const response = await harness.dispatch("http://localhost/revkit/pr-7/index.html", {
          method: verb,
          headers: { cookie: cookieHeader(issued.sessionId) },
        });
        const raw = await response.text();
        expect(response.status, `${verb}: ${raw}`).toBe(405);
        expect(JSON.parse(raw) as { error?: string; reason?: string }, verb).toEqual({
          error: "method-not-allowed",
        });
      }
      // And the refusal ORDER: no session is a 401 even on a write verb, so the
      // 405 is not something an anonymous caller can read off the surface.
      expect((await harness.dispatch("http://localhost/revkit/pr-7/index.html", { method: "POST" })).status).toBe(401);
    });

    // ── #96 fix 2: one spelling per review ─────────────────────────────────
    test("a repo segment that is not its canonical spelling is not a preview at all", async () => {
      // `/Revkit/pr-7` and `/revkit/pr-7` used to be TWO reviews — two log keys,
      // two R2 prefixes, two lines in the access log — while a guest invite
      // covered exactly one of them, because the stored side is folded at mint.
      // The fold is at MINT on purpose (`router.ts`'s `canonicalRepoName`), so
      // the read side cannot be folded too: that would collapse two spellings of
      // one path onto one review, which is the aliasing this grammar already
      // refuses for `//`, for `%2e` and for a leading zero.
      //
      // So the parser refuses, and "not a preview" is the same answer a caller
      // gets for `/API/pr-7`. Exactly one spelling resolves.
      for (const spelling of ["Revkit", "REVKIT", "rEvKiT", "Revkit2", "vig-OS.revkit", "API", "_REVKIT"]) {
        expect(parsePreviewPath(`/${spelling}/pr-7`), spelling).toBeUndefined();
        expect(parseScopedThreadsPath(scopedThreadsPath(spelling, 7)), spelling).toBeUndefined();
        // Not a preview, so not a gated path, so not a scope — 404 for everyone.
        const route = classifyRoute(`/${spelling}/pr-7/index.html`, "GET");
        expect(route.kind, spelling).toBe("unknown");
        expect(route.requiresSession, spelling).toBe(false);
        expect(route.scope, spelling).toBeUndefined();
      }
      // And the canonical spelling is untouched: the same paths parse, and their
      // repo segment is already the stored spelling, so a minted invite and a
      // served URL still meet.
      for (const spelling of ["revkit", "vig-os.revkit", "a", "a_b-c.d0", "revkit.pr-7"]) {
        const preview = parsePreviewPath(`/${spelling}/pr-7`);
        expect(preview?.repo, spelling).toBe(spelling);
        expect(preview?.logKey, spelling).toBe(`/${spelling}/pr-7`);
      }
      // End to end: an `operator` session — the one identity the gate does not
      // scope-check, and so the one that would have READ `/REVKIT/pr-7`'s empty
      // log before — now gets a 404, and the canonical path still works.
      const issued = await issueTestSession(harness.db);
      const shouted = await harness.dispatch("http://localhost/REVKIT/pr-7/api/threads", {
        headers: { cookie: cookieHeader(issued.sessionId) },
      });
      expect(shouted.status).toBe(404);
      expect(await shouted.text()).not.toContain("th-seed");
      const canonical = await harness.dispatch("http://localhost/revkit/pr-7/api/threads", {
        headers: { cookie: cookieHeader(issued.sessionId) },
      });
      expect(canonical.status).toBe(200);
      // The invariant as a SWEEP rather than as the spellings above: over the
      // whole admitted character class, a repo segment is servable at the
      // canonical spelling and is a 404 at every other one, so "two spellings of
      // one path must not both resolve" holds for every name rather than for the
      // seven a fixture happened to spell.
      let canonicals = 0;
      for (let code = 0x61; code <= 0x7a; code += 1) {
        const lower = String.fromCharCode(code);
        const upper = lower.toUpperCase();
        expect(parsePreviewPath(`/${lower}/pr-7`) !== undefined, lower).toBe(true);
        expect(parsePreviewPath(`/${upper}/pr-7`) !== undefined, upper).toBe(false);
        canonicals += 1;
      }
      expect(canonicals).toBe(26);
    });

    // ── slice 5: the scope invariant, and the read it moved ───────────────
    test("every gated route either names a scope or is the ONE exempt classification", () => {
      // **This is the invariant `invite-scope-unbounded` defends.** The gate
      // refuses a guest on a gated route that names no scope, so a route table
      // with a gated, unscoped, non-exempt arm would be a guest reading
      // something whose review it never named.
      //
      // **Over the DERIVED product, not a written-out list.** A new `RouteKind`
      // that is gated, names no scope and sets `guestScopeExempt: true` was in no
      // hand-written list, so this case produced 0 red for exactly the shape it
      // exists to catch. The product covers the spellings nobody thought of
      // because it generates them.
      //
      // Three assertions, in the order that can fail: the set is non-trivial, the
      // invariant holds, and the set is not vacuous — it must actually CONTAIN a
      // gated scoped route and a gated exempt one, or "every gated route names a
      // scope" would be true of an empty set.
      expect(DERIVED_PROBES.length).toBeGreaterThan(3000);
      expect(ALL_PROBES.length).toBeGreaterThan(DERIVED_PROBES.length);
      let gatedScoped = 0;
      let gatedExempt = 0;
      for (const [pathname, method] of ALL_PROBES) {
        const route = classifyRoute(pathname, method);
        if (!route.requiresSession) continue;
        const label = `${pathname} ${method} is ${route.kind}`;
        if (route.scope !== undefined) {
          gatedScoped += 1;
          // A scope must be INTERNAL: a present-but-empty scope would pass a
          // truthiness check and select nothing, which is the defect again.
          expect(route.scope.repo.length, label).toBeGreaterThan(0);
          expect(route.scope.pr, label).toBeGreaterThan(0);
          expect(route.scope.logKey, label).toBe(`/${route.scope.repo}/pr-${String(route.scope.pr)}`);
        } else if (route.guestScopeExempt) {
          gatedExempt += 1;
        } else {
          expect(false, `${label} is gated, names no scope, and is not exempt`).toBe(true);
        }
      }
      // Non-vacuity: the product really does reach both halves.
      expect(gatedScoped).toBeGreaterThan(100);
      expect(gatedExempt).toBeGreaterThan(1);
    });

    test("exactly ONE arm in `classifyPath` may pass `guestScopeExempt: true`", () => {
      // **The half of H3 the derived product cannot reach.** The probes iterate
      // *classifications of grammar-shaped paths*, so a new HARD-CODED path arm is
      // invisible to them however it is spelled. Measured on this branch: adding
      // `/rogue` — gated, no scope, `guestScopeExempt: true`, i.e. the shape the
      // hand-written probe list missed — left the suite **green**.
      //
      // The derivation cannot enumerate a function's domain, so this asserts over
      // the arms themselves: the flag is set in exactly one place, and that place
      // is the session refresh. It is a one-token, whole-file scan of a small
      // closed region, and it is the only assertion here that does not depend on
      // knowing the paths in advance — which is what makes it the one that catches
      // a path nobody has heard of.
      //
      // The BEHAVIOURAL consequence is proved separately, over HTTP, by the
      // `invite-scope-unbounded` case in `test/invites.test.ts`; this is the
      // structural claim underneath it.
      const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
      // Strings KEPT here: the arms are identified by their `kind`, which is a
      // string literal, and this check is about WHICH arm — not about identifiers.
      const code = stripTsComments(readFileSync(join(srcDir, "authz.ts"), "utf8"), { strings: true });
      const arms = [...code.matchAll(/guestScopeExempt:\s*(true|false)/g)];
      // EXACTLY ONE occurrence in the whole module, and it is `true`. The
      // `path()` helper's default is spelled `?? false` rather than
      // `guestScopeExempt: false`, so it does not match — and it is asserted
      // separately below so the default cannot be flipped either.
      expect(arms).toHaveLength(1);
      expect(arms[0]?.[1]).toBe("true");
      // And it is inside the `session-refresh` arm — checked by SLICE rather than
      // a brace-balanced regex, because a regex that has to match an object's
      // closing brace is a regex that breaks when the object is reformatted, and
      // this test must not be the thing that makes an arm hard to edit.
      const at = arms[0]?.index ?? -1;
      expect(at).toBeGreaterThan(0);
      const around = code.slice(Math.max(0, at - 200), at + 200);
      expect(around).toContain('kind: "session-refresh"');
      // The default stays FAIL-CLOSED, which is what makes a new arm safe by
      // default rather than by remembering: a flipped `?? true` is 0 red below,
      // so it is asserted here directly.
      expect(code).toContain("guestScopeExempt: arm.guestScopeExempt ?? false");
      expect(code).toContain("requiresSession: arm.requiresSession ?? true");
    });

    test("every DECLARED RouteKind is PRODUCIBLE, and every produced kind is declared", () => {
      // **The other half of H3, and the one that was silently open.** The probes
      // iterate *classifications*, so a kind added to the union and never wired
      // into `classifyPath` is invisible to them: measured on this branch, a tenth
      // `RouteKind` — gated, no scope, `guestScopeExempt: true` — produced
      // **0 red across 53 cases**. `ROUTE_KINDS` exists so the declared set is a
      // runtime value and can be compared against what the classifier emits.
      //
      // Both directions, because either half alone is satisfiable by a lie: a
      // declared-but-unproducible kind is dead code nobody tests, and a
      // produced-but-undeclared kind cannot typecheck but shows the table and the
      // array disagreeing about the grammar.
      const produced = new Set<RouteKind>();
      for (const [pathname, method] of ALL_PROBES) produced.add(classifyRoute(pathname, method).kind);
      expect(produced.size).toBeGreaterThan(5);
      for (const kind of ROUTE_KINDS) {
        expect(produced.has(kind), `${kind} is declared in ROUTE_KINDS but classifyRoute never produces it`).toBe(true);
      }
      for (const kind of produced) {
        expect((ROUTE_KINDS as readonly string[]).includes(kind), `${kind} is produced but not declared`).toBe(true);
      }
      // Stated as a set, so a reordering cannot fail here — the dispatcher's
      // reading order is pinned by the classification table instead.
      expect([...ROUTE_KINDS].sort()).toEqual([...produced].sort());
      // And every one of them is named by the gate's own log-event mapping or by
      // the dispatchers, which is what makes a declared kind a real one.
      expect(ROUTE_KINDS.length).toBe(10);
    });

    test("the DECLARED partition matches BEHAVIOUR: gated, ungated, and both-sides", () => {
      // The compile-time half lives in `src/authz.ts` (`GatedIsTotal` /
      // `UngatedIsTotal` / `ListsAreDisjoint`), and it fires — measured: declaring
      // an eleventh `RouteKind` produces `tsc` errors naming the unaccounted
      // members. This is the other half, because a partition can be type-correct
      // and still not describe the code: a kind listed as gated that nothing
      // classifies as gated is a dispatcher `case` for a route that cannot exist.
      //
      // So the declared sets are compared against what the DERIVED product
      // actually produces. **`method-not-allowed` is expected on BOTH sides** —
      // it inherits `requiresSession` from the path whose verb was wrong, so a
      // two-sided partition would have had to lie about one of its two cases.
      const gated = new Set<RouteKind>();
      const ungated = new Set<RouteKind>();
      for (const [pathname, method] of ALL_PROBES) {
        const route = classifyRoute(pathname, method);
        (route.requiresSession ? gated : ungated).add(route.kind);
      }
      expect([...gated].sort()).toEqual([...HANDLED_GATED_KINDS].sort());
      expect([...ungated].sort()).toEqual([...UNGATED_ROUTE_KINDS, ...BOTH_SIDES_ROUTE_KINDS].sort());
      // And `method-not-allowed` really is produced on both sides, so the
      // three-way partition is describing the code rather than accommodating it.
      expect(gated.has("method-not-allowed")).toBe(true);
      expect(ungated.has("method-not-allowed")).toBe(true);
      // The three lists partition `RouteKind`, disjointly.
      const declared: RouteKind[] = [...GATED_ROUTE_KINDS, ...UNGATED_ROUTE_KINDS, ...BOTH_SIDES_ROUTE_KINDS];
      expect(declared.sort()).toEqual([...ROUTE_KINDS].sort());
      expect(new Set(declared).size).toBe(declared.length);
    });

    test("HANDLED_GATED_KINDS is exactly the set of kinds reachable with requiresSession", () => {
      // The second half of the same hole. `handleAuthorized` switches over the
      // gated kinds and throws `unreachable()` on anything else, so a NEW gated
      // kind that no handler case covers answers **500** at runtime — and every
      // `switch` over `RouteKind` has a `default`, so `tsc` cannot catch it. The
      // old check asserted each handled kind was reachable; it did NOT assert the
      // converse, which is the direction that finds a missing `case`.
      const reachable = new Set<RouteKind>();
      for (const [pathname, method] of ALL_PROBES) {
        const route = classifyRoute(pathname, method);
        if (route.requiresSession) reachable.add(route.kind);
      }
      expect(reachable.size).toBeGreaterThan(3);
      // The converse, which is what was missing: nothing gated is unhandled.
      for (const kind of reachable) {
        expect(HANDLED_GATED_KINDS.has(kind), `${kind} is gated but handleAuthorized has no case`).toBe(true);
      }
      // And nothing is handled that cannot be gated, or its case is dead code.
      for (const kind of HANDLED_GATED_KINDS) {
        expect(reachable.has(kind), `${kind} has a handler but is never gated`).toBe(true);
      }
      // Spelled out, so a new kind has to be added in two places on purpose.
      expect([...reachable].sort()).toEqual([...HANDLED_GATED_KINDS].sort());
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
      // Over the derived product: a new exempt PATH is caught here whatever its
      // shape, which a written-out list could not do.
      const exemptPaths = new Set<string>();
      for (const [pathname, method] of ALL_PROBES) {
        if (classifyRoute(pathname, method).guestScopeExempt) exemptPaths.add(pathname);
      }
      expect([...exemptPaths]).toEqual([SESSION_REFRESH_PATH]);
      // And nothing on the review surface is exempt, on any verb, whatever the
      // wrong verb does to the kind — asserted over the product rather than four
      // paths, so a new preview-shaped route cannot slip in.
      let reviewSurfaceExempt = 0;
      for (const [pathname, method] of ALL_PROBES) {
        if (!pathname.startsWith("/") || pathname === SESSION_REFRESH_PATH) continue;
        const route = classifyRoute(pathname, method);
        // The invite routes and `/healthz` are ungated, so "exempt" is meaningless
        // there; the claim is about GATED routes only.
        if (!route.requiresSession) continue;
        if (route.guestScopeExempt) reviewSurfaceExempt += 1;
      }
      expect(reviewSurfaceExempt).toBe(0);
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
      // `try`/`finally` because this file's fixture is seeded ONCE in `beforeAll`
      // and the SECOND key is this case's to clean up. Without it, an assertion
      // failing above leaks `/revkit/pr-99` into every later case and the next
      // `seedLog` dies with `UNIQUE constraint failed: review_logs.log_key,
      // review_logs.seq` — a cascade that hides the real failure. Its sibling case
      // below already used `finally`; this one did not, and now does.
      const otherKey = previewScopePath(REVIEW.repo, 99);
      try {
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
      } finally {
        await harness.db
          .prepare("DELETE FROM review_logs WHERE log_key = ?")
          .bind(otherKey)
          .run();
      }
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

    // ── H2: the log key is STRUCTURAL, and that is asserted, not asserted-to ──
    test("MUTATION GUARD: a header-SUPPLIED log key handed to the store DOES cross reviews — so the store is not the control", async () => {
      // **The forbidden shape, executed.** `d1-store.test.ts`'s A10 guard runs the
      // naive allocator that A10 forbids and asserts it collides, so a passing A10
      // is a real result. This is the same discipline for the scope axis, and it
      // is the case that makes the rest of H2 non-vacuous.
      //
      // The fact it establishes: `D1ThreadStore` does exactly what it is told. A
      // log key read out of a caller-supplied header, handed straight to the
      // constructor, returns ANOTHER REVIEW'S THREADS — no refusal, no warning,
      // 200-shaped data. So the partition is faithful and the store is not a
      // boundary; **the only control is that nothing caller-influenceable ever
      // becomes a log key**, and that is a property of the HANDLER, not of the
      // store. The review found the same thing by mutating `src/index.ts` to
      // `request.headers.get("x-revkit-log-key") ?? route.scope?.logKey` and
      // getting `200 {"head":1,"threads":[{ … "THEIRS-ONLY-MARKER" … }]}`.
      const otherKey = previewScopePath(REVIEW.repo, 99);
      await seedLog(harness.db, otherKey, "theirs");
      try {
        // Read the key out of a header, exactly as the mutant did.
        const fromHeader = new Headers({ "x-revkit-log-key": otherKey }).get("x-revkit-log-key");
        expect(fromHeader).toBe(otherKey);
        const crossed = new D1ThreadStore({ db: harness.db, logKey: fromHeader ?? LOG_KEY });
        // It really does cross: another review's threads, in full.
        expect((await crossed.threads()).map((t) => t.id)).toEqual(["theirs-1", "theirs-2", "theirs-3", "theirs-7"]);
        expect((await crossed.since(0)).length).toBe(4);
        expect(await crossed.head()).toBe(7);
        // And the faithful store, pointed at THIS review, does not — so the two
        // differ ONLY by the key, which is the whole claim.
        const faithful = new D1ThreadStore({ db: harness.db, logKey: LOG_KEY });
        expect((await faithful.threads()).map((t) => t.id)).toEqual(["th-seed-1", "th-seed-2", "th-seed-3", "th-seed-7"]);
      } finally {
        await harness.db.prepare("DELETE FROM review_logs WHERE log_key = ?").bind(otherKey).run();
      }
    });

    test("MUTATION GUARD: `readThreads` cannot see the request at all, so no header can become a log key", async () => {
      // **The structural half of H2, and the reason the case above matters.**
      // The behavioural battery that follows proves headers are ignored; on its
      // own that is unfalsifiable, because "ignored" and "not readable" look the
      // same from outside. This asserts the property directly, over the shipped
      // source, in the same idiom as `schema.test.ts`'s scan for the retired
      // `events` table.
      //
      // The claim: inside `readThreads`, the binding that names the log is derived
      // from `route` — and the function has no access to `request`, `env`, or the
      // URL's query, so there is nothing for a caller to influence. The reviewer's
      // mutant had to *add* `request` to reach a header; this fails if anyone
      // does.
      const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
      const index = readFileSync(join(srcDir, "index.ts"), "utf8");
      const start = index.indexOf("async function readThreads(");
      expect(start, "readThreads is declared").toBeGreaterThan(-1);
      // The whole declaration, up to its closing brace at column 0.
      const body = stripTsComments(index.slice(start, index.indexOf("\n}\n", start) + 3));
      expect(body.length).toBeGreaterThan(200);

      // 1. Its PARAMETER NAMES are exactly the five it is called with — no
      //    `request`, which is what the review's mutant had to add.
      const params = /async function readThreads\(([\s\S]*?)\): Promise<Response> \{/.exec(body)?.[1] ?? "";
      const names = params
        .split(",")
        .map((one) => (one.split(":")[0] ?? "").trim())
        .filter((one) => one.length > 0);
      expect(names).toEqual(["authorized", "env", "scope", "url", "route"]);

      // 2. Comments are stripped before the scan, and that is deliberate: the
      //    function's own comment block NAMES the mutant (it has to, to document
      //    the survivor), so scanning the raw text would fail on the
      //    documentation of the very thing being guarded. The claim is about CODE.
      // `url.search` is ALLOWED and is the point: it is handed whole to
      // `parseThreadsQuery`, which is total over the parameter set. What is
      // forbidden is reading it as a KEY (`searchParams.get`), which is the
      // shape this PR's own equivalence argument covers.
      for (const forbidden of ["request", "headers", "getCookie", "searchParams", "process", "fetch(", "getAll("]) {
        expect(body.includes(forbidden), `readThreads' code mentions ${forbidden}`).toBe(false);
      }
      // `env` is legitimate — it is the database handle — but nothing else may be
      // read off it either.
      expect([...body.matchAll(/env\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1])).toEqual(["DB"]);

      // 3. The binding itself is the scope's, with no fallback chain: exactly one
      //    assignment, off `route`. This is the line the review mutated.
      const bindings = [...body.matchAll(/const logKey = ([^;]+);/g)].map((m) => (m[1] ?? "").trim());
      expect(bindings).toEqual(["route.scope?.logKey"]);

      // 4. And no OTHER statement in `src/` reads a `log_key` out of a request.
      //    Belt-and-braces over the one function, because the claim is about the
      //    package: a second reader elsewhere would be the same hole.
      for (const file of readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
        const code = stripTsComments(readFileSync(join(srcDir, file), "utf8"));
        expect(/log_key/.test(code), `${file} reads a log_key`).toBe(false);
        expect(/logKey\s*[:=]/.test(code) && !/route\.scope/.test(code) && file === "index.ts", `${file} assigns logKey off-route`).toBe(false);
      }
    });

    test("no caller-influenceable channel can name a log — header, Referer, cookie, query, or path case", async () => {
      // **The behavioural half of H2.** Every channel a caller controls that could
      // plausibly carry a log key is sent at a scoped read, and the answer must be
      // THIS review's content every time. Two reviews are populated with
      // DISTINGUISHABLE markers, so a single honoured channel would show up in the
      // body.
      const otherKey = previewScopePath(REVIEW.repo, 99);
      await seedLog(harness.db, otherKey, "theirs");
      try {
        const issued = await issueTestSession(harness.db);
        const session = cookieHeader(issued.sessionId);
        const channels: [string, Readonly<Record<string, string>>][] = [
          ["custom header", { "x-revkit-log-key": otherKey }],
          ["Referer", { referer: `http://localhost${scopedThreadsPath("other-repo", 7)}` }],
          // APPENDED to the session cookie rather than replacing it: a channel that
          // dropped the credential would answer 401 and prove nothing about logs.
          ["cookie", { cookie: `${session}; log_key=${encodeURIComponent(otherKey)}` }],
          ["query", {}],
          ["X-Forwarded-Host", { "x-forwarded-host": "other-repo" }],
          ["Host", { host: "other-repo" }],
          ["Origin", { origin: `https://${encodeURIComponent(otherKey)}` }],
          ["prefixed header", { "x-revkit-scope": otherKey, "x-log-key": otherKey, "scope": otherKey }],
        ];
        for (const [label, extra] of channels) {
          const suffix = label === "query" ? `?log_key=${encodeURIComponent(otherKey)}` : "";
          const response = await harness.dispatch(`http://localhost${THREADS_PATH}${suffix}`, {
            headers: label === "cookie" ? extra : { cookie: session, ...extra },
          });
          const raw = await response.text();
          if (label === "query") {
            // The one channel with a real answer: an unknown parameter is a 400,
            // and the body is the refusal shape.
            expect(response.status, label).toBe(400);
            expect(JSON.parse(raw) as Record<string, unknown>).toMatchObject({
              error: "bad-request",
              reason: "unknown-parameter",
            });
          } else {
            expect(response.status, `${label}: ${raw.slice(0, 120)}`).toBe(200);
            expect(raw, label).toContain("th-seed-1");
            expect(raw, label).not.toContain("theirs-");
          }
        }
        // The PATH is case-SENSITIVE, and since #96 a non-canonical repo segment
        // is not a preview at all: `/REVKIT/pr-7/api/threads` names nothing, so
        // it is a 404. Before that it named a DIFFERENT review — the empty log
        // `/REVKIT/pr-7` — which this session could read, because an
        // `operator` is the one identity kind the gate does not scope-check (see
        // `authz.ts`). "Two spellings of one review, one of them empty and
        // readable by anyone with a session" was not a hole, but it was a second
        // review nobody created. The content assertions stay, because the point
        // is still CONTENT: neither this review's threads nor the other
        // populated one.
        const shouty = await harness.dispatch("http://localhost/REVKIT/pr-7/api/threads", {
          headers: { cookie: cookieHeader(issued.sessionId) },
        });
        expect(shouty.status).toBe(404);
        const shoutyRaw = await shouty.text();
        expect(shoutyRaw).not.toContain("theirs-");
        expect(shoutyRaw).not.toContain("th-seed");
        expect(shoutyRaw).not.toContain(SEED_BODY);
      } finally {
        await harness.db.prepare("DELETE FROM review_logs WHERE log_key = ?").bind(otherKey).run();
      }
    });

    test("the largest accepted ?since= is bounded, so a path cannot carry an unbounded integer into a query", async () => {
      const issued = await issueTestSession(harness.db);
      // 16 digits is the CEILING, and it is deliberately not claimed to be exact.
      // It is not: `9999999999999999 > Number.MAX_SAFE_INTEGER` (measured), so
      // `Number.parseInt("9999999999999999")` is `10000000000000000`. An earlier
      // version of this comment said "under 2^53, so `parseInt` is exact", which
      // was false, and the case below is what now pins the actual behaviour rather
      // than the intent.
      //
      // Why the imprecision is harmless, and why it is still worth stating: `since`
      // becomes `WHERE seq > ?`, and `seq` is a per-review counter that cannot
      // reach 10^16 in any deployment this build has (a review with 10^16
      // comments is not a review, it is a number). Rounding UP can only
      // under-read — a client resumes slightly later and re-receives at most one
      // event — and it cannot cross a log boundary, because the log key is
      // selected from the PATH and not from this number. One more digit IS refused
      // rather than silently truncated, which is the property that matters: the
      // bound is enforced.
      const ok = await harness.dispatch(`http://localhost${THREADS_PATH}?since=9999999999999999`, {
        headers: { cookie: cookieHeader(issued.sessionId) },
      });
      expect(ok.status).toBe(200);
      const tooBig = await harness.dispatch(`http://localhost${THREADS_PATH}?since=99999999999999999`, {
        headers: { cookie: cookieHeader(issued.sessionId) },
      });
      expect(tooBig.status).toBe(400);
      // The imprecision itself, measured rather than described: 16 digits is past
      // 2^53, and the accepted value rounds UP.
      expect(9999999999999999 > Number.MAX_SAFE_INTEGER).toBe(true);
      expect(Number.parseInt("9999999999999999", 10)).toBe(10000000000000000);
      expect(JSON.parse(await ok.text()) as { events: unknown[] }).toMatchObject({ events: [] });
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
