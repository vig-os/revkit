// Map `<consumer>/docs/**/*.md(x)` → the dist-relative page path Starlight
// emits for each. Used by `revkit build` to hand `check-dist` the set of
// pages whose source bodies were non-empty, so the output-gate can fail
// loudly on a page that silently rendered empty (issue #237, defense in
// depth after the astro-level `guardedDocsLoader`).
//
// Starlight ultimately routes a glob-loaded entry through astro's slug
// algorithm (lower-case `githubSlug` per path segment, `/index` stripped
// from the tail) and writes it as `<slug>/index.html`, with the root
// (empty) slug writing to `index.html`. The slug function here mirrors
// that behaviour for the realistic character set consumer docs use
// (ASCII alphanumeric + `-`, `_`, spaces, dots). A consumer whose filename
// slips through this mapping (unusual unicode letters) is not covered by
// the defense-in-depth scan — the primary build-time guard in
// `site/src/content/assert-rendered.ts` is the backstop for that case.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";

/** Return the set of dist-relative page paths whose source doc under
 * `docsDir` has a non-empty body. An unreadable or missing `docsDir`
 * yields an empty set — the caller is `revkit build`, which has already
 * run `revkit check` against the consumer tree and failed on missing
 * trees. */
export function collectPagesWithNonEmptySource(docsDir: string): Set<string> {
  const out = new Set<string>();
  let roots: readonly string[];
  try {
    const st = statSync(docsDir, { throwIfNoEntry: false });
    if (st === undefined || !st.isDirectory()) return out;
    roots = walkMarkdown(docsDir);
  } catch {
    return out;
  }
  for (const abs of roots) {
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const body = stripFrontmatter(text);
    if (body.trim().length === 0) continue;
    const rel = relative(docsDir, abs);
    const page = distPagePathFromSourceRelPath(rel);
    if (page === null) continue;
    out.add(page);
  }
  return out;
}

/** Strip a leading YAML frontmatter block (`---\n…\n---\n`) from a
 * markdown/MDX source. The dash fence must be the very first bytes of
 * the file; any other `---` farther down is left alone. */
export function stripFrontmatter(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  if (match === null) return text;
  return text.slice(match[0].length);
}

/** Compute the dist-relative page path (`"index.html"` / `"foo/index.html"`
 * / `"adr/0001-record/index.html"`) Starlight writes for a source file
 * whose path is `relFromDocsDir` within the docs directory. Returns
 * `null` when the file is not a markdown source we route (we accept
 * `.md` and `.mdx`, matching `docsExtensions` in
 * `@astrojs/starlight/dist/loaders.js`). */
export function distPagePathFromSourceRelPath(
  relFromDocsDir: string,
): string | null {
  const ext = extname(relFromDocsDir).toLowerCase();
  if (ext !== ".md" && ext !== ".mdx") return null;
  const withoutExt = relFromDocsDir.slice(0, relFromDocsDir.length - ext.length);
  const segments = withoutExt.split(sep).map(githubSlugMinimal);
  const slug = segments.join("/").replace(/\/index$/, "");
  const rootSlug = slug.length === 0 || slug === "index" ? "" : slug;
  return rootSlug.length === 0 ? "index.html" : `${rootSlug}/index.html`;
}

/** Minimal slug function matching astro's `github-slugger` for the
 * characters consumer docs realistically use. The real implementation
 * normalises unicode, folds emoji and handles diacritics; this one
 * handles ASCII letters, digits, `-`, `_`, `.`, spaces. That covers
 * every filename in revkit's own docs and every one we have seen in
 * practice. Edge cases (accented filenames, emoji in filenames) are
 * caught by the primary build-time guard, not this map. */
export function githubSlugMinimal(segment: string): string {
  return segment
    .toLowerCase()
    // Any run of whitespace / `_` / `.` collapses to a single hyphen.
    .replace(/[\s_.]+/g, "-")
    // Drop every character that is not a lowercase letter, digit or
    // hyphen (no accented letters etc).
    .replace(/[^a-z0-9-]/g, "")
    // Trim leading / trailing hyphens so `_foo_.md` → `foo`.
    .replace(/^-+|-+$/g, "");
}

function walkMarkdown(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Starlight's glob pattern (`**/[^_]*.{md,mdx}`) excludes files
      // and directories whose name starts with `_`. Mirror that so
      // `_private.md` sources are not expected to produce dist pages.
      if (entry.name.startsWith("_")) continue;
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (ext !== ".md" && ext !== ".mdx") continue;
      // Skip hidden dotfiles (`.DS_Store` etc. rarely masquerade as md).
      if (basename(entry.name).startsWith(".")) continue;
      out.push(abs);
    }
  }
  return out;
}
