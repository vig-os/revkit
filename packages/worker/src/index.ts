// The hosted revkit Worker (ADR-0008; ADR-0025 surface (c)).
//
// One real `fetch` handler over one bound D1 database. The shipped HTTP
// surface is:
//
//   GET|HEAD /healthz               200 — liveness + the version it runs
//   ANY    /healthz (other verbs)   405
//   GET|HEAD /api/threads           200 — behind ADR-0012's per-request gate
//   GET    /api/threads?since=<n>   200 — the delta since the caller's head
//   POST   /api/session/refresh     200 — rotate the caller's own session
//   POST   /api/threads             501 — see below
//   ANY    /api/* (other verbs)     405, behind the gate
//   ANY    /_revkit/…               404 — never a redirect (ADR-0012)
//   ANY    <repo>/pr-<n>/…          501 — behind the gate; slice 5 serves it
//   ANY    anything else            404
//
// ── ADR-0012's per-request authorization gate ─────────────────────────────
//
// Every route except `/healthz` and the 404s passes through
// `authorizeRequest` (`src/authz.ts`), which resolves the session cookie BY
// DIGEST against D1 and refuses when the row is missing, expired, or carries
// an identity kind this build does not recognise. On a state-changing verb it
// additionally requires the per-session CSRF token in `x-revkit-csrf` and
// `application/json`. Slice 1 closed `GET /api/threads` with a 501 precisely
// because none of that existed; it is open now, and `GET` is the larger of the
// two exposures it was protecting — an open read needs no browser, no user
// interaction and no bypass at all, and it returns comment bodies, which is
// what ADR-0015 protects.
//
// **What "authorized" means here, stated narrowly so it is not read as more
// than it is:** a session this build issued is presenting, unexpired. It does
// NOT yet mean "has read access to the repo" or "an invite's scope, type and
// expiry were checked", because there is no `TokenSource` (the App is
// owner-gated, #34), no invite (slice 3) and — because `events(seq, ts,
// payload)` has no `repo` column — no axis for a scope check to select on.
// The two missing clauses and the slice that owns each are in ADR-0012's
// 2026-10-04 amendment. This is a NECESSARY condition, and calling it
// sufficient would be the same overclaim slice 1 corrected twice.
//
// ── Where a session comes from in this slice ──────────────────────────────
//
// `issueSession` (`src/session.ts`) has no HTTP caller, deliberately. It is
// invoked out of band by whoever holds write access to the D1 database — in
// production that is `revkit deploy init` (slice 8), in tests the harness —
// and it mints the `operator` identity kind. The alternative, a
// `POST /api/session` guarded by a deployment secret, would add an
// unauthenticated endpoint to the shipped surface that cannot even be built
// offline (a Worker secret needs provisioning, #34). An unreachable control is
// worse than an honest "the operator mints it". ADR-0009's real providers —
// the GitHub App and invite links — arrive in slices 4 and 3 and each adds an
// arm to `RECOGNISED_IDENTITY_KINDS`, which is closed here on purpose.
//
// ── ADR-0025's runtime gate, now on the SHIPPED artefact ─────────────────
//
// Unlike slice 1, this entry DOES import `@revkit/review-core`: `GET
// /api/threads` constructs a real `D1ThreadStore` and reduces a real log, so
// the bundler pulls the whole core graph into the deployed Worker. That makes
// the bundle ~790 KB again and it means ADR-0025's "the same core serves all
// three surfaces" is now true of the code that will actually be deployed, not
// only of a test probe. `test/worker-runtime.test.ts` asserts the shipped
// bundle both CLEAN (no Node/Bun escape hatches) and NON-VACUOUS (it contains
// named core exports) — the two together are what make the scan mean
// something. The runtime probe (`test/fixtures/runtime-probe.ts`) stays as the
// second runtime the graph is EXECUTED in rather than merely bundled for.
//
// ── `POST /api/threads` is still 501, on purpose ──────────────────────────
//
// ADR-0012's CSRF and `application/json` rules are only meaningful if a
// state-changing call is reachable, and `POST /api/session/refresh` is the
// smallest route that gives them a real end-to-end path: it writes nothing
// but the caller's own `sessions` row. `POST /api/threads` needs the bridge
// and the hosted write shape, which is slice 4, so it stays 501 rather than
// shipping a write whose failure modes have not been reviewed.
//
// ── `workers_dev: false` ──────────────────────────────────────────────────
//
// A TRIPWIRE, never an authorization check, and it says so in
// `wrangler.jsonc` too. It means there is no `*.workers.dev` URL, so a mistake
// here is not immediately public. It evaporates the moment a `routes` entry
// arrives, and it never applied to `wrangler dev --remote`. The authorization
// this Worker performs is what `src/authz.ts` does, per request, and
// `test/authorization.test.ts` drives its refusals through real workerd
// requests.

import {
  authorizeRequest,
  classifyRoute,
  denialLogMessage,
  type AuthorizedSession,
  type Route,
} from "./authz.ts";
import { D1ThreadStore } from "./d1-store.ts";
import {
  applyJsonHeaders,
  applyTextHeaders,
  REQUEST_ID_HEADER,
  requestOrigin,
  workerHeaderContext,
  type HeaderContext,
} from "./headers.ts";
import { createLogger, newRequestId, type Logger } from "./logger.ts";
import { parseThreadsQuery } from "./router.ts";
import { SessionAlreadyRotatedError, rotateSession, CSRF_HEADER } from "./session.ts";

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
 * `extra` carries the headers a route must set itself — today only
 * `POST /api/session/refresh`'s `Set-Cookie` and its fresh CSRF token, which
 * are per-response credentials and so cannot live in the shared policy. They
 * go through here rather than being set on the returned object so that every
 * JSON response provably passes `applyJsonHeaders` (and therefore gets
 * `Cache-Control: no-store`, which a `Set-Cookie` response must carry).
 */
function json(body: unknown, status: number, scope: RequestScope, extra?: Readonly<Record<string, string>>): Response {
  const response = new Response(`${JSON.stringify(body)}\n`, { status });
  for (const [name, value] of Object.entries(extra ?? {})) response.headers.set(name, value);
  return tag(applyJsonHeaders(response, scope.headers), scope.requestId);
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
        const response = handleOpen(route, request, env, scope);
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
 * Routes that need no session. `/healthz` (a liveness probe that reads no
 * database and returns no review content), the `/_revkit/` bundle path
 * (ADR-0012: never a preview, never a redirect), and the 404 for everything
 * else. Nothing here can return review data, which is the whole reason these
 * three are exempt rather than an oversight.
 */
function handleOpen(route: Route, request: Request, env: Env, scope: RequestScope): Response {
  switch (route.kind) {
    case "health": {
      // A `HEAD` probe takes this same branch; the platform drops the body
      // afterwards. The method check below is deliberate, so a health probe
      // written either way works.
      if (route.unsupportedMethod) return json({ error: "method-not-allowed" }, 405, scope);
      return json({ ok: true, revkitVersion: env.REVKIT_VERSION, requestId: scope.requestId }, 200, scope);
    }
    case "revkit-bundle":
      return json({ error: "not-found", note: "revkit bundle serving lands in M4 slice 3" }, 404, scope);
    case "unknown":
      return json({ error: "not-found" }, 404, scope);
    default:
      return unreachable(route);
  }
}

/**
 * Every route that requires a session, reached only with a
 * `decision.authorized` in hand. `authorized` is not used here except to log
 * the identity kind — and it is not LOGGED AS AN ID: `identity_kind` is a
 * closed vocabulary of provider names (`operator` today), never an identity,
 * so this line cannot carry personal data (ADR-0020, ADR-0015). The session
 * id the request carried is not passed to `scope.logger` at all, and
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
 * A gated route kind this dispatcher does not handle. Unreachable by
 * construction — `classifyRoute` returns `requiresSession: true` only for
 * the five kinds `handleAuthorized` switches over — so reaching it is a bug
 * in `classifyRoute`, not a caller error. It throws rather than returning
 * something plausible: the error boundary turns it into a 500 with full ADR-
 * 0012 hygiene, which is the correct outcome for "the router and the
 * dispatcher disagree".
 */
function unreachable(route: Route): never {
  throw new Error(`unreachable route kind: ${route.kind} (requiresSession=${String(route.requiresSession)})`);
}
