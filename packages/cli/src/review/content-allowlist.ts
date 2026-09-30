// The committed **CONTENT allowlist** — the ONLY paths in a PR head
// whose bytes the safe-build materializer trusts from the PR (ADR-0025:
// "The build uses the reviewer's TRUSTED revkit toolchain and config
// from the base branch; it takes only *content* from the PR head").
//
// **This is an allowlist, not a denylist, on purpose.** A denylist
// (list the "tooling" paths that must come from base) would fail open
// on a new attack surface introduced by a future PR that plants an
// executable file in a directory the denylist hasn't heard of. An
// allowlist fails safe: anything not on it is tooling, so a new
// executable spot introduced by a hostile PR is refused by default.
//
// The prefixes below are the directories that hold revkit's authoring
// surface (ADR-0003/0004/0005):
//
//   - `docs/`         — MDX prose + ADRs + designs
//   - `vocab/`        — the vocabulary tables that `revkit check` walks
//   - `plots/`        — plot specs (`spec.vl.json`) + sibling data files
//   - `site/src/content/` — Starlight content collections
//   - `site/src/content/docs/` (a sub-tree) is covered by the parent
//
// The file extensions inside those directories are further constrained
// by `isAllowedContentExtension` to a small, well-known set — a `.js`
// or `.sh` file dropped inside `docs/` is refused (it isn't content),
// even though `docs/` is on the allowlist.

/** Prefixes of allowed content directories, POSIX-normalised (trailing
 * slash). Order does not matter; matching is prefix-based. */
export const CONTENT_ALLOWLIST_PREFIXES: readonly string[] = Object.freeze([
  "docs/",
  "vocab/",
  "plots/",
  "site/src/content/",
]);

/** File extensions (with leading dot, lowercase) allowed inside content
 * directories. Prose (`.md`, `.mdx`), data (`.json`, `.yaml`, `.yml`),
 * plot specs (`.vl.json` is `.json`), and the odd figure asset
 * (`.svg`, `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.avif`).
 * `.mjs` / `.ts` / `.astro` / `.tsx` are DELIBERATELY OFF the list —
 * a `.ts` file inside `docs/` is code, not content, and the M3 build
 * takes it from base. */
export const CONTENT_ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  ".md",
  ".mdx",
  ".json",
  ".yaml",
  ".yml",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".avif",
]);

/** Classify a repo-relative POSIX path. `content` when the path lives
 * under a content prefix and carries an allowed extension; `tooling`
 * otherwise. The materializer trusts `content` paths from the PR head
 * and rebuilds `tooling` paths from base. */
export type PathClass = "content" | "tooling";

/** Classify a repo-relative POSIX path. */
export function classifyPath(path: string): PathClass {
  // Refuse any absolute path (should be repo-relative), any `..`
  // segment (should have been rejected earlier), and any `\\`
  // separator (POSIX-only). Callers are the git-runner output, which
  // is POSIX-normalised, but a defensive check keeps a Windows-shape
  // path from silently matching a prefix.
  if (path.length === 0) return "tooling";
  if (path.startsWith("/")) return "tooling";
  if (path.includes("\\")) return "tooling";
  if (path.split("/").some((segment) => segment === "..")) return "tooling";

  // Prefix match.
  const onPrefix = CONTENT_ALLOWLIST_PREFIXES.some((prefix) => path.startsWith(prefix));
  if (!onPrefix) return "tooling";

  // Extension check. `path.basename.ext` — take everything after the
  // last `.` in the basename. A file without an extension counts as
  // tooling (a Makefile-like file in `docs/` is not content).
  const slash = path.lastIndexOf("/");
  const basename = slash === -1 ? path : path.slice(slash + 1);
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) return "tooling"; // no ext, or dotfile like `.gitkeep`
  const ext = basename.slice(dot).toLowerCase();
  return CONTENT_ALLOWED_EXTENSIONS.has(ext) ? "content" : "tooling";
}

/** True when `path` is under any content prefix, regardless of
 * extension. Used by the tooling-diff to spot the "well-known prefix
 * but wrong extension" case for a clearer diagnostic. */
export function isUnderContentPrefix(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\")) return false;
  if (path.split("/").some((segment) => segment === "..")) return false;
  return CONTENT_ALLOWLIST_PREFIXES.some((prefix) => path.startsWith(prefix));
}
