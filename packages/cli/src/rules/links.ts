// links (C3, ADR-0005): every relative link in repo docs and site content
// resolves to a real file, and any `#fragment` matches a heading anchor
// in that file. Absolute URLs (http, https, mailto, tel), same-page `#`
// anchors and protocol-less external references (`//host/path`) pass
// through — this rule owns file-level resolution, not external URL
// health.
//
// Heading slugs are computed with the same lowercase-and-collapse rule
// GitHub / Starlight use (github-slugger's core algorithm) so a link like
// `../adr/0005-guards.md#context` matches the ADR's `## Context`.
//
// Doc-set ordering / orphan rules are C3's second half (item 5) and
// deliberately not scoped here (per the plan).

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import type { Link, Nodes } from "mdast";
import type { Diagnostic } from "../diagnostics.ts";
import { lineOf, parseSourceFor, walkMdast } from "../mdx-parse.ts";

/** Cache of file-path -> heading-slug set, so a link check that walks a
 * 20-file docs tree parses each file at most once. */
type SlugCache = Map<string, Set<string>>;

/** Compute a heading anchor slug the way GitHub renders them. Kept
 * inline (rather than pulling `github-slugger`) so the rule has no
 * runtime dep for a well-defined 20-line transform, and so a future
 * change to what a slug looks like stays visible in one place. */
export function headingSlug(text: string): string {
  return text
    .toLowerCase()
    // Strip a small set of punctuation that GitHub drops. Keep letters,
    // digits, hyphens, underscores and combining marks.
    .replace(/[ -⁯⸀-⹿\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Extract every heading's anchor slug for a markdown / MDX file. The
 * parse is cached in `cache` — a docs tree with many cross-links reads
 * each file at most once. */
function slugsFor(filePath: string, cache: SlugCache): Set<string> {
  const cached = cache.get(filePath);
  if (cached) return cached;
  const slugs = new Set<string>();
  let source: string;
  try {
    source = readFileSync(filePath, "utf8");
  } catch {
    cache.set(filePath, slugs);
    return slugs;
  }
  const root = parseSourceFor(filePath, source);
  walkMdast(root as unknown as Nodes, (node) => {
    if (node.type !== "heading") return;
    const heading = node as { children: readonly Nodes[] };
    // Collect all text-carrying descendants.
    let text = "";
    walkMdast(heading as unknown as Nodes, (child) => {
      if (child.type === "text" || child.type === "inlineCode") {
        text += (child as unknown as { value: string }).value;
      }
    });
    if (text.length > 0) slugs.add(headingSlug(text));
  });
  cache.set(filePath, slugs);
  return slugs;
}

/** Is `href` an external URL / same-page anchor / mail link / built-site
 * route? Those pass through file-level link checking here. Built-site
 * routes (leading `/`) are Starlight's routing layer, not a filesystem
 * path — the site's `starlight-links-validator` integration checks
 * them at build time (DESIGN-0001 §2), so this rule owns relative-path
 * resolution only. */
function isExternalOrAnchor(href: string): boolean {
  if (href.length === 0) return true;
  if (href.startsWith("#")) return true;
  if (href.startsWith("/")) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return true;
  return false;
}

/** Result of one file-check: findings only; the cache is passed in and
 * mutated so a batch run shares heading parses across files. */
export function checkLinksFile(
  source: string,
  absoluteFilePath: string,
  reportPath: string,
  cache: SlugCache = new Map(),
  repoRoot?: string,
): Diagnostic[] {
  const root = parseSourceFor(absoluteFilePath, source);
  const findings: Diagnostic[] = [];
  const sourceDir = dirname(absoluteFilePath);

  walkMdast(root as unknown as Nodes, (node) => {
    if (node.type !== "link") return;
    const link = node as Link;
    const href = link.url;
    if (isExternalOrAnchor(href)) return;

    // Split off `#anchor` and any `?query` (query strings are unusual in
    // markdown but must not break the file check).
    const hashIndex = href.indexOf("#");
    const questionIndex = href.indexOf("?");
    const boundary = [hashIndex, questionIndex].filter((idx) => idx !== -1).sort((a, b) => a - b)[0];
    const [pathPart, fragment] = boundary === undefined
      ? [href, ""]
      : [href.slice(0, boundary), hashIndex === -1 ? "" : href.slice(hashIndex + 1)];

    const targetAbsolute = resolve(sourceDir, pathPart);

    // Refuse relative traversals that escape the repo root — a link
    // like `../../../../../../etc/passwd` is broken by intent, not by
    // typo. When `repoRoot` is not supplied (bare unit-test call), fall
    // back to the existence check alone.
    if (repoRoot !== undefined) {
      const trimmedRoot = repoRoot.endsWith(sep) ? repoRoot.slice(0, -1) : repoRoot;
      const rel = relative(trimmedRoot, targetAbsolute);
      if (rel.startsWith("..") || rel === "" && sourceDir !== trimmedRoot) {
        // `rel === ""` means the link resolves TO the repo root, which
        // is a directory not a file — flagged below in any case.
      }
      if (rel.startsWith("..")) {
        findings.push({
          file: reportPath,
          line: lineOf(node),
          rule: "links",
          message: `broken link: ${href} escapes the repo root (resolved to ${targetAbsolute}); links must resolve inside the workspace.`,
        });
        return;
      }
    }

    if (!existsSync(targetAbsolute)) {
      findings.push({
        file: reportPath,
        line: lineOf(node),
        rule: "links",
        message: `broken link: ${href} (resolved to ${targetAbsolute}; no such file).`,
      });
      return;
    }

    let stat;
    try {
      stat = statSync(targetAbsolute);
    } catch {
      return;
    }

    if (fragment.length === 0) {
      // File exists, no anchor to check.
      return;
    }
    if (!stat.isFile()) {
      // Fragment against a directory — cannot resolve to a heading.
      findings.push({
        file: reportPath,
        line: lineOf(node),
        rule: "links",
        message: `broken link fragment: ${href} points at a directory; anchors resolve against a file.`,
      });
      return;
    }
    // Only markdown / MDX targets carry heading anchors this rule can
    // verify — a link into a JSON or PNG with an anchor is a shape a
    // reviewer would need to explain, not our concern here.
    if (!/\.(md|mdx)$/i.test(targetAbsolute)) return;
    const slugs = slugsFor(targetAbsolute, cache);
    if (!slugs.has(fragment)) {
      findings.push({
        file: reportPath,
        line: lineOf(node),
        rule: "links",
        message: `broken link anchor: ${href} — no heading with slug '${fragment}' in ${targetAbsolute}.`,
      });
    }
  });

  return findings;
}
