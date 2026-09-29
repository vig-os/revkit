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
// Devkit-managed docs under `docs/` (COMMIT_MESSAGE_STANDARD.md,
// DOWNSTREAM_RELEASE.md) are deliberately excluded — they document the
// release process, not revkit itself, and their titles would collide with
// the sidebar grouping (Design / ADRs / Matrix).
import type { Loader } from "astro/loaders";
import { readFile, readdir } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
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

/** First `# ` heading in the file — the ADR/design/matrix title. Falls back
 * to the filename with an explanatory error so a source that lacks a title
 * fails the build loudly (a silent fallback would produce nameless sidebar
 * entries). */
function extractTitle(body: string, filePath: string): string {
  for (const rawLine of body.split(/\r?\n/)) {
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
  for (const rawLine of body.split(/\r?\n/)) {
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
    async load({ config, store, parseData, generateDigest, renderMarkdown, watcher }) {
      const projectRoot = fileURLToPath(config.root);
      const docsRoot = resolve(projectRoot, baseFromProjectRoot);
      const sources = await discover(docsRoot);

      for (const source of sources) {
        const raw = await readFile(source.filePath, "utf8");
        const title = extractTitle(raw, source.filePath);
        const revkitStatus = extractStatus(raw);

        const frontmatter: Record<string, unknown> = { title };
        if (revkitStatus !== undefined) {
          frontmatter.revkitStatus = revkitStatus;
          // Starlight's sidebar badge picks up on this data field so the ADR
          // status is visible without opening the page (ADR-0003 acceptance).
          frontmatter.sidebar = { badge: { text: revkitStatus, variant: badgeVariantFor(revkitStatus) } };
        }

        const data = await parseData({
          id: source.id,
          data: frontmatter,
          filePath: source.filePath,
        });

        const body = stripLeadingHeading(raw);
        const rendered = await renderMarkdown(body, {
          fileURL: pathToFileURL(source.filePath),
        });

        // Astro requires filePath relative to the project root (site/), so a
        // repo-doc at /home/.../docs/adr/0001-*.md becomes ../docs/adr/… —
        // the same shape a glob loader would produce for a file above the
        // project root.
        const filePath = relative(projectRoot, source.filePath);
        store.set({
          id: source.id,
          data,
          body,
          filePath,
          digest: generateDigest(raw),
          rendered,
        });
      }

      if (watcher) {
        for (const source of sources) watcher.add(source.filePath);
      }
    },
  };
}
