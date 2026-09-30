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

/** Hard cap on the response body size for injection. Above this we
 * hand the page through untouched (with a log line the daemon can
 * pick up), so an accidentally huge asset served with a `text/html`
 * mimetype doesn't blow the process's memory reading + rewriting +
 * re-encoding. 8 MiB comfortably covers every Astro page in the
 * revkit build (largest is a few hundred KiB); anything larger is
 * almost certainly not a real doc. PR #38 review. */
export const RAIL_INJECT_MAX_BYTES = 8 * 1024 * 1024;

/** Wrap `response` in an `HTMLRewriter` transform that appends the
 * rail's `<link>` and `<script>` to `<head>`.
 *
 * **Implementation note (Bun HTMLRewriter workaround, upstream
 * oven-sh/bun#6068).** We MATERIALISE the response body into a
 * string first, then feed the string to `HTMLRewriter.transform`.
 * Streaming — the natural, one-line form — hangs `Bun.serve` on
 * Bun 1.3.13 when the body is a `Bun.file()`: the file's unknown
 * size (`u64::MAX`) overflows HTMLRewriter's preallocated buffer
 * hint, and the response body never flushes to the socket. The
 * user hits a "request timed out after 10 seconds" error. Fully
 * buffering is cheap for HTML (a few hundred KiB in the revkit
 * build), but not free — see `RAIL_INJECT_MAX_BYTES` for the cap.
 *
 * A page without a `<head>` is returned unchanged — the append
 * selector never fires and the body streams through as-is.
 *
 * **Size cap** (`RAIL_INJECT_MAX_BYTES`, 8 MiB). Above the cap the
 * page is served WITHOUT the rail, and `options.onOversize` is
 * called so the daemon can log a warning. This is a defence-in-
 * depth guard: we don't want a giant image served with an accidental
 * `text/html` mimetype to double our memory footprint reading + re-
 * encoding.
 *
 * The response's Content-Length header is dropped when we did
 * inject, because the added bytes change the body size; leaving a
 * stale length would make the browser cut the response short. */
export interface InjectRailOptions {
  /** Called with the body byte length when the response is too big
   * to inject the rail into. The caller may log a warning. */
  onOversize?: (bodyBytes: number) => void;
}

export async function injectRail(
  response: Response,
  options: InjectRailOptions = {},
): Promise<Response> {
  const originalText = await response.text();
  const bodyBytes = Buffer.byteLength(originalText, "utf8");
  if (bodyBytes > RAIL_INJECT_MAX_BYTES) {
    options.onOversize?.(bodyBytes);
    // Return the original body unchanged. Drop Content-Length since
    // the caller might have set it based on `Bun.file()`, which the
    // stream has already been read from — we re-create the response
    // to reset any state.
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(originalText, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
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
