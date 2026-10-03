// The hosted revkit Worker (ADR-0008; ADR-0025 surface (c)).
//
// One real `fetch` handler over one bound D1 database. Slice 1 ships:
//
//   GET  /healthz              liveness + the revkit version it runs
//   GET  /api/threads          the thread projection (review-core's)
//   GET  /api/threads?since=<n> the log since `n` (reconnect catch-up)
//   POST /api/threads          DISABLED, 501 — see the handler
//
// Everything else ADR-0008/0012/0025 imagine — previews from R2, invites,
// sessions, the GitHub App's `TokenSource`, Durable Object fan-out — is
// out of this slice, and `packages/worker/README.md` says so.
//
// ── ADR-0025's runtime gate ─────────────────────────────────────────────────
//
// This module imports `@revkit/review-core` and nothing else. It builds and
// runs inside workerd with `compatibility_flags: []` (no `nodejs_compat`),
// which is what makes "the same core serves all three surfaces" a
// measurement rather than an aspiration: `test/worker-runtime.test.ts`
// bundles THIS file for the workers runtime, dispatches it through a real
// workerd, and pins both `/healthz` and a `revisionOf()` evaluated inside
// the runtime against a literal digest computed on a third one.
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

import { D1ThreadStore } from "./d1-store.ts";
import {
  applyJsonHeaders,
  applyTextHeaders,
  REQUEST_ID_HEADER,
  requestOrigin,
  workerHeaderContext,
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

/** Stamp the request id on every response, whatever produced it. */
function tag(response: Response, scope: RequestScope): Response {
  response.headers.set(REQUEST_ID_HEADER, scope.requestId);
  return response;
}

/** A JSON response with ADR-0012 hygiene headers and the request id.
 * Built explicitly rather than via `Response.json(body, init)`: bun's and
 * `@cloudflare/workers-types`' declarations of that static disagree on its
 * arity, and a serialise-then-set sequence has no such disagreement. */
function json(body: unknown, status: number, scope: RequestScope): Response {
  const response = new Response(`${JSON.stringify(body)}\n`, { status });
  return tag(applyJsonHeaders(response, scope.headers), scope);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const scope = beginRequest(request, env);
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    try {
      scope.logger.log("info", "request.start", { method, path: url.pathname });

      if (url.pathname === "/healthz") {
        // `HEAD` is the same handler with the body dropped by the
        // platform; method-insensitivity here is deliberate so a health
        // probe written either way works.
        if (method !== "GET" && method !== "HEAD") {
          return json({ error: "method-not-allowed" }, 405, scope);
        }
        return json({ ok: true, revkitVersion: env.REVKIT_VERSION, requestId: scope.requestId }, 200, scope);
      }

      if (url.pathname === "/api/threads") {
        return handleThreads(request, method, env, scope);
      }

      // ADR-0012: `/_revkit/` NEVER redirects — a browser drops the path
      // part of a CSP source after a redirect, which would widen
      // `script-src`. Slice 1 serves no bundle (that is slice 3, with
      // R2), so the honest answer is a 404 rather than a redirect, and
      // this branch is what guarantees no future redirect can creep in
      // here by accident.
      if (isRevkitBundlePath(url.pathname)) {
        return json({ error: "not-found", note: "revkit bundle serving lands in M4 slice 3" }, 404, scope);
      }

      // The path grammar is live and tested, but serving a preview needs
      // R2 (slice 5) and the ADR-0012 extension allowlist (slice 3). A
      // recognised preview path answers 501 so the routing is honest
      // about which slice owns it.
      if (parsePreviewPath(url.pathname) !== undefined) {
        return json({ error: "not-implemented", enabledIn: "M4 slice 5 (R2 preview serving)" }, 501, scope);
      }

      return json({ error: "not-found" }, 404, scope);
    } catch (error) {
      // The request id is in the log line AND in the response, so a
      // reviewer can quote it (ADR-0020). The message stays generic: an
      // error string can carry a SQL fragment or a path, and this
      // response is readable by whoever reached the Worker.
      scope.logger.log("error", "request.error", {
        error: error instanceof Error ? error.name : typeof error,
        path: url.pathname,
      });
      return tag(
        applyTextHeaders(
          new Response("internal error\n", { status: 500 }),
          scope.headers,
        ),
        scope,
      );
    } finally {
      scope.logger.log("info", "request.end", { path: url.pathname });
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

async function handleThreads(
  request: Request,
  method: string,
  env: Env,
  scope: RequestScope,
): Promise<Response> {
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
