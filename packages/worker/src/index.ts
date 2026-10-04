// The hosted revkit Worker (ADR-0008; ADR-0025 surface (c)).
//
// One real `fetch` handler over one bound D1 database. The shipped HTTP
// surface is:
//
//   GET|HEAD /healthz               200 — liveness + the version it runs
//   ANY    /healthz (other verbs)   405  (kind `method-not-allowed`, ungated)
//   GET|HEAD /api/threads           200 — behind ADR-0012's per-request gate
//   GET    /api/threads?since=<n>   200 — the delta since the caller's head
//   POST   /api/session/refresh     200 — rotate the caller's own session
//   POST   /api/threads             501 — see below
//   GET    /invite/<token>          200 — the display-name form (slice 3)
//   POST   /invite/redeem           303 — exchange the token for a session
//   ANY    /api/* (other verbs)     405, behind the gate
//   ANY    /_revkit/…               404 — never a redirect (ADR-0012)
//   ANY    <repo>/pr-<n>/…          501 — behind the gate; slice 5 serves it
//   ANY    anything else            404
//
// ── Two ungated readers of `env.DB`, and what that means for the invariant ──
//
// Slice 2's invariant was "the gate is the only path to `env.DB`". Slice 3 adds
// the invite routes, which MUST be ungated — a guest arriving from a mail
// client has no session and ADR-0009 requires the exchange — so the invariant is
// restated precisely rather than dropped:
//
//   - The gate is still the only path to the THREAD STORE and to `sessions`
//     for authorized requests. `D1ThreadStore` is constructed only inside the
//     handlers `handleAuthorized` can reach, and `handleAuthorized` is the only
//     thing that accepts an `AuthorizedSession` — a type whose brand symbol is
//     module-private to `authz.ts`.
//   - The invite handlers are the second reader, and they touch only `invites`,
//     `invite_redemptions`, `guests` and `rate_limit_counters`. They never
//     construct a `D1ThreadStore`, and `test/invite-http.test.ts` drives
//     `GET /api/threads` without a session to show it still answers 401.
//
// The controls that stand in for the gate on those two routes, and why each is
// the right one for a route that issues a credential to a caller who has none:
//
//   - the invite TOKEN is the credential (256 bits, hashed at rest), so there
//     is no session to check — and ADR-0012's CSRF rule protects an existing
//     session's authority, which a redemption does not touch
//   - single use per browser (`invites.max_browsers`, enforced inside one D1
//     batch) is what makes a replay impossible
//   - `src/rate-limit.ts` bounds attempts per invite and per address, which is
//     ADR-0012's abuse-limit clause
//   - `classifyRoute` refuses `HEAD` on both, so a link checker cannot consume
//     a redemption
//
// A `POST /api/session` would still be the thing not to build: it hands a
// credential to whoever asks with no token to present.
//
// ── ADR-0012's per-request authorization gate ─────────────────────────────
//
// Every route except `/healthz`, the two invite routes, the bundle path and the
// 404s passes through `authorizeRequest` (`src/authz.ts`), which resolves the
// session cookie BY DIGEST against D1 and refuses when the row is missing,
// expired, or carries an identity kind this build does not recognise. On a
// state-changing verb it additionally requires the per-session CSRF token in
// `x-revkit-csrf` and `application/json`. Slice 1 closed `GET /api/threads`
// with a 501 precisely because none of that existed.
//
// **For a GUEST session the gate does not stop there.** ADR-0012: "a guest
// invite is checked for scope, type and expiry on each call", so
// `authorizeRequest` re-reads the invite on every request and adds the route's
// scope and the invite's `can_comment`. That is what makes revocation
// immediate: a session already in a cookie jar dies on its next request.
//
// **What "authorized" means here, stated narrowly so it is not read as more
// than it is:** a session this build issued is presenting and unexpired; and if
// it is a guest, its invite is unrevoked, unexpired, in scope, permitted to do
// what the route writes, and bound to this browser. It does NOT yet mean "has
// GitHub read access to the repo" — there is no `TokenSource` (the App is
// owner-gated, #34) — and it does not scope `GET /api/threads`, because
// `events(seq, ts, payload)` has no `repo` column to scope by (slice 5). Both
// halves are in ADR-0012's 2026-10-04 amendment.
//
// ── Where a session comes from ─────────────────────────────────────────────
//
// Two callers, and only two. `issueSession` (`src/session.ts`) is invoked out
// of band by whoever holds write access to D1 — in production `revkit deploy
// init` (slice 8) — and mints the `operator` identity kind. `redeemInvite`
// (`src/invites.ts`) is the legitimate caller ADR-0009 asks for, and it goes
// through the SAME `mintSession` + `sessionInsertStatement` internals, so there
// is one issuance path rather than two. MINTING an invite is reachable by
// nobody over HTTP: ADR-0009's only stated consequence is "invite minting
// requires write access", so `mintInvite` is out of band too, like the
// operator session.
//
// ── `POST /api/threads` is still 501, on purpose ──────────────────────────
//
// ADR-0012's CSRF and `application/json` rules are only meaningful if a
// state-changing call is reachable, and `POST /api/session/refresh` is the
// smallest route that gives them a real end-to-end path. `POST /api/threads`
// needs the bridge and the hosted write shape (slice 4), so it stays 501 — and
// a `view` guest's attempt at it is refused by the GATE, not by the 501, which
// is how ADR-0009's read-only rule is proven while the write does not exist.

import {
  authorizeRequest,
  classifyRoute,
  denialLogMessage,
  INVITE_OPEN_PREFIX,
  INVITE_REDEEM_PATH,
  type AuthorizedSession,
  type Route,
} from "./authz.ts";
import { D1ThreadStore } from "./d1-store.ts";
import {
  applyAuthHeaders,
  applyHtmlHeaders,
  applyJsonHeaders,
  applyTextHeaders,
  REQUEST_ID_HEADER,
  requestOrigin,
  workerHeaderContext,
  type HeaderContext,
} from "./headers.ts";
import { inviteClosedPage, rateLimitedPage, redeemFormPage, REDEEM_PATH } from "./invite-page.ts";
import {
  MAX_DISPLAY_NAME_CHARS,
  browserCookieHeader,
  loadInviteByToken,
  readBrowserCookie,
  redeemInvite,
} from "./invites.ts";
import { createLogger, newRequestId, type Logger } from "./logger.ts";
import { parseThreadsQuery } from "./router.ts";
import { clientAddress, redeemBuckets, spendAttempts } from "./rate-limit.ts";
import { SessionAlreadyRotatedError, mintToken, rotateSession, sha256Hex, CSRF_HEADER } from "./session.ts";

// NOTE: this module exports its DEFAULT ONLY. A Worker entry may export
// nothing but handlers — miniflare refuses a runtime with
// "Incorrect type for map entry 'X': the provided value is not of type
// 'function or ExportedHandler'", and so does `wrangler deploy`. That is
// why `REQUEST_ID_HEADER` lives in `headers.ts` rather than here. The
// COMMITTED, reviewed inline-script hash allowlist the running revkit
// version ships (ADR-0012's "the Worker applies the allowlist of the revkit
// version it runs, never hashes found in an artifact"). It lives in the CLI
// package because that is where the release artefact is built and where
// `check-dist` enforces it, and this import crosses the package line on
// purpose: a second copy would be a second `script-src` policy, which is the
// failure ADR-0025 exists to prevent. Nothing the SERVED content carries is
// ever consulted — `test/headers.test.ts` plants a hostile `sha256-…` in a
// fake artefact and asserts it never reaches the header.
import ALLOWLIST_JSON from "../../cli/src/dist-check-allowlist.json" with { type: "json" };

/** The bindings this Worker needs. `DB` is the D1 database named in
 *  `wrangler.jsonc`; `REVKIT_VERSION` is a plain (non-secret) var the
 *  release train pins, asserted against `packages/cli/package.json` by
 *  `test/worker-config.test.ts` so the two cannot drift (ADR-0021). */
export interface Env {
  readonly DB: D1Database;
  readonly REVKIT_VERSION: string;
}

/** The allowlist's digests, de-duplicated and sorted — the same
 * derivation `revkit serve` uses (`daemon.ts`'s `cspHashes`). */
const INLINE_SCRIPT_HASHES: readonly string[] = Object.freeze(
  Array.from(new Set(Object.keys((ALLOWLIST_JSON as { sha256: Record<string, unknown> }).sha256))).sort(),
);

/** Per-request context: the id, the logger that stamps it, and the header
 * context every response this request produces carries. */
interface RequestScope {
  readonly requestId: string;
  readonly logger: Logger;
  readonly headers: ReturnType<typeof workerHeaderContext>;
}

/** Header context for a response whose REAL context could not be built.
 *
 * `applyResponseHeaders` attaches only the hygiene quartet and
 * `Permissions-Policy` to a `text` response — it reads no script path, no
 * origin and no hash — so every field here is deliberately empty and none of
 * it is consulted. It exists because building the real context is itself a
 * fallible operation: `workerHeaderContext` throws on a missing
 * `REVKIT_VERSION`, and before this existed that throw happened OUTSIDE the
 * handler's `try`, so a misconfigured deploy answered with workerd's default
 * error page — a stack trace and an absolute store path in the response body
 * (measured). Now that failure is inside the boundary and gets the generic
 * body plus full hygiene.
 */
const ERROR_HEADER_CONTEXT: HeaderContext = {
  scriptOrigins: [],
  scriptPaths: [],
  workerPaths: [],
  connectOrigins: [],
  inlineScriptHashes: [],
};

/** A logger for a request whose scope could not be built. Same shape, no
 * header context. */
function fallbackLogger(requestId: string): Logger {
  return createLogger({
    sink: (line) => console.log(line), // guardrails-ok: see beginRequest
    clock: () => new Date().toISOString(),
    requestId,
  });
}

function beginRequest(request: Request, env: Env): RequestScope {
  const requestId = newRequestId();
  const logger = createLogger({
    // Workers Logs IS `console.log` — ADR-0020 names `wrangler tail` as the
    // local viewer, so there is no tracing facade to route through here and
    // the structured line is the product. guardrails-ok: logging facade
    sink: (line) => console.log(line), // guardrails-ok
    clock: () => new Date().toISOString(),
    requestId,
  }).withRequestId(requestId);
  return {
    requestId,
    logger,
    headers: workerHeaderContext({
      origin: requestOrigin(request),
      version: env.REVKIT_VERSION,
      inlineScriptHashes: INLINE_SCRIPT_HASHES,
    }),
  };
}

/** Stamp a request id on every response, whatever produced it. Accepts an
 * explicit id as well as a scope, because the error path may have no scope. */
function tag(response: Response, requestId: string): Response {
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

/** A JSON response with ADR-0012 hygiene headers and the request id.
 * Built explicitly rather than via `Response.json(body, init)`: bun's and
 * `@cloudflare/workers-types`' declarations of that static disagree on its
 * arity, and a serialise-then-set sequence has no such disagreement.
 *
 * `extra` carries the headers a route must set itself — `POST
 * /api/session/refresh`'s `Set-Cookie` and its fresh CSRF token, and the
 * redemption's TWO cookies. They are per-response credentials, so they cannot
 * live in the shared policy. They go through here rather than being set on the
 * returned object so that every JSON response provably passes
 * `applyJsonHeaders` (and therefore gets `Cache-Control: no-store`, which a
 * `Set-Cookie` response must carry).
 */
function json(body: unknown, status: number, scope: RequestScope, extra?: Readonly<Record<string, string | readonly string[]>>): Response {
  return withExtra(applyJsonHeaders(new Response(`${JSON.stringify(body)}\n`, { status }), scope.headers), scope, extra);
}

/**
 * An HTML response with ADR-0012's full CSP and the request id.
 *
 * `Cache-Control: no-store` is set here and not by the shared policy, because
 * the shared policy sets it only for `json` and `auth` kinds and this page is
 * an `html` one. It has to be: the invite form carries the invite TOKEN in a
 * hidden field, and an HTML page that a shared cache is allowed to store is a
 * token in a disk cache. This is an ADDITION to the policy on one route, not a
 * second implementation of it — every other header still comes from
 * `applyHtmlHeaders`, and a test asserts the page carries the full directive
 * set (`default-src 'none'`, `form-action 'self'`, `frame-ancestors 'none'`)
 * as well as the no-store.
 */
function html(body: string, status: number, scope: RequestScope, extra?: Readonly<Record<string, string | readonly string[]>>): Response {
  const response = new Response(body, { status });
  response.headers.set("cache-control", "no-store");
  return withExtra(applyHtmlHeaders(response, scope.headers), scope, extra);
}

/**
 * The credential-bearing `303` the redemption answers.
 *
 * `Location` is a TOKEN-FREE path — the preview path the invite's scope names,
 * built by `previewPath`, never the URL the token arrived on. That is the
 * "stripped from the URL" half of ADR-0009 that is available without
 * JavaScript; `src/invites.ts`'s header has the rest of the argument, including
 * why `history.replaceState` is slice 5's and not this slice's.
 *
 * `kind: "auth"` gives it `Cache-Control: no-store`, which ADR-0012's
 * amendment names for exactly this kind of answer.
 */
function seeOther(
  location: string,
  scope: RequestScope,
  setCookies: readonly string[],
  extra: Readonly<Record<string, string | readonly string[]>> = {},
): Response {
  const response = new Response(null, { status: 303, headers: { location } });
  return withExtra(applyAuthHeaders(response, scope.headers), scope, { ...extra, "set-cookie": setCookies });
}

/** Attach the request id and any per-route headers, appending repeated names
 * rather than overwriting — `Set-Cookie` appears TWICE on the redemption's
 * response (the session and the browser binding) and `Headers.set` would keep
 * only the last, silently dropping the session cookie and leaving a guest with
 * a browser binding and no session. */
function withExtra(
  response: Response,
  scope: RequestScope,
  extra?: Readonly<Record<string, string | readonly string[]>>,
): Response {
  for (const [name, value] of Object.entries(extra ?? {})) {
    for (const one of typeof value === "string" ? [value] : value) response.headers.append(name, one);
  }
  return tag(response, scope.requestId);
}

/** `request.url`'s pathname, or `"?"` if it cannot be derived. Total, and
 * never throws — it exists so the log line in a failure path is safe. */
function safePath(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "?";
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // A path for logging, computed without throwing, so the catch and
    // finally blocks can name the request even if `new URL` were the thing
    // that failed.
    const path = safePath(request);
    const method = request.method.toUpperCase();
    let scope: RequestScope | undefined;
    let status = 500;
    try {
      // INSIDE the boundary. `beginRequest` builds the header context and
      // throws on a missing `REVKIT_VERSION`; that used to happen before
      // this `try`, so the catch never ran and workerd returned its own
      // error page — a stack trace and a store path in the response body.
      // `test/worker-runtime.test.ts` now drives exactly that deploy.
      scope = beginRequest(request, env);
      const url = new URL(request.url);
      const route = classifyRoute(path, method);
      scope.logger.log("info", "request.start", { method, path });

      // ── THE GATE ──────────────────────────────────────────────────────
      // Everything except `/healthz`, the bundle path and the 404 runs
      // through here, and nothing below reads `env.DB` without it. There is
      // no other path to the database in this module: `D1ThreadStore` is
      // constructed only inside the two handlers `handleAuthorized` can
      // reach, and `handleAuthorized` is the only thing that accepts an
      // `AuthorizedSession` — a type whose brand symbol is module-private
      // to `authz.ts`.
      if (!route.requiresSession) {
        const response = await handleOpen(route, request, env, scope);
        status = response.status;
        return response;
      }

      const decision = await authorizeRequest(request, env.DB, route);
      if (!decision.ok) {
        // Logged BEFORE the response is built, and with the reason drawn
        // from `authz.ts`'s closed vocabulary — never from the request, so
        // no refusal reason can carry request content into a log line. The
        // session id and the CSRF token are absent from this call by
        // construction; `reason` is the only field it passes.
        scope.logger.log("info", denialLogMessage(decision.reason), {
          method,
          path,
          reason: decision.reason,
        });
        const response = json({ error: decision.error, reason: decision.reason }, decision.status, scope);
        status = response.status;
        return response;
      }

      const response = await handleAuthorized(route, decision.authorized, request, env, scope, url);
      status = response.status;
      return response;
    } catch (error) {
      // The request id is in the log line AND in the response, so a
      // reviewer can quote it (ADR-0020). The message stays generic: an
      // error string can carry a SQL fragment, a stack or an absolute store
      // path, and this response is readable by whoever reached the Worker.
      const requestId = scope?.requestId ?? newRequestId();
      (scope?.logger ?? fallbackLogger(requestId)).log("error", "request.error", {
        error: error instanceof Error ? error.name : typeof error,
        path,
      });
      status = 500;
      return tag(
        applyTextHeaders(new Response("internal error\n", { status: 500 }), scope?.headers ?? ERROR_HEADER_CONTEXT),
        requestId,
      );
    } finally {
      // `status` is assigned before every `return`, so this line is the real
      // outcome of the request rather than a guess — which is what makes a
      // spike of 401s visible in Workers Logs without a second mechanism.
      scope?.logger.log("info", "request.end", { path, status });
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * The ungated routes, and they are ungated because none of them can return
 * review data or a session by any means other than a valid invite token:
 * `/healthz` is a liveness probe that reads no database, `/_revkit/` is
 * ADR-0012's never-redirecting bundle path, `unknown` is not a route at all,
 * `method-not-allowed` carries no data either, and the two invite routes are
 * gated by the invite TOKEN instead of by a session.
 *
 * `test/authorization.test.ts` asserts that the GATED paths are exactly those
 * that can carry review data, so "these kinds are the exception" is a claim
 * about the route table rather than about this function — and it is what turns
 * a missing `case` here into a caught 500 rather than a quiet gap.
 *
 * `request` is a parameter now because the invite routes read the request's
 * OWN cookies and headers — the browser binding and the client address — and
 * nothing else on this path does.
 */
async function handleOpen(route: Route, request: Request, env: Env, scope: RequestScope): Promise<Response> {
  switch (route.kind) {
    case "health":
      // A `HEAD` probe takes this same branch and the platform drops the body
      // afterwards. `classifyRoute` already answered the verb question — a
      // wrong verb is its own kind now — so there is no method check here to
      // forget, which is the point of the case below.
      return json({ ok: true, revkitVersion: env.REVKIT_VERSION, requestId: scope.requestId }, 200, scope);
    // `method-not-allowed` appears on BOTH sides of the gate: gated for the API
    // paths, ungated for `/healthz` and for the invite routes. It is therefore
    // the one kind a dispatcher written per-side can handle on one side and DROP
    // on the other — and it was dropped here, so `POST /healthz` fell through
    // to `unreachable()`, threw into the error boundary, and answered **500
    // `internal error`** with no `Cache-Control` and a `request.error` log line.
    // Base `7a7bb652` answered 405. Measured before the fix: GET/HEAD 200, and
    // POST / PUT / DELETE / OPTIONS / PATCH all 500. `test/authorization.test.ts`
    // now drives every one — and slice 3 adds `HEAD /invite/<token>`, which
    // must be 405 and must NOT consume the redemption.
    case "method-not-allowed":
      return json({ error: "method-not-allowed" }, 405, scope);
    case "revkit-bundle":
      return json({ error: "not-found", note: "revkit bundle serving lands in M4 slice 3" }, 404, scope);
    case "invite-open":
      return openInvite(request, env, scope);
    case "invite-redeem":
      return redeemFromRequest(request, env, scope);
    case "unknown":
      return json({ error: "not-found" }, 404, scope);
    default:
      return unreachable(route);
  }
}

// ── the invite surface (slice 3) ──────────────────────────────────────────

/** The token out of `/invite/<token>`, or `undefined`. `classifyRoute` has
 * already established the prefix; this refuses an empty or over-long segment
 * without consulting the database, and returns `undefined` rather than a
 * refusal reason because the CALLER turns both "not a token" and "not an
 * invite" into the same closed page. */
function inviteTokenFrom(pathname: string): string | undefined {
  const token = pathname.slice(INVITE_OPEN_PREFIX.length);
  return token.length === 0 || token.length > 256 ? undefined : token;
}

/**
 * `GET /invite/<token>` — the display-name form.
 *
 * Three things happen here, in this order, and the order is the security
 * shape:
 *
 *   1. **Rate limit, before any database read of the invite.** The token's
 *      digest and the client address are enough to build the buckets without a
 *      lookup, so an unmetered oracle for "is this token live?" does not exist.
 *      ADR-0012's abuse-limit clause is a limit on redemption ATTEMPTS, and an
 *      attempt includes this one.
 *   2. **Look the invite up.** If it is missing, revoked, expired or full, the
 *      response is the SAME closed page — one page for every dead-link reason,
 *      which `src/invite-page.ts` explains.
 *   3. **Mint the browser-binding cookie** and render the form. The binding is
 *      minted HERE, on the open, which is what makes ADR-0009's "bound to the
 *      first browser that opens it" literally true: the browser that opened the
 *      link is the browser that holds the binding before anyone can redeem it.
 *      It is a fresh value every time, so a browser that opens a link, closes
 *      it, and re-opens it in a second tab presents the same binding and the
 *      redemption still works — while a DIFFERENT browser mints a different one
 *      and is refused by `max_browsers`.
 *
 * **This route does not consume the redemption.** That is what makes the
 * `HEAD` refusal in `classifyRoute` a matter of correctness rather than
 * politeness for the *open* — and note the asymmetry it creates: `HEAD` on
 * `/invite/<token>` is refused rather than served, because a `HEAD` on the
 * redeem route would consume. `GET` here is safe to repeat for the same reason.
 */
async function openInvite(request: Request, env: Env, scope: RequestScope): Promise<Response> {
  const pathname = safePath(request);
  const token = inviteTokenFrom(pathname);
  if (token === undefined) return html(inviteClosedPage(), 404, scope);
  const limited = await spendAttempts(env.DB, redeemBuckets({ tokenDigest: await sha256Hex(token), address: clientAddress(request.headers) }));
  if (!limited.ok) {
    scope.logger.log("info", "rate.limit.hit", { bucketKind: limited.kind, route: "invite-open" });
    return rateLimited(env, limited.retryAfterSeconds, scope);
  }
  const invite = await loadInviteByToken(env.DB, token);
  const now = Date.now();
  if (invite === undefined || invite.revokedAt !== null || Date.parse(invite.expiresAt) <= now) {
    scope.logger.log("info", "invite.denied", { stage: "open", reason: invite === undefined ? "unknown-token" : "not-live" });
    return html(inviteClosedPage(), 410, scope);
  }
  const binding = mintToken();
  scope.logger.log("info", "invite.opened", { inviteKind: invite.kind, canComment: invite.canComment });
  return html(redeemFormPage({ token, repo: invite.repo, pr: invite.pr, kind: invite.kind, canComment: invite.canComment }), 200, scope, {
    // The SHARED builder, with the invite's remaining lifetime as the `Max-Age`.
    // This route had its own copy of these five attributes and the mutation run
    // is what caught it: dropping `SameSite=Lax` from the copy changed **zero**
    // tests, because no assertion covered the cookie this route sets — while the
    // redemption's identical cookie, built by `browserCookieHeader`, was
    // asserted. Two builders, one covered: the classic way for a security
    // attribute to rot in the copy nobody looks at.
    "set-cookie": browserCookieHeader(binding, (Date.parse(invite.expiresAt) - now) / 1000),
  });
}

/**
 * `POST /invite/redeem` — exchange the token for a session.
 *
 * **The order is the whole design.** Rate limit first (an attempt is an attempt
 * whether or not the body parses), then the body, then the browser-binding
 * cookie, then the redemption. The redemption itself decides scope, type,
 * expiry, revocation and slot availability inside one D1 batch — see
 * `redeemInvite`, whose header has the atomicity argument.
 *
 * On success the response is a `303` to a TOKEN-FREE path, carrying TWO
 * `Set-Cookie` headers: the session and the browser binding. Both are
 * `__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`.
 *
 * The body is `application/json` only, because ADR-0012 says the API accepts
 * only `application/json` and a redemption is an API call — but there is NO
 * CSRF header here, and that is deliberate rather than an omission: a CSRF
 * token binds a state change to an EXISTING session, and the caller here has
 * none. The controls that fit this shape are the token itself (256 bits,
 * single use per browser) and the rate limit, and pretending a CSRF check would
 * apply would be a control that cannot fail.
 *
 * A refusal returns the closed page rather than JSON, because the caller is a
 * browser following a mail link, not a client of an API. The 429 is JSON
 * because a client that is being rate limited may be a script.
 */
async function redeemFromRequest(request: Request, env: Env, scope: RequestScope): Promise<Response> {
  if (!isRedeemContentType(request.headers.get("content-type"))) {
    return json({ error: "unsupported-media-type", reason: "content-type-not-json" }, 415, scope);
  }
  const body = await readRedeemBody(request);
  if (body === undefined) return json({ error: "bad-request", reason: "unparsable-body" }, 400, scope);
  const limited = await spendAttempts(env.DB, redeemBuckets({ tokenDigest: await sha256Hex(body.token), address: clientAddress(request.headers) }));
  if (!limited.ok) {
    scope.logger.log("info", "rate.limit.hit", { bucketKind: limited.kind, route: "invite-redeem" });
    return rateLimited(env, limited.retryAfterSeconds, scope);
  }
  const cookie = readBrowserCookie(request.headers.get("cookie"));
  if (cookie.kind !== "present") {
    scope.logger.log("info", "invite.denied", { stage: "redeem", reason: "browser-binding-missing" });
    return html(inviteClosedPage(), 410, scope);
  }
  const result = await redeemInvite(env.DB, {
    token: body.token,
    binding: cookie.value,
    displayName: body.displayName,
  });
  if (!result.ok) {
    scope.logger.log("info", "invite.redeem.denied", { reason: result.refusal });
    return html(inviteClosedPage(), 410, scope);
  }
  scope.logger.log("info", "invite.redeem.ok", { inviteKind: result.invite.kind, canComment: result.invite.canComment });
  // The CSRF token rides on the `303` as a response header, exactly as
  // `POST /api/session/refresh` returns it, because a guest's first
  // state-changing call needs one and ADR-0012 requires it per session. **How a
  // browser PAGE reads it is not answered here**: a navigation cannot see a
  // response header, and the two candidates are slice 5's to choose between —
  // a meta tag in the preview document (whose hash then joins the committed
  // allowlist) or a second, non-HttpOnly cookie. Shipping neither here is the
  // honest position, because `POST /api/threads` is a 501 and no guest page
  // exists to need one yet; what ships is that the token EXISTS and is bound
  // to the session, so slice 5 inherits a minted one.
  return seeOther(previewPath(result.invite.repo, result.invite.pr), scope, [result.issued.cookie, result.browserCookie], {
    [CSRF_HEADER]: result.issued.csrfToken,
  });
}

/** The token-free path the redemption redirects to. `/` when the invite covers
 * a whole repo and there is no PR to name — a repo-scoped invite's holder has
 * no single review to land on, and sending them to a PR the invite never named
 * would be a scope leak in the redirect. */
function previewPath(repo: string, pr: number | null): string {
  return pr === null ? "/" : `/${repo}/pr-${pr}/`;
}

/** A 429 in whichever shape the caller can use: HTML for the navigation the
 * invite routes are reached by, and it always carries `Retry-After` because a
 * 429 without one tells a client nothing except that it should guess. */
function rateLimited(env: Env, retryAfterSeconds: number, scope: RequestScope): Response {
  void env;
  return html(rateLimitedPage(retryAfterSeconds), 429, scope, { "retry-after": String(Math.max(1, retryAfterSeconds)) });
}

/** `application/json` and nothing else, for the redeem body. The same predicate
 * the gate applies to every other state-changing call
 * (`isJsonContentType`), duplicated as a local name only so this route reads
 * without a jump — it IS the same rule and `test/invite-http.test.ts` asserts
 * the same refusals on both paths. */
function isRedeemContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const type = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return type === "application/json";
}

/** The redemption body, or `undefined` when it cannot be read as one.
 *
 * Total: a missing body, a malformed JSON document, a non-object, a missing
 * field, a field of the wrong type and an over-long name all resolve to
 * `undefined`, and the caller answers one 400 with a fixed reason. Nothing from
 * the body reaches a response, a log line or a page — the closed reasons are
 * literals.
 *
 * The token is shape-checked HERE, before it is used as a rate-limit key and
 * before it reaches `redeemInvite`. That is an input filter, not the control:
 * a well-shaped forgery is refused by finding no row.
 */
async function readRedeemBody(request: Request): Promise<{ token: string; displayName: string } | undefined> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const { token, displayName } = record;
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return undefined;
  if (typeof displayName !== "string" || displayName.length > MAX_DISPLAY_NAME_CHARS * 8) return undefined;
  return { token, displayName };
}

/** The same anchored, exact-length shape `src/session.ts` checks a minted
 * token against. Re-declared here because `src/index.ts` may export nothing but
 * handlers (miniflare refuses a runtime with an extra export), so the constant
 * is spelled out rather than imported for the test to compare against. A test
 * asserts the two agree, so the copy cannot drift. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Every route that requires a session, reached only with a
 * `decision.authorized` in hand. `authorized` is not used here except to log
 * the identity kind — and it is not LOGGED AS AN ID: `identity_kind` is a
 * closed vocabulary of provider names (`operator`, `invite`), never an
 * identity, so this line cannot carry personal data (ADR-0020, ADR-0015). The
 * session id the request carried is not passed to `scope.logger` at all, and
 * `SENSITIVE_KEY` in `src/logger.ts` would replace it if a future call site
 * tried.
 */
async function handleAuthorized(
  route: Route,
  authorized: AuthorizedSession,
  request: Request,
  env: Env,
  scope: RequestScope,
  url: URL,
): Promise<Response> {
  scope.logger.log("info", "auth.granted", { identityKind: authorized.principal.kind });
  switch (route.kind) {
    case "threads-read":
      return readThreads(authorized, env, scope, url);
    case "threads-append":
      return appendDisabled(scope);
    case "session-refresh":
      return refreshSession(authorized, env, scope);
    case "preview":
      return json({ error: "not-implemented", enabledIn: "M4 slice 5 (R2 preview serving)" }, 501, scope);
    case "method-not-allowed":
      return json({ error: "method-not-allowed" }, 405, scope);
    default:
      return unreachable(route);
  }
}

/**
 * `GET /api/threads` — the read slice 1 closed, now behind the gate.
 *
 *   no `since`     -> { head, threads }   the whole projection, via
 *                      `D1ThreadStore.threads()` (review-core's `reduce` +
 *                      `selectThreads`, not a local reimplementation)
 *   `?since=<n>`   -> { head, events }    exactly the events with `seq > n`,
 *                      via `since(n)`, which is the resume point the hosted
 *                      rail needs (ADR-0006: consumers use `since(lastSeen)`
 *                      and never assume `seq` is contiguous)
 *
 * `head` is `MAX(seq)` read from D1, not this store's validated watermark:
 * the store is built per request, so its own `#head` starts at 0 and would
 * hand a client a resume point that silently skips the log.
 *
 * `request` is not a parameter: nothing about the request reaches this
 * handler except the query already parsed by the caller. That is deliberate —
 * it is not possible to read this comment's data path without a cookie that
 * the gate resolved.
 */
async function readThreads(
  authorized: AuthorizedSession,
  env: Env,
  scope: RequestScope,
  url: URL,
): Promise<Response> {
  // The parameter is what makes the gate structural rather than a
  // convention: `AuthorizedSession`'s brand symbol is private to
  // `src/authz.ts`, so `tsc` refuses this call from anywhere the gate does
  // not run first. Nothing in the body needs it.
  void authorized;
  const query = parseThreadsQuery(url.search);
  if (query.kind === "invalid") {
    return json({ error: "bad-request", reason: query.reason, parameter: query.parameter }, 400, scope);
  }
  const store = new D1ThreadStore({ db: env.DB });
  if (query.kind === "delta") {
    return json({ head: await store.head(), events: await store.since(query.since) }, 200, scope);
  }
  return json({ head: await store.head(), threads: await store.threads() }, 200, scope);
}

/**
 * `POST /api/session/refresh` — rotate the caller's own session.
 *
 * The only state-changing route this slice opens, and it exists so ADR-0012's
 * CSRF token and `application/json` rules have a reachable path to be proven
 * on. By the time this runs the gate has already verified: a valid unexpired
 * session (so `authorized.sessionId` names a real row), the per-session CSRF
 * token, and the media type. This body therefore does none of those checks,
 * which is the point — the checks are not "in" the handler, they are in front
 * of every handler.
 *
 * The response carries the new cookie and the new CSRF token, and nothing
 * else: `identityKind`, `expiresAt` and `createdAt` are not secrets. It is a
 * `json` response, so it also carries `Cache-Control: no-store`, which a
 * response with a `Set-Cookie` must have.
 */
async function refreshSession(authorized: AuthorizedSession, env: Env, scope: RequestScope): Promise<Response> {
  try {
    const issued = await rotateSession(env.DB, authorized);
    scope.logger.log("info", "api.session.refresh.ok", { identityKind: issued.identity.kind });
    return json(
      { identityKind: issued.identity.kind, createdAt: issued.createdAt, expiresAt: issued.expiresAt },
      200,
      scope,
      { "set-cookie": issued.cookie, [CSRF_HEADER]: issued.csrfToken },
    );
  } catch (error) {
    // A concurrent refresh already replaced this session. 409 with "start
    // again" is the honest answer: the caller is known and its credential is
    // dead, which is neither 401 (we do know who you are) nor 500 (nothing
    // broke). Mapped here rather than by a generic catch so a future typed
    // error cannot silently become a 500.
    if (error instanceof SessionAlreadyRotatedError) {
      return json({ error: "session-rotated", reason: "already-refreshed" }, 409, scope);
    }
    throw error;
  }
}

/**
 * `POST /api/threads` — still 501, and now for a narrower and stated reason.
 *
 * It has passed the gate (a valid session, a valid CSRF token, JSON) and is
 * refused because the WRITE does not exist yet: the hosted bridge and the
 * hosted write shape are slice 4, and ADR-0012's authorization is only half
 * of what a hosted comment needs. `GET` is open; this is not an oversight
 * inherited from slice 1, it is the one route whose handler was not in this
 * slice's scope.
 */
function appendDisabled(scope: RequestScope): Response {
  scope.logger.log("info", "api.threads.append.disabled", {});
  return json(
    {
      error: "not-implemented",
      enabledIn: "M4 slice 4 (hosted GitHub bridge: the hosted write path)",
      detail: "Session authorization and the per-session CSRF token are enforced on this call and both passed; the append itself ships in slice 4.",
    },
    501,
    scope,
  );
}

/**
 * A route kind this dispatcher does not handle. Unreachable by construction:
 * `classifyRoute`'s eight kinds partition across `handleOpen` and
 * `handleAuthorized` on `requiresSession`, and between them they switch over
 * all of them.
 *
 * **This doc used to claim unreachability for the GATED dispatcher only, and
 * that was false** — which is how a dropped `case` became a 500 nobody noticed.
 * `method-not-allowed` is reachable from the UNGATED side (`/healthz` with a
 * wrong verb classifies to it with `requiresSession: false`), and `handleOpen`
 * had no case for it, so `POST /healthz` answered 500 `internal error` where
 * base `7a7bb652` answered 405.
 *
 * Two tests keep it honest now, and both are stronger than this comment: the
 * route-table case in `test/authorization.test.ts` asserts the gated paths are
 * exactly the three that carry data AND that every kind `handleAuthorized`
 * switches over is one `requiresSession` can be true for; and the hygiene matrix
 * drives a wrong verb on `/healthz` through real workerd, which fails if the
 * case is ever dropped again.
 *
 * It throws rather than returning something plausible: the error boundary turns
 * it into a 500 with full ADR-0012 hygiene, which is the right outcome for "the
 * router and the dispatcher disagree".
 */
function unreachable(route: Route): never {
  throw new Error(`unreachable route kind: ${route.kind} (requiresSession=${String(route.requiresSession)})`);
}
