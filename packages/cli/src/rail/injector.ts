// Rail injection — wraps a static HTML `Response` from the daemon so
// every served page also loads the rail bundle from `/-/rail.js` /
// `/-/rail.css`.
//
// The injection is a streaming rewrite over the response body: Bun
// ships `HTMLRewriter` (Cloudflare Workers compatible) which parses
// HTML incrementally, so a large page never buffers in memory. We
// append two elements to `<head>`:
//   1. `<link rel="stylesheet" href="/-/rail.css">`
//   2. `<script type="module" src="/-/rail.js"></script>`
//
// The script tag is EXTERNAL (a `src=`), not inline: the M2 CSP
// direction (ADR-0012, issue #22) refuses inline script even before
// the full CSP ships. A page that has no `<head>` (a fragment or a
// non-HTML file) is returned untouched — HTMLRewriter's `head`
// selector never fires and the body streams through as-is.
//
// Injection is opt-in on the caller: `handleStatic` only wraps
// responses whose Content-Type is `text/html`. A stylesheet or a JS
// asset is served without touching the body.

/** The URLs the injected tags point at. Kept as constants so the
 * static-server branch and this file agree on one spelling. */
export const RAIL_JS_PATH = "/-/rail.js";
export const RAIL_CSS_PATH = "/-/rail.css";

/** Wrap `response` in an `HTMLRewriter` transform that appends the
 * rail's `<link>` and `<script>` to `<head>`. Returns a Promise
 * because we materialise the response body first — a `Bun.file()`
 * body handed straight to `rewriter.transform(...)` does not flush
 * cleanly when the transformed response is served by `Bun.serve`
 * (Bun 1.3.13: `HTMLRewriter.transform` on a file-backed body hangs
 * the response — see Bun.serve request-timeout). Reading the body
 * to a string first sidesteps that bug and keeps the injector's
 * output identical to the streaming API.
 *
 * A page without a `<head>` is returned unchanged — the append
 * selector never fires and the body streams through as-is.
 *
 * The response's Content-Length header is dropped because the
 * injected bytes change the body size; leaving a stale length would
 * make the browser cut the response short. */
export async function injectRail(response: Response): Promise<Response> {
  const originalText = await response.text();
  const rewriter = new HTMLRewriter().on("head", {
    element(element: {
      append(html: string, options?: { html?: boolean }): void;
    }): void {
      element.append(
        `<link rel="stylesheet" href="${RAIL_CSS_PATH}">`,
        { html: true },
      );
      element.append(
        `<script type="module" src="${RAIL_JS_PATH}"></script>`,
        { html: true },
      );
    },
  });
  const rewritten = rewriter.transform(
    new Response(originalText, { headers: response.headers }),
  );
  const outText = await rewritten.text();
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(outText, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
