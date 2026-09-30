// Path confinement for `POST /api/publish` (M2 item 9, story A4).
//
// The `publish` MCP tool writes to disk on the LOCAL machine (ADR-0013:
// this daemon is loopback-only, the agent has already been invited by
// the owner into this repo). Even so, an agent-supplied `path` reaches
// the daemon over the same wire as a browser-composed request — so
// the containment rules apply the same way they do to a rail POST:
// path traversal is refused, symlinks are refused, dot-prefixed
// segments are refused, and the final path MUST resolve to a file
// under one of the publishable roots below.
//
// **Publishable roots** are an ALLOWLIST, not a denylist (CLAUDE.md
// "Allowlist over denylist"). They enumerate the exact source
// locations the review pipeline knows how to render: the ADR /
// design / feature-matrix Markdown trees, the site's own content
// MDX, plot spec + data side files, and the vocabulary YAML. A path
// that doesn't match any of them is refused with a uniform reason,
// so a probe can't tell whether "you can't publish there" means
// "the file is outside the repo" (`docs.md`), "the extension is
// wrong" (`docs/adr/x.txt`), or "that tree isn't a publishable
// root" (`.github/workflows/x.yml`).
//
// **Symlink refusal** uses the same `resolveWithinRoot` helper the
// static server does (`confined-path.ts`) — one realpath + lstat
// pair, so an intermediate symlink between `<repoRoot>` and the
// file is refused whether it's the leaf or a parent (the
// pre-existing "no dot-prefixed segments" refusal keeps
// `.git/config` out too).
//
// **Route mapping** is a small, static map from a repo-relative
// source path to the site route the daemon serves it under. The
// values match the repo-docs loader's `siteRouteForDoc` for the
// three Markdown trees; MDX / data files return `undefined`
// (they participate in a page but do not have a page of their
// own, so publish emits `doc.published` without a `route`).

import { extname, dirname, resolve as resolvePath } from "node:path";
import { realpathSync } from "node:fs";
import { resolveWithinRoot } from "./confined-path.ts";

/** Uniform rejection string. `resolveWithinRoot` reports its own
 * fine-grained kinds internally (traversal / symlink / outside /
 * not-found); the daemon collapses them to one message on the wire
 * so a caller cannot distinguish which file exists. Same discipline
 * as `anchor-source.ts::UNIFORM_ANCHOR_REJECTION`. */
export const UNIFORM_PUBLISH_REJECTION =
  "publish.path is not a publishable target in the repository";

/** Hard cap on one source file the `publish` tool may write. 5 MiB
 * matches `ANCHOR_SOURCE_MAX_BYTES` — a source file that a comment
 * can anchor to has the same size ceiling as one the agent can
 * write. Bytes, not chars, so a UTF-8 payload with multi-byte
 * runes cannot double the effective cap. */
export const PUBLISH_FILE_MAX_BYTES = 5 * 1024 * 1024;

/** Hard cap on the total serialised bytes of ONE `publish` request
 * (all `docs` + `data` files combined). 10 MiB — twice the per-file
 * cap so a small batch is unaffected but a runaway payload cannot
 * eat the daemon's memory. */
export const PUBLISH_REQUEST_MAX_BYTES = 10 * 1024 * 1024;

/** Repo-relative publishable root prefixes. Each entry names one
 * source tree the review pipeline understands and pairs it with the
 * set of file extensions allowed inside — narrow, not wildcard, so
 * a stray `.sh` under `docs/` cannot be written even if the path
 * survives the confinement check. */
interface PublishableRoot {
  /** Repo-relative POSIX prefix, always ending in `/` OR (for the
   * single-file case) the exact file. */
  readonly prefix: string;
  /** Allowed file extensions (lowercase, with the dot). Empty means
   * "the prefix is an exact file, no children — extension is
   * whatever the file already carries". */
  readonly extensions: readonly string[];
  /** Human-readable label used in logs (never in the wire response). */
  readonly label: string;
}

/** The allowlist. Order is defensive-first: `docs/COMMIT_MESSAGE_STANDARD.md`
 * lives under `docs/` but is devkit-managed content, so a specific-
 * file entry that MATCHES the exact devkit-managed file would refuse
 * a write; instead, the allowlist NAMES the specific publishable
 * subtrees (`docs/adr/`, `docs/designs/`) plus the single
 * `docs/FEATURE-MATRIX.md`, so anything else under `docs/` is
 * refused as "outside a publishable root".
 *
 * MDX under `site/src/content/docs/` is deliberately EXCLUDED in
 * M2: the fast-path renderer does not yet drive the MDX pipeline
 * (compiles component JSX, runs Starlight expressive-code), so
 * allowing a write there would produce an override HTML that
 * diverges from the full build. Tracked in the ADR-0001 amendment
 * this PR ships. Callers hit the same refusal shape as any other
 * off-root path.
 */
const PUBLISHABLE_ROOTS: readonly PublishableRoot[] = Object.freeze([
  { prefix: "docs/adr/", extensions: [".md"], label: "adr" },
  { prefix: "docs/designs/", extensions: [".md"], label: "design" },
  { prefix: "docs/FEATURE-MATRIX.md", extensions: [], label: "feature-matrix" },
  // Plot spec + sibling data files (ADR-0004). A plot lives at
  // `plots/<name>/spec.vl.json` with siblings such as `data.json`,
  // `data.csv` — the daemon accepts either the spec OR one of the
  // registered data extensions.
  { prefix: "plots/", extensions: [".json", ".csv", ".tsv"], label: "plot" },
  // Vocabulary (ADR-0003). The check-time schema validates the
  // whole file; writing anything else there is refused by
  // `revkit check`'s frontmatter guard even if it survived here.
  { prefix: "vocab/terms.yaml", extensions: [], label: "vocab" },
]);

/** Static map from a repo-relative source path to the site route
 * the daemon serves it under. Mirrors `site/src/content/loaders/
 * repo-docs.ts::siteRouteForDoc` — one source of truth would need
 * an import from the site package, which the CLI package already
 * takes but at a much heavier level (the render-plot module). Kept
 * duplicated here with a paired unit test that pins both spellings
 * against a shared fixture, so a drift shows up as a red test on
 * either side (see `publish-confine.test.ts`). */
export function siteRouteForPath(path: string): string | undefined {
  if (path === "docs/FEATURE-MATRIX.md") return "/feature-matrix/";
  const adrMatch = path.match(/^docs\/adr\/(.+)\.md$/);
  if (adrMatch !== null && adrMatch[1] !== undefined) {
    return `/adr/${adrMatch[1].toLowerCase()}/`;
  }
  const designMatch = path.match(/^docs\/designs\/(.+)\.md$/);
  if (designMatch !== null && designMatch[1] !== undefined) {
    return `/designs/${designMatch[1].toLowerCase()}/`;
  }
  return undefined;
}

/** Result of `resolvePublishTarget`. On success, the file's absolute
 * path plus the label of the root it matched (for logs). On failure,
 * a uniform rejection string. */
export type ResolveTargetResult =
  | { ok: true; absolutePath: string; label: string; siteRoute: string | undefined }
  | { ok: false; reason: string };

/** Resolve one publish `path` against the repo root and the
 * allowlist. Returns the file's absolute path on success, or the
 * uniform rejection string on failure. Callers pass ONLY
 * repo-relative POSIX paths — leading `/` refused, `..` refused,
 * symlink refused (per `resolveWithinRoot`). */
export function resolvePublishTarget(
  repoRoot: string,
  repoRelativePath: string,
): ResolveTargetResult {
  // Shape check. A leading `/`, a Windows-style backslash, or an
  // empty segment is refused before touching the filesystem.
  if (repoRelativePath.length === 0) return { ok: false, reason: UNIFORM_PUBLISH_REJECTION };
  if (repoRelativePath.startsWith("/")) return { ok: false, reason: UNIFORM_PUBLISH_REJECTION };
  if (repoRelativePath.includes("\\")) return { ok: false, reason: UNIFORM_PUBLISH_REJECTION };
  if (repoRelativePath.includes("\0")) return { ok: false, reason: UNIFORM_PUBLISH_REJECTION };

  // Refuse uppercase extensions so the site route (case-sensitive
  // lower-case) and the on-disk filename agree. `foo.MD` and
  // `foo.md` would otherwise land at two different Astro
  // collection ids, so the confinement side rejects the
  // upper-case shape and the caller renames.
  const ext = extname(repoRelativePath);
  if (ext.length > 0 && ext !== ext.toLowerCase()) {
    return { ok: false, reason: UNIFORM_PUBLISH_REJECTION };
  }

  // Match against the allowlist FIRST. The alternative (resolve, then
  // check prefix) would leak "file exists" information via timing.
  let matched: PublishableRoot | undefined;
  for (const root of PUBLISHABLE_ROOTS) {
    if (root.extensions.length === 0) {
      // Exact-file entry.
      if (repoRelativePath === root.prefix) {
        matched = root;
        break;
      }
      continue;
    }
    // Prefix entry.
    if (repoRelativePath.startsWith(root.prefix)) {
      const ext = extname(repoRelativePath).toLowerCase();
      if (root.extensions.includes(ext)) {
        matched = root;
        break;
      }
    }
  }
  if (matched === undefined) return { ok: false, reason: UNIFORM_PUBLISH_REJECTION };

  // Containment: resolve under the realpath'd repo root, refuse any
  // symlink in the chain, refuse traversal. Note the leading `/` we
  // pass to `resolveWithinRoot` — that helper takes a URL path.
  let rootReal: string;
  try {
    rootReal = realpathSync(resolvePath(repoRoot));
  } catch {
    return { ok: false, reason: UNIFORM_PUBLISH_REJECTION };
  }
  const resolved = resolveWithinRoot(rootReal, "/" + repoRelativePath);
  // `resolveWithinRoot` refuses when the file does NOT exist, but a
  // publish MUST accept a brand-new file (that's the whole point).
  // Fall back to a two-step containment check for the not-found
  // case: resolve the PARENT (which must exist and be a real dir
  // under the root), then join the filename and confirm no `..`
  // escaped.
  if (resolved.ok) {
    return {
      ok: true,
      absolutePath: resolved.absolutePath,
      label: matched.label,
      siteRoute: siteRouteForPath(repoRelativePath),
    };
  }
  if (resolved.kind !== "not-found") {
    return { ok: false, reason: UNIFORM_PUBLISH_REJECTION };
  }
  // Recurse on the parent so a `docs/adr/new-file.md` where
  // `docs/adr/` already exists succeeds — but a
  // `docs/adr/new-dir/new-file.md` requires `docs/adr/new-dir/` to
  // exist too (the daemon does NOT create nested subdirectories
  // for you: the publishable roots are the only recognised
  // containers, and each of them is a single flat directory).
  const parent = dirname(repoRelativePath);
  if (parent.length === 0 || parent === ".") return { ok: false, reason: UNIFORM_PUBLISH_REJECTION };
  const parentResolved = resolveWithinRoot(rootReal, "/" + parent);
  if (!parentResolved.ok) return { ok: false, reason: UNIFORM_PUBLISH_REJECTION };
  // Compose the absolute path from the parent's realpath so a
  // symlinked directory in the middle can never be created inside.
  const absolutePath = `${parentResolved.absolutePath}/${repoRelativePath.slice(parent.length + 1)}`;
  return {
    ok: true,
    absolutePath,
    label: matched.label,
    siteRoute: siteRouteForPath(repoRelativePath),
  };
}
