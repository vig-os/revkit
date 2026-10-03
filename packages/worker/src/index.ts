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
// The state-changing endpoint is DELIBERATELY DISABLED. ADR-0012 requires
// a per-session CSRF token in a header on every state-changing call, and
// slice 1 has no session — no invite has been minted, no cookie issued,
// no CSRF token exists to check. Shipping `POST` anyway would put a
// documented ADR-0012 violation in the first line of hosted code, in the
// one ADR whose subject is "do not do this". Append is therefore proven
// through `test/store-conformance.test.ts` against the same `D1ThreadStore`
// object this handler constructs, which tests the code path without
// opening an unauthorised one. **Slice 2 (invite links + session exchange,
// which is where ADR-0012's CSRF token becomes real) removes the 501.**
//
// Reading is `GET`, so ADR-0012's CSRF rule does not bite — but its
// per-request AUTHORIZATION rule does, and slice 1 has no `TokenSource` to
// authorise with. That gap is closed structurally rather than by a comment:
// `wrangler.jsonc` sets `workers_dev: false` and declares no `routes`, so
// this Worker has no public URL until `revkit deploy init` provisions one,
// and provisioning is owner-gated (#34) and sequenced after slice 2's
// sessions. See the residual-risk note in the PR body — the gap is real and
// the mitigation is a config flag, not an authentication check.

import { D1ThreadStore } from "./d1-store.ts";
import {
  applyJsonHeaders,
  applyTextHeaders,
  REQUEST_ID_HEADER,
  requestOrigin,
  workerHeaderContext,
} from "./headers.ts";
import { createLogger, newRequestId, type Logger } from "./logger.ts";
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
        return await handleThreads(request, method, url, env, scope);
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

async function handleThreads(
  request: Request,
  method: string,
  url: URL,
  env: Env,
  scope: RequestScope,
): Promise<Response> {
  if (method === "GET") {
    const store = new D1ThreadStore({ db: env.DB });
    const sinceParam = url.searchParams.get("since");
    if (sinceParam === null) {
      // No `since`: the caller wants the derived view.
      const threads = await store.threads();
      return json({ head: store.head(), threads }, 200, scope);
    }
    // `since=<n>`: the caller is reconnecting and wants the log. The two
    // shapes are separate on purpose — `since` is the store's own method
    // name, and a response that mixed a projection into a log catch-up
    // would force every client to know which half it wanted.
    const parsed = Number.parseInt(sinceParam, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      return json({ error: "bad-request", detail: "since must be a non-negative integer" }, 400, scope);
    }
    const events = await store.since(parsed);
    return json({ head: store.head(), events }, 200, scope);
  }

  if (method === "POST") {
    // DISABLED — see the module header. ADR-0012 requires a per-session
    // CSRF token on every state-changing call, and no session exists in
    // slice 1. Append is proven against the same `D1ThreadStore` in
    // `test/store-conformance.test.ts`.
    //
    // ENABLED BY: M4 slice 2 — invite links + session exchange, which is
    // where ADR-0012's per-session CSRF token becomes real. This branch
    // then checks the token and the session's identity before touching
    // `append`.
    scope.logger.log("info", "api.threads.append.disabled", {});
    return json(
      {
        error: "not-implemented",
        enabledIn: "M4 slice 2 (invite links + ADR-0012 per-session CSRF)",
        detail: "ADR-0012 requires a per-session CSRF token on every state-changing call; slice 1 has no session.",
      },
      501,
      scope,
    );
  }

  return json({ error: "method-not-allowed" }, 405, scope);
}
