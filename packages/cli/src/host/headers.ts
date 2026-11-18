// `revkit host` adapter over the SHARED header policy
// (`@revkit/review-core/http-headers`, ADR-0012 + ADR-0025 amendment
// 2026-10-03).
//
// Mirrors `packages/cli/src/serve/headers.ts` but points at the
// configured public origin (ADR-0026 §"Plain Linux host / VM" →
// Request checks), not the daemon's loopback aliases. `script-src`,
// `worker-src` and `connect-src` all name the configured origin plus
// its `ws://` or `wss://` twin.
//
// What is NOT here: the ask-page, the per-request Astro bundle, the
// pagefind Worker. Those routes are not registered on the host target
// in this sub-issue of #195; adding them later adds one entry each,
// not a policy change.

import {
  applyResponseHeaders as applySharedResponseHeaders,
  type HeaderContext as SharedHeaderContext,
  type ResponseKind as SharedResponseKind,
} from "@revkit/review-core/http-headers";

export type ResponseKind = SharedResponseKind;

/** Script paths the host target serves — matches the daemon's set
 * except no `ASK_SCRIPT_URL_PATH` and no base-path prefix
 * (`rewritePathInHtml` adds the prefix to absolute references in
 * body HTML; `script-src` is written against the un-prefixed path
 * because the browser resolves absolute paths against origin, not
 * origin+base-path). */
const RAIL_SCRIPT_URL_PATH = "/-/rail.js";
const ASTRO_SCRIPTS_URL_PREFIX = "/_astro/";
const PAGEFIND_URL_PREFIX = "/pagefind/";

/** Inputs to the host target's header builder. */
export interface HostHeaderContext {
  /** Absolute public origin (`https://host[:port]`) the reverse
   * proxy exposes. */
  readonly publicOrigin: string;
  /** Configured base path (`"" | "/review"`). The `script-src`
   * directive names the browser-visible paths, so the base path
   * prefixes every scoped script path. */
  readonly basePath: string;
  /** SHA-256 hex digests of the inline scripts the running revkit
   * version allowlists (same source as the daemon). */
  readonly inlineScriptHashes: readonly string[];
}

/** Build the host-target CSP context. Exported for the test suite. */
function sharedContext(ctx: HostHeaderContext): SharedHeaderContext {
  const base = ctx.basePath;
  const wsTwin = ctx.publicOrigin.startsWith("https://")
    ? "wss://" + ctx.publicOrigin.slice("https://".length)
    : "ws://" + ctx.publicOrigin.slice("http://".length);
  return {
    scriptOrigins: [ctx.publicOrigin],
    scriptPaths: [
      base + RAIL_SCRIPT_URL_PATH,
      base + ASTRO_SCRIPTS_URL_PREFIX,
      base + PAGEFIND_URL_PREFIX,
    ],
    workerPaths: [base + PAGEFIND_URL_PREFIX],
    // Both the proxy scheme's origin AND its WebSocket twin — CSP L3
    // treats `'self'` as covering `ws://`/`wss://` on same origin,
    // but older WebKit builds predate that rule. One directive for
    // both the SSE fetch (same origin) and a future WebSocket.
    connectOrigins: [ctx.publicOrigin, wsTwin],
    inlineScriptHashes: ctx.inlineScriptHashes,
  };
}

/** Attach ADR-0012 headers to `response` using the host-target
 * context. Returns the same response mutated in place. */
export function applyHostResponseHeaders(
  response: Response,
  kind: ResponseKind,
  contentType: string | undefined,
  ctx: HostHeaderContext,
): Response {
  return applySharedResponseHeaders(response, kind, contentType, sharedContext(ctx));
}
