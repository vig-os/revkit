// Daemon adapter over the SHARED header policy
// (`@revkit/review-core/http-headers`, ADR-0012 + ADR-0025 amendment
// 2026-10-03).
//
// One place composes every header the daemon attaches to a response
// (issue #22, M2 half of item 8): the ADR-0012 Content-Security-Policy,
// `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
// the cross-origin isolation pair (`COOP`, `CORP`), a
// `Permissions-Policy` that denies the powerful features the daemon UI
// never asks for, and per-kind `Cache-Control`.
//
// **What this file is now.** A pure coordinate-mapping: the CSP origin
// allowlists the active guard policy exposes (`guardPolicy.cspOrigins`,
// ADR-0025 one core + ADR-0026 §"Plain Linux host / VM"), the script
// path conventions, and the position a route-specific bundle takes
// inside `script-src`. The policy itself — which directives exist, the
// hygiene quartet, the hex→base64 conversion — lives in
// `@revkit/review-core` so the hosted Worker (D2) runs the same rules.
//
// Before #245 the context carried a `port` from which loopback origins
// were derived inline. That worked for the local daemon but silently
// pinned the CSP to loopback on the Linux-host target too: a reverse-
// proxied reviewer loading `https://host.example/review/…` would have
// received a CSP whose `script-src` named `http://127.0.0.1:…`,
// refused by the browser. The context now takes `scriptOrigins` /
// `connectOrigins` directly — the local daemon passes the loopback
// aliases (byte-for-byte unchanged via `guardPolicy.cspOrigins`); the
// host target passes its configured public origin and its `ws://`
// twin.
//
// This module remains pure — `buildCspHeader` and
// `applyResponseHeaders` return values only, so a unit test drives them
// without spinning up a daemon. The daemon calls
// `applyResponseHeaders` from a single wrapper (`withHygiene`) so every
// branch — static, API, SSE, WebSocket handshake, auth exchange, error
// responses — carries the same set.
//
// The script-path decision (ADR-0013 amendment 2026-09-30): the daemon
// KEEPS `/-/rail.js` for the rail bundle. The `/_revkit/<version>/`
// convention in ADR-0012 is a HOSTED origin concern (many co-tenant
// preview paths share one origin), and the local daemon serves one
// project at a time from an isolated loopback origin. `script-src`
// still names the exact path — `/-/rail.js`, `/_astro/`, and
// `/pagefind/` — so a stored HTML with any other script src is refused
// by the browser as a policy violation.

import {
  applyResponseHeaders as applySharedResponseHeaders,
  buildCspHeader as buildSharedCspHeader,
  buildMinimalCspHeader,
  hexToBase64,
  permissionsPolicyValue,
  type HeaderContext as SharedHeaderContext,
  type ResponseKind as SharedResponseKind,
} from "@revkit/review-core/http-headers";

export { buildMinimalCspHeader, hexToBase64, permissionsPolicyValue };

/** Kind of response the daemon is about to return. Re-exported from the
 *  shared policy so the daemon and the Worker agree on one vocabulary. */
export type ResponseKind = SharedResponseKind;

/** Inputs to the daemon's header builders. #245: `scriptOrigins` /
 * `connectOrigins` are passed in directly instead of derived from a
 * `port`, so the host target can emit a CSP keyed on its configured
 * public origin instead of the loopback port. The local daemon passes
 * `guardPolicy.cspOrigins.http` / `guardPolicy.cspOrigins.ws` from the
 * loopback policy — the two loopback aliases, byte-for-byte unchanged
 * from before. */
export interface HeaderContext {
  /** Origins named in the CSP's `script-src` (and `worker-src`). For
   * the local target these are the two loopback aliases; for the host
   * target this is the configured public origin only (one entry). The
   * daemon derives this from `guardPolicy.cspOrigins.http`. */
  readonly scriptOrigins: readonly string[];
  /** Origins named in the CSP's `connect-src`, after the implicit
   * `'self'`. Covers the WebSocket twin of each `scriptOrigins`
   * entry. Derived from `guardPolicy.cspOrigins.ws`. */
  readonly connectOrigins: readonly string[];
  /** Distinct SHA-256 hex digests of the inline scripts allowed by
   * the running revkit version. These come from the COMMITTED,
   * reviewed set (`packages/cli/src/dist-check-allowlist.json`), not
   * from anything the served dir carries — ADR-0012's rule "the daemon
   * applies the allowlist of the revkit version it runs, never hashes
   * found in an artifact". */
  readonly inlineScriptHashes: readonly string[];
}

/** Where the rail bundle lives on the daemon. Kept as a constant so
 *  the header builder and `rail/injector.ts` agree on one spelling. */
export const RAIL_SCRIPT_URL_PATH = "/-/rail.js";

/** Where the `/ask/<id>` page bundle lives. Same shape as the rail:
 * a compiled Solid bundle served from an exact daemon path so
 * `script-src` names it verbatim. Kept alongside `RAIL_SCRIPT_URL_PATH`
 * so a future third bundle adds one line here + one entry per alias
 * in `buildCspHeader` rather than a copy-paste of the whole loop.
 * (M2 item 7, story A1.)
 *
 * PR #52 review — this path is NOT in the base CSP applied to every
 * HTML response; the daemon adds it only to the `/ask/<id>` response
 * via `applyResponseHeaders(..., extraScriptPaths)`. That keeps
 * every other page's `script-src` tighter (a stored HTML that tries
 * `<script src="/-/ask.js">` is refused by the browser). */
export const ASK_SCRIPT_URL_PATH = "/-/ask.js";

/** Astro's chunk directory — every static JS asset a page loads via
 * `<script src>` starts with this prefix (`check-dist.ts` enforces the
 * same on the built HTML). */
export const ASTRO_SCRIPTS_URL_PREFIX = "/_astro/";

/** Starlight ships client-side search via pagefind, which loads
 * `/pagefind/pagefind.js` and spawns a Worker fetching `.pagefind`
 * / `.pf_meta` / `.pf_fragment` / `.pf_index` / `.pf_filter` and a
 * WebAssembly blob. `script-src` and `worker-src` allow the whole
 * `/pagefind/` prefix; the WASM instantiation gets `'wasm-unsafe-eval'`
 * (the narrow WASM-only keyword — not `'unsafe-eval'`, which would
 * allow `eval` / `new Function()` on any script). */
export const PAGEFIND_URL_PREFIX = "/pagefind/";

/** Map the daemon's context (policy-derived origins plus the response's
 * route-specific script paths) onto the shared policy's inputs.
 *
 * **Order is load-bearing.** Before the move, `buildCspHeader` emitted
 * `RAIL`, then every `extraScriptPaths` entry, then `ASTRO`, then
 * `PAGEFIND`. Flattening that into one ordered `scriptPaths` list is
 * what keeps the emitted header byte-identical, so `RAIL` leads and
 * the extras sit second. */
function sharedContext(
  ctx: HeaderContext,
  extraScriptPaths: readonly string[],
  scriptPathPrefix: string,
): SharedHeaderContext {
  const prefixed = (path: string): string => scriptPathPrefix + path;
  return {
    scriptOrigins: ctx.scriptOrigins,
    scriptPaths: [
      prefixed(RAIL_SCRIPT_URL_PATH),
      ...extraScriptPaths.map(prefixed),
      prefixed(ASTRO_SCRIPTS_URL_PREFIX),
      prefixed(PAGEFIND_URL_PREFIX),
    ],
    // Pagefind is the ONLY runtime the daemon serves a Worker for
    // today; naming the exact prefix means a future stored HTML that
    // tries `new Worker("/-/anything.js")` is refused by the browser
    // as a CSP violation, closing the narrowest hole a bare
    // `worker-src 'self'` would leave open. Same shape as script-src's
    // pagefind entry — one path scope, every configured origin. (M2
    // item 5b carry-over from #41 review.)
    workerPaths: [prefixed(PAGEFIND_URL_PREFIX)],
    // CSP L3 (Chromium >= 96, Firefox >= 99) treats `'self'` as covering
    // `ws://` on the same origin; the explicit `ws://` origins are for
    // older WebKit builds (ADR-0012 amendment 2026-09-30).
    connectOrigins: ctx.connectOrigins,
    inlineScriptHashes: ctx.inlineScriptHashes,
  };
}

/** Build the daemon's Content-Security-Policy value for an HTML
 * response. See `@revkit/review-core/http-headers` for the directive
 * rationale; this function only supplies the daemon's coordinates.
 *
 * `scriptPathPrefix` is the deployment's base path (e.g. `/review`)
 * prepended to every daemon-served script path so the CSP matches
 * what the browser actually requests under a sub-path deployment.
 * Empty on the root deployment (default). */
export function buildCspHeader(
  ctx: HeaderContext,
  extraScriptPaths: readonly string[] = [],
  scriptPathPrefix: string = "",
): string {
  return buildSharedCspHeader(sharedContext(ctx, extraScriptPaths, scriptPathPrefix));
}

/** Attach ADR-0012 headers to `response` given the response kind and
 * (optional) explicit content-type. Returns the same response
 * mutated in place — callers already treat `withHygiene` this way.
 *
 * `scriptPathPrefix` is the deployment's base path prepended to every
 * daemon-served script path; see `buildCspHeader` above. */
export function applyResponseHeaders(
  response: Response,
  kind: ResponseKind,
  contentType: string | undefined,
  ctx: HeaderContext,
  extraScriptPaths: readonly string[] = [],
  scriptPathPrefix: string = "",
): Response {
  return applySharedResponseHeaders(
    response,
    kind,
    contentType,
    sharedContext(ctx, extraScriptPaths, scriptPathPrefix),
  );
}
