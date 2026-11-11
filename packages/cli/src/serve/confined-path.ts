// Confine a request path to a root directory — the containment primitive
// the daemon's static server (`static-server.ts`) leans on to refuse path
// traversal and symlink escape.
//
// The **containment rules** (rules 2 and 3 below) are shared with the
// plot-data reader in `@revkit/site`
// (`site/src/lib/plot-file-io.ts`'s `readConfinedSibling`, which
// `@revkit/cli` already depends on transitively). The two implementations
// stay separate for two concrete reasons:
//
// - The URL shape checked by rule 1 differs: the plot helper's
//   `isSiblingFilename` refuses a leading `/` and any scheme (a plot's
//   `data.url` is a bare filename or a subdirectory-nested filename),
//   while the daemon receives HTTP URL paths that start with `/` and
//   need URL-decoding before the same segment refusal applies. A
//   shared entry point would end up as two thin wrappers around a
//   third primitive.
// - The plot helper is `async` (it calls `readFile` after resolving),
//   the daemon's static server is called synchronously per request
//   (`Bun.file` handles the async read itself); one file's I/O style
//   would have to change to share the primitive.
//
// Both files are audited together whenever the primitive changes.
//
// The three rules:
//
// 1. **Path shape:** the resolved candidate must sit under the pre-
//    resolved `rootReal`. `..` segments in the decoded URL path are
//    refused (a caller that passes an already-decoded string containing
//    "%2e%2e" is caught by that literal `..` check once decodeURIComponent
//    has run at the HTTP boundary).
// 2. **No symlinks anywhere in the chain:** after resolving traversal
//    ourselves, `realpathSync(candidate)` must equal `candidate` — any
//    intermediate or leaf symlink between `rootReal` and the file makes
//    them differ and is refused. `astro build` does not produce
//    symlinks, so this cannot be a false positive on a legitimate site
//    output; a symlink in dist is either a mistake or an attack.
// 3. **Realpath containment:** belt-and-braces against a caller that
//    forgot to resolve the root's own symlinks — the daemon does
//    resolve `rootReal` once at startup, so this is a defensive check.
//
// Errors NEVER include the file's contents. The daemon logs a request
// id and the outcome kind ("traversal" | "symlink" | "outside" |
// "not-found"), and the client sees a 400 or a 404. Content bytes stay
// on disk when refused.

import { lstatSync, realpathSync } from "node:fs";
import { normalize, resolve, sep } from "node:path";

/** The outcome of `resolveWithinRoot`. On success, the file's real
 * absolute path. On failure, a machine-readable `kind` so the caller
 * (the static server) can render the right status code without
 * parsing the message. */
export type ResolveResult =
  | { ok: true; absolutePath: string }
  | { ok: false; kind: "invalid" | "traversal" | "not-found" | "symlink" | "outside"; message: string };

/** Split a POSIX-style URL path into its segments, dropping empty
 * segments so `/foo//bar/` and `foo/bar` produce the same list. */
function urlSegments(pathname: string): readonly string[] {
  return pathname.split("/").filter((segment) => segment.length > 0);
}

/** Resolve a request path (already URL-decoded by the caller) inside
 * `rootReal` (which itself is already a realpath). Returns the file's
 * real absolute path, or a typed rejection.
 *
 * Callers pass the URL's `pathname` after `decodeURIComponent` — that
 * turns `%2e%2e` into `..`, which the shape rule below catches
 * uniformly. NUL bytes are refused (path arguments must not contain
 * them; `readFile` treats them as end-of-string on some platforms).
 */
export function resolveWithinRoot(rootReal: string, pathname: string): ResolveResult {
  if (pathname.includes("\0")) {
    return { ok: false, kind: "invalid", message: "path contains a NUL byte" };
  }
  const segments = urlSegments(pathname);
  for (const segment of segments) {
    if (segment === "..") {
      return { ok: false, kind: "traversal", message: "path traversal segment '..' is refused" };
    }
    // `.` is dropped by `normalize` below, so we do not refuse it
    // outright — a legitimate URL might carry it.
    // Dot-directories and dotfiles: refuse any segment that begins
    // with `.` and is not a bare `.` (which `normalize` drops).
    // The daemon does not serve `/.git/…`, `/.revkit/…` or any
    // other dot-scoped tree — these are IDE / VCS / tool-state
    // directories that ended up in a served output only by
    // mistake, and revealing them over loopback still leaks
    // history. `.well-known/*` is not used by revkit; if a future
    // ADR needs it, this refusal is the one place to open a hole.
    // (M2 item 5b carry-over from #41 review.)
    if (segment.length > 1 && segment.charCodeAt(0) === 0x2e /* . */) {
      return { ok: false, kind: "not-found", message: "dot-prefixed path segment refused" };
    }
  }
  // Reassemble the path via `normalize` so an OS-specific separator
  // does not sneak in. `segments` has already stripped leading slashes
  // and refused '..', so this is defensive against a caller that
  // did some other odd normalisation.
  const joined = segments.join("/");
  const normalized = normalize(joined);
  // After normalize, if there is still a `..` (there should not be —
  // we refused above — but a Windows-style '..\\' input would slip past
  // a POSIX split; be defensive).
  if (normalized.split(/[/\\]/).includes("..")) {
    return { ok: false, kind: "traversal", message: "path traversal segment '..' is refused" };
  }
  const candidate = normalized === "" || normalized === "." ? rootReal : resolve(rootReal, normalized);

  let lstat;
  try {
    lstat = lstatSync(candidate);
  } catch {
    return { ok: false, kind: "not-found", message: "not found" };
  }
  if (lstat.isSymbolicLink()) {
    return { ok: false, kind: "symlink", message: "symlink refused" };
  }
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return { ok: false, kind: "not-found", message: "not found" };
  }
  // If `realpath` differs from `candidate`, there is a symlink somewhere
  // in the chain between the root and the file — refuse. (The leaf-
  // symlink case is already caught by the `lstat.isSymbolicLink()`
  // branch above; this branch catches an intermediate directory being
  // a symlink.)
  if (real !== candidate) {
    return { ok: false, kind: "symlink", message: "symlink in path chain refused" };
  }
  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    return { ok: false, kind: "outside", message: "path resolves outside the served root" };
  }
  return { ok: true, absolutePath: real };
}
