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
//
// NOT IMPLEMENTED YET, and named so nobody reads the list above as more than
// it is:
//
//   - "a GitHub session must still have read access to the repo (cached ≤ 5
//     min)". There is no `TokenSource` — the App is owner-gated (#34) — and
//     nothing to check repo access against. Slice 4.
//   - "a guest invite is checked for scope … on each call" is implemented for
//     the routes that NAME a repo and PR — today ADR-0008's `<repo>/pr-<n>/`
//     preview paths — and is a no-op for `GET /api/threads`, because
//     `events(seq, ts, payload)` has no `repo` column for a scope check to
//     select on. The preview surface (slice 5) adds the axis. So a guest with
//     a valid invite currently reads the whole log, exactly as an operator
//     does; ADR-0012's 2026-10-04 amendment records that half as landing in
//     slice 5.
//
// So "authorized" in this slice means: **a session this build issued is
// presenting, unexpired; and if it is a guest session, its invite still exists,
// is unrevoked, unexpired, covers what this route names, permits what this
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

import { parsePreviewPath, isRevkitBundlePath } from "./router.ts";
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
export type RouteKind =
  | "health"
  | "method-not-allowed"
  | "threads-read"
  | "threads-append"
  | "session-refresh"
  | "invite-open"
  | "invite-redeem"
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
  /** ADR-0012's "a guest invite is checked for … type on each call": this
   * route WRITES review content, so a `view` invite's `can_comment = 0` must
   * refuse it. Separate from `stateChanging` on purpose — `POST
   * /api/session/refresh` changes state and must work for a read-only guest,
   * because it only touches the guest's own session row. */
  readonly requiresComment: boolean;
  /** The repo and PR this route names, when it names any. A guest session's
   * invite scope is checked against it. Computed HERE, at classification, so
   * the gate still never parses a URL — see `classifyRoute`. */
  readonly scope: PreviewScope | undefined;
  /** The path is real but the verb is not. Answered 405 — AFTER the gate,
   * where `requiresSession` is true, so an unauthorized caller learns
   * "unauthorized", never "that route exists". */
  readonly unsupportedMethod: boolean;
}

/** What an invite's scope is compared against. Structurally identical to
 * `PreviewRef`'s first two fields, and declared separately rather than
 * importing it so `authz.ts` does not depend on the preview grammar's shape. */
export interface PreviewScope {
  readonly repo: string;
  readonly pr: number;
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
 *   3. `/invite/redeem` — exact path, POST only. Before `/invite/…`, because
 *      `redeem` is itself a well-shaped invite token: without this ordering a
 *      `POST /invite/redeem` would be classified as opening a token whose name
 *      is `redeem`, which is one spelling of two meanings.
 *   4. `/invite/<token>` — GET only. **`HEAD` is refused, and that is not
 *      uniformity.** `HEAD` is a read everywhere else in this table, but a
 *      redeem is the one read that CONSUMES: answering it for `HEAD` would let
 *      a link checker, a proxy or a prefetch burn a guest's single redemption
 *      without the guest ever seeing a page. So the invite routes are
 *      GET-or-nothing.
 *   5. `/_revkit/…` — ADR-0012: never a preview, never a redirect.
 *   6. `<repo>/pr-<n>/…` — a preview path. GATED, and it now carries a
 *      `scope`, which is what ADR-0012's per-call scope check selects on.
 *   7. anything else — 404, ungated, because there is nothing to authorize.
 */
export function classifyRoute(pathname: string, method: string): Route {
  const verb = method.toUpperCase();
  if (pathname === HEALTH_PATH) {
    // The probe is ungated either way, but the classification is uniform:
    // a path whose verb is wrong answers `method-not-allowed`, not a special
    // case the dispatcher has to remember.
    if (!READ_METHODS.has(verb)) return route("method-not-allowed", false, false, false, undefined, true);
    return route("health", false, false, false, undefined, false);
  }
  if (pathname === THREADS_PATH) {
    if (READ_METHODS.has(verb)) return route("threads-read", true, false, false, undefined, false);
    // `requiresComment` is what makes ADR-0009's "view is read-only"
    // enforceable while `POST /api/threads` is still a 501: the gate refuses a
    // read-only guest BEFORE the handler, so the 501 is only ever reached by a
    // caller entitled to write. See the HTTP half of `test/invites.test.ts`.
    if (verb === "POST") return route("threads-append", true, true, true, undefined, false);
    return route("method-not-allowed", true, false, false, undefined, true);
  }
  if (pathname === SESSION_REFRESH_PATH) {
    if (verb === "POST") return route("session-refresh", true, true, false, undefined, false);
    return route("method-not-allowed", true, false, false, undefined, true);
  }
  if (pathname === INVITE_REDEEM_PATH) {
    if (verb === "POST") return route("invite-redeem", false, true, false, undefined, false);
    return route("method-not-allowed", false, false, false, undefined, true);
  }
  if (pathname.startsWith(INVITE_OPEN_PREFIX)) {
    if (verb === "GET") return route("invite-open", false, false, false, undefined, false);
    return route("method-not-allowed", false, false, false, undefined, true);
  }
  if (isRevkitBundlePath(pathname)) {
    return route("revkit-bundle", false, false, false, undefined, false);
  }
  const preview = parsePreviewPath(pathname);
  if (preview !== undefined) {
    // The scope travels WITH the classification rather than being re-derived
    // in the gate: the gate must not become an oracle that parses a request
    // before authorization, and `classifyRoute` is a pure function of the path
    // so nothing about the request's contents reaches it.
    return route("preview", true, false, false, { repo: preview.repo, pr: preview.pr }, false);
  }
  return route("unknown", false, false, false, undefined, false);
}

function route(
  kind: RouteKind,
  requiresSession: boolean,
  stateChanging: boolean,
  requiresComment: boolean,
  scope: PreviewScope | undefined,
  unsupportedMethod: boolean,
): Route {
  return { kind, requiresSession, stateChanging, requiresComment, scope, unsupportedMethod };
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
    if (!inviteCovers(grant.grant.invite, route.scope)) return refused(403, "forbidden", "invite-scope-mismatch");
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
