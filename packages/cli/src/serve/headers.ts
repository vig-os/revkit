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
// still names the exact path — `/-/rail.js` and `/_astro/` — so a
// stored HTML with any other script src (an /_astro/ moved to a
// different prefix, a /-/foo.js smuggled into a fixture) is refused
// by the browser as a policy violation.

/** Kind of response the daemon is about to return. Governs which
 * `Cache-Control` applies and whether the CSP is attached (only HTML
 * carries CSP — a stylesheet or JS file has no need for it and some
 * browsers reject it as noise). */
export type ResponseKind =
  | "html"
  /** JS bundle we ship (rail bundle, or a static /_astro/ file). */
  | "asset"
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
  /** Distinct SHA-256 hex digests of the inline scripts the site
   * build emitted (from `csp-hashes.json`, ADR-0012). Empty when the
   * artefact is missing — the daemon fails closed by omitting hashes
   * from `script-src` (inline scripts then refuse in the browser). */
  readonly inlineScriptHashes: readonly string[];
  /** Whether the CSP allowlist artefact was loaded. `false` means we
   * are serving fail-closed: inline scripts and Starlight islands
   * will not run. The daemon logs the state on startup. */
  readonly cspHashesLoaded: boolean;
}

/** Where the rail bundle lives on the daemon. Kept as a constant so
 * the header builder and `rail/injector.ts` agree on one spelling. */
export const RAIL_SCRIPT_URL_PATH = "/-/rail.js";

/** Astro's chunk directory — every static JS asset a page loads via
 * `<script src>` starts with this prefix (`check-dist.ts` enforces the
 * same on the built HTML). */
export const ASTRO_SCRIPTS_URL_PREFIX = "/_astro/";

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

/** Build the daemon's Content-Security-Policy value.
 *
 * Design notes:
 *
 * - `default-src 'none'` — nothing is allowed unless a specific
 *   directive names it.
 * - `script-src` names the EXACT paths the daemon serves scripts
 *   from: `/-/rail.js` (the rail bundle) and `/_astro/` (Astro's
 *   chunk directory). CSP L3 allows a path component in a source
 *   expression, and Chromium / Firefox / WebKit all support it. In
 *   addition, every inline-script SHA-256 the site build emitted is
 *   listed — Starlight and its theme-toggle bootstrap use inline
 *   scripts (the same hashes `check-dist` enforces on disk). If
 *   `cspHashesLoaded` is false we omit the hashes: any inline
 *   script then refuses in the browser, and the daemon logs the
 *   startup message.
 *   `'unsafe-eval'` is included because the rail bundle imports
 *   `solid-js/html`, whose tagged-template runtime compiles
 *   templates into JS functions via `new Function(...)` at first
 *   render — refused without `'unsafe-eval'`. The daemon runs on a
 *   loopback origin under a single user, and the rail bundle is
 *   revkit's own code (never user content), so the widening is
 *   accepted for M2. ADR-0013 amendment (2026-09-30) captures the
 *   scope: the M3/M4 hosted Worker does NOT ship the rail this way
 *   and keeps `script-src` free of `'unsafe-eval'`.
 * - `style-src 'self' 'unsafe-inline'` — Starlight and expressive-
 *   code inject inline styles for syntax highlighting; KaTeX styles
 *   are self-hosted so `'self'` covers them, but the theme-toggle
 *   script writes a `<style>` element too. We keep `'unsafe-inline'`
 *   for `style-src` and justify it: styles cannot execute script,
 *   and dropping it would require rebuilding Starlight's runtime to
 *   emit style hashes (not available at Astro 7.3.5). ADR-0012's
 *   original text lists this as an accepted trade-off.
 * - `img-src` and `font-src` keep the ADR-0012 allowlist as-is.
 * - `connect-src 'self'` — CSP L3 defines `'self'` to include the
 *   same-origin WebSocket scheme (ws/wss). Chromium (since Chrome
 *   96) and Firefox (since Firefox 99) implement it. We also list
 *   the explicit `ws://127.0.0.1:<port>` origin: a browser that
 *   normalises `ws://` to `http://` (Safari on older iOS) then
 *   still matches. Listing both is redundant on modern browsers
 *   and forward-compatible; the ADR-0012 host-mode text names only
 *   `'self'` and this daemon path amends it (ADR-0013 amendment
 *   2026-09-30).
 * - `frame-ancestors 'none'`, `base-uri 'none'`, `object-src 'none'`,
 *   `form-action 'self'` — verbatim from ADR-0012.
 */
export function buildCspHeader(ctx: HeaderContext): string {
  const scriptSources: string[] = [];
  // Path-scoped script sources. CSP treats a source with a trailing
  // slash as "any file under this path"; a source WITHOUT a trailing
  // slash matches exactly one URL.
  scriptSources.push(`http://127.0.0.1:${ctx.port}${RAIL_SCRIPT_URL_PATH}`);
  scriptSources.push(`http://127.0.0.1:${ctx.port}${ASTRO_SCRIPTS_URL_PREFIX}`);
  // ADR-0013 amendment (2026-09-30): the rail bundle uses
  // `solid-js/html`, which compiles templates via `new Function()`.
  // Allow it on the local daemon; drop on the hosted worker.
  scriptSources.push("'unsafe-eval'");
  if (ctx.cspHashesLoaded) {
    for (const hex of ctx.inlineScriptHashes) {
      // Hashes in CSP use base64, not hex. `check-dist.ts` stores hex
      // digests (they are easier to eyeball in a diff); `sha256Hex`
      // there produced them. We convert to base64 here so the header
      // is a valid CSP source.
      scriptSources.push(`'sha256-${hexToBase64(hex)}'`);
    }
  }
  const wsOrigin = `ws://127.0.0.1:${ctx.port}`;
  // Order chosen so the header reads top-down like the ADR text —
  // default first, script/style next, then fetch destinations, then
  // navigation guards. Semicolon-separated is the CSP spec form.
  const directives: string[] = [
    "default-src 'none'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://avatars.githubusercontent.com",
    "font-src 'self'",
    `connect-src 'self' ${wsOrigin}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ];
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

  // CSP goes on every HTML response. A JS/CSS/image asset served
  // from `/_astro/`, the rail bundle, or the site's public/ folder
  // does not need CSP itself — browsers apply the CSP of the
  // embedding document. Applying it here anyway is safe (browsers
  // ignore CSP on non-document responses) but adds bytes; the
  // header omission is a deliberate optimisation and covered by the
  // unit tests.
  if (kind === "html") {
    response.headers.set("content-security-policy", buildCspHeader(ctx));
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
