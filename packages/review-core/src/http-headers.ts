// ADR-0012 response-header and Content-Security-Policy policy, as ONE
// module every surface imports (ADR-0025 amendment 2026-10-03: header
// policy is part of the shared core, not a per-surface copy).
//
// Two surfaces attach these headers today and a third will:
//
//   - `revkit serve` (local daemon, `packages/cli/src/serve/headers.ts`),
//     an adapter supplying loopback origins and the rail's path
//     conventions.
//   - the hosted Cloudflare Worker (`packages/worker/src/headers.ts`), an
//     adapter supplying the revkit-owned `/_revkit/<version>/` path
//     ADR-0012 prescribes.
//   - any future surface, which is another adapter and nothing more.
//
// What lives HERE is the policy: which directives exist, the
// hygiene quartet plus `Permissions-Policy`, the `asset`-gets-no-CSP
// rule, the `Cache-Control` mapping, and the hex→base64 conversion a
// CSP hash source needs. What does NOT live here is any surface's
// origin or path list — those are `HeaderContext` inputs, so a surface
// never re-implements a directive and a policy change lands once.
//
// **Runtime-neutral on purpose (ADR-0025).** This module has ZERO
// imports and touches no host global beyond `TextEncoder`-free string
// handling — in particular NOT `Buffer`, which does not exist in
// workerd without `nodejs_compat` (measured: `typeof Buffer ===
// "undefined"` inside workerd on miniflare 4.20260518.0 with
// `compatibility_flags: []`). `hexToBase64` is a 12-line pure
// encoder, differentially tested against `Buffer.from(hex, "hex")` in
// `test/http-headers.test.ts` so the two cannot drift.

/** Kind of response a surface is about to return. Governs which CSP
 *  shape it carries and which `Cache-Control` applies. */
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
  /** JSON body from `/api/*` or a health endpoint. */
  | "json"
  /** SSE event stream. */
  | "sse"
  /** An auth exchange response (session cookie or launch code). */
  | "auth"
  /** Anything else: a plain-text 4xx/5xx error body. */
  | "text";

/** Everything the CSP builder needs from a surface. The policy is
 * fixed; these are the surface's own coordinates. */
export interface HeaderContext {
  /** Absolute origins (`scheme://host[:port]`) that `script-src` and
   * `worker-src` name. The daemon passes both loopback aliases so a
   * page opened at either loads the same set; the Worker passes the
   * origin it was actually addressed on. */
  readonly scriptOrigins: readonly string[];
  /** Path expressions, already leading-slashed, emitted under EVERY
   * `scriptOrigins` entry and in this exact order. A trailing slash
   * means "any file under this path" in CSP; without one it matches a
   * single URL. Order is the surface's choice and is preserved
   * verbatim, so a surface that interleaves a route-specific bundle
   * can place it where it wants. */
  readonly scriptPaths: readonly string[];
  /** Path expressions for `worker-src`, under every `scriptOrigins`
   * entry. Empty leaves `worker-src` off the policy entirely, which
   * is correct for a surface that serves no Worker. */
  readonly workerPaths: readonly string[];
  /** Absolute origins to add to `connect-src` beyond `'self'` — the
   * daemon's explicit `ws://` loopback aliases, for WebKit builds
   * that predate CSP L3's `'self'`-covers-`ws://` rule. */
  readonly connectOrigins: readonly string[];
  /** Distinct SHA-256 hex digests of the inline scripts the RUNNING
   * revkit version allowlists. These come from the COMMITTED,
   * reviewed set (`packages/cli/src/dist-check-allowlist.json`), not
   * from anything the served content carries — ADR-0012's rule "the
   * Worker applies the allowlist of the revkit version it runs, never
   * hashes found in an artifact". */
  readonly inlineScriptHashes: readonly string[];
}

/** Denied Permissions-Policy features. A revkit review surface is a
 * reader-and-comment surface — none of these is ever needed, so we deny
 * them explicitly. The list is the union of the powerful features
 * browsers document; a browser that does not implement a name treats it
 * as unknown and ignores it, which is safe. */
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

/** Build the Content-Security-Policy value for an HTML response.
 *
 * Design notes:
 *
 * - `default-src 'none'` — nothing is allowed unless a specific
 *   directive names it.
 * - `script-src` names the EXACT paths the surface serves scripts
 *   from, once per `scriptOrigins` entry, plus `'wasm-unsafe-eval'`
 *   and every allowlisted inline-script SHA-256. `'unsafe-eval'` is
 *   deliberately NOT in this directive: revkit's client bundles are
 *   compiled ahead of time and emit no `eval()` / `new Function()`.
 *   `'wasm-unsafe-eval'` is the narrow WASM-only keyword — it lets
 *   `WebAssembly.instantiate` compile a byte sequence into a module
 *   and does NOT permit `eval` on JavaScript strings.
 * - `worker-src` — only when the surface names `workerPaths`, and
 *   then path-scoped so a stored HTML cannot start a Worker from a
 *   path the revkit release does not own.
 * - `style-src 'self' 'unsafe-inline'` — KaTeX, Vega SVG and
 *   Starlight need inline styles; styles cannot execute script.
 * - `img-src` and `font-src` keep the ADR-0012 allowlist as-is.
 * - `connect-src 'self'` plus the surface's `connectOrigins`.
 * - `frame-ancestors 'none'`, `base-uri 'none'`, `object-src 'none'`,
 *   `form-action 'self'` — verbatim from ADR-0012.
 */
export function buildCspHeader(ctx: HeaderContext): string {
  const scriptSources: string[] = [];
  for (const origin of ctx.scriptOrigins) {
    for (const path of ctx.scriptPaths) {
      scriptSources.push(`${origin}${path}`);
    }
  }
  scriptSources.push("'wasm-unsafe-eval'");
  for (const hex of ctx.inlineScriptHashes) {
    // Hashes in CSP use base64, not hex. `dist-check-allowlist.json`
    // stores hex digests (easier to eyeball in a diff); we convert to
    // base64 here so the header is a valid CSP source.
    scriptSources.push(`'sha256-${hexToBase64(hex)}'`);
  }
  const workerSources: string[] = [];
  for (const origin of ctx.scriptOrigins) {
    for (const path of ctx.workerPaths) {
      workerSources.push(`${origin}${path}`);
    }
  }
  // Order chosen so the header reads top-down like the ADR text —
  // default first, script/style next, then fetch destinations, then
  // navigation guards. Semicolon-separated is the CSP spec form.
  const directives: string[] = [
    "default-src 'none'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://avatars.githubusercontent.com",
    "font-src 'self'",
    `connect-src 'self'${ctx.connectOrigins.length > 0 ? ` ${ctx.connectOrigins.join(" ")}` : ""}`,
  ];
  if (workerSources.length > 0) {
    directives.push(`worker-src ${workerSources.join(" ")}`);
  }
  directives.push(
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  );
  return directives.join("; ");
}

/** Build the MINIMAL CSP a surface puts on a NON-HTML response the
 * browser could still open AS ITS OWN DOCUMENT — an SVG (script can run
 * inside SVG) or an XML feed (an XSLT-styled XML also renders as a
 * document). The value denies scripting and framing:
 *
 *   `default-src 'none'; frame-ancestors 'none'`
 *
 * plus `sandbox` on SVG (ADR-0012's upload-handling rule: an SVG can
 * carry `<script>`, but the browser treats a sandboxed document as an
 * opaque origin with no script).
 *
 * DO NOT call this for other asset kinds (JS chunk, CSS, font, image,
 * JSON body, `.wasm`, `.pf_meta`): those render as source or media when
 * opened directly (no script execution), and attaching a CSP with
 * `default-src 'none'` to a JS response that a Worker will later load
 * DENIES the Worker's own `fetch()` — Pagefind's search runtime is a
 * concrete case (issue #22 review). Assets carry NO CSP header. */
export function buildMinimalCspHeader(kind: "svg" | "xml"): string {
  const directives = ["default-src 'none'", "frame-ancestors 'none'"];
  if (kind === "svg") directives.push("sandbox");
  return directives.join("; ");
}

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Convert a hex-encoded SHA-256 digest into base64 (what CSP hash
 * sources require).
 *
 * Written by hand rather than via `Buffer.from(hex, "hex")` because
 * `Buffer` does not exist in workerd without `nodejs_compat`
 * (ADR-0025's runtime-neutrality rule, and `wrangler.jsonc` pins
 * `compatibility_flags: []` so the platform enforces it).
 * `test/http-headers.test.ts` differentially checks this against
 * `Buffer` over every digest length 0–64 bytes plus a SHA-256 of the
 * real allowlist, so "hand-written" cannot quietly mean "different". */
export function hexToBase64(hex: string): string {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`hexToBase64: not a hex string: ${JSON.stringify(hex)}`);
  }
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  }
  let out = "";
  // Base64 consumes THREE bytes per four output characters, so the loop
  // steps by three — the trailing group is short when the input is not a
  // multiple of 3 and is padded with '=' to match Buffer's output.
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64_ALPHABET.charAt(b0 >> 2);
    out += BASE64_ALPHABET.charAt(((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4));
    out += b1 === undefined ? "=" : BASE64_ALPHABET.charAt(((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6));
    out += b2 === undefined ? "=" : BASE64_ALPHABET.charAt(b2 & 0x3f);
  }
  return out;
}

/** Attach ADR-0012 headers to `response` given the response kind and
 * (optional) explicit content-type. Returns the same response
 * mutated in place — callers already treat their wrapper this way. */
export function applyResponseHeaders(
  response: Response,
  kind: ResponseKind,
  contentType: string | undefined,
  ctx: HeaderContext,
): Response {
  // Always attach the hygiene quartet plus `Permissions-Policy`: every
  // response gets them — an HTML page, a JS asset, a JSON error, and an
  // auth redirect alike.
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("cross-origin-opener-policy", "same-origin");
  response.headers.set("cross-origin-resource-policy", "same-origin");
  response.headers.set("permissions-policy", permissionsPolicyValue());

  if (contentType !== undefined) {
    response.headers.set("content-type", contentType);
  }

  // CSP: HTML gets the full policy. SVG and XML get the minimal policy
  // (`default-src 'none'; frame-ancestors 'none'`, plus `sandbox` on
  // SVG) — those two are the non-HTML shapes the browser will still
  // render AS A DOCUMENT when opened directly, and script can execute
  // inside both. Every other asset (JS bundle, CSS, image, font, JSON,
  // `.wasm`, `.pf_meta`) carries NO CSP header: browsers apply the
  // embedding document's CSP to subresource loads, and a Worker whose
  // script response carries `default-src 'none'` has its own `fetch()`
  // denied inside the Worker — see the issue #22 review's second
  // blocker.
  if (kind === "html") {
    response.headers.set("content-security-policy", buildCspHeader(ctx));
  } else if (kind === "svg" || kind === "xml") {
    response.headers.set("content-security-policy", buildMinimalCspHeader(kind));
  }

  // Cache-Control: never cache API JSON or an auth exchange (the
  // response body carries either a session cookie or a launch code
  // that must not sit in an intermediary). SSE sets its own value
  // (`no-cache, no-transform`) at the source — overwriting it here with
  // `no-store` would allow a middlebox to buffer the whole stream, so
  // the SSE cache header is left alone. Static assets and HTML skip the
  // header.
  if (kind === "json" || kind === "auth") {
    response.headers.set("cache-control", "no-store");
  }

  return response;
}
