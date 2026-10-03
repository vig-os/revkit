// The hosted revkit Worker (ADR-0008; ADR-0025 surface (c)).
//
// One real `fetch` handler over one bound D1 database. The entire shipped
// HTTP surface is:
//
//   GET  /healthz       200, liveness + the revkit version it runs
//   ANY  /api/threads   501 — every verb, read and write (see below)
//
// plus a 404 for anything else and a 501 for a recognised preview path. So
// the honest one-line description is: one JSON line, two 501s, a 404.
//
// Everything else ADR-0008/0012/0025 imagine — previews from R2, invites,
// sessions, the GitHub App's `TokenSource`, Durable Object fan-out — is
// out of this slice, and `packages/worker/README.md` says so.
//
// ── ADR-0025's runtime gate, stated precisely ──────────────────────────────
//
// **This module does NOT import `@revkit/review-core`, and the shipped
// bundle does not contain it.** Closing `/api/threads` removed the only code
// path that reached `D1ThreadStore`, so the bundler tree-shook
// `d1-store.ts` — and with it the whole core graph — out of this entry:
// ~21 KB, against ~790 KB while that route was open. An earlier version of
// this header claimed the opposite, and claimed A4's scan of this artefact
// as evidence for it; the scan was clean because there was nothing in it to
// find. Do not infer from this file that the hosted Worker runs the core
// today. It does not, yet.
//
// What IS proven, and where: ADR-0025's "the same core serves all three
// surfaces" is measured in `test/worker-runtime.test.ts` against the RUNTIME
// PROBE (`test/fixtures/runtime-probe.ts`), which imports
// `@revkit/review-core` and this package's `d1-store.ts` and is dispatched
// through its own miniflare with the same empty `compatibility_flags`. It
// pins `revisionOf()` evaluated INSIDE workerd against a literal digest, and
// runs the full D1 -> `exportArchive` -> in-memory bridge there. That probe
// is the same graph this entry would pull in the moment a route needs it.
//
// Both bundles are scanned for Node/Bun escape hatches, and the probe's is
// additionally asserted to CONTAIN the core so the scan cannot be vacuous.
//
// ── ADR-0012 on day one ────────────────────────────────────────────────────
//
// `/api/threads` answers **501 for every verb**, read and write. ADR-0012
// requires authorization on EVERY request — a GitHub session must still have
// read access to the repo, a guest invite must be checked for scope, type and
// expiry — and slice 1 has neither a session nor a `TokenSource` to
// authorize with. Shipping either verb would put a documented ADR-0012
// violation in the first line of hosted code, in the one ADR whose subject is
// "do not do this". See `handleThreads`'s own header for why the READ is the
// larger of the two exposures.
//
// Read and append are still fully proven — just not over HTTP. The shared
// conformance suite (`packages/review-core/test/store-conformance.ts`) runs
// the same 19 cases against all three `ThreadStore` implementations, and
// `test/d1-store.test.ts` proves the `?since=` catch-up and the
// `exportArchive`/`import` bridge between D1 and an in-memory store.
//
// `workers_dev: false` in `wrangler.jsonc` stays as DEFENCE IN DEPTH, and
// nothing more: it means there is no `*.workers.dev` URL, so a mistake here
// is not immediately public. It is a tripwire, NOT an authorization check —
// it evaporates the moment slice 3 or slice 5 adds a `routes` entry, and it
// never held for `wrangler dev --remote`. The authorization this Worker
// actually performs is: none.

import {
  applyJsonHeaders,
  applyTextHeaders,
  REQUEST_ID_HEADER,
  requestOrigin,
  workerHeaderContext,
  type HeaderContext,
} from "./headers.ts";
import { createLogger, newRequestId, type Logger, type LogMessage } from "./logger.ts";
import { isRevkitBundlePath, parsePreviewPath } from "./router.ts";

// NOTE: this module exports its DEFAULT ONLY. A Worker entry may export
// nothing but handlers — miniflare refuses a runtime with
// "Incorrect type for map entry 'X': the provided value is not of type
// 'function or ExportedHandler'", and so does `wrangler deploy`. That is
// why `REQUEST_ID_HEADER` lives in `headers.ts` rather than here, and why
// `applyHtmlHeaders` is not re-exported: both were failures first time.
// The COMMITTED, reviewed inline-script hash allowlist the running revkit
// version ships (ADR-0012's "the Worker applies the allowlist of the revkit
// version it runs, never hashes found in an artifact"). It lives in the CLI
// package because that is where the release artefact is built and where
// `check-dist` enforces it, and this import crosses the package line on
// purpose: a second copy would be a second `script-src` policy, which is
// the failure ADR-0025 exists to prevent. Nothing the SERVED content
// carries is ever consulted — `test/headers.test.ts` plants a hostile
// `sha256-…` in a fake artefact and asserts it never reaches the header.
import ALLOWLIST_JSON from "../../cli/src/dist-check-allowlist.json" with { type: "json" };

/** The bindings this Worker needs. `DB` is the D1 database named in
 * `wrangler.jsonc`; `REVKIT_VERSION` is a plain (non-secret) var the
 * release train pins, asserted against `packages/cli/package.json` by
 * `test/worker-config.test.ts` so the two cannot drift (ADR-0021). */
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
 * arity, and a serialise-then-set sequence has no such disagreement. */
function json(body: unknown, status: number, scope: RequestScope): Response {
  const response = new Response(`${JSON.stringify(body)}\n`, { status });
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
    try {
      // INSIDE the boundary. `beginRequest` builds the header context and
      // throws on a missing `REVKIT_VERSION`; that used to happen before
      // this `try`, so the catch never ran and workerd returned its own
      // error page — a stack trace and a store path in the response body.
      // `test/worker-runtime.test.ts` now drives exactly that deploy.
      scope = beginRequest(request, env);
      const url = new URL(request.url);
      scope.logger.log("info", "request.start", { method, path });

      if (path === "/healthz") {
        // `HEAD` is the same handler with the body dropped by the
        // platform; method-insensitivity here is deliberate so a health
        // probe written either way works.
        if (method !== "GET" && method !== "HEAD") {
          return json({ error: "method-not-allowed" }, 405, scope);
        }
        return json({ ok: true, revkitVersion: env.REVKIT_VERSION, requestId: scope.requestId }, 200, scope);
      }

      if (path === "/api/threads") {
        return handleThreads(method, scope);
      }

      // ADR-0012: `/_revkit/` NEVER redirects — a browser drops the path
      // part of a CSP source after a redirect, which would widen
      // `script-src`. Slice 1 serves no bundle (that is slice 3, with
      // R2), so the honest answer is a 404 rather than a redirect, and
      // this branch is what guarantees no future redirect can creep in
      // here by accident.
      if (isRevkitBundlePath(path)) {
        return json({ error: "not-found", note: "revkit bundle serving lands in M4 slice 3" }, 404, scope);
      }

      // The path grammar is live and tested, but serving a preview needs
      // R2 (slice 5) and the ADR-0012 extension allowlist (slice 3). A
      // recognised preview path answers 501 so the routing is honest
      // about which slice owns it.
      if (parsePreviewPath(path) !== undefined) {
        return json({ error: "not-implemented", enabledIn: "M4 slice 5 (R2 preview serving)" }, 501, scope);
      }

      return json({ error: "not-found" }, 404, scope);
    } catch (error) {
      // The request id is in the log line AND in the response, so a
      // reviewer can quote it (ADR-0020). The message stays generic: an
      // error string can carry a SQL fragment, a stack or an absolute
      // store path, and this response is readable by whoever reached the
      // Worker.
      const requestId = scope?.requestId ?? newRequestId();
      (scope?.logger ?? fallbackLogger(requestId)).log("error", "request.error", {
        error: error instanceof Error ? error.name : typeof error,
        path,
      });
      return tag(
        applyTextHeaders(new Response("internal error\n", { status: 500 }), scope?.headers ?? ERROR_HEADER_CONTEXT),
        requestId,
      );
    } finally {
      scope?.logger.log("info", "request.end", { path });
    }
  },
} satisfies ExportedHandler<Env>;

/** Everything under `/api/threads` is DISABLED in slice 1 — read AND
 * write. Both verbs answer the same 501 with the same body shape, and both
 * name the slice that enables them.
 *
 * **Why GET is closed too.** An earlier revision left `GET` open and argued
 * that ADR-0012's CSRF rule does not bite a read. That argument was wrong
 * twice over. ADR-0012 requires **"Authorization per request"** — a GitHub
 * session must still have read access to the repo, an invite must be checked
 * for scope/type/expiry — and that is unconditional, so it applies verbatim
 * to `GET`. And the read is the LARGER exposure: a state-changing call at
 * least has CSRF to stop a cross-origin forgery, whereas an open `GET` needs
 * no browser, no user interaction and no bypass at all — and it returns
 * comment bodies, which is exactly what ADR-0015 protects.
 *
 * **What is NOT lost.** Read and append stay fully proven, just not over
 * HTTP: `packages/review-core/test/store-conformance.ts` runs the same 19
 * cases against all three stores, and `test/d1-store.test.ts` proves the
 * `?since=` log catch-up and the `exportArchive`/`import` bridge in both
 * directions between D1 and an in-memory store.
 *
 * ENABLED BY: M4 slice 2 — invite links + session exchange, which is where
 * ADR-0012's per-session authorization (and its CSRF token) becomes real.
 * The `GET` branch then checks the caller's session and repo access before
 * constructing a store; the `POST` branch additionally checks the CSRF
 * token before touching `append`. */
function disabled(scope: RequestScope, msg: LogMessage, detail: string): Response {
  scope.logger.log("info", msg, {});
  return json(
    {
      error: "not-implemented",
      enabledIn: "M4 slice 2 (invite links, sessions + ADR-0012 per-request authorization)",
      detail,
    },
    501,
    scope,
  );
}

async function handleThreads(method: string, scope: RequestScope): Promise<Response> {
  if (method === "GET") {
    return disabled(
      scope,
      "api.threads.read.disabled",
      "ADR-0012 requires authorization on every request; slice 1 has no session, so the read is closed rather than exposed.",
    );
  }

  if (method === "POST") {
    return disabled(
      scope,
      "api.threads.append.disabled",
      "ADR-0012 requires a per-session CSRF token on every state-changing call; slice 1 has no session.",
    );
  }

  return json({ error: "method-not-allowed" }, 405, scope);
}
