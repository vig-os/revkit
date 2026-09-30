// Content-Type by file extension for the daemon's static server.
//
// ADR-0012 (hosted mode) forbids sniffing and the daemon lives on the
// same principle: the daemon derives Content-Type from the extension
// against this allowlist, sets `X-Content-Type-Options: nosniff` on
// every response, and refuses (404) any extension we do not recognise.
// The full CSP lands with M2 item 8 (issue #22); nosniff and correct
// content types are the pre-condition and ship here.
//
// The list is deliberately narrow — only what a static Astro site
// output actually produces. A new extension needs a code change and a
// review, which is the property this file wants.

/** Extension → RFC-shaped media type. Lowercase key with the leading
 * dot; add `; charset=utf-8` on text-shaped types so a client does not
 * fall back to a legacy default. */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
};

/** Return the Content-Type for a file's lowercased extension (with the
 * leading dot), or `null` when the extension is not on the allowlist.
 * The static server treats `null` as a 404 — the daemon does not serve
 * types it cannot type. */
export function contentTypeForExtension(extLower: string): string | null {
  return MIME_BY_EXT[extLower] ?? null;
}
