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

/** Basenames that are ALWAYS tooling — even under a content prefix,
 * even with a content-allowed extension. Package manager manifests
 * and lockfiles never belong in a content directory, so a PR that
 * plants one there is refused (defense-in-depth against a
 * content-directory smuggle; the manifests are only meaningful to
 * package managers, but the CLASS of file is tooling and taking it
 * from the PR head would violate ADR-0025's "content from head,
 * tooling from base" rule regardless of location). */
const ALWAYS_TOOLING_BASENAMES: ReadonlySet<string> = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnpmrc",
]);

/** Path segments that are ALWAYS tooling if they appear ANYWHERE in
 * the path. `node_modules/` is never valid inside a PR — it is
 * derived from `package.json` on the reviewer's trusted toolchain,
 * never authored. `.git/` cannot appear in a tree anyway (git
 * refuses), but the segment check surfaces a clearer refusal if
 * something ever conspired to smuggle one in. */
const ALWAYS_TOOLING_SEGMENTS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".direnv",
]);

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
  const segments = path.split("/");
  if (segments.some((segment) => segment === "..")) return "tooling";

  // ALWAYS-tooling segments — `node_modules/anything`,
  // `.git/anything`, `.direnv/anything`. Applies before the prefix
  // check so a `docs/x/node_modules/evil.js` (which starts with a
  // content prefix and has a `.js` extension excluded from
  // CONTENT_ALLOWED_EXTENSIONS anyway) surfaces the clearest reason
  // — and a hypothetical future content extension that included
  // `.js` still refuses this path.
  if (segments.some((segment) => ALWAYS_TOOLING_SEGMENTS.has(segment))) return "tooling";

  // Prefix match.
  const onPrefix = CONTENT_ALLOWLIST_PREFIXES.some((prefix) => path.startsWith(prefix));
  if (!onPrefix) return "tooling";

  // Extension check. `path.basename.ext` — take everything after the
  // last `.` in the basename. A file without an extension counts as
  // tooling (a Makefile-like file in `docs/` is not content).
  const slash = path.lastIndexOf("/");
  const basename = slash === -1 ? path : path.slice(slash + 1);

  // ALWAYS-tooling basenames — `package.json`, lockfiles, `.npmrc`.
  // A `docs/x/package.json` has `.json` in CONTENT_ALLOWED_EXTENSIONS
  // and would otherwise be classified as content; this belt refuses
  // it regardless of location (PR #48 round-4 nit: defense-in-depth
  // against content-directory smuggle of package-manager metadata).
  if (ALWAYS_TOOLING_BASENAMES.has(basename)) return "tooling";

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
