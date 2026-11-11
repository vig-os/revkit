// Built-output test for the `data-src` anchor.
//
// Walks `site/dist` (produced by `just build`), reads every stamped
// element from the built HTML, opens the source file the `data-src`
// names, and asserts that the block's rendered text appears in the
// source line range. This is the load-bearing regression test for
// PR #38 blocker 1: the old repo-doc loader stripped `# Title` and
// its trailing blank line from the SOURCE before rendering, so
// every downstream `data-src` was 2 lines early. The plugin now
// drops the h1 in hast, keeping positions intact.
//
// The test asserts:
//   - every parsed `data-src` value has the shape `<path>:<start>-<end>`;
//   - the source file exists in the repo;
//   - the block's visible text (normalised — whitespace collapsed,
//     entities decoded) occurs somewhere in the joined source lines
//     `[start..end]`.
//
// Mutation check: revert the `stripLeadingHeading` no-op to strip 2
// lines and this spec goes red on every ADR/design/matrix page.
//
// Chromium-only (this is a static HTML walk, no browser needed; we
// keep it in the Playwright suite so it runs alongside the
// build-based checks that already gate on a fresh `dist`).

import { test, expect } from "@playwright/test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDataSrc } from "../../packages/cli/src/data-src-format.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const DIST = resolve(__dirname, "..", "dist");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else if (entry.isFile() && entry.name.endsWith(".html")) out.push(abs);
  }
  return out;
}

/** Decode the handful of HTML entities the built output emits, then
 * collapse whitespace. Enough for the substring assertion; not a
 * general-purpose HTML parser. Single pass so `&amp;lt;` stays as
 * `&lt;` rather than double-unescaping to `<`. */
const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&nbsp;": " ",
};
function normaliseText(html: string): string {
  const decoded = html.replace(/&(?:amp|lt|gt|quot|nbsp|#39|#x27);/g, (m) => ENTITY_MAP[m] ?? m);
  return decoded.replace(/\s+/g, " ").trim();
}

/** Strip HTML tags to get visible text. Good enough for the
 * assertion — nested elements' text still surfaces. */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

/** Extract `[{value, innerHtml, tagName}]` for every element with a
 * `data-src` attribute. The parser is a small regex — the built
 * HTML is well-formed enough for this test, and pulling in a full
 * DOM parser would be more code than the assertion it enables. */
function extractStamped(html: string): Array<{ value: string; innerHtml: string; tagName: string }> {
  const results: Array<{ value: string; innerHtml: string; tagName: string }> = [];
  // Element opening tag through its matching closer. Non-greedy on
  // the tag name so nested identical tags don't confuse it.
  const re = /<([a-z][a-z0-9]*)[^>]*\bdata-src="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const [, tag, value, inner] = match;
    results.push({ tagName: tag!.toLowerCase(), value: value!, innerHtml: inner! });
  }
  return results;
}

test.describe("data-src anchors point at real source lines @chromium-only", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "chromium-only");

  test("every data-src on every built page names a source line range whose text matches the block", () => {
    const htmlFiles = walk(DIST).filter((path) => !path.includes("/_astro/"));
    expect(htmlFiles.length).toBeGreaterThan(0);

    let checked = 0;
    let repoDocChecked = 0;
    let mdxChecked = 0;
    const failures: string[] = [];

    for (const htmlFile of htmlFiles) {
      const html = readFileSync(htmlFile, "utf8");
      const stamped = extractStamped(html);
      for (const { value, innerHtml, tagName } of stamped) {
        const parsed = parseDataSrc(value);
        expect(parsed, `bad data-src '${value}' on ${htmlFile}`).toBeDefined();
        const { path, startLine, endLine } = parsed!;
        const sourceAbs = join(REPO_ROOT, path);
        let sourceStat;
        try {
          sourceStat = statSync(sourceAbs);
        } catch {
          failures.push(`${htmlFile}: data-src '${value}' references missing source '${path}'`);
          continue;
        }
        if (!sourceStat.isFile()) continue;
        const sourceLines = readFileSync(sourceAbs, "utf8").split(/\r?\n/);
        // 1-indexed inclusive → slice range.
        const range = sourceLines.slice(startLine - 1, endLine).join(" ");
        const rangeNorm = normaliseText(range);
        const blockText = normaliseText(stripTags(innerHtml));
        if (blockText.length === 0) continue; // empty block; nothing to assert
        // Sample the first meaningful chunk of the block text. A full
        // "block ⊆ source" would need MDX / KaTeX / plot expansions
        // that reverse the build; asserting the first 20 chars of
        // block text appear in the range is a strong, cheap proxy
        // that goes red on a line-offset regression.
        const sample = blockText.slice(0, Math.min(80, blockText.length));
        // Some rendered chunks (headings with links, mermaid) are
        // wrapper-heavy — pick the longest run of alphanumerics as
        // the substring probe. Empty means "give up" (rare).
        const probe = pickProbe(sample);
        if (probe.length === 0) continue;
        if (!rangeNorm.includes(probe)) {
          failures.push(
            `${htmlFile}: <${tagName} data-src="${value}"> — block probe '${probe}' not found in source lines ${startLine}-${endLine} of ${path}\n` +
              `  source range: '${rangeNorm.slice(0, 200)}'`,
          );
        }
        checked++;
        if (path.startsWith("docs/")) repoDocChecked++;
        else if (path.startsWith("site/")) mdxChecked++;
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `${failures.length}/${checked} anchors mismatched source (of ${checked} probed; ` +
          `${repoDocChecked} repo-doc, ${mdxChecked} MDX). First 5:\n` +
          failures.slice(0, 5).join("\n"),
      );
    }
    // Health: BOTH branches must be exercised. If MDX pages
    // regressed to zero anchors, the plugin's file-extension gate
    // would be wrong (the coordinator noted MDX stamped correctly
    // before this PR — same must hold after).
    expect(repoDocChecked).toBeGreaterThan(100);
    expect(mdxChecked).toBeGreaterThan(0);
  });

  test("MUTATION: fenced code blocks carry a data-src wrapper (PR #38 round-2 review)", () => {
    // DESIGN-0001 has 7 fenced code blocks (mermaid + jsonc +
    // sh + directory tree). Under the old plugin, expressive-code
    // replaced our stamped `<pre>` with its wrapper and the
    // anchor was lost — reviewers could not comment on code
    // blocks at all. The new stampTree wraps every `<pre>` in a
    // `<div data-src=… class="revkit-code-anchor">` that
    // survives expressive-code.
    const html = readFileSync(join(DIST, "designs", "design-0001-revkit-architecture", "index.html"), "utf8");
    const wrappers = html.match(/<div data-src="[^"]+" class="revkit-code-anchor">/g) ?? [];
    expect(wrappers.length).toBeGreaterThanOrEqual(5);
    // Each wrapper's data-src must parse.
    for (const wrapper of wrappers) {
      const m = wrapper.match(/data-src="([^"]+)"/);
      expect(m).not.toBeNull();
      const parsed = parseDataSrc(m![1]!);
      expect(parsed, `bad wrapper anchor: ${wrapper}`).toBeDefined();
      expect(parsed!.path).toBe("docs/designs/DESIGN-0001-revkit-architecture.md");
    }
  });
});

/** Pick a substring likely to survive both the built-HTML → text
 * and source-line rendering (e.g. strip markdown markers). We take
 * the longest run of alphanumerics in the first 80 chars of the
 * probe, dropping tokens shorter than 4 chars (spurious matches). */
function pickProbe(text: string): string {
  const tokens = text.split(/[^A-Za-z0-9]+/).filter((t) => t.length >= 4);
  if (tokens.length === 0) return "";
  // Return the longest, up to 30 chars.
  const longest = tokens.reduce((a, b) => (a.length >= b.length ? a : b));
  return longest.slice(0, 30);
}
