// Response headers for `revkit serve` — ADR-0012 CSP + hygiene.
//
// One place composes every header the daemon attaches to a response
// (issue #22, M2 half of item 8): the ADR-0012 Content-Security-Policy,
// `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
// the cross-origin isolation triplet (`COOP`, `CORP`), a
// `Permissions-Policy` that denies the powerful features the daemon
// UI never asks for, and per-kind `Cache-Control`.
//
// This module is pure: `buildCspHeader` and `applyResponseHeaders`
// return values only, so a unit test drives them without spinning up
// a daemon. The daemon calls `applyResponseHeaders` from a single
// wrapper (`withHygiene`) so every branch — static, API, SSE,
// WebSocket handshake, auth exchange, error responses — carries the
// same set.
//
// The script-path decision (ADR-0013 amendment 2026-09-30): the daemon
// KEEPS `/-/rail.js` for the rail bundle. The `/_revkit/<version>/`
// convention in ADR-0012 is a HOSTED origin concern (many co-tenant
// preview paths share one origin), and the local daemon serves one
// project at a time from an isolated loopback origin. `script-src`
// still names the exact path — `/-/rail.js`, `/_astro/`, and
// `/pagefind/` — so a stored HTML with any other script src is
// refused by the browser as a policy violation.

/** Kind of response the daemon is about to return. Governs which CSP
 * shape it carries and which `Cache-Control` applies. */
export type ResponseKind =
  | "html"
  /** JS bundle we ship (rail bundle, or a static /_astro/ file), a
   * CSS file, an image, a font, a `.wasm` blob, a `.pf_meta` /
   * `.pf_index` / `.pf_fragment` search chunk — anything a document
   * loads as a subresource. Assets get NO CSP header of their own:
   * browsers apply the embedding document's CSP to subresource
   * fetches, and a Worker (Pagefind's runtime) whose response
   * carries a restrictive CSP would have its own `fetch` denied. */
  | "asset"
  /** SVG served as its own document (browser can open it directly). */
  | "svg"
  /** XML served as its own document (`sitemap.xml`, feed). */
  | "xml"
  /** JSON body from `/api/*` or `/-/health`. */
  | "json"
  /** SSE event stream from `/events`. */
  | "sse"
  /** `/-/auth` exchange, `/-/launch-code`. */
  | "auth"
  /** Anything else: a plain-text 4xx/5xx error body. */
  | "text";

/** Inputs to `buildCspHeader` and `applyResponseHeaders`. */
export interface HeaderContext {
  /** Loopback port the daemon bound to. */
  readonly port: number;
  /** Distinct SHA-256 hex digests of the inline scripts allowed by
   * the running revkit version. These come from the COMMITTED,
   * reviewed set (`packages/cli/src/dist-check-allowlist.json`), not
   * from anything the served dir carries — ADR-0012 rule "the daemon
   * applies the allowlist of the revkit version it runs, never
   * hashes found in an artifact". */
  readonly inlineScriptHashes: readonly string[];
}

/** Where the rail bundle lives on the daemon. Kept as a constant so
 * the header builder and `rail/injector.ts` agree on one spelling. */
export const RAIL_SCRIPT_URL_PATH = "/-/rail.js";

/** Where the `/ask/<id>` page bundle lives. Same shape as the rail:
 * a compiled Solid bundle served from an exact daemon path so
 * `script-src` names it verbatim. Kept alongside `RAIL_SCRIPT_URL_PATH`
 * so a future third bundle adds one line here + one entry per alias
 * in `buildCspHeader` rather than a copy-paste of the whole loop.
 * (M2 item 7, story A1.) */
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

/** Denied Permissions-Policy features. The daemon UI is a reader-and-
 * comment surface — none of these features is ever needed, so we
 * deny them explicitly. The list is the union of the powerful
 * features browsers document; a browser that does not implement a
 * name treats it as unknown and ignores it, which is safe. */
const DENIED_PERMISSIONS: readonly string[] = [
  "accelerometer",
  "ambient-light-sensor",
  "attribution-reporting",
  "autoplay",
  "battery",
  "bluetooth",
  "browsing-topics",
  "camera",
  "display-capture",
  "encrypted-media",
  "fullscreen",
  "gamepad",
  "geolocation",
  "gyroscope",
  "hid",
  "identity-credentials-get",
  "idle-detection",
  "keyboard-map",
  "local-fonts",
  "magnetometer",
  "microphone",
  "midi",
  "otp-credentials",
  "payment",
  "picture-in-picture",
  "publickey-credentials-create",
  "publickey-credentials-get",
  "screen-wake-lock",
  "serial",
  "storage-access",
  "usb",
  "web-share",
  "window-management",
  "xr-spatial-tracking",
];

/** Build the `Permissions-Policy` header value: every listed feature
 * disallowed with `()` (empty allowlist). */
export function permissionsPolicyValue(): string {
  return DENIED_PERMISSIONS.map((name) => `${name}=()`).join(", ");
}

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

/** Build the daemon's Content-Security-Policy value for an HTML
 * response.
 *
 * Design notes:
 *
 * - `default-src 'none'` — nothing is allowed unless a specific
 *   directive names it.
 * - `script-src` names the EXACT paths the daemon serves scripts
 *   from, once per loopback alias (`127.0.0.1:<port>` and
 *   `localhost:<port>`): `/-/rail.js` (the rail bundle), `/_astro/`
 *   (Astro's chunk directory), and `/pagefind/` (Starlight's
 *   client-side search runtime). CSP L3 allows a path component in
 *   a source expression, and Chromium / Firefox / WebKit all
 *   support it. In addition, every inline-script SHA-256 the
 *   running revkit version allowlists is listed — Starlight and its
 *   theme-toggle bootstrap use inline scripts (the same hashes
 *   `check-dist` enforces on disk). `'unsafe-eval'` is NOT in this
 *   directive; the rail is JSX-compiled at build time by
 *   `babel-preset-solid` and produces no `eval()` / `new Function()`
 *   at runtime. `'wasm-unsafe-eval'` is the narrow WASM-only
 *   keyword pagefind's compiled `.wasm` needs to instantiate; it
 *   does NOT permit `eval()` or `new Function()` on JS.
 * - `worker-src` — pagefind uses `new Worker(...)` for its indexer.
 *   `'self'` covers the same origin.
 * - `style-src 'self' 'unsafe-inline'` — Starlight and expressive-
 *   code inject inline styles for syntax highlighting; KaTeX styles
 *   are self-hosted so `'self'` covers them, but the theme-toggle
 *   script writes a `<style>` element too. We keep `'unsafe-inline'`
 *   for `style-src` and justify it: styles cannot execute script,
 *   and dropping it would require rebuilding Starlight's runtime to
 *   emit style hashes (not available at Astro 7.3.5). ADR-0012's
 *   original text lists this as an accepted trade-off.
 * - `img-src` and `font-src` keep the ADR-0012 allowlist as-is.
 * - `connect-src 'self'` covers pagefind's `.pf_meta` / `.pf_index`
 *   / `.pf_fragment` fetches. CSP L3 defines `'self'` to include the
 *   same-origin WebSocket scheme (ws/wss); we also list the explicit
 *   `ws://` origins for older WebKit builds.
 * - `frame-ancestors 'none'`, `base-uri 'none'`, `object-src 'none'`,
 *   `form-action 'self'` — verbatim from ADR-0012.
 */
export function buildCspHeader(ctx: HeaderContext): string {
  const scriptSources: string[] = [];
  // Path-scoped script sources. CSP treats a source with a trailing
  // slash as "any file under this path"; a source WITHOUT a trailing
  // slash matches exactly one URL. Emit one entry per loopback alias
  // so a page opened at http://localhost:<port>/ loads the same set
  // as a page opened at http://127.0.0.1:<port>/.
  for (const origin of loopbackOrigins(ctx.port, "http")) {
    scriptSources.push(`${origin}${RAIL_SCRIPT_URL_PATH}`);
    scriptSources.push(`${origin}${ASK_SCRIPT_URL_PATH}`);
    scriptSources.push(`${origin}${ASTRO_SCRIPTS_URL_PREFIX}`);
    scriptSources.push(`${origin}${PAGEFIND_URL_PREFIX}`);
  }
  // `'wasm-unsafe-eval'` is the narrow WASM-only keyword: it lets
  // `WebAssembly.compile` / `WebAssembly.instantiate` compile a byte
  // sequence into a module. It does NOT permit `eval()` or
  // `new Function()` on JavaScript strings. Required by pagefind
  // (Starlight search).
  scriptSources.push("'wasm-unsafe-eval'");
  for (const hex of ctx.inlineScriptHashes) {
    // Hashes in CSP use base64, not hex. `dist-check-allowlist.json`
    // stores hex digests (easier to eyeball in a diff); we convert
    // to base64 here so the header is a valid CSP source.
    scriptSources.push(`'sha256-${hexToBase64(hex)}'`);
  }
  const wsOrigins = loopbackOrigins(ctx.port, "ws");
  // Path-scope worker-src to `/pagefind/` on BOTH loopback aliases.
  // Pagefind is the ONLY runtime the daemon serves a Worker for
  // today; naming the exact prefix means a future stored HTML that
  // tries `new Worker("/-/anything.js")` is refused by the browser
  // as a CSP violation, closing the narrowest hole the previous
  // `worker-src 'self'` left open. Same shape as script-src's
  // pagefind entry — one path scope, two aliases. (M2 item 5b
  // carry-over from #41 review.)
  const workerSources = loopbackOrigins(ctx.port, "http").map(
    (origin) => `${origin}${PAGEFIND_URL_PREFIX}`,
  );
  // Order chosen so the header reads top-down like the ADR text —
  // default first, script/style next, then fetch destinations, then
  // navigation guards. Semicolon-separated is the CSP spec form.
  const directives: string[] = [
    "default-src 'none'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://avatars.githubusercontent.com",
    "font-src 'self'",
    `connect-src 'self' ${wsOrigins.join(" ")}`,
    `worker-src ${workerSources.join(" ")}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ];
  return directives.join("; ");
}

/** Build the MINIMAL CSP the daemon puts on a NON-HTML response the
 * browser could still open AS ITS OWN DOCUMENT — an SVG at `/foo.svg`
 * (script can run inside SVG) or an XML feed at `/sitemap.xml` (an
 * XSLT-styled XML also renders as a document). The value denies
 * scripting and framing:
 *
 *   `default-src 'none'; frame-ancestors 'none'`
 *
 * plus `sandbox` on SVG (ADR-0012's upload-handling rule: an SVG can
 * carry `<script>`, but the browser treats a sandboxed document as
 * an opaque origin with no script).
 *
 * DO NOT call this for other asset kinds (JS chunk, CSS, font,
 * image, JSON body, .wasm, .pf_meta): those render as source or
 * media when opened directly (no script execution), and attaching a
 * CSP with `default-src 'none'` to a JS response that a Worker will
 * later load DENIES the Worker's own `fetch()` — Pagefind's search
 * runtime is a concrete case (issue #22 review). Assets carry NO
 * CSP header. */
export function buildMinimalCspHeader(kind: "svg" | "xml"): string {
  const directives = ["default-src 'none'", "frame-ancestors 'none'"];
  if (kind === "svg") directives.push("sandbox");
  return directives.join("; ");
}

/** Convert a hex-encoded SHA-256 digest into base64 (what CSP hash
 * sources require). Uses `Buffer` so we stay in the runtime shipped
 * with Bun / Node — no third-party dependency. */
export function hexToBase64(hex: string): string {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`hexToBase64: not a hex string: ${JSON.stringify(hex)}`);
  }
  return Buffer.from(hex, "hex").toString("base64");
}

/** Attach ADR-0012 headers to `response` given the response kind and
 * (optional) explicit content-type. Returns the same response
 * mutated in place — callers already treat `withHygiene` this way. */
export function applyResponseHeaders(
  response: Response,
  kind: ResponseKind,
  contentType: string | undefined,
  ctx: HeaderContext,
): Response {
  // Always attach the hygiene triplet: nosniff, no-referrer, and the
  // cross-origin isolation pair. Every response gets them — an HTML
  // page, a JS asset, a JSON error, and a 302 auth redirect all.
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("cross-origin-opener-policy", "same-origin");
  response.headers.set("cross-origin-resource-policy", "same-origin");
  response.headers.set("permissions-policy", permissionsPolicyValue());

  if (contentType !== undefined) {
    response.headers.set("content-type", contentType);
  }

  // CSP: HTML gets the full policy. SVG and XML get the minimal
  // policy (`default-src 'none'; frame-ancestors 'none'`, plus
  // `sandbox` on SVG) — those two are the non-HTML shapes the
  // browser will still render AS A DOCUMENT when opened directly,
  // and script can execute inside both. Every other asset (JS
  // bundle, CSS, image, font, JSON, .wasm, .pf_meta) carries NO
  // CSP header: browsers apply the embedding document's CSP to
  // subresource loads, and a Worker (Pagefind's search runtime)
  // whose script response carries `default-src 'none'` has its
  // own `fetch()` denied inside the Worker — see the issue #22
  // review's second blocker.
  if (kind === "html") {
    response.headers.set("content-security-policy", buildCspHeader(ctx));
  } else if (kind === "svg" || kind === "xml") {
    response.headers.set("content-security-policy", buildMinimalCspHeader(kind));
  }

  // Cache-Control: never cache API JSON or the auth exchange (the
  // response body carries either a session cookie or a launch code
  // that must not sit in an intermediary). SSE sets its own value
  // (`no-cache, no-transform`) at the source — overwriting it here
  // with `no-store` would allow a middlebox to buffer the whole
  // stream, so we leave the SSE cache header alone. Static assets
  // and HTML skip the header (loopback, no CDN).
  if (kind === "json" || kind === "auth") {
    response.headers.set("cache-control", "no-store");
  }

  return response;
}
