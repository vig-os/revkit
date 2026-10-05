// The hosted revkit Worker (ADR-0008; ADR-0025 surface (c)).
//
// One real `fetch` handler over one bound D1 database. The shipped HTTP
// surface is:
//
//   GET|HEAD /healthz               200 — liveness + the version it runs
//   ANY    /healthz (other verbs)   405  (kind `method-not-allowed`, ungated)
//   GET|HEAD <repo>/pr-<n>/api/threads  200 — behind ADR-0012's per-request
//                                      gate, scoped to THAT review (slice 5)
//   GET|HEAD …/api/threads?since=<n>   200 — the delta since the caller's head
//   POST   <repo>/pr-<n>/api/threads  501 — see below
//   POST   /api/session/refresh     200 — rotate the caller's own session
//   GET    /invite/<token>          200 — the display-name form (slice 3)
//   POST   /invite/redeem           303 — exchange the token for a session
//   GET    /api/threads             404 — REMOVED in slice 5; it named no
//                                      review, so it could only answer org-wide
//   ANY    /api/* (other verbs)     404
//   ANY    /_revkit/<version>/invite-<sha256>.js   200 — the ONE client script
//                                      (slice 5b), content-addressed; every
//                                      OTHER name under /_revkit/ is 404 and
//                                      NONE of them redirects (ADR-0012)
//   GET|HEAD <repo>/pr-<n>/…        200 — behind the gate, one object from the
//                                      R2 `PREVIEWS` binding, typed from the
//                                      PATH's extension against the allowlist in
//                                      `src/preview-assets.ts` (ADR-0012). A
//                                      refused extension, a missing object and a
//                                      missing preview are ONE 404 with NO body
//                                      and no R2 read. Any OTHER verb on the
//                                      same path is 405 (#96): reads only.
//   ANY    <REPO>/pr-<n>/…          404 — a repo segment that is not lowercase
//                                      is not a preview, so exactly one spelling
//                                      of a preview path resolves (#96)
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
//     construct a `D1ThreadStore`, and the HTTP half of `test/invites.test.ts` drives
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
// ── The preview surface, and the one binding it adds ───────────────────────
//
// `<repo>/pr-<n>/…` serves one object out of the `PREVIEWS` R2 binding, behind
// the same gate and the same scope check as the thread read — `Route.scope` is
// `parsePreviewPath`'s `(repo, pr)`, so the invite comparison and the R2 prefix
// are derived from ONE string in ONE place (`previewScopePath`), and a guest
// scoped to `revkit/pr-7` cannot name another review's key.
//
// **Three properties are the security content of this route, and each has a
// test in `test/preview.test.ts`:**
//
//   1. **`Content-Type` comes from the REQUEST PATH, never from the object.**
//      `src/preview-assets.ts` decides from the path alone, and the handler
//      never reads `httpMetadata` or `customMetadata` — a hostile
//      `contentType` planted on a real object changes nothing, because there is
//      no code here that would look at it. `nosniff` is what makes the
//      derived type load-bearing rather than advisory.
//   2. **A refused extension never reaches R2.** The decision is made before a
//      key exists, so `.js`, `.mjs`, `.css`, `.wasm`, a double extension, a
//      case variant, a trailing dot and a name with no extension are all 404 with
//      no body and no bucket read — proven with a counting binding rather than
//      by reading the order of two statements.
//   3. **The key layout is DESIGN-0001 §6.1's**: `<repo>/pr-<n>/<path>`, the
//      scope path with the built site's path appended, so one review's objects
//      cannot share a prefix with another's.
//
// **There is no upload side.** Nothing in this Worker writes to the bucket:
// CI writing PR-head builds, the bucket's provisioning and the credentials that
// could do either are all out of scope and tracked separately, so this surface
// serves whatever is in the bucket and the operator puts it there.
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
// owner-gated, #34) — and **that is the axis slice 5 deliberately left open**.
//
// **Named precisely, because the obvious name is WRONG.** `github` is ABSENT from
// `RECOGNISED_IDENTITY_KINDS` (`src/session.ts`), so there is no `github` session
// to be narrow or wide: one re-pointed at that kind is refused
// `401 unrecognised-identity-kind`. **The unscoped kind is `operator`** — the
// gate's scope block is under `if (resolved.principal.kind === "invite")`, so an
// `operator` session reads whatever review the path names, across the whole
// deployment, because nothing can yet prove it has access to any of them. Slice 5
// confined the guest and left `operator` exactly as it found it; neither half was
// quietly changed.
//
// ── Slice 5, the scope axis ───────────────────────────────────────────────
//
// `GET /api/threads` is gone and `<repo>/pr-<n>/api/threads` replaced it, for
// one reason: the flat read named no repository, so ADR-0012's per-call scope
// check had nothing to select on and a guest in scope for one review read the
// whole org's log. The route is path-scoped, the store is per-log
// (`D1ThreadStore`'s required `logKey`), and the gate refuses a GUEST on any
// gated route that names no scope rather than reading the absence as a
// permission.
//
// **The org-wide read is GONE, not narrowed.** An operator session reads one
// review per request now, by URL. That is what a path-addressed surface means,
// and it is the safe direction; the cost is that nothing in this build can
// enumerate a deployment's reviews, which the GitHub bridge (slice 4) will want
// and which ADR-0012's other, unimplemented clause is what would authorise.
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
// ── `POST <repo>/pr-<n>/api/threads` is still 501, on purpose ─────────────
//
// ADR-0012's CSRF and `application/json` rules are only meaningful if a
// state-changing call is reachable, and `POST /api/session/refresh` is the
// smallest route that gives them a real end-to-end path. The append needs the
// bridge and the hosted write shape (slice 4), so it stays 501 — and a `view`
// guest's attempt at it is refused by the GATE, not by the 501, which is how
// ADR-0009's read-only rule is proven while the write does not exist.

import {
  authorizeRequest,
  classifyRoute,
  denialLogMessage,
  INVITE_OPEN_PREFIX,
  INVITE_REDEEM_PATH,
  isGatedRouteKind,
  type AuthorizedSession,
  type Route,
} from "./authz.ts";
import { D1ThreadStore } from "./d1-store.ts";
import {
  CLIENT_ASSET_CACHE_CONTROL,
  CLIENT_ASSET_MEDIA_TYPE,
  clientAssetDigest,
  clientScriptSrc,
  clientAssetSource,
  isClientAssetPath,
} from "./client-asset.ts";
import {
  applyAssetHeaders,
  applyAuthHeaders,
  applyHtmlHeaders,
  applyJsonHeaders,
  applySvgHeaders,
  applyTextHeaders,
  REQUEST_ID_HEADER,
  requestOrigin,
  workerHeaderContext,
  type HeaderContext,
} from "./headers.ts";
import {
  FORM_MEDIA_TYPE,
  inviteClosedPage,
  rateLimitedPage,
  redeemFormPage,
  REDEEM_PATH,
} from "./invite-page.ts";
import {
  MAX_DISPLAY_NAME_CHARS,
  MAX_REDEEM_BODY_BYTES,
  browserCookieHeader,
  loadInviteByToken,
  readBrowserCookie,
  redeemInvite,
} from "./invites.ts";
import { createLogger, newRequestId, type Logger } from "./logger.ts";
import { previewTargetFor, type PreviewObjectKind, type PreviewObjectTarget } from "./preview-assets.ts";
import { parseThreadsQuery, previewScopePath } from "./router.ts";
import {
  INVITE_TOKEN_HMAC_KEY,
  MissingInviteTokenKeyError,
  hasUsableInviteTokenKey,
  inviteTokenHasher,
  type InviteTokenHasher,
} from "./invite-token.ts";
import { addressBucket, clientAddress, openBuckets, spendAttempts, tokenBucket } from "./rate-limit.ts";
import {
  CSRF_HEADER,
  SessionAlreadyRotatedError,
  isTokenShaped,
  mintToken,
  rotateSession,
} from "./session.ts";

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
  /**
   * The invite-token HMAC key (ADR-0012's "stored as HMAC").
   *
   * A Worker **secret** in production — `wrangler secret put
   * INVITE_TOKEN_HMAC_KEY`, provisioned by `revkit deploy init` (slice 8,
   * owner-gated #34) — and a plain `bindings` entry in the offline harness.
   * From inside the Worker the two are the same string in `env`, which is why
   * slice 3's first attempt, which concluded that a keyed hash was "verified
   * nowhere" because miniflare ignores its `secrets` option, was reasoning
   * about the harness rather than about the Worker. It is deliberately NOT in
   * `wrangler.jsonc`: a `vars` entry would put a secret in a tracked file
   * (ADR-0014), and `test/worker-config.test.ts` asserts it is absent from
   * there.
   */
  readonly INVITE_TOKEN_HMAC_KEY: string;
  /**
   * The preview bucket: one built site per `<repo>/pr-<n>/`, keys shaped by
   * `src/preview-assets.ts` (`previewScopePath` + the built site's path).
   *
   * Declared in `wrangler.jsonc` as an `r2_buckets` entry so the binding NAME is
   * a tested contract (`test/worker-config.test.ts`), and provisioned by
   * whatever eventually runs `wrangler r2 bucket create` — owner-gated and out
   * of scope here, so **the bucket name is a declaration and not a resource this
   * repo has created**. The offline harness binds an in-memory one and seeds it
   * per test.
   *
   * **Read-only in this Worker, and that is the whole trust story.** Nothing
   * here calls `put`/`delete`, so whatever controls the bucket's contents is
   * whoever runs the build pipeline — and ADR-0012's guarantee does not depend on
   * that being careful: the bytes are typed by the REQUEST PATH's extension, so
   * a PR that ships its own `text/javascript` metadata still gets served as the
   * type its name asks for, or not at all.
   *
   * A deployment with the binding MISSING answers 500 on preview paths and
   * nothing else: no route outside `servePreviewObject` reads it, so the absence
   * cannot be mistaken for a healthy surface that simply has no previews in it.
   */
  readonly PREVIEWS: R2Bucket;
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
 * built by `previewPath`, never the URL the token arrived on.
 *
 * **This is the half of DESIGN-0001 §6's "stripped from the URL" that needs no
 * JavaScript, and it is the control.** (The phrase appears exactly once in the
 * repo, and it is there — not in ADR-0009, which is where this used to cite
 * it, and which says nothing about the URL at all.) The other half arrived in
 * slice 5b: the invite page now loads one external script that rewrites the
 * address bar with `history.replaceState` on load, so the token does not survive
 * in this tab's history either — but only when scripting is enabled, which is a
 * conditional the design states unconditionally and the third ADR-0012
 * amendment in this slice now records. That is a belt; this is the pair of
 * braces. `src/invites.ts`'s header has the full argument, including what a
 * guest with scripting disabled keeps and does not lose.
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
      // FIRST, before `beginRequest`. A deployment that cannot hash an invite
      // token cannot redeem one, so it is not healthy and every route —
      // `/healthz` included — says so. There is no fallback key, deliberately: a
      // zero-filled key produces a VALID, WRONG digest, which is worse than no
      // key. See `src/invite-token.ts` for why a 500 is the faithful shape
      // rather than a compromise, and for the two alternatives that are worse.
      //
      // It has to precede `beginRequest`, which reads `env.REVKIT_VERSION` and
      // throws on a missing one. With the order the other way round, a
      // deployment missing BOTH bindings reported the `REVKIT_VERSION`
      // TypeError instead — measured, and the reason the missing-key test
      // asserts on the message and not merely on a 500. The catch below copes
      // with no scope: `fallbackLogger` and `ERROR_HEADER_CONTEXT` are the
      // no-context answers, and they are why this can be first.
      if (!hasUsableInviteTokenKey(env.INVITE_TOKEN_HMAC_KEY)) {
        throw new MissingInviteTokenKeyError();
      }
      // INSIDE the boundary. `beginRequest` builds the header context and
      // throws on a missing `REVKIT_VERSION`; that used to happen before
      // this `try`, so the catch never ran and workerd returned its own
      // error page — a stack trace and a store path in the response body.
      // `test/worker-runtime.test.ts` now drives exactly that deploy.
      scope = beginRequest(request, env);
      const keys = await inviteTokenHasher(env.INVITE_TOKEN_HMAC_KEY);
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
        const response = await handleOpen(route, request, env, keys, scope);
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

      // The gate admitted this request, so `route.requiresSession` is true — and
      // `classifyPath` cannot produce a gated route carrying an ungated kind. The
      // predicate is a CHECK rather than a cast because `handleAuthorized`'s
      // narrowed parameter type is only worth anything with a check behind it: a
      // partition mistake becomes `unreachable()` and a loud 500, which is this
      // codebase's standing answer, instead of a dispatcher `case` that silently
      // does not exist. It cannot fire with the table as shipped —
      // `test/authorization.test.ts` asserts the partition against behaviour over
      // the derived probe product.
      if (!isGatedRouteKind(route.kind)) return unreachable(route);
      const response = await handleAuthorized(route, decision.authorized, request, env, scope, url);
      status = response.status;
      return response;
    } catch (error) {
      // The request id is in the log line AND in the response, so a
      // reviewer can quote it (ADR-0020). The message stays generic: an
      // error string can carry a SQL fragment, a stack or an absolute store
      // path, and this response is readable by whoever reached the Worker.
      const requestId = scope?.requestId ?? newRequestId();
      // The MESSAGE, not the name. Slice 3 logged `error.name` and justified it
      // as "an error string can carry a SQL fragment, a stack or an absolute
      // store path". The redactor is the control for that, and it was never
      // applied to a field this call site chose not to populate — so the
      // strongest statement available about the exchange's logs was untested on
      // the one path that matters, an unhandled throw. Every throw site in this
      // module interpolates a closed vocabulary or a constant
      // (`MissingInviteTokenKeyError` names the binding and never a value), and
      // `test/invites.test.ts` now drives a throwing path with a marker in the
      // message and asserts the marker is absent from every captured line. A
      // caller rule the logger's own header calls primary is worth more than a
      // field left empty by hope.
      (scope?.logger ?? fallbackLogger(requestId)).log("error", "request.error", {
        error: error instanceof Error ? error.message : typeof error,
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
async function handleOpen(
  route: Route,
  request: Request,
  env: Env,
  keys: InviteTokenHasher,
  scope: RequestScope,
): Promise<Response> {
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
      return serveClientAsset(safePath(request), env, scope);
    case "invite-open":
      return openInvite(request, env, keys, scope);
    case "invite-redeem":
      return redeemFromRequest(request, env, keys, scope);
    case "unknown":
      return json({ error: "not-found" }, 404, scope);
    default:
      return unreachable(route);
  }
}

// ── the invite surface (slice 3) ──────────────────────────────────────────

/**
 * `ANY /_revkit/<version>/invite-<digest>.js` — the Worker serves ONE client
 * script, and this is it.
 *
 * **This replaces a 404 that a CSP was already pointing at.** Until slice 5b,
 * `script-src` named `/_revkit/<version>/` and every path under it answered
 * `404 {"note": "revkit bundle serving lands in M4 slice 3"}`, so the policy
 * allowlisted a directory that served nothing.
 *
 * ── Why this is a route at all, rather than R2 or a static upload ──────────
 *
 * ADR-0012 says the bundle path is "deployed by revkit's own release". The
 * honest state of that is that there is no release pipeline for this surface
 * yet: `revkit deploy init` — which would provision one — is slice 8 and
 * owner-gated (#34). So the bytes are compiled INTO the
 * Worker (`src/client-script.ts`) and served from the bundle path, which keeps
 * the property ADR-0012 actually cares about: **the script comes from the
 * running revkit version, never from a PR artefact.** Whoever controls the
 * artefact controls the `<script>` tag in it; the digest in the filename is
 * computed from the same string this handler writes to the body, in the same
 * request, so a page and the asset it names cannot disagree.
 *
 * **The `PREVIEWS` R2 binding does not change this, and the difference is the
 * point.** There IS an R2 bucket now (issue #101), and it holds PR-controlled
 * content — so the reason the bundle is not in it is not "there is nowhere to
 * put it". It is that a bundle's bytes must come from the running version, and
 * a bucket whose contents are whatever CI last wrote is the wrong home for them
 * however convenient it would be.
 *
 * ── The three properties this handler is responsible for ───────────────────
 *
 *   1. **Exact-match only.** `isClientAssetPath` is string equality against the
 *      one name that resolves, so an unhashed name, a mis-hashed name, a `.mjs`
 *      spelling, another version, and the bare `/_revkit/` are all 404s — and
 *      there is no pattern in here to widen.
 *   2. **Never a redirect.** ADR-0012: a browser drops the path part of a CSP
 *      source after a redirect, which would widen `script-src` from one pinned
 *      directory to whatever a `Location` named. `isRevkitBundlePath` classifies
 *      the whole prefix and this handler only ever answers 200 or 404.
 *   3. **No database, no gate, no request-derived input.** `env.DB` is never
 *      touched, so this cannot become a second reader of review data; and the
 *      only things read are `env.REVKIT_VERSION` and the request's own pathname.
 *
 * **Ungated, and that is correct for the same reason `/healthz` is.** The bytes
 * are a compile-time constant: there is nothing here to authorize, and a gate in
 * front of it would only mean a first-visit failure mode for a page that must
 * load before anything else does.
 *
 * **`Cache-Control` is set HERE rather than left to the shared policy**, because
 * the policy sets it only for `json` and `auth` kinds and an asset is neither.
 * The value is `immutable` and the naming scheme is what makes that true rather
 * than optimistic — see `src/client-asset.ts`.
 *
 * The `asset` kind is what makes this response carry **no CSP of its own**:
 * browsers apply the embedding document's CSP to subresource loads, so a
 * `default-src 'none'` on the script response would deny the document's own load
 * of it. The document's `default-src 'none'` is the control; this one would be
 * the thing that breaks it.
 */
async function serveClientAsset(pathname: string, env: Env, scope: RequestScope): Promise<Response> {
  const digest = await clientAssetDigest();
  if (!isClientAssetPath(pathname, env.REVKIT_VERSION, digest)) {
    scope.logger.log("info", "asset.miss", { pathKind: "revkit-bundle" });
    return json({ error: "not-found" }, 404, scope);
  }
  const response = new Response(clientAssetSource(), { status: 200 });
  response.headers.set("cache-control", CLIENT_ASSET_CACHE_CONTROL);
  return withExtra(applyAssetHeaders(response, scope.headers, CLIENT_ASSET_MEDIA_TYPE), scope);
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
 * **Three things happen here, in this order, and the order is the security
 * shape:**
 *
 *   1. **Spend the ADDRESS bucket, before anything else.** An open is
 *      unauthenticated and idempotent, so it must be metered by the one bucket
 *      whose key is not derived from the request. It is deliberately NOT charged
 *      to the per-token bucket: that bucket was charged here in slice 3's first
 *      cut, and anyone holding the URL could then spend the intended guest's
 *      whole window with 45 GETs and lock them out with no recovery, because the
 *      redemption slot is single-use and there is nothing to retry. See
 *      `src/rate-limit.ts`'s `tokenBucket`.
 *   2. **Look the invite up.** Missing, revoked and expired all produce the SAME
 *      closed page — one page for every dead-link reason, which
 *      `src/invite-page.ts` explains.
 *   3. **Mint the browser binding ONLY if the request did not already present
 *      one**, and render the form.
 *
 * ── Why step 3 is conditional, which was a shipped defect ────────────────
 *
 * This route used to mint a FRESH binding on every open. The binding is bound on
 * the OPEN deliberately — it is what makes ADR-0009's "bound to the first browser
 * that opens it" literal — but overwriting it was wrong, because the session is
 * bound to the binding it was REDEEMED with and that binding is re-read on every
 * authorized call. So a second click on the mail link, a second tab, a session
 * restore or a Back-navigation silently replaced the cookie a live session
 * depended on:
 *
 *     redeem -> 303 | GET /api/threads -> 200
 *     re-open -> 200 | binding ROTATED -> GET /api/threads -> 403
 *     re-redeem -> 410 (the slot is spent, so there is no recovery)
 *
 * Every one of those triggers is ordinary browser behaviour rather than an
 * attack. Reusing a presented binding fixes it without weakening anything: a
 * second, DIFFERENT browser still has no binding, so it still mints one and is
 * still refused by `max_browsers`; and a binding is per-browser, so reusing one
 * across several of a guest's own invites costs nothing (the ledger is keyed by
 * `(invite_id, binding_hash)`).
 *
 * This route does not consume the redemption, which is what makes the `HEAD`
 * refusal in `classifyRoute` a matter of correctness rather than politeness for
 * the *open* — and note the asymmetry: `HEAD` on the redeem route is refused
 * because a `HEAD` there WOULD consume.
 */
async function openInvite(
  request: Request,
  env: Env,
  keys: InviteTokenHasher,
  scope: RequestScope,
): Promise<Response> {
  const pathname = safePath(request);
  const token = inviteTokenFrom(pathname);
  // Resolved ONCE per request and reused by every page this handler can return —
  // the form, the closed page and the 429 all load the same script, and all
  // three are served at a URL that still contains the token. Memoised in
  // `src/client-asset.ts`, so this is a map read after the first request.
  const scriptSrc = await clientScriptSrc(env.REVKIT_VERSION);
  // NEVER unmetered, and the rule that guarantees it lives in `openBuckets` —
  // the address bucket when the edge set one, the per-token bucket when it did
  // not, because an empty bucket list writes nothing at all.
  const limited = await spendAttempts(
    env.DB,
    openBuckets({
      address: clientAddress(request.headers),
      tokenHash: token === undefined ? undefined : await keys.hash(token),
    }),
  );
  if (!limited.ok) {
    scope.logger.log("info", "rate.limit.hit", { bucketKind: limited.kind, route: "invite-open" });
    return rateLimited(limited.retryAfterSeconds, scope, scriptSrc);
  }
  if (token === undefined) return html(inviteClosedPage(scriptSrc), 404, scope);
  const invite = await loadInviteByToken(env.DB, token, { keys });
  const now = Date.now();
  if (invite === undefined || invite.revokedAt !== null || Date.parse(invite.expiresAt) <= now) {
    scope.logger.log("info", "invite.denied", { stage: "open", reason: invite === undefined ? "unknown-token" : "not-live" });
    return html(inviteClosedPage(scriptSrc), 410, scope);
  }
  // L1: the field is `writable`, and the first two names tried were both wrong.
  // `SENSITIVE_KEY`'s content-word alternative has NO boundary guards —
  // deliberately, it is what stops `arrayOfEmails` — so it matches `comment`
  // INSIDE `canComment`, and the boolean reached the log as `"[redacted]"`
  // carrying nothing at all. Renaming it to `commentable` failed the same way,
  // because `commentable` also contains `comment`. `writable` contains no word
  // on that list.
  //
  // Dropping the field was the other option and it loses a real diagnostic:
  // `can_comment` is a COLUMN, and nothing in the schema ties it to `kind`, so a
  // row can say `kind = view` with `can_comment = 1`. The gate decides from the
  // column, so the column is what an operator needs to see when a guest's rights
  // disagree with their invite's share type. Narrowing the redactor is NOT the
  // fix: that alternative is guard-free by design, and slice 2's boundary work
  // was on the token-shape rule, which this must not weaken.
  scope.logger.log("info", "invite.opened", { inviteKind: invite.kind, writable: invite.canComment });
  const presented = readBrowserCookie(request.headers.get("cookie"));
  const reuse = presented.kind === "present" && isTokenShaped(presented.value) ? presented.value : mintToken();
  return html(
    redeemFormPage({
      token,
      repo: invite.repo,
      pr: invite.pr,
      kind: invite.kind,
      canComment: invite.canComment,
      scriptSrc,
    }),
    200,
    scope,
    {
      // The SHARED builder, with the invite's remaining lifetime as the `Max-Age`.
      // This route had its own copy of these five attributes and the mutation
      // run is what caught it: dropping `SameSite=Lax` from the copy changed
      // **zero** tests, because no assertion covered the cookie this route sets
      // — while the redemption's identical cookie, built by
      // `browserCookieHeader`, was asserted. Two builders, one covered: the
      // classic way for a security attribute to rot in the copy nobody looks at.
      "set-cookie": browserCookieHeader(reuse, (Date.parse(invite.expiresAt) - now) / 1000),
    },
  );
}

/**
 * `POST /invite/redeem` — exchange the token for a session.
 *
 * ── The order, and the three corrections that produced it ──────────────────
 *
 *   1. **ADDRESS bucket first.** This route's first cut charged the rate limit
 *      AFTER the content-type check and AFTER `readRedeemBody`, while a comment
 *      above it claimed "rate limit first (an attempt is an attempt whether or
 *      not the body parses)". Measured: five malformed-JSON bodies, five wrong
 *      media types, an over-long body and both malformed open-route spellings each
 *      left **zero** counter rows — an unauthenticated, unmetered body-parse
 *      endpoint in front of an invite. The address bucket is charged before the
 *      media type is even looked at, so every path through this handler is
 *      metered.
 *   2. **Media type, then body.** `application/x-www-form-urlencoded` is
 *      accepted HERE AND NOWHERE ELSE (see `isRedeemContentType`).
 *   3. **Look the token up, then charge the PER-TOKEN bucket** — only for a token
 *      that resolves to a live invite, per `src/rate-limit.ts`'s `tokenBucket`.
 *   4. **The browser-binding cookie**, then the redemption, which decides scope,
 *      type, expiry, revocation and slot availability inside one D1 batch.
 *
 * On success the response is a `303` to a TOKEN-FREE path, carrying TWO
 * `Set-Cookie` headers — the session and the browser binding, both `__Host-`,
 * `HttpOnly`, `Secure`, `SameSite=Lax` — plus the CSRF token as a response
 * header, exactly as `POST /api/session/refresh` returns it.
 *
 * There is NO CSRF requirement here, and that is deliberate rather than an
 * omission: a CSRF token binds a state change to an EXISTING session and the
 * caller has none. The controls that fit this shape are the 256-bit token, the
 * single-use ledger and the rate limit; a CSRF check here would be a control
 * that cannot fail.
 */
async function redeemFromRequest(
  request: Request,
  env: Env,
  keys: InviteTokenHasher,
  scope: RequestScope,
): Promise<Response> {
  const address = clientAddress(request.headers);
  // Same reasoning as the open route: every page below is rendered here, so the
  // script URL is resolved once rather than at each return.
  const scriptSrc = await clientScriptSrc(env.REVKIT_VERSION);
  // Same rule as the open route, and for the same reason: an empty bucket list
  // writes nothing, so a request with no edge address would skip the limiter
  // entirely on this path too. The token is inside the body, which has not been
  // read yet at this point — so before the parse there is no token key to fall
  // back to, and the address bucket being empty here means this specific request
  // is unmetered. That is stated rather than papered over: reading the body to
  // get a key would undo the ordering rule above. What IS metered without an
  // address is every request that reaches the token lookup, which is the
  // expensive path.
  const limited = await spendAttempts(env.DB, addressBucket(address));
  if (!limited.ok) {
    scope.logger.log("info", "rate.limit.hit", { bucketKind: limited.kind, route: "invite-redeem" });
    return rateLimited(limited.retryAfterSeconds, scope, scriptSrc);
  }
  if (!isRedeemContentType(request.headers.get("content-type"))) {
    return json({ error: "unsupported-media-type", reason: "content-type-not-json" }, 415, scope);
  }
  const body = await readRedeemBody(request, request.headers.get("content-type"));
  // Over the ceiling is its own answer, not a malformed body. The response says
  // which, so a caller can tell "send less" from "send something I can parse".
  if (body?.kind === "too-large") {
    return json({ error: "bad-request", reason: "body-too-large" }, 413, scope);
  }
  if (body === undefined) return json({ error: "bad-request", reason: "unparsable-body" }, 400, scope);
  const invite = await loadInviteByToken(env.DB, body.token, { keys });
  if (invite === undefined) {
    scope.logger.log("info", "invite.redeem.denied", { reason: "unknown-token" });
    return html(inviteClosedPage(scriptSrc), 410, scope);
  }
  // The token resolved, so its own bucket is now worth charging. A guessed token
  // never reaches this line and therefore never creates a counter row.
  const tokenLimit = await spendAttempts(env.DB, tokenBucket(invite.tokenHash));
  if (!tokenLimit.ok) {
    scope.logger.log("info", "rate.limit.hit", { bucketKind: tokenLimit.kind, route: "invite-redeem-token" });
    return rateLimited(tokenLimit.retryAfterSeconds, scope, scriptSrc);
  }
  // No outer "no binding cookie" guard here, and that is the SECOND half of a
  // correction rather than a fresh decision. There was one, and the mutation run
  // replaced it with `if (false)` and changed **zero** tests, because
  // `redeemInvite`'s own `isTokenShaped(binding)` check refuses a missing or
  // malformed binding with the same `browser-binding-missing` refusal. Two
  // places deciding one fact is how they drift, so the inner one — the one the
  // test actually pins — is now the only one. `redeemInvite`'s refusal is also
  // what names the reason, so the log line moved with it.
  const cookie = readBrowserCookie(request.headers.get("cookie"));
  const result = await redeemInvite(
    env.DB,
    {
      token: body.token,
      binding: cookie.kind === "present" ? cookie.value : "",
      displayName: body.displayName,
    },
    { keys },
  );
  if (!result.ok) {
    scope.logger.log("info", "invite.redeem.denied", { reason: result.refusal });
    return html(inviteClosedPage(scriptSrc), 410, scope);
  }
  scope.logger.log("info", "invite.redeem.ok", { inviteKind: result.invite.kind, writable: result.invite.canComment });
  // The CSRF token rides on the `303` as a response header, exactly as
  // `POST /api/session/refresh` returns it, because a guest's first
  // state-changing call needs one and ADR-0012 requires it per session. **How a
  // browser PAGE reads it is not answered here:** a navigation cannot see a
  // response header, and the two candidates are slice 5's to choose between — a
  // meta tag in the preview document (whose hash then joins the committed
  // allowlist) or a second, non-HttpOnly cookie. Shipping neither is the honest
  // position, because `POST <repo>/pr-<n>/api/threads` is a 501 and no guest page exists
  // need one; what ships is that the token EXISTS and is bound to the session.
  return seeOther(previewPath(result.invite.repo, result.invite.pr), scope, [result.issued.cookie, result.browserCookie], {
    [CSRF_HEADER]: result.issued.csrfToken,
  });
}

/** The token-free path the redemption redirects to. `/` when the invite covers
 * a whole repo and there is no PR to name — a repo-scoped invite's holder has
 * no single review to land on, and sending them to a PR the invite never named
 * would be a scope leak in the redirect.
 *
 * The `/` is **itself a residual gap, unchanged by slice 5**: `classifyRoute("/")`
 * is `unknown`, so a repo-wide invite's holder is redirected to a 404. There is
 * no repo-wide index page in this build, and inventing one is a product
 * decision rather than a security fix. It is security-neutral (a 404 leaks
 * nothing) and recorded in the PR rather than fixed here. The PR case uses
 * `previewScopePath`, so the scoped spellings cannot drift apart. */
function previewPath(repo: string, pr: number | null): string {
  return pr === null ? "/" : `${previewScopePath(repo, pr)}/`;
}

/** A 429 in whichever shape the caller can use: HTML for the navigation the
 * invite routes are reached by, and it always carries `Retry-After` because a
 * 429 without one tells a client nothing except that it should guess. */
function rateLimited(retryAfterSeconds: number, scope: RequestScope, scriptSrc: string): Response {
  return html(rateLimitedPage(retryAfterSeconds, scriptSrc), 429, scope, { "retry-after": String(Math.max(1, retryAfterSeconds)) });
}

/**
 * The two media types `POST /invite/redeem` accepts. **This route only.**
 *
 * `application/json` because ADR-0012 says the API accepts only that — and
 * `application/x-www-form-urlencoded` because the page this route is reached
 * from IS a form.
 *
 * ── Why the second one is not a violation of ADR-0012 ─────────────────────
 *
 * ADR-0012's clause is "**the API** accepts only `application/json`". A guest
 * arriving from a mail client on a form submission is not an API client, and
 * slice 3's first cut treated it as one — which made the shipped flow
 * **unsubmittable**: `redeemFormPage` emits `<form method="post">` with no
 * `enctype`, so a browser sends `application/x-www-form-urlencoded`; the route
 * refused it with 415; and the page had no `fetch()` that could send JSON, so
 * **no HTML mechanism could produce `application/json` at all**. Every guest got
 * a 415 and no session.
 *
 * *Still true after slice 5b, and worth being precise about why:* the page now
 * loads a script, so "the page serves no script" is no longer the premise — but
 * that script only rewrites the address bar (`src/client-script.ts`), and
 * `test/invites.test.ts` asserts it contains no `fetch` at all. The form still
 * posts natively, so `application/x-www-form-urlencoded` remains the only thing a
 * browser can produce here.
 *
 * Nothing caught it because every POST in the suite was a hand-built JSON
 * `Request`. The fix is therefore paired with a test that parses the SHIPPED
 * page's `action`, `method` and absent `enctype` and submits accordingly, so the
 * page and this function cannot drift apart again.
 *
 * `text/plain` and the `+json` structured suffixes are still refused: ADR-0012's
 * named type plus one browser default, and nothing else.
 */
function isRedeemContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const type = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return type === "application/json" || type === FORM_MEDIA_TYPE;
}

/** The browser default for a `<form>` with no `enctype`. Named so the page and
 * the route cannot disagree about the spelling. */
/**
 * The redemption body, or `undefined` when it cannot be read as one.
 *
 * **Total in both encodings**, and the discipline is identical: a missing body,
 * a malformed document, a non-object, a missing field, a field of the wrong
 * type, a REPEATED field and an over-long name all resolve to `undefined`, and
 * the caller answers one 400 with a fixed literal reason. Nothing from the body
 * reaches a response, a log line or a page.
 *
 * A **repeated** field is refused rather than resolved, because a form-encoded
 * body can legitimately carry `token` twice and "the first one" is how one
 * browser's redemption becomes another's — the same `since-repeated` rule
 * `parseThreadsQuery` already applies, for the same reason.
 *
 * The form encoding's `+` becomes a space and `%XX` is decoded by
 * `URLSearchParams`, which is the WHOLE reason the display name needs its own
 * round-trip test: `"Ada L/ovelace & co — 引き継ぎ"` encodes differently under
 * each media type, and only the decoded value reaches `redeemInvite`.
 *
 * The token is shape-checked HERE, before it is used as a rate-limit key and
 * before it reaches `redeemInvite`. That is an input filter, not the control: a
 * well-shaped forgery is refused by finding no row.
 *
 * `MAX_DISPLAY_NAME_CHARS * 8` is a ceiling on what this function will even
 * look at, not the stored bound (`redeemInvite` refuses rather than truncates at
 * `MAX_DISPLAY_NAME_CHARS`). It exists so an over-long field is rejected without
 * being copied around; the 8x slack is for multi-byte characters and for the
 * percent-encoding of one, and the test asserts the boundary from both sides.
 */
async function readRedeemBody(
  request: Request,
  contentType: string | null,
): Promise<RedeemBody | undefined> {
  const type = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const read = await readBoundedText(request);
  if (read.kind === "too-large") return { kind: "too-large" };
  if (read.kind === "unreadable") return undefined;
  const record = type === FORM_MEDIA_TYPE ? formFields(read.text) : jsonFields(parseJson(read.text));
  if (record === undefined) return undefined;
  const { token, displayName } = record;
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return undefined;
  if (typeof displayName !== "string" || displayName.length > MAX_DISPLAY_NAME_CHARS * 8) return undefined;
  return { kind: "fields", token, displayName };
}

/** What `readRedeemBody` concluded. `too-large` is its own verdict rather than
 * a malformed body, because it is a different answer to give a caller and a
 * different thing to assert: 413 says "your body is too big", 400 says "I could
 * not read that", and collapsing them would hide the bound the test pins. */
type RedeemBody =
  | { kind: "fields"; token: string; displayName: string }
  | { kind: "too-large" };

/** Read at most `MAX_REDEEM_BODY_BYTES`, and STOP reading when the body exceeds
 * it rather than reading it and then complaining.
 *
 * `content-length` is checked first because it is free and it lets an oversized
 * request be refused with **zero** bytes read — but it is attacker-controlled,
 * so it is a hint and never the guarantee. The streaming cap below is the
 * guarantee: the reader is cancelled the moment the running total passes the
 * ceiling, so an absent, wrong or `Transfer-Encoding: chunked` length cannot make
 * this read more than the bound.
 *
 * `request.text()` cannot express this — it resolves the whole body before the
 * caller sees any of it, so a size check after it is a check on bytes already in
 * memory, which is the thing being avoided.
 */
async function readBoundedText(
  request: Request,
): Promise<{ kind: "text"; text: string } | { kind: "too-large" } | { kind: "unreadable" }> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REDEEM_BODY_BYTES) {
    return { kind: "too-large" };
  }
  const body = request.body;
  if (body === null) return { kind: "text", text: "" };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_REDEEM_BODY_BYTES) {
        await reader.cancel();
        return { kind: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { kind: "unreadable" };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "text", text: new TextDecoder().decode(bytes) };
}

/** `JSON.parse` that answers `undefined` instead of throwing, so the caller has
 * one "unreadable" path rather than two. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Form-encoded fields, with a repeat refused. `URLSearchParams` decodes
 * `+` and `%XX`; it does not, and must not, decide which of two `token`s wins. */
function formFields(body: string): Record<string, unknown> | undefined {
  const params = new URLSearchParams(body);
  const out: Record<string, unknown> = {};
  for (const [name, value] of params) {
    if (Object.hasOwn(out, name)) return undefined;
    out[name] = value;
  }
  return out;
}

/** JSON fields. A JSON document can carry a duplicate key too, and `JSON.parse`
 * silently keeps the last, so the check is done on the RAW text rather than on
 * the parsed object — otherwise this function would accept a repeated `token`
 * on one media type and refuse it on the other. */
function jsonFields(parsed: unknown): Record<string, unknown> | undefined {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
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
      return readThreads(authorized, env, scope, url, route);
    case "threads-append":
      return appendDisabled(scope);
    case "session-refresh":
      return refreshSession(authorized, env, scope);
    case "preview":
      return servePreviewObject(env, scope, route, url);
    case "method-not-allowed":
      return json({ error: "method-not-allowed" }, 405, scope);
    default:
      return unreachable(route);
  }
}

/**
 * `GET <repo>/pr-<n>/api/threads` — the scoped read slice 1 closed, slice 2
 * opened and slice 5 SCOPED.
 *
 *   no `since`     -> { head, threads }   THIS review's projection, via
 *                      `D1ThreadStore.threads()` (review-core's `reduce` +
 *                      `selectThreads`, not a local reimplementation)
 *   `?since=<n>`   -> { head, events }    this review's events with `seq > n`,
 *                      via `since(n)`, which is the resume point the hosted
 *                      rail needs (ADR-0006: consumers use `since(lastSeen)`
 *                      and never assume `seq` is contiguous)
 *
 * `head` is this LOG's `MAX(seq)` read from D1, not this store's validated
 * watermark: the store is built per request, so its own `#head` starts at 0 and
 * would hand a client a resume point that silently skips the log.
 *
 * ── `route.scope` is the ONLY source of the log key ──────────────────────
 *
 * `route.scope.logKey` came out of `parseScopedThreadsPath`, i.e. out of the
 * PATH this request presented, and the gate compared that path's `(repo, pr)`
 * against the caller's invite before this function was reached. This handler
 * reads no header, no query parameter and no body field, and it derives nothing:
 * a log key is not something a caller can name. `route` is a parameter rather
 * than the scope alone so the `unreachable` below can prove the scope is present
 * — a `threads-read` classification with no scope cannot happen, and if one ever
 * did it is a 500 rather than an org-wide read.
 *
 * `authorized` is not otherwise used: it is what makes the gate structural
 * rather than a convention. `AuthorizedSession`'s brand symbol is private to
 * `src/authz.ts`, so `tsc` refuses this call from anywhere the gate does not run
 * first. Nothing in the body needs it.
 */
async function readThreads(
  authorized: AuthorizedSession,
  env: Env,
  scope: RequestScope,
  url: URL,
  route: Route,
): Promise<Response> {
  void authorized;
  // ── The ORDER of these two blocks is what makes the mutation equivalent ──
  //
  // The query is validated BEFORE a log key is chosen. `parseThreadsQuery`
  // refuses every parameter but `since`, so a request naming a log in its query
  // string is refused here and the key below is the only one that can reach a
  // store.
  //
  // **A mutation run put a number on this, and the number is 0.** Changing
  // `route.scope?.logKey` to
  // `url.searchParams.get("log_key") ?? route.scope?.logKey` — a
  // caller-supplied log key — leaves the suite **fully green**, and it is worth
  // being precise about WHY rather than recording it as an untested risk:
  //
  //   - It was tried in BOTH orders. Before this reorder it was safe only by
  //     accident of ordering; after it, the mutated line is **unreachable** for
  //     any query carrying a parameter, because the refusal returned 400 above.
  //   - For every query the parser ACCEPTS — none, or `?since=<canonical>` —
  //     `searchParams.get("log_key")` is `null`, so the fallback yields the
  //     same key. Every input, therefore, produces identical behaviour: the
  //     mutant is **equivalent**, and no test can kill it.
  //
  // So the control is not "a test asserts this", because there is none to
  // write. It is structural: the key comes from `route.scope`, which
  // `classifyRoute` derives from the path by a pure function of
  // `(pathname, method)`, and the query parser is **total** over the parameter
  // set. `test/authorization.test.ts` pins both halves — the refusal, and the
  // absence of any log's `head` from the answer — so a future edit that made
  // the parser accept a parameter would be caught, which is the case that
  // would actually open the hole.
  const query = parseThreadsQuery(url.search);
  if (query.kind === "invalid") {
    return json({ error: "bad-request", reason: query.reason, parameter: query.parameter }, 400, scope);
  }
  const logKey = route.scope?.logKey;
  if (logKey === undefined) return unreachable(route);
  const store = new D1ThreadStore({ db: env.DB, logKey });
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
 * `POST <repo>/pr-<n>/api/threads` — still 501, for a narrower and stated reason.
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

// ── the preview surface: one object per request, typed by its PATH ────────

/** Every preview response is `no-store`, and that is a property of the KEY
 *  rather than of the bytes.
 *
 * The revkit-owned bundle path can be `immutable` because its name is the hash
 * of its content. A preview object cannot: `revkit/pr-7/index.html` is a
 * different document after every push, and a cache that had seen the previous
 * one would show a reviewer the PREVIOUS PR head while the thread read beside it
 * described the current one. So nothing on this surface is cacheable, and the
 * value is set here — the shared policy sets `Cache-Control` only for `json` and
 * `auth`, so an `html`, `svg` or `asset` preview would otherwise ship with none.
 */
const PREVIEW_CACHE_CONTROL = "no-store";

/**
 * `GET|HEAD <repo>/pr-<n>/…` — one preview object, behind the gate.
 *
 * The order is the security shape, and there are only three steps:
 *
 *   1. **Decide from the path, before anything is read.** `previewTargetFor`
 *      takes `route.scope.logKey` and the request's own pathname and returns
 *      either an object to read or a refusal. A refusal returns HERE — no key
 *      exists yet, so there is nothing to read, and the request never becomes an
 *      R2 operation at all. `.js`, `.mjs`, `.css`, `.wasm`, `.html.js`, `X.JS`,
 *      `index.html.`, `%2e`, a doubled slash and a name with no extension are
 *      all in that set.
 *   2. **Read that one key.** `get` returns `null` for a missing object, which
 *      is the same 404 as a refusal: a caller learns that it did not get bytes,
 *      and nothing about which of the two it was.
 *   3. **Answer through the shared policy** with the kind the extension decided:
 *      `html` → the full ADR-0012 CSP, `svg` → minimal CSP + `sandbox` +
 *      `Content-Disposition: inline`, `json` and `asset` → theirs.
 *
 * **The object's metadata is never read, and there is no line here that could.**
 * The response's `Content-Type` comes from `target.contentType`, which came from
 * the extension table; `writeHttpMetadata` — the API that would copy an object's
 * `httpMetadata` onto a response — is not called, and neither is `customMetadata`.
 * That is asserted over workerd against an object whose stored `contentType` is
 * `text/javascript`, in `test/preview.test.ts`.
 *
 * `route` is a parameter rather than `route.scope` so the `unreachable` below can
 * prove the scope is present: a `preview` classification without a scope cannot
 * happen, and if one ever did it is a 500 rather than a read of a key derived
 * from nothing.
 */
async function servePreviewObject(env: Env, scope: RequestScope, route: Route, url: URL): Promise<Response> {
  const logKey = route.scope?.logKey;
  if (logKey === undefined) return unreachable(route);
  const decision = previewTargetFor(logKey, url.pathname);
  if (decision.kind === "refused") {
    // The reason is one of `preview-assets.ts`'s closed vocabulary, so no part
    // of the request reaches the log line — and the object path is deliberately
    // NOT a field, because `request.end` already carries the pathname.
    scope.logger.log("info", "preview.refused", { reason: decision.reason });
    return previewNotFound(scope);
  }
  const target = decision.target;
  const object = await env.PREVIEWS.get(target.key);
  if (object === null) {
    scope.logger.log("info", "preview.miss", { objectKind: target.kind });
    return previewNotFound(scope);
  }
  scope.logger.log("info", "preview.served", { objectKind: target.kind });
  return previewObject(object.body, target, scope);
}

/**
 * A preview object as a response, through the ONE header policy.
 *
 * The switch is the whole point: there is no per-kind header written here, so a
 * served SVG cannot grow a `script-src` and a served PNG cannot grow a CSP of
 * its own (which would deny the document's own load of it). `kind` and
 * `contentType` come as a PAIR from the extension table, so they cannot disagree
 * about what a `.svg` is.
 *
 * `no-store` is set before the policy runs because the shared policy sets
 * `Cache-Control` only for `json` and `auth` — and for `json` it sets the same
 * value, so no header is ever set twice.
 */
function previewObject(body: ReadableStream, target: PreviewObjectTarget, scope: RequestScope): Response {
  const response = new Response(body, { status: 200 });
  response.headers.set("cache-control", PREVIEW_CACHE_CONTROL);
  return withExtra(previewPolicyHeaders(response, target.kind, target.contentType, scope.headers), scope);
}

function previewPolicyHeaders(
  response: Response,
  kind: PreviewObjectKind,
  contentType: string,
  ctx: HeaderContext,
): Response {
  switch (kind) {
    case "html":
      return applyHtmlHeaders(response, ctx);
    case "json":
      return applyJsonHeaders(response, ctx, contentType);
    case "svg":
      return applySvgHeaders(response, ctx);
    case "asset":
      return applyAssetHeaders(response, ctx, contentType);
  }
}

/**
 * The preview surface's ONE 404: a refused path, a missing object and a review
 * with nothing built in it are indistinguishable from outside.
 *
 * **No body, and that is the requirement rather than an omission.** A body here
 * would be the only place on this surface where a caller-supplied name could
 * travel, and the three cases have nothing to tell a caller that the status does
 * not already say. `text` is the shared policy's kind for "an answer that is not
 * a representation of anything", and it carries the hygiene quartet and
 * `Permissions-Policy` like every other response — a 404 is a response a browser
 * renders.
 *
 * `no-store` is set for the same reason as on a served object: an intermediary
 * that cached this would keep answering it after a push that published the
 * object.
 */
function previewNotFound(scope: RequestScope): Response {
  const response = new Response(null, { status: 404 });
  response.headers.set("cache-control", PREVIEW_CACHE_CONTROL);
  return withExtra(applyTextHeaders(response, scope.headers), scope);
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
