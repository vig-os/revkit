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
// **What this file is now.** A pure coordinate-mapping: the daemon's
// loopback origins, its script path conventions, and the position a
// route-specific bundle takes inside `script-src`. The policy itself —
// which directives exist, the hygiene quartet, the hex→base64
// conversion — moved to `@revkit/review-core` when the hosted Worker
// needed the same rules. Copying it would have been the third
// implementation of one security policy; importing it from
// `@revkit/cli/serve/headers` would have dragged the whole CLI into the
// Worker bundle for a dependency-free module.
//
// The daemon's emitted CSP is byte-for-byte what it was before the move.
// `test/serve/headers.test.ts` pins that, and the pinned literals were not
// edited in this refactor.
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

/** Inputs to the daemon's header builders. Unchanged in shape from
 * before the move to the shared policy: the daemon speaks in terms of
 * its own `port` and the allowlist the running revkit version ships. */
export interface HeaderContext {
  /** Loopback port the daemon bound to. */
  readonly port: number;
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

/** The two loopback origins the daemon's `isLoopbackHost` accepts —
 * `127.0.0.1:<port>` and `localhost:<port>`. `script-src`,
 * `worker-src` and the WebSocket `connect-src` list both so a page
 * opened at either origin loads the same set of assets under the
 * same policy. Kept small (two aliases only); a browser that opens
 * a foreign public IP whose DNS points at 127.0.0.1 fails the Host
 * check well before the CSP fires. */
function loopbackOrigins(port: number, scheme: "http" | "ws"): readonly string[] {
  return [`${scheme}://127.0.0.1:${port}`, `${scheme}://localhost:${port}`];
}

/** Map the daemon's `(port, allowlist)` context plus the response's
 * route-specific script paths onto the shared policy's inputs.
 *
 * **Order is load-bearing.** Before the move, `buildCspHeader` emitted
 * `RAIL`, then every `extraScriptPaths` entry, then `ASTRO`, then
 * `PAGEFIND`. Flattening that into one ordered `scriptPaths` list is
 * what keeps the emitted header byte-identical, so `RAIL` leads and
 * the extras sit second. */
function sharedContext(ctx: HeaderContext, extraScriptPaths: readonly string[]): SharedHeaderContext {
  return {
    scriptOrigins: loopbackOrigins(ctx.port, "http"),
    scriptPaths: [RAIL_SCRIPT_URL_PATH, ...extraScriptPaths, ASTRO_SCRIPTS_URL_PREFIX, PAGEFIND_URL_PREFIX],
    // Pagefind is the ONLY runtime the daemon serves a Worker for
    // today; naming the exact prefix means a future stored HTML that
    // tries `new Worker("/-/anything.js")` is refused by the browser
    // as a CSP violation, closing the narrowest hole a bare
    // `worker-src 'self'` would leave open. Same shape as script-src's
    // pagefind entry — one path scope, two aliases. (M2 item 5b
    // carry-over from #41 review.)
    workerPaths: [PAGEFIND_URL_PREFIX],
    // CSP L3 (Chromium >= 96, Firefox >= 99) treats `'self'` as covering
    // `ws://` on the same origin; the explicit `ws://` origins are for
    // older WebKit builds (ADR-0012 amendment 2026-09-30).
    connectOrigins: loopbackOrigins(ctx.port, "ws"),
    inlineScriptHashes: ctx.inlineScriptHashes,
  };
}

/** Build the daemon's Content-Security-Policy value for an HTML
 * response. See `@revkit/review-core/http-headers` for the directive
 * rationale; this function only supplies the daemon's coordinates. */
export function buildCspHeader(ctx: HeaderContext, extraScriptPaths: readonly string[] = []): string {
  return buildSharedCspHeader(sharedContext(ctx, extraScriptPaths));
}

/** Attach ADR-0012 headers to `response` given the response kind and
 * (optional) explicit content-type. Returns the same response
 * mutated in place — callers already treat `withHygiene` this way. */
export function applyResponseHeaders(
  response: Response,
  kind: ResponseKind,
  contentType: string | undefined,
  ctx: HeaderContext,
  extraScriptPaths: readonly string[] = [],
): Response {
  return applySharedResponseHeaders(response, kind, contentType, sharedContext(ctx, extraScriptPaths));
}
