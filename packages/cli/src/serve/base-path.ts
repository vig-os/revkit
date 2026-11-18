// Base-path utilities for the composable request handler
// (ADR-0026 §"Plain Linux host / VM" sub-path deployment, #195
// implementation scope, #245).
//
// Two pure helpers kept in one place so the dispatcher's
// prefix-stripping and the body rewriter share one rule:
//
//   - `stripBasePath(pathname, basePath)` — the inverse of a
//     sub-path deployment on the request side. Returns the routed
//     pathname when the request falls under the prefix, or
//     `undefined` when it does not. An empty `basePath` is the
//     root deployment (pass-through).
//   - `prefixAbsolutePaths(text, basePath)` — the body-side
//     counterpart. Rewrites absolute HTML `href` / `src` / `action`
//     attributes and quoted absolute-path literals (as the rail
//     bundle emits for `fetch("/api/threads")`) so a browser loading
//     `https://host/<basePath>/...` resolves every served link
//     against the configured prefix. Idempotent — an already-
//     prefixed absolute path is left untouched.
//
// The dispatcher stripping and the response rewriting MUST agree on
// which paths carry the prefix. Both live here, and the daemon
// reaches for them through a thin call site only.
//
// Protocol-relative URLs (`//cdn.example.com/...`) are never
// rewritten — the `(?!/)` lookahead after the leading slash drops
// them from the pattern. Fully qualified `https://...` URLs carry
// no leading slash in the pattern position and are untouched by
// construction.

/** Strip the `basePath` prefix from a request's pathname.
 *
 * Returns the routed pathname (always starting with `/`) when the
 * request falls under the prefix, or `undefined` when it does not
 * (so the dispatcher can 404 before routing). An empty `basePath`
 * is the root deployment and returns the pathname unchanged.
 *
 * The match is exact on the prefix and allows a trailing `/` but
 * not any other character — `/reviewer` does NOT match `/review`.
 * This is the "prefix confusion" defence `#245` must close
 * (reviewers on a `/review` deployment should not reach a
 * `/reviewer/*` URL by accident). */
export function stripBasePath(pathname: string, basePath: string): string | undefined {
  if (basePath.length === 0) return pathname;
  if (pathname === basePath) return "/";
  if (pathname.startsWith(basePath + "/")) {
    const stripped = pathname.slice(basePath.length);
    return stripped.length === 0 ? "/" : stripped;
  }
  return undefined;
}

/** Prefix every absolute-path reference in `text` with `basePath`.
 * Returns the input unchanged when `basePath` is empty.
 *
 * Catches two shapes in one pass:
 *   - HTML attribute openers (`href=`, `src=`, `action=`), with or
 *     without a quote (`href="/foo"`, `href='/foo'`, `href=/foo`).
 *   - Quoted absolute-path literals (`"/api/foo"`, `'/api/foo'`)
 *     the rail and ask bundles emit for runtime `fetch(...)` calls.
 *
 * Protocol-relative (`//host`) and fully qualified (`https://host/...`)
 * URLs are untouched: the `(?!/)` lookahead rules out the former,
 * and the regex matches on a BARE leading slash (no scheme).
 *
 * Idempotent: an already-prefixed path (`"/review/api/foo"` when
 * `basePath === "/review"`) is passed through unchanged. This
 * matters because the rewriter runs on every HTML response and the
 * rail.js bundle, and a build artefact that already names the
 * prefix must not be double-prefixed on serve. */
export function prefixAbsolutePaths(text: string, basePath: string): string {
  if (basePath.length === 0) return text;
  const prefixForSlash = basePath + "/";
  // Groups: $1 = opener (attribute name or quote); $2 = optional
  // quote char; $3 = the leading slash of the absolute path we are
  // about to rewrite. `(?!/)` after the slash drops `//` (protocol-
  // relative URLs) from the match.
  const pattern = /(href=|src=|action=|["'])(["'])?(\/)(?!\/)/g;
  return text.replace(pattern, (match, opener: string, quote: string | undefined, _slash: string, offset: number) => {
    // Idempotent guard: if the slash already starts the prefix (or
    // equals it exactly), the path is already correct — return the
    // match unchanged.
    const slashOffset = offset + match.length - 1;
    const tail = text.slice(slashOffset);
    if (tail === basePath || tail.startsWith(prefixForSlash)) {
      return match;
    }
    return opener + (quote ?? "") + basePath + "/";
  });
}
