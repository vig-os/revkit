// ADR-0012's per-request authorization gate, and the ONE place a request can
// become a principal.
//
// ADR-0012 states the requirement in one line and it is unconditional:
//
//   > **Authorization per request:** a GitHub session must still have read
//   > access to the repo (cached ≤ 5 min); a guest invite is checked for
//   > scope, type and expiry on each call.
//
// The word that matters is **per request**. M4 slice 1 had to close
// `GET /api/threads` entirely (501, every verb) precisely because this module
// did not exist: there was no session to authorize, and an open read needs no
// browser, no user interaction and no bypass to return comment bodies.
//
// ── What this gate implements, and what it does not ───────────────────────
//
// IMPLEMENTED, unconditionally, on every route except `/healthz`:
//
//   1. A session cookie that resolves, BY DIGEST, to a row that exists, is
//      unexpired, and carries an identity kind this build recognises.
//   2. On a state-changing verb, a CSRF token that satisfies THAT session's
//      own `csrf_hash` — bound per session, not a constant.
//   3. On a state-changing verb, `application/json` and nothing else
//      (ADR-0012).
//
// IMPLEMENTED, for a GUEST session, on every route that requires one — slice 3:
//
//   4. The invite is re-read and re-decided ON THIS REQUEST: binding, then
//      revocation/expiry, then scope, then comment rights. Not once at
//      redemption — a session's authority belongs to its invite, and the
//      invite moves after the session exists.
//   5. Slice 5: the route NAMES a review, or the guest is refused. "No scope"
//      is not "no restriction"; see the fail-closed branch in `authorizeRequest`.
//
// NOT IMPLEMENTED YET, and named so nobody reads the list above as more than
// it is:
//
//   - "a GitHub session must still have read access to the repo (cached ≤ 5
//     min)". There is no `TokenSource` — the App is owner-gated (#34) — and
//     nothing to check repo access against. **This is the axis still missing
//     after slice 5**, and it is missing in a specific, nameable place:
//
//     **`github` is ABSENT from `RECOGNISED_IDENTITY_KINDS`**, deliberately
//     (`src/session.ts`): there is no App to honour it, so a session row naming
//     `github` is refused `401 unrecognised-identity-kind` rather than guessed at.
//     **The kind that is org-wide today is therefore `operator`** — and the gate
//     does not scope-check it: the whole scope block below is under
//     `if (resolved.principal.kind === "invite")`, so an `operator` session reads
//     whatever `(repo, PR)` the path names, across every review in this
//     deployment. That is the class to audit, and it is one line of this file.
//
//     Slice 5 narrowed the GUEST side and deliberately did not touch this one. A
//     guest is confined to its invite's scope; `operator` stays unscoped until the
//     provider can prove repo access. Narrowing it to "deny everything" would lock
//     the operator out of their own deployment, which is the failure mode
//     `issueSession`'s operator identity exists to avoid.
//
// So "authorized" in this slice means: **a session this build issued is
// presenting, unexpired; and if it is a guest session, its invite still exists,
// is unrevoked, unexpired, covers what this route names — which for every
// gated route but one means the route names a review at all — permits what this
// route writes, and was redeemed in THIS browser.** Calling the remaining
// GitHub-read clause sufficient would be the same kind of overclaim slice 1
// corrected twice.
//
// ── Why `RECOGNISED_IDENTITY_KINDS` is closed here ───────────────────────
//
// A session row's `identity_kind` is not constrained by the schema, on
// purpose (`migrations/0001_init.sql` records why: adding a provider must not
// be a table rewrite). The gate therefore refuses a kind it does not know,
// instead of treating "unknown provider" as "allowed". That direction matters
// because the failure is asymmetric: a provider revkit cannot honour would
// otherwise be honoured with no scope check, no expiry rule and no revocation
// path — a session that passes every gate precisely because nothing gates it.
// Adding a real provider means adding an arm HERE, where the diff shows the
// scope rules being written, not a `default:` arm.
//
// ── What "one gate every route passes through" means mechanically ─────────
//
// `classifyRoute` is a pure function of `(pathname, method)` and it returns
// `requiresSession` for every kind. `authorizeRequest` is the only producer
// of an `AuthorizedSession`, and that type carries a brand from a module-local
// `unique symbol` which is **not exported** — so no other module in this
// package can construct one, and a handler whose parameter is
// `AuthorizedSession` will not typecheck if it is reachable without the gate.
// The brand is a compile-time device only (no runtime check does that job).
// the runtime evidence that the gate holds is the negative matrix in
// `test/authorization.test.ts`, one case per route per verb.

import { parsePreviewPath, parseScopedThreadsPath, isRevkitBundlePath } from "./router.ts";
import {
  csrfSatisfied,
  readSessionCookie,
  resolveSession,
  CSRF_HEADER,
  type MsClock,
  type SessionPrincipal,
} from "./session.ts";
import { inviteCovers, loadInviteGrant, readBrowserCookie, type GrantRefusal } from "./invites.ts";
import type { LogMessage } from "./logger.ts";

// ── the routes ────────────────────────────────────────────────────────────

/** `GET /healthz`. Deliberately the ONLY unauthenticated route that answers.
 * It is a liveness probe, it reads no database, and its body is `{ok, the
 * revkit version it runs, the request id}` — no review content, no identity,
 * no count. A probe that needed a session would be a probe nobody runs. */
export const HEALTH_PATH = "/healthz";

/** `POST /api/session/refresh` — rotate the caller's own session id and CSRF
 * token. The only state-changing route this slice opens, and it exists for
 * that reason: ADR-0012's CSRF and `application/json` rules are only
 * testable end to end if at least one state-changing call is reachable, and
 * `POST <repo>/pr-<n>/api/threads` stays 501 because its handler is slice 4's.
 * This one writes nothing but the caller's own `sessions` row. */
export const SESSION_REFRESH_PATH = "/api/session/refresh";

/** `GET /invite/<token>` — the display-name form. UNGATED by necessity: a
 * guest arriving from a mail client has no session, and ADR-0009 requires the
 * exchange. See `INVITE_PATH_PREFIX`'s own comment for what that costs and
 * which controls stand in for the gate. */
export const INVITE_OPEN_PREFIX = "/invite/";

/** `POST /invite/redeem` — exchange the token for a session. Same reasoning,
 * and it is the only route in this Worker that issues a credential to a caller
 * who has none. */
export const INVITE_REDEEM_PATH = "/invite/redeem";

/** Every route kind. `method-not-allowed` is its own kind rather than a flag
 * on a real one so the classification table below reads the way the dispatch
 * does, and so a test can enumerate it exhaustively. */
/**
 * Every kind `classifyRoute` can return, as DATA, and `RouteKind` derived from it.
 *
 * **Why the union is now derived rather than written (slice 5 review).** A
 * hand-written `type RouteKind = "a" | "b" | …` is invisible at runtime, so a new
 * kind added to the union but never wired into `classifyPath` is **unreachable and
 * untested**: the route-table probes iterate classifications, so they never see a
 * kind nothing classifies as. Measured on this branch: adding a tenth member to the
 * union, gated and `guestScopeExempt: true`, produced **0 red across 53 cases** —
 * because the kind was never produced, the probes had nothing to say about it, and
 * `tsc` has no opinion (the field is required, so an arm compiles, and every
 * `switch` over `RouteKind` has a `default`).
 *
 * Deriving the type from a frozen array makes the set a runtime value, so
 * `test/authorization.test.ts` can assert it against what the classifier actually
 * produces in BOTH directions: no declared kind is unproducible, and no produced
 * kind is undeclared. `tsc` still gets its exhaustiveness — the switches still
 * narrow over a union of literals — and now the declaration and the wiring cannot
 * drift without a test failing.
 *
 * Order is the dispatcher's reading order and is asserted by the test that pins
 * the classification table.
 */
export const ROUTE_KINDS = [
  "health",
  "method-not-allowed",
  "threads-read",
  "threads-append",
  "session-refresh",
  "invite-open",
  "invite-redeem",
  "preview",
  "revkit-bundle",
  "unknown",
] as const;

export type RouteKind = (typeof ROUTE_KINDS)[number];

/**
 * The table's PARTITION: which kinds are gated, which are not, and which is
 * BOTH — as data, in the module that owns the table.
 *
 * `classifyRoute` is total over `RouteKind`, so the partition is a claim about
 * every kind that exists — and until slice 5's review it was a claim written only
 * in `test/authorization.test.ts`, over a probe list that could not see a kind
 * nothing produced. Two consequences followed, both measured on this branch:
 *
 *   - a hard-coded arm that is gated, names no scope and sets
 *     `guestScopeExempt: true` left the suite **green**, because the derived
 *     probes iterate grammar-shaped paths and cannot enumerate a function's
 *     domain;
 *   - flipping `path()`'s fail-closed `guestScopeExempt` default to `?? true`
 *     also left it **green**.
 *
 * So the partition lives HERE, in three arrays whose union is checked against
 * `RouteKind` **at compile time** by the assertions below. `tsc` is the backstop
 * the runtime `default:` arm defeats: a `switch` with a `default` cannot be
 * exhaustive-checked, and every `switch` over `RouteKind` here has one — by
 * design, because `unreachable()` turning a missing case into a loud 500 is worth
 * more than a compile error. These type-level set differences get both.
 *
 * **`method-not-allowed` is on BOTH sides, and that is not a hedge.** It is the
 * relabelled kind of whichever path carried the wrong verb, and it INHERITS that
 * path's `requiresSession` — a wrong verb on `/healthz` is ungated, a wrong verb
 * on `<repo>/pr-<n>/api/threads` is gated and in scope. Two lists would have had
 * to lie about one of those cases; measured, the lie is what a two-sided
 * partition produces: `method-not-allowed` showed up in the ungated set and the
 * comparison failed until the third list existed.
 */
export const GATED_ROUTE_KINDS = ["threads-read", "threads-append", "session-refresh", "preview"] as const;

export const UNGATED_ROUTE_KINDS = ["health", "invite-open", "invite-redeem", "revkit-bundle", "unknown"] as const;

/** Reachable on either side of the gate, depending on the path it shadows. */
export const BOTH_SIDES_ROUTE_KINDS = ["method-not-allowed"] as const;

export type GatedRouteKind = (typeof GATED_ROUTE_KINDS)[number] | (typeof BOTH_SIDES_ROUTE_KINDS)[number];
export type UngatedRouteKind = (typeof UNGATED_ROUTE_KINDS)[number] | (typeof BOTH_SIDES_ROUTE_KINDS)[number];

/**
 * Is this kind reachable on the GATED side of the partition?
 *
 * **A runtime check, not a cast.** `handleAuthorized` takes
 * `Route & { kind: GatedRouteKind }`, and the gate's call site cannot derive that
 * from `route.requiresSession` alone (`Route` is an interface, not a union, so
 * TypeScript does not connect the two). The alternative was a cast, and a cast
 * is an assertion where this codebase insists on a check — so this predicate is
 * the check, it runs on every authorized request, and a partition mistake becomes
 * `unreachable()` and a loud 500 rather than a dispatcher `case` that silently
 * does not exist.
 */
export function isGatedRouteKind(kind: RouteKind): kind is GatedRouteKind {
  return (GATED_ROUTE_KINDS as readonly string[]).includes(kind) ||
    (BOTH_SIDES_ROUTE_KINDS as readonly string[]).includes(kind);
}

/** Compile-time: the partition is TOTAL — every `RouteKind` is on at least one
 * side. Declared bindings rather than bare `type`s so a failure names a line and
 * lists the unaccounted members. */
type PartitionIsTotal = Exclude<RouteKind, GatedRouteKind | UngatedRouteKind> extends never
  ? true
  : ["a RouteKind is on neither side of the partition", Exclude<RouteKind, GatedRouteKind | UngatedRouteKind>];
const _partitionIsTotal: PartitionIsTotal = true;

/** Compile-time: the three lists are DISJOINT, so a kind cannot be claimed twice
 * and quietly satisfy two dispatchers. (`GatedRouteKind` and `UngatedRouteKind`
 * deliberately OVERLAP on `BOTH_SIDES_ROUTE_KINDS`, so the check is over the raw
 * lists, not the widened types.)
 *
 * **`Extract`, not `Exclude` — the polarity is the whole check.** "These lists do
 * not overlap" is `Extract<A, B> is never` (nothing of A is in B). `Exclude<A, B>
 * is never` says the opposite: that EVERY member of A is in B. Three separate
 * aliases, because a conditional over a tuple does not distribute the way a
 * reader would assume. */
type GatedOnlyIsAlone = Extract<
  (typeof GATED_ROUTE_KINDS)[number],
  (typeof UNGATED_ROUTE_KINDS)[number] | (typeof BOTH_SIDES_ROUTE_KINDS)[number]
> extends never
  ? true
  : ["a kind is in GATED_ROUTE_KINDS and another list", never];
type UngatedOnlyIsAlone = Extract<
  (typeof UNGATED_ROUTE_KINDS)[number],
  (typeof GATED_ROUTE_KINDS)[number] | (typeof BOTH_SIDES_ROUTE_KINDS)[number]
> extends never
  ? true
  : ["a kind is in UNGATED_ROUTE_KINDS and another list", never];
type BothSidesIsAlone = Extract<
  (typeof BOTH_SIDES_ROUTE_KINDS)[number],
  (typeof GATED_ROUTE_KINDS)[number] | (typeof UNGATED_ROUTE_KINDS)[number]
> extends never
  ? true
  : ["a kind is in BOTH_SIDES_ROUTE_KINDS and another list", never];
const _gatedOnlyIsAlone: GatedOnlyIsAlone = true;
const _ungatedOnlyIsAlone: UngatedOnlyIsAlone = true;
const _bothSidesIsAlone: BothSidesIsAlone = true;

void [_partitionIsTotal, _gatedOnlyIsAlone, _ungatedOnlyIsAlone, _bothSidesIsAlone];

export interface Route {
  readonly kind: RouteKind;
  /** ADR-0012: this route may only be reached with a valid session. */
  readonly requiresSession: boolean;
  /** ADR-0012: this route changes state, so it also needs the CSRF token and
   * `application/json`. */
  readonly stateChanging: boolean;
  /** ADR-0012's "a guest invite is checked for … type on each call": this
   * route WRITES review content, so a `view` invite's `can_comment = 0` must
   * refuse it. Separate from `stateChanging` on purpose — `POST
   * /api/session/refresh` changes state and must work for a read-only guest,
   * because it only touches the guest's own session row. */
  readonly requiresComment: boolean;
  /** The repo and PR this route names, when it names any. A guest session's
   * invite scope is checked against it, AND it selects which log the read
   * serves. Computed HERE, at classification, so the gate still never parses a
   * URL — see `classifyRoute`. */
  readonly scope: PreviewScope | undefined;
  /**
   * Slice 5's fail-closed rule, and it is a FIELD rather than a list on purpose.
   *
   * A guest session may only reach a route that names a scope. "No scope" is not
   * "no restriction" — it is the absence of the answer to "which review?", and
   * a read with no review to read is org-wide by accident. Before slice 5 that
   * absence was the default for `GET /api/threads`, and the per-call check ran
   * on every guest request and selected nothing.
   *
   * **Exactly one route is exempt: `POST /api/session/refresh`**, which rotates
   * the caller's OWN credential and touches only their own `sessions` row. It
   * names no review because it is not about one, and a read-only guest needs it
   * (`Route.requiresComment` says why).
   *
   * **Why a boolean per classification rather than a set of kinds here.** The
   * exempt set is one entry, so a `Set<RouteKind>` would also work — and would
   * then be a second thing to keep in step with `RouteKind`, checkable at no
   * call site. Making it a field forces `route()` to be handed an answer for
   * every path and verb in the table, so a new route cannot inherit "unscoped
   * is fine" without someone typing the word. The type has no default for it,
   * which is the fail-closed direction.
   */
  readonly guestScopeExempt: boolean;
  /** The path is real but the verb is not. Answered 405 — AFTER the gate,
   * where `requiresSession` is true, so an unauthorized caller learns
   * "unauthorized", never "that route exists". */
  readonly unsupportedMethod: boolean;
}

/** What an invite's scope is compared against, and which log a read serves.
 * Structurally identical to `PreviewRef`'s first three fields, and declared
 * separately rather than importing it so `authz.ts` does not depend on the
 * preview grammar's shape. */
export interface PreviewScope {
  readonly repo: string;
  readonly pr: number;
  /** `previewScopePath(repo, pr)` — one review's log key, produced by the
   * grammar in `src/router.ts`. Carried here so a handler selects the log from
   * the AUTHENTICATED PATH rather than deriving it a second time, and so there
   * is no function in this package that turns caller input into a log key. */
  readonly logKey: string;
}

/** Methods that read. `HEAD` is `GET` without a body; treating it as a read
 * is the whole point, because a `HEAD` on a gated path that slipped through as
 * a "not really a read" would still run the query. */
const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/**
 * A route before the verb has been looked at: everything that is a property of
 * the PATH, and nothing that is a property of the request's method.
 *
 * **Why the table is split into two phases (slice 5).** Before, each arm of
 * `classifyRoute` checked the verb itself and spelled `undefined` for the scope
 * of every wrong-verb arm. That put two facts in one place and neither was
 * derivable from the other: `PUT <repo>/pr-<n>/api/threads` classified as
 * `method-not-allowed` with **no scope**, and `PUT /api/session/refresh` with
 * none either — so "which review does this path name" and "may a guest reach
 * this path without one" were answered by which arm the verb happened to fall
 * into. With slice 5's fail-closed rule in the gate, that ambiguity has teeth: the
 * wrong-verb arm on a scoped path would have refused a guest for the reason
 * *invite-scope-unbounded* while the path plainly named a scope.
 *
 * Phase one answers everything the path decides. Phase two, `classifyRoute`,
 * only decides whether the verb is allowed and, if not, **keeps every path
 * fact** and relabels the kind. So a wrong verb on a scoped path is a 405 *in
 * that scope*, and a wrong verb on the session route inherits the session
 * route's exemption — which is what leaves the gate's rule with no carve-outs
 * to keep in step:
 *
 *     a guest may reach a gated route iff it names a scope, or is exempt.
 */
interface PathRoute {
  readonly kind: Exclude<RouteKind, "method-not-allowed">;
  readonly requiresSession: boolean;
  readonly stateChanging: boolean;
  readonly requiresComment: boolean;
  readonly scope: PreviewScope | undefined;
  readonly guestScopeExempt: boolean;
  /** Does this path answer `verb` as `kind`? Anything else becomes
   * `method-not-allowed` with the fields below preserved. A predicate rather
   * than a set because TWO paths accept EVERY verb — `unknown` and
   * `revkit-bundle`, both ungated, where the verb cannot change the answer; see
   * `ANY_VERB`. Every GATED path takes a read or a write predicate, so a wrong
   * verb on one is a 405 rather than a route that quietly accepts it. */
  readonly acceptsVerb: (verb: string) => boolean;
  /**
   * The one path that answers DIFFERENTLY per verb: `<repo>/pr-<n>/api/threads`
   * is a read on `GET`/`HEAD` and a write on `POST`, and the write arm carries
   * `requiresComment`, which is what makes ADR-0009's "`view` is read-only"
   * enforceable while the write itself is still a 501 (the gate refuses a
   * read-only guest BEFORE the handler, so the 501 is only ever reached by a
   * caller entitled to write — `test/invites.test.ts`).
   *
   * A second arm rather than a second path entry, so the path's SCOPE is stated
   * once and cannot differ between the read and the write of one review.
   */
  readonly writeArm:
    | { readonly verb: "POST"; readonly kind: Exclude<RouteKind, "method-not-allowed">; readonly stateChanging: boolean; readonly requiresComment: boolean }
    | undefined;
}

/** Every verb — for the two UNGATED kinds only, where the verb changes nothing
 * because there is no route for the answer to be about (`/_revkit/…`, `unknown`).
 *
 * **A preview path is deliberately NOT one of them (#96).** Slice 2 let any verb
 * on `<repo>/pr-<n>/…` classify as `preview` and justified it as "the handler is
 * 501 anyway". That justification described the handler and not the GATE:
 * `stateChanging: false` is precisely the flag that makes `authorizeRequest`
 * SKIP the CSRF and `application/json` checks, so POST/PUT/DELETE on a preview
 * path passed with neither. Nothing observable then, because the handler was 501
 * — and the arm was fixed BEFORE that could change, rather than after, which is
 * the whole point of fixing a gate default on the strength of what the default
 * is. **The prediction this comment made has since come true**: a preview route
 * now serves bytes (issue #101), and a first WRITE handler under a preview path
 * would have inherited exactly that hole. So the preview arm accepts `READ_VERB`,
 * like every other read-only route, and a wrong verb becomes `method-not-allowed`:
 * still behind the gate, answered 405 — asserted in `test/preview.test.ts` for
 * every write verb, with the R2 read counter at zero. */
const ANY_VERB = (): boolean => true;
const READ_VERB = (verb: string): boolean => READ_METHODS.has(verb);
const POST_VERB = (verb: string): boolean => verb === "POST";
const GET_VERB = (verb: string): boolean => verb === "GET";

/**
 * The whole routing decision, as a pure function.
 *
 * Order matters and is load-bearing, so it is stated rather than implied. The
 * PATH arms, in order:
 *
 *   1. `/healthz` — exact path.
 *   2. `/api/session/refresh` — EXACT path. No trailing slash, no case folding,
 *      no alias: `/api/session/refresh/` is a different path and falls through
 *      to `unknown`, which is how a closed route does not come back under a
 *      second spelling.
 *   3. `/invite/redeem` — exact path. Before `/invite/…`, because `redeem` is
 *      itself a well-shaped invite token: without this ordering a
 *      `POST /invite/redeem` would be classified as opening a token whose name
 *      is `redeem`, which is one spelling of two meanings.
 *   4. `/invite/<token>`.
 *   5. `/_revkit/…` — ADR-0012: never a preview, never a redirect.
 *   6. `<repo>/pr-<n>/api/threads` — the scoped read. **Before** arm 7, because
 *      `parsePreviewPath` ignores everything after the PR segment and would
 *      happily call this a preview.
 *   7. `<repo>/pr-<n>/…` — a preview path.
 *   8. anything else — `unknown`, ungated, because there is nothing to authorize.
 *
 * `/api/threads` is **not among them, on purpose** (slice 5). It named no
 * repository, so it could only be answered org-wide, and ADR-0012's per-call
 * scope check cannot narrow a read whose rows carry no scope. It is now spelled
 * `/<repo>/pr-<n>/api/threads` and this file answers `unknown` — 404 — for the
 * old path, for a guest and an operator alike. `test/authorization.test.ts`
 * asserts it is not a route.
 *
 * Then, and only then, the verb: `HEAD` is a read everywhere EXCEPT the invite
 * routes, and that is not uniformity. `HEAD` on a read is `GET` without a body;
 * `HEAD` on a redeem is the one read that CONSUMES, and answering it would let a
 * link checker, a proxy or a prefetch burn a guest's single redemption without
 * the guest ever seeing a page. So those two paths are `GET`-only.
 */
export function classifyRoute(pathname: string, method: string): Route {
  const path = classifyPath(pathname);
  const verb = method.toUpperCase();
  const write = path.writeArm;
  if (write !== undefined && verb === write.verb) {
    return route(
      write.kind,
      { ...path, kind: write.kind, stateChanging: write.stateChanging, requiresComment: write.requiresComment },
      false,
    );
  }
  if (path.acceptsVerb(verb)) return route(path.kind, path, false);
  // A wrong verb DROPS the state-changing and comment obligations rather than
  // inheriting them. The route is being refused, so it will change nothing and
  // write no review content, and an obligation the handler does not honour is an
  // obligation that only produces misleading refusals — inheriting
  // `stateChanging` made a `GET /api/session/refresh` answer 403 `csrf` instead
  // of the 405 it is, which tells an authorized caller about the CSRF machinery
  // on a request that was never going to be authorized anyway.
  return route("method-not-allowed", { ...path, stateChanging: false, requiresComment: false }, true);
}

/** Which review a PATH is for, and everything else the path decides. */
function classifyPath(pathname: string): PathRoute {
  if (pathname === HEALTH_PATH) {
    // The probe is ungated either way, but the classification is uniform:
    // a path whose verb is wrong answers `method-not-allowed`, not a special
    // case the dispatcher has to remember.
    return path({ kind: "health", requiresSession: false, acceptsVerb: READ_VERB });
  }
  if (pathname === SESSION_REFRESH_PATH) {
    // The ONE `guestScopeExempt: true` in the table. This route names no review
    // because it is not about one: it rotates the caller's own session id and
    // CSRF token and touches nothing else. It must keep working for a guest —
    // including a read-only one — or a guest would have no refresh path at all.
    return path({
      kind: "session-refresh",
      requiresSession: true,
      stateChanging: true,
      guestScopeExempt: true,
      acceptsVerb: POST_VERB,
    });
  }
  if (pathname === INVITE_REDEEM_PATH) {
    return path({ kind: "invite-redeem", requiresSession: false, stateChanging: true, acceptsVerb: POST_VERB });
  }
  if (pathname.startsWith(INVITE_OPEN_PREFIX)) {
    return path({ kind: "invite-open", requiresSession: false, acceptsVerb: GET_VERB });
  }
  if (isRevkitBundlePath(pathname)) {
    return path({ kind: "revkit-bundle", requiresSession: false, acceptsVerb: ANY_VERB });
  }
  const scoped = parseScopedThreadsPath(pathname);
  if (scoped !== undefined) {
    // The scope travels WITH the classification rather than being re-derived
    // in the gate: the gate must not become an oracle that parses a request
    // before authorization, and `classifyRoute` is a pure function of the path
    // so nothing about the request's contents reaches it.
    return path({
      kind: "threads-read",
      requiresSession: true,
      scope: toScope(scoped),
      acceptsVerb: READ_VERB,
      writeArm: { verb: "POST", kind: "threads-append", stateChanging: true, requiresComment: true },
    });
  }
  const preview = parsePreviewPath(pathname);
  if (preview !== undefined) {
    // `READ_VERB`, not `ANY_VERB` (#96): a preview serves bytes and nothing else,
    // so a verb that is not a read has no route to reach. `stateChanging` stays
    // false because nothing here writes — the refusals are the verb's, made by
    // `classifyRoute`'s `method-not-allowed` relabel, which keeps this path's
    // scope so a guest is refused `invite-scope-mismatch` before it is told 405.
    return path({ kind: "preview", requiresSession: true, scope: toScope(preview), acceptsVerb: READ_VERB });
  }
  // `unknown` and `revkit-bundle` accept EVERY verb, and both are ungated, so
  // the verb changes nothing: there is no route for the answer to be about.
  // Spelling a verb set here would relabel a wrong verb on a path that is not
  // a route as `method-not-allowed`, which reads as "this route exists and you
  // may not use this verb" — a statement about a route that does not exist.
  return path({ kind: "unknown", requiresSession: false, acceptsVerb: ANY_VERB });
}

function toScope(ref: { repo: string; pr: number; logKey: string }): PreviewScope {
  return { repo: ref.repo, pr: ref.pr, logKey: ref.logKey };
}

/** One path's facts, as an object rather than seven positional flags: this
 * helper had seven of them once `guestScopeExempt` joined, and at that width a
 * mis-ordered `false` is a security defect that typechecks and reads plausibly.
 * Named fields make the mis-ordering impossible and make every arm state what
 * it is.
 *
 * **The DEFAULTS are the fail-closed ones, and that is why the five ungated
 * arms all spell `requiresSession: false` out loud** instead of relying on
 * inheritance from a shared default: `requiresSession: true`,
 * `guestScopeExempt: false`, every other flag off. An arm that forgets a field
 * therefore gets a route that is GATED, NOT EXEMPT, and therefore refuses a
 * guest — the three answers that cannot leak review content. Only
 * `POST /api/session/refresh` may widen itself, and it has to type the word. */
function path(arm: {
  readonly kind: PathRoute["kind"];
  readonly requiresSession?: boolean;
  readonly stateChanging?: boolean;
  readonly requiresComment?: boolean;
  readonly scope?: PreviewScope;
  readonly guestScopeExempt?: boolean;
  readonly acceptsVerb: (verb: string) => boolean;
  readonly writeArm?: NonNullable<PathRoute["writeArm"]>;
}): PathRoute {
  return {
    kind: arm.kind,
    requiresSession: arm.requiresSession ?? true,
    stateChanging: arm.stateChanging ?? false,
    requiresComment: arm.requiresComment ?? false,
    scope: arm.scope,
    guestScopeExempt: arm.guestScopeExempt ?? false,
    acceptsVerb: arm.acceptsVerb,
    writeArm: arm.writeArm,
  };
}

function route(kind: RouteKind, path: PathRoute, unsupportedMethod: boolean): Route {
  return {
    kind,
    requiresSession: path.requiresSession,
    stateChanging: path.stateChanging,
    requiresComment: path.requiresComment,
    scope: path.scope,
    guestScopeExempt: path.guestScopeExempt,
    unsupportedMethod,
  };
}

// ── the decision ──────────────────────────────────────────────────────────

/**
 * Every reason the gate can refuse for, as one closed list. `DenialReason` is
 * DERIVED from it, so the union and the list cannot drift.
 *
 * A closed vocabulary rather than free text, because these strings reach BOTH
 * a response body and a log line, and either one carrying a request's contents
 * would be the leak this repo's ADRs keep naming. The gate chooses the reason
 * and no route builds one, so nothing about the request can reach it.
 *
 * **It is here, with the gate, rather than in `src/logger.ts`.** An earlier
 * revision put it in the logger, on the theory that half its members are
 * credential-shaped names the logger's key pattern would eat. That theory was
 * wrong and the mutation run is what proved it: `SENSITIVE_KEY` is tested
 * against the KEY, and `reason` is not a sensitive key; no member matches a
 * credential VALUE shape either. So the exemption did nothing, and a
 * mechanism with a plausible justification and no measured effect was removed
 * rather than kept with a comment explaining itself. See `src/logger.ts`'s
 * `LOG_MESSAGES` comment for the receipts.
 *
 * `test/authorization.test.ts` pins the list, and asserts that every refusal
 * this surface actually produced carries a member of it — so a reason added
 * to the code without being registered fails there.
 */
export const DENIAL_REASONS = [
  "no-session-cookie",
  "ambiguous-session-cookie",
  "malformed-session-cookie",
  "unknown-session",
  "expired-session",
  "incomplete-session-row",
  "unrecognised-identity-kind",
  "csrf-header-missing",
  "csrf-header-rejected",
  "content-type-not-json",
  // Slice 3: a GUEST session is a necessary condition plus four more, all
  // decided against the invite row as it stands NOW (ADR-0012: "a guest invite
  // is checked for scope, type and expiry on each call").
  //
  // The 401/403 split is the same one the session checks use and means the same
  // thing: a 401 says "I do not know who you are" — which is what a revoked or
  // expired invite means, because the credential is dead — and a 403 says "I
  // know who you are and this request is not permitted", which is what a
  // wrong-scope, read-only or wrong-browser request means.
  "invite-no-grant",
  "incomplete-invite-row",
  "invite-revoked",
  "invite-expired",
  "invite-browser-mismatch",
  "invite-scope-mismatch",
  // Slice 5: a guest reached a route that names NO scope and is not exempt.
  // This is the fail-closed direction, and before slice 5 the condition it
  // refuses was the DEFAULT for the thread read — `events(seq, ts, payload)`
  // named no repo, so `inviteCovers(invite, undefined)` returned true and a
  // guest in scope for one review read the whole org. "No scope" is now a
  // refusal, never a permission.
  "invite-scope-unbounded",
  "invite-read-only",
] as const;

/** Why a request was refused. */
export type DenialReason = (typeof DENIAL_REASONS)[number];

/** The refusal's log event. CSRF failures, shape failures and guest-invite
 * failures are separate events from authorization failures because they have
 * different causes and a different response to one — a burst of `auth.denied`
 * is an attack, a burst of `csrf.rejected` is usually a broken client, and a
 * burst of `invite.denied` is usually a revoked link rather than an
 * authentication failure. */
export function denialLogMessage(reason: DenialReason): LogMessage {
  if (reason === "csrf-header-missing" || reason === "csrf-header-rejected") return "csrf.rejected";
  if (reason.startsWith("invite-")) return "invite.denied";
  return "auth.denied";
}

/**
 * A session the gate has resolved. The brand symbol is NOT exported, so this
 * type cannot be constructed anywhere else in the package: a handler that
 * takes one cannot be reached without passing `authorizeRequest`.
 *
 * `sessionId` is the plaintext cookie value and is the only secret here. It
 * exists because `POST /api/session/refresh` has to name the row it replaces,
 * and it is deliberately NOT on `principal` — a principal is the
 * credential-free view of a session, and the more handlers that can see a
 * credential, the more likely one is logged.
 */
const AUTHORIZED = Symbol("revkit.authorized-session");

export interface AuthorizedSession {
  readonly [AUTHORIZED]: true;
  readonly principal: SessionPrincipal;
  readonly sessionId: string;
}

export type Decision =
  | { readonly ok: true; readonly authorized: AuthorizedSession }
  | {
      readonly ok: false;
      /** 401 for authorization, 403 for a CSRF failure or a refused guest
       * request, 415 for a shape failure. Standard and conventional: 401 says
       * "I do not know who you are", 403 says "I know who you are and this
       * request is not permitted". */
      readonly status: 401 | 403 | 415;
      readonly error: "unauthorized" | "forbidden" | "csrf" | "unsupported-media-type";
      readonly reason: DenialReason;
    };

/** The one construction site. */
function grant(principal: SessionPrincipal, sessionId: string): AuthorizedSession {
  return { [AUTHORIZED]: true, principal, sessionId };
}

/**
 * ADR-0012's per-request gate. Call this for every route whose
 * `classifyRoute(...).requiresSession` is true, and for nothing else.
 *
 * The order of the three checks is the contract, and it is a contract about
 * what an UNAUTHORIZED caller can learn:
 *
 *   session → CSRF → content type
 *
 * Authorization first, unconditionally, before any parameter is parsed or any
 * body is read. So a request with no session and a malformed `?since=` gets
 * 401, not 400: the gate must not become an oracle that says something about
 * the request's shape to a caller who has not proved who they are.
 *
 * CSRF before content type, because the token is the security control and
 * the more actionable diagnostic for a client that has a session and forgot
 * the header.
 */
export async function authorizeRequest(
  request: Request,
  db: D1Database,
  route: Route,
  options: { readonly now?: MsClock } = {},
): Promise<Decision> {
  const cookie = readSessionCookie(request.headers.get("cookie"));
  if (cookie.kind === "ambiguous") {
    return refused(401, "unauthorized", "ambiguous-session-cookie");
  }
  if (cookie.kind === "absent") {
    return refused(401, "unauthorized", "no-session-cookie");
  }
  // No shape pre-check here, and that is a measured decision rather than an
  // oversight. An earlier revision had one, commented as "an input filter, not
  // the control" — but it duplicated `resolveSession`'s own first line, which is
  // the SAME predicate on the SAME value. Replacing this block with nothing
  // scored **0 tests red**, and the cost it claimed to avoid does not exist:
  // `resolveSession` returns `malformed` before it touches the database, so a
  // malformed cookie still costs zero round trips and still produces the
  // identical `malformed-session-cookie` reason. One predicate, one place.
  const resolved = await resolveSession(db, cookie.value, options);
  if (resolved.outcome === "malformed") return refused(401, "unauthorized", "malformed-session-cookie");
  if (resolved.outcome === "unknown") return refused(401, "unauthorized", "unknown-session");
  if (resolved.outcome === "expired") return refused(401, "unauthorized", "expired-session");
  if (resolved.outcome === "incomplete-row") return refused(401, "unauthorized", "incomplete-session-row");
  if (resolved.outcome === "unrecognised-identity-kind") {
    return refused(401, "unauthorized", "unrecognised-identity-kind");
  }

  if (route.stateChanging) {
    const presented = request.headers.get(CSRF_HEADER);
    if (presented === null) return refused(403, "csrf", "csrf-header-missing");
    // Bound to THIS session: `resolved.principal.csrfHash` came from this
    // row, and the presented value is hashed before comparison.
    if (!(await csrfSatisfied(resolved.principal.csrfHash, presented))) {
      return refused(403, "csrf", "csrf-header-rejected");
    }
    if (!isJsonContentType(request.headers.get("content-type"))) {
      return refused(415, "unsupported-media-type", "content-type-not-json");
    }
  }

  // ── A GUEST SESSION IS NOT AUTHORIZED YET ─────────────────────────────
  //
  // Everything above proves "a session this build issued is presenting, and has
  // not expired". For `identity_kind = "invite"` that is a NECESSARY
  // condition and nowhere near sufficient, because the session's authority is
  // not its own — it is its invite's, and the invite moves after the session
  // exists. ADR-0012 names exactly this: "a guest invite is checked for scope,
  // type and expiry on each call".
  //
  // So here, on every request, `loadInviteGrant` reads the invite row as it
  // stands NOW and the gate adds the two checks that need the route's shape:
  // the invite's scope against `route.scope`, and its `can_comment` against
  // `route.requiresComment`. Revocation is therefore immediate — a session
  // already in a cookie jar dies on its next request, with no expiry to wait
  // for — which is the mechanism ADR-0012's slice-2 amendment called "the first
  // mechanism that closes any of" its open items.
  //
  // **The order of the four is a contract about what a caller can learn**, and
  // it runs from "is this the right credential" to "is this the right request":
  //
  //   1. the browser binding — the cheapest question, and the one that decides
  //      whether a stolen cookie is being replayed from somewhere else at all
  //   2. revocation and expiry — the invite's own liveness, which supersedes
  //      everything else and is decided from the row, never from a cache
  //   3. scope — whether this invite covers what this route names
  //   4. comment rights — ADR-0009's `view` is read-only
  //
  // It runs AFTER the CSRF and content-type checks because those are about the
  // REQUEST and this is about the CREDENTIAL, and a request with no session is
  // refused before this is reached at all.
  if (resolved.principal.kind === "invite") {
    const binding = readBrowserCookie(request.headers.get("cookie"));
    const bindingValue = binding.kind === "present" ? binding.value : null;
    const grant = await loadInviteGrant(db, { guestId: resolved.principal.id, binding: bindingValue }, options);
    if (!grant.ok) {
      return refused(...grantDenial(grant.refusal));
    }
    if (!grant.grant.browserMatches) return refused(403, "forbidden", "invite-browser-mismatch");
    // ── Slice 5: FAIL CLOSED on a route that names no scope ──────────────
    //
    // The branch is written so the two halves cannot be confused, and the
    // ordering is the point:
    //
    //   - `scope === undefined && !guestScopeExempt` is a REFUSAL. Not a
    //     permission, not a fall-through, not "the check had nothing to
    //     select on so it passed". Before this slice the check below received
    //     exactly that `undefined` for the read route, `inviteCovers` answered
    //     `true` by definition, and ADR-0012's "a guest invite is checked for
    //     scope … on each call" ran on every request of a stranger's session and
    //     selected nothing. The bug was never a missing check; it was an absent
    //     scope being read as an absent restriction.
    //   - `inviteCovers` takes a REQUIRED target, so within this branch the
    //     scope is not optional at all — the "no target ⇒ allowed" answer is no
    //     longer expressible in this package.
    //
    // **Which routes this refuses.** Exactly one classification is exempt
    // (`POST /api/session/refresh`, `Route.guestScopeExempt`), so with the table
    // as shipped this branch is unreachable over HTTP — and that is the POINT,
    // not a sign it is dead: it is the second half of an invariant the first half
    // pins. `test/authorization.test.ts` asserts the table satisfies it
    // exhaustively (so the branch stays unreachable), and
    // `test/invites.test.ts` drives THIS function with a hand-built `Route`
    // whose scope is absent, so the branch is proven live against a route the
    // table does not contain. A control proven only by the table can be
    // deleted with the table; a control proven by both cannot.
    //    A mutation run recorded this branch as an EQUIVALENT mutant: narrowing it
    //    to `if (route.guestScopeExempt) return …` changed 0 tests over HTTP,
    //    because `classifyRoute` cannot produce a gated, unscoped, non-exempt
    //    route — that is the invariant `test/authorization.test.ts` now pins over
    //    a DERIVED probe product and `authz.ts`'s three-way partition asserts at
    //    compile time. So the branch is unreachable-with-the-table-as-shipped, and
    //    its teeth are proven by driving `authorizeRequest` with a hand-built
    //    `Route` (see `test/invites.test.ts`). Three mechanisms, no assertion
    //    standing in for a check.
    const scope = route.scope;
    if (scope === undefined) {
      if (!route.guestScopeExempt) return refused(403, "forbidden", "invite-scope-unbounded");
    } else if (!inviteCovers(grant.grant.invite, scope)) {
      return refused(403, "forbidden", "invite-scope-mismatch");
    }
    if (route.requiresComment && !grant.grant.invite.canComment) {
      return refused(403, "forbidden", "invite-read-only");
    }
  }

  return { ok: true, authorized: grant(resolved.principal, cookie.value) };
}

/** A guest-invite refusal as a `(status, error, reason)` triple.
 *
 * The map is EXHAUSTIVE over `GrantRefusal`, so a new refusal kind in
 * `src/invites.ts` fails to typecheck here rather than defaulting to a 500 or,
 * worse, to a success. */
type DenialTriple = [401 | 403, "unauthorized" | "forbidden", DenialReason];

function grantDenial(refusal: GrantRefusal): DenialTriple {
  switch (refusal) {
    case "invite-row-unreadable":
      return [401, "unauthorized", "incomplete-invite-row"];
    case "invite-revoked":
      return [401, "unauthorized", "invite-revoked"];
    case "invite-expired":
      return [401, "unauthorized", "invite-expired"];
    case "browser-mismatch":
      return [403, "forbidden", "invite-browser-mismatch"];
    case "no-grant":
      return [401, "unauthorized", "invite-no-grant"];
  }
}

function refused(
  status: 401 | 403 | 415,
  error: "unauthorized" | "forbidden" | "csrf" | "unsupported-media-type",
  reason: DenialReason,
): Decision {
  return { ok: false, status, error, reason };
}

/**
 * `application/json` and nothing else — ADR-0012's "the API accepts only
 * `application/json`".
 *
 * A media-type parameter (`; charset=utf-8`) is accepted, because it changes
 * nothing about how the body parses. `application/ld+json`, `text/json`, a
 * `+json` suffix and a MISSING header are all refused: this check is not a
 * content validation (each route's own schema does that), it is the
 * precondition that says "this body will be read as JSON and nothing else",
 * which is what stops a `text/plain` or form-encoded body being smuggled into
 * a JSON-only API.
 *
 * `+json` is refused on purpose. A structured-suffix type (`application/x-foo
 * +json`) is a DIFFERENT media type with different semantics, and ADR-0012
 * names one type, not a family.
 */
export function isJsonContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const type = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return type === JSON_MEDIA_TYPE;
}

/** The one media type a state-changing API call may declare. */
export const JSON_MEDIA_TYPE = "application/json";
