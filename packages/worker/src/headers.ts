// Worker adapter over the SHARED header policy
// (`@revkit/review-core/http-headers`, ADR-0012 + ADR-0025 amendment
// 2026-10-03).
//
// The difference from the daemon's adapter is exactly one thing, and it
// is the difference ADR-0012 draws: where scripts come from.
//
//   daemon  — loopback origins, `/-/rail.js`, `/_astro/`, `/pagefind/`
//   Worker  — the revkit-owned `/_revkit/<version>/`, ONE path, on the
//             origin the request was actually addressed to
//
// Everything else — the directive set, the hygiene quartet, the
// Permissions-Policy denials, the hex->base64 hash conversion — is the
// shared module's, so a change to the policy cannot land on one surface
// and miss the other.
//
// **`script-src` names a version, never an alias.** ADR-0012 is explicit
// that `/_revkit/` never redirects (a browser drops the path part of a
// CSP source after a redirect, which would widen `script-src`) and that
// only the CURRENT version is listed, so a page cannot load an older,
// possibly vulnerable bundle. So `revkitBundlePath` refuses a version
// with a trailing slash and refuses the literal `latest`, and the test
// asserts both.
//
// **Why the origin comes from the request.** ADR-0008 makes the hostname
// a configuration value (one Worker per org), so it cannot be a constant
// in the source. Deriving it from `request.url` cannot widen `script-src`
// beyond what the document was already loaded from: an origin that can
// serve this Worker can already serve its own scripts there. The
// version-scoped PATH is the part ADR-0012 constrains, and that is
// fixed.

import {
  applyResponseHeaders,
  buildMinimalCspHeader,
  type HeaderContext,
  type ResponseKind,
} from "@revkit/review-core/http-headers";
import { REVKIT_BUNDLE_ROOT } from "./router.ts";

export { REVKIT_BUNDLE_ROOT };

/** Path prefix revkit's own release serves scripts and styles from, for
 * one exact version. `revkitBundlePath("1.4.0")` ->
 * `/_revkit/1.4.0/`. */
export function revkitBundlePath(version: string): string {
  if (version.length === 0 || version === "latest" || version.endsWith("/")) {
    throw new Error(`revkitBundlePath: refusing a non-version or redirecting alias: ${JSON.stringify(version)}`);
  }
  return `${REVKIT_BUNDLE_ROOT}${version}/`;
}

/** The Worker-side header context for one response.
 *
 * `scriptPaths` is the single versioned bundle path plus `/` for
 * co-located chunks, because revkit's release emits its chunks beside the
 * entry rather than under an `/_astro/` directory revkit does not own.
 * `workerPaths` is empty: slice 1 serves no Web Worker, and an empty list
 * makes the shared policy omit `worker-src` entirely rather than emit a
 * `worker-src 'self'` that would permit a stored HTML to start one from
 * any path on the origin.
 *
 * `inlineScriptHashes` comes from the CALLER, which must read them from
 * the running revkit version's committed allowlist
 * (`packages/cli/src/dist-check-allowlist.json`) and never from anything
 * the served content carries. See `src/index.ts` for the load site and
 * `test/headers.test.ts` for the hostile-artefact test that pins it. */
export function workerHeaderContext(options: {
  readonly origin: string;
  readonly version: string;
  readonly inlineScriptHashes: readonly string[];
}): HeaderContext {
  return {
    scriptOrigins: [options.origin],
    scriptPaths: [revkitBundlePath(options.version)],
    workerPaths: [],
    connectOrigins: [],
    inlineScriptHashes: options.inlineScriptHashes,
  };
}

/** Absolute origin the request was addressed to, e.g.
 * `https://review.exoma.org`. See the header comment for why this is
 * derived rather than configured. */
export function requestOrigin(request: Request): string {
  return new URL(request.url).origin;
}

/** Attach ADR-0012 headers to a JSON API response. */
export function applyJsonHeaders(
  response: Response,
  ctx: HeaderContext,
  contentType = "application/json; charset=utf-8",
): Response {
  return applyResponseHeaders(response, "json", contentType, ctx);
}

/** Attach ADR-0012 headers to an HTML response. */
export function applyHtmlHeaders(response: Response, ctx: HeaderContext): Response {
  return applyResponseHeaders(response, "html", "text/html; charset=utf-8", ctx);
}

/** Attach ADR-0012 headers to a plain-text error response. */
export function applyTextHeaders(response: Response, ctx: HeaderContext): Response {
  return applyResponseHeaders(response, "text", "text/plain; charset=utf-8", ctx);
}

/**
 * Attach ADR-0012 headers to a CREDENTIAL-BEARING redirect — the invite
 * redemption's `303`, which sets a session cookie and points the browser
 * somewhere else.
 *
 * `kind: "auth"` is the shared policy's own category for "an auth exchange
 * response (session cookie or launch code)", and it is the one that carries
 * `Cache-Control: no-store`. That header is the control here, not tidiness:
 * ADR-0012's amendment names it for exactly this case ("API JSON,
 * launch-code responses, and the `/-/auth` 302 carry `Cache-Control:
 * no-store`"), and a 303 that set a session cookie without it would let an
 * intermediary store the answer to a request whose URL no longer identifies
 * anything.
 *
 * No CSP, because a redirect has no document to constrain.
 */
export function applyAuthHeaders(response: Response, ctx: HeaderContext): Response {
  return applyResponseHeaders(response, "auth", undefined, ctx);
}

/** Attach the minimal CSP plus `Content-Disposition: inline` to an SVG.
 *
 * ADR-0012: "SVG is served with `Content-Security-Policy: sandbox` and
 * `Content-Disposition: inline` so it can't run script." Slice 1 serves
 * no SVG — there is no R2 — but the header SHAPE is exported and pinned
 * now, so slice 3 (the preview surface) inherits a tested policy instead
 * of writing one.
 *
 * `inline` (not `attachment`) because an SVG inlined into the page is
 * rendered by the embedding document's CSP and never becomes a document
 * of its own; `attachment` would only force a download. */
export function applySvgHeaders(response: Response, ctx: HeaderContext): Response {
  applyResponseHeaders(response, "svg", "image/svg+xml", ctx);
  response.headers.set("content-disposition", "inline");
  return response;
}

/** Header carrying the per-request id, so a reviewer reporting a failure
 * can quote one string that appears in the response AND in the log line
 * (ADR-0020). */
export const REQUEST_ID_HEADER = "x-revkit-request-id";

export { buildMinimalCspHeader };
export type { HeaderContext, ResponseKind };
