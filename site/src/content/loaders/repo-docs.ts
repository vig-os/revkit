// Loader that maps revkit's own docs — ADRs, design docs and the feature
// matrix — into Starlight's `docs` collection so the built site renders them
// (M1 item 2 dogfood, issue #6).
//
// The ADR and design files are the source of truth (scripts/adr-index.sh and
// the adr-matrix guard both parse them), so this loader does NOT require
// frontmatter on them: it derives the page title from the first `# ` heading
// in the file and, for ADRs, carries the `- Status: <value>` line through as
// `revkitStatus` so the page can render it as a badge.
//
// Cross-doc links (`docs/adr/0002-*.md`, `../FEATURE-MATRIX.md`, etc.) are
// rewritten to the built site's own routes. Links to files outside the
// rendered set (`LICENSE`, `scripts/adr-index.sh`) become GitHub blob URLs
// on `main`, so the reader can follow them from the rendered page even
// though revkit does not publish them itself.
//
// Devkit-managed docs under `docs/` (COMMIT_MESSAGE_STANDARD.md,
// DOWNSTREAM_RELEASE.md) are deliberately excluded — they document the
// release process, not revkit itself, and their titles would collide with
// the sidebar grouping (Design / ADRs / Matrix).
import type { Loader, LoaderContext } from "astro/loaders";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** One repo-docs source: absolute path plus the collection id it should
 * publish under (Starlight routes to `/{id}`). */
interface Source {
  filePath: string;
  id: string;
}

const ADR_DIR = "adr";
const DESIGNS_DIR = "designs";
const MATRIX_FILE = "FEATURE-MATRIX.md";
const MATRIX_ID = "feature-matrix";

/** GitHub blob URL for files this loader references but does not render
 * (LICENSE, scripts/…, docs/COMMIT_MESSAGE_STANDARD.md). Pinned to `main`
 * so a link written into a prose page keeps resolving after the current
 * branch is deleted — this is the shape a Renovate-style bot would give,
 * and is the choice stated in PR #20's Decisions section. */
const GITHUB_BLOB_BASE = "https://github.com/vig-os/revkit/blob/main/";

/** Walk `../docs/adr` and `../docs/designs`, and add `FEATURE-MATRIX.md`,
 * mapping each into a Starlight id (`adr/<slug>`, `designs/<slug>`,
 * `feature-matrix`). Devkit-managed docs sitting alongside are skipped. */
async function discover(docsRoot: string): Promise<Source[]> {
  const sources: Source[] = [];

  for (const dir of [ADR_DIR, DESIGNS_DIR]) {
    const dirPath = join(docsRoot, dir);
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".md")) continue;
      const slug = basename(entry.name, ".md").toLowerCase();
      sources.push({
        filePath: join(dirPath, entry.name),
        id: `${dir}/${slug}`,
      });
    }
  }

  sources.push({
    filePath: join(docsRoot, MATRIX_FILE),
    id: MATRIX_ID,
  });

  return sources;
}

/** Strip fenced code blocks from a source body so extractTitle /
 * extractStatus never match a `# ` heading or `- Status:` line that lives
 * inside an example. The check treats a line starting with three or more
 * backticks or tildes as a fence; identical delimiter closes the block. */
function stripFencedCode(body: string): string {
  const lines = body.split(/\r?\n/);
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    if (fence !== null) {
      if (line.trimStart().startsWith(fence)) fence = null;
      continue;
    }
    const openMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (openMatch) {
      fence = openMatch[1][0].repeat(openMatch[1].length);
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

/** First `# ` heading in the file — the ADR/design/matrix title. Throws with
 * an explanatory message so a source that lacks a title fails the build
 * loudly (a silent fallback would produce nameless sidebar entries). */
function extractTitle(body: string, filePath: string): string {
  for (const rawLine of stripFencedCode(body).split(/\r?\n/)) {
    const match = rawLine.match(/^#\s+(.+?)\s*$/);
    if (match) return match[1];
  }
  throw new Error(
    `repo-docs loader: ${filePath} has no '# <title>' heading; add one (or exclude the file) — the docs collection uses it as the page title.`,
  );
}

/** Map an ADR status to a Starlight badge variant. Falls back to `default`
 * so an unrecognised status still renders, rather than throwing at build
 * time — a new status word is a soft addition, not a schema break. */
function badgeVariantFor(status: string): "success" | "tip" | "note" | "caution" | "danger" | "default" {
  const normalised = status.trim().toLowerCase();
  if (normalised === "accepted") return "success";
  if (normalised === "proposed") return "tip";
  if (normalised === "superseded" || normalised === "deprecated") return "caution";
  if (normalised === "rejected") return "danger";
  return "default";
}

/** ADR files carry `- Status: Accepted` (or Proposed / Superseded / …) as
 * the first bulleted field; the design docs and the matrix do not. Returns
 * `undefined` when there is no such line, which is fine for non-ADR pages. */
function extractStatus(body: string): string | undefined {
  for (const rawLine of stripFencedCode(body).split(/\r?\n/)) {
    const match = rawLine.match(/^-\s*Status:\s*(.+?)\s*$/i);
    if (match) return match[1];
  }
  return undefined;
}

/** Strip the leading `# <title>` line (and any blank lines that follow) so
 * Starlight's own heading doesn't render twice — its layout renders the
 * title from frontmatter above the body. */
function stripLeadingHeading(body: string): string {
  const lines = body.split(/\r?\n/);
  let index = 0;
  while (index < lines.length && lines[index].trim() === "") index += 1;
  if (index < lines.length && /^#\s+/.test(lines[index])) {
    index += 1;
    while (index < lines.length && lines[index].trim() === "") index += 1;
  }
  return lines.slice(index).join("\n");
}

/** Map a repo-relative markdown path (POSIX-normalised, e.g.
 * `docs/adr/0002-solid-islands-component-registry.md`) to the site route
 * that renders it. Returns `null` when the file is not one of the rendered
 * docs (e.g. `LICENSE`, `docs/COMMIT_MESSAGE_STANDARD.md`, `scripts/…`) —
 * the caller then falls back to a GitHub blob URL. */
export function siteRouteForDoc(repoRelativePath: string): string | null {
  if (repoRelativePath === "docs/FEATURE-MATRIX.md") return "/feature-matrix/";
  const adrMatch = repoRelativePath.match(/^docs\/adr\/(.+)\.md$/);
  if (adrMatch) return `/adr/${adrMatch[1].toLowerCase()}/`;
  const designMatch = repoRelativePath.match(/^docs\/designs\/(.+)\.md$/);
  if (designMatch) return `/designs/${designMatch[1].toLowerCase()}/`;
  return null;
}

/**
 * Rewrite `href="…md(#anchor)?"` attributes in a rendered HTML fragment.
 *
 * - Absolute URLs (`https:`, `mailto:`, `#anchor`) pass through untouched.
 * - A link that points at a rendered doc becomes the site route for that
 *   doc, with any fragment preserved.
 * - Anything else (files revkit does not publish) becomes a GitHub blob URL
 *   on `main` — the fixed default branch, so the link stays live after any
 *   feature branch is deleted.
 *
 * Exported so unit tests can exercise the mapping without a full render.
 */
export function rewriteInternalMarkdownLinks(
  html: string,
  sourceFileAbsolutePath: string,
  repoRoot: string,
): string {
  const sourceDir = dirname(sourceFileAbsolutePath);
  return html.replace(/href="([^"]+)"/g, (attr, href: string) => {
    // External or same-page anchors: pass through.
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("//")) {
      return attr;
    }
    // Only rewrite links that target a Markdown file (with or without a
    // fragment). Anything else (assets, subpaths of images) is left as-is
    // so the underlying markdown renderer's own resolution stays authoritative.
    const mdMatch = href.match(/^([^#?]+\.md)(#[^?]*)?$/i);
    if (!mdMatch) return attr;
    const relativeMdPath = mdMatch[1];
    const fragment = mdMatch[2] ?? "";
    const targetAbsolute = resolve(sourceDir, relativeMdPath);
    const repoRelative = posix.normalize(
      relative(repoRoot, targetAbsolute).split(/[\\/]/).join("/"),
    );
    const siteRoute = siteRouteForDoc(repoRelative);
    if (siteRoute !== null) return `href="${siteRoute}${fragment}"`;
    return `href="${GITHUB_BLOB_BASE}${repoRelative}${fragment}"`;
  });
}

/** Extract every remaining internal `.md` href from the rendered HTML so
 * the loader can fail the build if the rewrite ever misses one (regression
 * guard for the C3 links + sets rule). */
function findResidualMdHrefs(html: string): string[] {
  const residual: string[] = [];
  for (const match of html.matchAll(/href="([^"]+\.md(?:#[^"]*)?)"/g)) {
    const href = match[1];
    if (/^https?:/i.test(href)) continue;
    residual.push(href);
  }
  return residual;
}

async function loadSource(
  source: Source,
  ctx: LoaderContext,
  repoRoot: string,
  projectRoot: string,
): Promise<void> {
  const raw = await readFile(source.filePath, "utf8");
  const title = extractTitle(raw, source.filePath);
  const revkitStatus = extractStatus(raw);

  const frontmatter: Record<string, unknown> = { title };
  if (revkitStatus !== undefined) {
    frontmatter.revkitStatus = revkitStatus;
    // Starlight's sidebar badge picks up on this data field so the ADR
    // status is visible without opening the page (ADR-0003 acceptance).
    frontmatter.sidebar = {
      badge: { text: revkitStatus, variant: badgeVariantFor(revkitStatus) },
    };
  }

  const data = await ctx.parseData({
    id: source.id,
    data: frontmatter,
    filePath: source.filePath,
  });

  const body = stripLeadingHeading(raw);
  const rendered = await ctx.renderMarkdown(body, {
    fileURL: pathToFileURL(source.filePath),
  });

  const rewrittenHtml = rewriteInternalMarkdownLinks(rendered.html, source.filePath, repoRoot);
  const residual = findResidualMdHrefs(rewrittenHtml);
  if (residual.length > 0) {
    throw new Error(
      `repo-docs loader: ${source.filePath} still contains internal .md hrefs after rewrite: ${residual.join(", ")}. Fix rewriteInternalMarkdownLinks so every internal link either resolves to a site route or a GitHub blob URL.`,
    );
  }

  // Astro requires filePath relative to the project root (site/), so a
  // repo-doc at /home/.../docs/adr/0001-*.md becomes ../docs/adr/… —
  // the same shape a glob loader would produce for a file above the
  // project root.
  const filePath = relative(projectRoot, source.filePath);
  ctx.store.set({
    id: source.id,
    data,
    body,
    filePath,
    digest: ctx.generateDigest(raw),
    rendered: { ...rendered, html: rewrittenHtml },
  });
}

/**
 * Load repo-sourced docs into the Starlight `docs` collection.
 *
 * The base path is resolved relative to the Astro project root (`site/`), so
 * the default `../docs` reaches this repo's `docs/` directory. Tests inject
 * an absolute base to stay hermetic.
 */
export function repoDocsLoader(baseFromProjectRoot = "../docs"): Loader {
  return {
    name: "revkit-repo-docs-loader",
    async load(context) {
      const projectRoot = fileURLToPath(context.config.root);
      const docsRoot = resolve(projectRoot, baseFromProjectRoot);
      const repoRoot = dirname(docsRoot);
      const sources = await discover(docsRoot);

      for (const source of sources) {
        await loadSource(source, context, repoRoot, projectRoot);
      }

      const { watcher } = context;
      if (!watcher) return;

      // Watch the containing directories (chokidar recurses by default) so a
      // brand-new ADR added during `astro dev` is picked up without a
      // restart. sourceForPath maps a chokidar event back to the id the
      // repo-docs loader would assign it — anything outside the docs/adr
      // and docs/designs .md set is ignored so the callback stays cheap.
      const adrDir = join(docsRoot, ADR_DIR);
      const designsDir = join(docsRoot, DESIGNS_DIR);
      const matrixFile = join(docsRoot, MATRIX_FILE);
      watcher.add(adrDir);
      watcher.add(designsDir);
      watcher.add(matrixFile);

      const sourceForPath = (rawPath: string): Source | null => {
        const absolute = resolve(rawPath);
        if (absolute === matrixFile) return { filePath: absolute, id: MATRIX_ID };
        if (!absolute.endsWith(".md")) return null;
        for (const [dir, prefix] of [
          [adrDir, ADR_DIR],
          [designsDir, DESIGNS_DIR],
        ] as const) {
          if (absolute === join(dir, basename(absolute)) && dirname(absolute) === dir) {
            return { filePath: absolute, id: `${prefix}/${basename(absolute, ".md").toLowerCase()}` };
          }
        }
        return null;
      };

      const rerun = async (rawPath: string, kind: "change" | "delete"): Promise<void> => {
        const source = sourceForPath(rawPath);
        if (!source) return;
        if (kind === "delete") {
          context.store.delete(source.id);
          return;
        }
        try {
          await loadSource(source, context, repoRoot, projectRoot);
        } catch (error) {
          context.logger.error(
            `revkit-repo-docs-loader: reload of ${source.id} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      };

      // chokidar emits `add` on the initial scan too; that just re-loads
      // the entries we already loaded above, which is idempotent — the
      // store's digest check dedupes real writes. `unlink` handles deletes.
      watcher.on("add", (path) => {
        void rerun(path, "change");
      });
      watcher.on("change", (path) => {
        void rerun(path, "change");
      });
      watcher.on("unlink", (path) => {
        void rerun(path, "delete");
      });
    },
  };
}
