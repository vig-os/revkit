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
// NOT IMPLEMENTED YET, and named so nobody reads the list above as more than
// it is:
//
//   - "a GitHub session must still have read access to the repo (cached ≤ 5
//     min)". There is no `TokenSource` — the App is owner-gated (#34) — and
//     nothing to check repo access against. Slice 4.
//   - "a guest invite is checked for scope, type and expiry on each call".
//     There is no invite to redeem (slice 3), and the store has no repo axis
//     to scope a read by: `events(seq, ts, payload)` has no `repo` column, so
//     there is literally nothing for a scope check to select on. Slice 3 for
//     the invite's own scope/type/expiry, slice 5 for the repo axis.
//
// So "authorized" in this slice means exactly: **a session this build issued
// is presenting, unexpired, for a request that carries no scope check
// because there is no scope to check yet.** That is a necessary condition, and
// calling it sufficient would be the same kind of overclaim slice 1 corrected
// twice. The two missing clauses are recorded in the ADR-0012 amendment dated
// 2026-10-04.
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

import { parsePreviewPath, isRevkitBundlePath } from "./router.ts";
import {
  csrfSatisfied,
  isTokenShaped,
  readSessionCookie,
  resolveSession,
  CSRF_HEADER,
  type MsClock,
  type SessionPrincipal,
} from "./session.ts";
import type { LogMessage } from "./logger.ts";

// ── the routes ────────────────────────────────────────────────────────────

/** `GET /healthz`. Deliberately the ONLY unauthenticated route that answers.
 * It is a liveness probe, it reads no database, and its body is `{ok, the
 * revkit version it runs, the request id}` — no review content, no identity,
 * no count. A probe that needed a session would be a probe nobody runs. */
export const HEALTH_PATH = "/healthz";

/** `GET|HEAD /api/threads` and `?since=`. Closed in slice 1 for want of this
 * gate; open now, behind it. */
export const THREADS_PATH = "/api/threads";

/** `POST /api/session/refresh` — rotate the caller's own session id and CSRF
 * token. The only state-changing route this slice opens, and it exists for
 * that reason: ADR-0012's CSRF and `application/json` rules are only
 * testable end to end if at least one state-changing call is reachable, and
 * `POST /api/threads` stays 501 because its handler is slice 4's. This one
 * writes nothing but the caller's own `sessions` row. */
export const SESSION_REFRESH_PATH = "/api/session/refresh";

/** Every route kind. `method-not-allowed` is its own kind rather than a flag
 * on a real one so the classification table below reads the way the dispatch
 * does, and so a test can enumerate it exhaustively. */
export type RouteKind =
  | "health"
  | "method-not-allowed"
  | "threads-read"
  | "threads-append"
  | "session-refresh"
  | "preview"
  | "revkit-bundle"
  | "unknown";

export interface Route {
  readonly kind: RouteKind;
  /** ADR-0012: this route may only be reached with a valid session. */
  readonly requiresSession: boolean;
  /** ADR-0012: this route changes state, so it also needs the CSRF token and
   * `application/json`. */
  readonly stateChanging: boolean;
  /** The path is real but the verb is not. Answered 405 — AFTER the gate,
   * where `requiresSession` is true, so an unauthorized caller learns
   * "unauthorized", never "that route exists". */
  readonly unsupportedMethod: boolean;
}

/** Methods that read. `HEAD` is `GET` without a body; treating it as a read
 * is the whole point, because a `HEAD` on a gated path that slipped through as
 * a "not really a read" would still run the query. */
const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/**
 * The whole routing decision, as a pure function.
 *
 * Order matters and is load-bearing, so it is stated rather than implied:
 *
 *   1. `/healthz` — exact path, GET/HEAD only.
 *   2. `/api/threads`, `/api/session/refresh` — EXACT paths. No trailing
 *      slash, no case folding, no alias: `/api/threads/` is a different path
 *      and falls through to `unknown`, which is how a closed route does not
 *      come back under a second spelling.
 *   3. `/_revkit/…` — ADR-0012: never a preview, never a redirect. Not gated,
 *      because it is a static bundle path with no data behind it; the 404 it
 *      answers is what slice 3 changes.
 *   4. `<repo>/pr-<n>/…` — a preview path. GATED NOW, though it answers 501
 *      and has nothing to serve, so that slice 5 inherits the gate from the
 *      route table instead of having to remember it. A 501 for an
 *      unauthorized caller and a 501 for an authorized one differ only in
 *      status (401 vs 501), and the stricter answer is the one that survives
 *      the day R2 exists.
 *   5. anything else — 404, ungated, because there is nothing to authorize.
 */
export function classifyRoute(pathname: string, method: string): Route {
  const verb = method.toUpperCase();
  if (pathname === HEALTH_PATH) {
    // The probe is ungated either way, but the classification is uniform:
    // a path whose verb is wrong answers `method-not-allowed`, not a special
    // case the dispatcher has to remember.
    if (!READ_METHODS.has(verb)) return route("method-not-allowed", false, false, true);
    return route("health", false, false, false);
  }
  if (pathname === THREADS_PATH) {
    if (READ_METHODS.has(verb)) return route("threads-read", true, false, false);
    if (verb === "POST") return route("threads-append", true, true, false);
    return route("method-not-allowed", true, false, true);
  }
  if (pathname === SESSION_REFRESH_PATH) {
    if (verb === "POST") return route("session-refresh", true, true, false);
    return route("method-not-allowed", true, false, true);
  }
  if (isRevkitBundlePath(pathname)) {
    return route("revkit-bundle", false, false, false);
  }
  if (parsePreviewPath(pathname) !== undefined) {
    return route("preview", true, false, false);
  }
  return route("unknown", false, false, false);
}

function route(
  kind: RouteKind,
  requiresSession: boolean,
  stateChanging: boolean,
  unsupportedMethod: boolean,
): Route {
  return { kind, requiresSession, stateChanging, unsupportedMethod };
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
] as const;

/** Why a request was refused. */
export type DenialReason = (typeof DENIAL_REASONS)[number];

/** The refusal's log event. CSRF failures and shape failures are separate
 * events from authorization failures because they have different causes and a
 * different response to one — a burst of `auth.denied` is an attack, a burst
 * of `csrf.rejected` is usually a broken client. */
export function denialLogMessage(reason: DenialReason): LogMessage {
  if (reason === "csrf-header-missing" || reason === "csrf-header-rejected") return "csrf.rejected";
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
      /** 401 for authorization, 403 for a CSRF failure, 415 for a shape
       * failure. Standard and conventional: 401 says "I do not know who you
       * are", 403 says "I know who you are and this request is not
       * permitted". */
      readonly status: 401 | 403 | 415;
      readonly error: "unauthorized" | "csrf" | "unsupported-media-type";
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
  if (!isTokenShaped(cookie.value)) {
    // An input filter, not the control. A correctly-shaped forgery reaches
    // the lookup below and is refused there; this branch only skips a
    // database round trip for a cookie that cannot be a minted token.
    return refused(401, "unauthorized", "malformed-session-cookie");
  }

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

  return { ok: true, authorized: grant(resolved.principal, cookie.value) };
}

function refused(
  status: 401 | 403 | 415,
  error: "unauthorized" | "csrf" | "unsupported-media-type",
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
