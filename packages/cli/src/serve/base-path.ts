// Base-path stripping for the composable request handler
// (ADR-0026 §"Plain Linux host / VM" sub-path deployment, #195
// implementation scope, #245).
//
// One pure helper: `stripBasePath(pathname, basePath)` — the inverse
// of a sub-path deployment on the request side. Returns the routed
// pathname when the request falls under the prefix, or `undefined`
// when it does not. An empty `basePath` is the root deployment
// (pass-through).
//
// **Body rewriting is NOT done here, and NOT done anywhere else on
// the serve path.** The #245 part 1 round-2 falsifier showed that a
// regex cannot reliably tell URLs from data in HTML / JS bodies:
// template-literal URLs such as `` `/api/threads/${id}/replies` ``
// are missed, `"/"` inside the rail's own path normaliser is
// rewritten to `"/review/"`, prose and comments get corrupted, and
// an existing `href="/review"` becomes `/review/review`. The
// decided answer (round-3 brief): the base path is a BUILD-TIME +
// RUNTIME property, never a response rewrite.
//
//   - Astro `base` (set from `revkit build --base /review`) emits
//     every page and asset URL prefixed at BUILD time.
//   - `<meta name="revkit-base" content="/review/">` is stamped
//     into the HTML head once, by the layout.
//   - The rail's `revkitUrl(path)` helper reads the meta at mount
//     and resolves API, SSE and asset URLs against it at RUNTIME.
//   - The server only strips the prefix before routing (THIS
//     module). It never rewrites bodies.
//
// Keeping `stripBasePath` in its own file leaves the dispatcher's
// prefix handling testable without a daemon, and gives a stable
// import path for the host entry (part 2) that needs the same
// routing rule.

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
