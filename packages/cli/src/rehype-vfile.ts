// Shared VFile → filesystem path helpers used by the two rehype
// plugins (`rehype-data-src`, `rehype-drop-repo-doc-title`).
// Extracted to ONE module (PR #38 round-2 review: duplication).

import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Minimal VFile view. The unified pipeline hands the plugin a
 * `VFile`-shaped object; we touch only `path`, `history`, and the
 * Astro-specific `data.astro.fileURL`. `data` is `unknown` so
 * downstream extensions do not narrow this type. */
export interface VFileLike {
  readonly path?: string;
  readonly history?: readonly string[];
  readonly data?: unknown;
}

/** Extract the source file's absolute path from a VFile. Falls
 * back to `file.data.astro.fileURL` when Astro's markdown pipeline
 * hands the path in its `data` bag. */
export function filePathOf(file: VFileLike): string | undefined {
  if (typeof file.path === "string" && file.path.length > 0) return file.path;
  if (Array.isArray(file.history) && file.history.length > 0) {
    const last = file.history[file.history.length - 1];
    if (typeof last === "string" && last.length > 0) return last;
  }
  const data = file.data;
  if (data !== undefined && data !== null && typeof data === "object") {
    const astro = (data as { readonly astro?: unknown }).astro;
    if (astro !== undefined && astro !== null && typeof astro === "object") {
      const astroFileUrl = (astro as { readonly fileURL?: unknown }).fileURL;
      if (astroFileUrl instanceof URL) return fileURLToPath(astroFileUrl);
      if (typeof astroFileUrl === "string" && astroFileUrl.length > 0) {
        try {
          return fileURLToPath(new URL(astroFileUrl));
        } catch {
          return astroFileUrl;
        }
      }
    }
  }
  return undefined;
}

/** POSIX-normalised path relative to `repoRoot`, or undefined if
 * the file escapes the root. */
export function repoRelativePosix(repoRoot: string, filePath: string): string | undefined {
  const rel = relative(resolve(repoRoot), resolve(filePath));
  if (rel.length === 0 || rel.startsWith("..")) return undefined;
  return sep === "/" ? rel : rel.split(sep).join("/");
}
