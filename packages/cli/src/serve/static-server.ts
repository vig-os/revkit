// Static file resolution for the daemon.
//
// The `openStaticServer(dir)` function realpath-resolves `dir` once
// at open time and then answers `resolve(pathname)` requests with a
// full containment check (`confined-path.ts`). Directories map to
// `index.html`; missing files fall back to `<path>.html` (Astro's
// default output shape).
//
// This module is intentionally small: containment lives in
// `confined-path.ts`, MIME lives in `mime.ts`, headers live in
// `daemon.ts`. What this file owns is one `realpath` at open time
// (so a symlinked `site/dist -> ../build/site` still gets the
// containment check right for its contents), a `resolve(pathname)`
// that returns `{absolutePath}` or a typed rejection, a
// `size(absolutePath)` for HEAD responses, and a `close()` that is
// today a no-op but keeps the surface stable if a future
// implementation caches file descriptors.

import { existsSync, realpathSync, statSync } from "node:fs";
import { resolveWithinRoot, type ResolveResult } from "./confined-path.ts";

/** Handle returned by `openStaticServer`. */
export interface StaticServer {
  /** Resolve a URL pathname (already URL-decoded) inside the served
   * root. On a directory hit, resolves to `<dir>/index.html`. Missing
   * files fall back to `<path>.html`. */
  resolve(pathname: string): ResolveResult;
  /** Size in bytes of a resolved file. Only called with an
   * `absolutePath` returned by a successful `resolve`. */
  size(absolutePath: string): number;
  /** Release any state. Currently a no-op. */
  close(): void;
}

/** Open a static server over `dir`. Throws if `dir` does not exist or
 * is not a directory — a misconfigured daemon should refuse to start
 * rather than serve nothing. */
export function openStaticServer(dir: string): StaticServer {
  if (!existsSync(dir)) {
    throw new Error(`revkit serve: --dir '${dir}' does not exist.`);
  }
  const dirStat = statSync(dir);
  if (!dirStat.isDirectory()) {
    throw new Error(`revkit serve: --dir '${dir}' is not a directory.`);
  }
  const rootReal = realpathSync(dir);

  const resolve = (pathname: string): ResolveResult => {
    const first = resolveWithinRoot(rootReal, pathname);
    if (!first.ok) return first;
    // Astro / Starlight emit `<page>/index.html` (directory-with-
    // index) by default and revkit does not override that, so we
    // only need the two candidates: the resolved file itself, or its
    // `index.html` when the resolved path is a directory. Each
    // candidate goes through `resolveWithinRoot` again so the
    // containment check applies at every step.
    const stat = statSync(first.absolutePath);
    if (stat.isDirectory()) {
      const indexed = resolveWithinRoot(rootReal, join(pathname, "index.html"));
      if (indexed.ok) {
        // Confirm it is a file, not another directory.
        try {
          const indexStat = statSync(indexed.absolutePath);
          if (indexStat.isFile()) return indexed;
        } catch {
          // Fall through to 404.
        }
      }
      return { ok: false, kind: "not-found", message: "not found" };
    }
    if (stat.isFile()) return first;
    return { ok: false, kind: "not-found", message: "not found" };
  };

  return {
    resolve,
    size(absolutePath: string): number {
      return statSync(absolutePath).size;
    },
    close(): void {
      // No cached state today.
    },
  };
}

/** Join two URL path segments so a trailing slash is not doubled and a
 * leading slash on the right does not reset the join. */
function join(a: string, b: string): string {
  if (a.endsWith("/") && b.startsWith("/")) return a + b.slice(1);
  if (!a.endsWith("/") && !b.startsWith("/")) return a + "/" + b;
  return a + b;
}
