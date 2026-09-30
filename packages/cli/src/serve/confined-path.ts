// Confine a request path to a root directory — the containment primitive
// the daemon's static server (`static-server.ts`) leans on to refuse path
// traversal and symlink escape.
//
// The three rules (same shape as `site/src/lib/plot-file-io.ts`'s
// `readConfinedSibling`, but the URL shape is different — plot data
// files are sibling filenames like `data.csv`, not URL paths like
// `/foo/bar.js` — so the shape check differs while the containment
// primitives are the same):
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
