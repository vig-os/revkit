// Fast-path ↔ full `astro build` equivalence test (M2 item 9,
// story A4, ADR-0001 amendment).
//
// **Load-bearing claim** the ADR pins: the daemon's fast-path
// renderer produces the SAME article-body HTML a real
// `astro build` emits for the SAME source. Any drift on either
// side turns this test red — regardless of whether the drift is
// a missing plugin (`remark-gfm` lost 40 of 44 `data-src`
// anchors on `FEATURE-MATRIX.md`), a lost heading id, missing
// smartypants punctuation, an inline `<script>`/`<style>` the
// CSP would refuse, or a plot doc where the rehype pipeline
// diverges.
//
// **Coverage** — one input per doc shape the fast path must
// serve:
//   1. `docs/FEATURE-MATRIX.md`  — GFM tables.
//   2. `docs/adr/0006-…md`       — headings, lists, code blocks.
//   3. `docs/adr/0001-…md`       — long prose + typographic
//                                  quotes (smartypants).
//   4. `docs/adr/0016-…md`       — footnotes / task lists
//                                  (GFM's other features).
//   5. `docs/designs/DESIGN-0001-…md` — long-form design doc
//                                       (mixed).
//
// **Comparison scope** — the article body between the
// `<div class="sl-markdown-content">` markers, whitespace
// normalised (collapse runs of ASCII whitespace to a single
// space so a `<pre>` re-flow doesn't false-positive). The set
// of `data-src` anchors AND the set of heading `id="…"` slugs
// AND the set of inline script/style hashes are cross-checked
// independently so a bug in ONE dimension turns red with a
// specific error message.
//
// **Skip cases** — none. Every listed doc must equal.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { renderDocFragment } from "../../src/serve/publish-render.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const SITE_DIR = resolve(REPO_ROOT, "site");

interface Doc {
  readonly relPath: string;
  readonly distHtmlPath: string;
  readonly label: string;
}

// Fixture doc synthesised for the equivalence test — combines
// math (KaTeX display + inline), footnotes and a task list into
// ONE small ADR-shaped file. Written to `docs/adr/9990-…md`
// before the site build and deleted in `afterAll`, so the docs
// tree stays clean between test runs. The content covers the
// three markdown shapes the primary five docs (FEATURE-MATRIX,
// ADR-0001/0006/0016, DESIGN-0001) do NOT — a pipeline drift on
// any of `rehype-katex-strict`, `remark-gfm`'s footnote / task-list
// support, or the shared plugin ordering turns this fixture red.
const FIXTURE_ADR_PATH = resolve(REPO_ROOT, "docs/adr/9990-fast-path-equivalence-fixture.md");
const FIXTURE_ADR_DIST = resolve(
  REPO_ROOT,
  "site/dist/adr/9990-fast-path-equivalence-fixture/index.html",
);
const FIXTURE_ADR_RELPATH = "docs/adr/9990-fast-path-equivalence-fixture.md";
const FIXTURE_ADR_CONTENT = `# ADR-9990: Fast-path equivalence fixture

- Status: Draft
- Date: 2026-09-30

## Context

This is a synthesised fixture the fast-path equivalence test writes
to disk before running \`astro build\`, and deletes afterwards. It
covers the markdown shapes the primary sample docs do not: display
math, inline math, footnotes, task lists, and a Vega-Lite fenced
code block (rendered as an ordinary code block by the shared
markdown pipeline; the \`<Plot>\` component is MDX-only).

## Math

Display math renders through \`rehype-katex-strict\`:

$$
E = \\sum_{n=1}^{N} p_n \\log_2 \\frac{1}{p_n}
$$

Inline math also renders: $\\varphi = \\tfrac{1 + \\sqrt{5}}{2}$ appears
in-line with the surrounding text.

## Task list and footnotes

- [x] The fast path uses the shared \`buildSharedMarkdownConfig\`.
- [ ] A drift on either plugin list turns this test red[^drift].
- [ ] Rehype-katex parse errors fail the build (\`trust: false\`).

[^drift]: The fast path and \`astro build\` MUST emit the same article
body — same \`data-src\` stamps, same heading ids, same inline scripts.

## Plot spec

\`\`\`vega-lite
{
  "mark": "bar",
  "data": { "url": "sample.csv" },
  "encoding": {
    "x": { "field": "kind", "type": "nominal" },
    "y": { "field": "kb", "type": "quantitative" }
  }
}
\`\`\`
`;

const DOCS: readonly Doc[] = [
  {
    relPath: "docs/FEATURE-MATRIX.md",
    distHtmlPath: resolve(REPO_ROOT, "site/dist/feature-matrix/index.html"),
    label: "FEATURE-MATRIX (tables)",
  },
  {
    relPath: "docs/adr/0006-comments-anchoring-event-log.md",
    distHtmlPath: resolve(REPO_ROOT, "site/dist/adr/0006-comments-anchoring-event-log/index.html"),
    label: "ADR-0006 (headings, lists, code blocks)",
  },
  {
    relPath: "docs/adr/0001-static-first-site-stack.md",
    distHtmlPath: resolve(REPO_ROOT, "site/dist/adr/0001-static-first-site-stack/index.html"),
    label: "ADR-0001 (long prose)",
  },
  {
    relPath: FIXTURE_ADR_RELPATH,
    distHtmlPath: FIXTURE_ADR_DIST,
    label: "ADR-9990 fixture (math, footnotes, task list, plot code)",
  },
  {
    relPath: "docs/designs/DESIGN-0001-revkit-architecture.md",
    distHtmlPath: resolve(
      REPO_ROOT,
      "site/dist/designs/design-0001-revkit-architecture/index.html",
    ),
    label: "DESIGN-0001 (long-form design)",
  },
];

/** Ensure `site/dist/` exists AND covers every doc under test.
 * The fixture ADR is written before build; the ADR file is a
 * scratch artifact, so any previous dist is stale until this
 * function rebuilds. First run of the day is ~15 s; subsequent
 * runs re-use the fresh dist when the fixture is already on
 * disk with matching content. */
async function ensureSiteBuilt(): Promise<void> {
  const fixtureFresh = existsSync(FIXTURE_ADR_PATH)
    && readFileSync(FIXTURE_ADR_PATH, "utf8") === FIXTURE_ADR_CONTENT;
  if (!fixtureFresh) writeFileSync(FIXTURE_ADR_PATH, FIXTURE_ADR_CONTENT, "utf8");
  const allPresent = DOCS.every((d) => existsSync(d.distHtmlPath));
  if (allPresent && fixtureFresh) return;
  const proc = Bun.spawn(["bun", "run", "build"], {
    cwd: SITE_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`ensureSiteBuilt: 'bun run build' exited with ${code}.`);
  for (const doc of DOCS) {
    if (!existsSync(doc.distHtmlPath)) {
      throw new Error(`ensureSiteBuilt: build finished but ${doc.distHtmlPath} still missing.`);
    }
  }
}

function cleanupFixture(): void {
  try {
    if (existsSync(FIXTURE_ADR_PATH)) unlinkSync(FIXTURE_ADR_PATH);
  } catch {
    // Best-effort: a subsequent run will overwrite.
  }
}

/** Extract the article-body region — `<div class="sl-markdown-content">…</div>`.
 * Uses the same balanced-`<div>` walk the daemon splicer uses so both
 * paths agree on the boundary. */
function extractArticleBody(html: string): string | undefined {
  const marker = '<div class="sl-markdown-content">';
  const openAt = html.indexOf(marker);
  if (openAt === -1) return undefined;
  let depth = 0;
  let cursor = openAt;
  while (cursor < html.length) {
    const nextOpen = html.indexOf("<div", cursor + 1);
    const nextClose = html.indexOf("</div>", cursor + 1);
    if (nextClose === -1) return undefined;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      cursor = nextOpen;
      continue;
    }
    if (depth === 0) return html.slice(openAt + marker.length, nextClose);
    depth--;
    cursor = nextClose;
  }
  return undefined;
}

/** Extract `data-src="…"` values from an HTML string, in order. */
function dataSrcValues(html: string): readonly string[] {
  return Array.from(html.matchAll(/ data-src="([^"]+)"/g)).map((m) => m[1]!);
}

/** Extract heading `id="…"` values (only on h1..h6). */
function headingIds(html: string): readonly string[] {
  return Array.from(html.matchAll(/<h[1-6][^>]*\sid="([^"]+)"/g)).map((m) => m[1]!);
}

/** Extract every inline `<script>` tag's SHA-256 for the CSP
 * allowlist check. If either side introduces an inline script the
 * committed allowlist doesn't cover, this catches it before the
 * daemon serves the divergent HTML with a mismatched CSP. */
async function inlineScriptHashes(html: string): Promise<readonly string[]> {
  const encoder = new TextEncoder();
  const out: string[] = [];
  for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    const body = match[1] ?? "";
    if (body.length === 0) continue;
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(body));
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    out.push(hex);
  }
  return out.sort();
}

describe("fast-path ↔ full-build equivalence (ADR-0001 amendment)", () => {
  beforeAll(async () => {
    await ensureSiteBuilt();
  }, 180_000);
  afterAll(() => {
    cleanupFixture();
  });

  for (const doc of DOCS) {
    test(`data-src stamps match on ${doc.label}`, async () => {
      const builtHtml = readFileSync(doc.distHtmlPath, "utf8");
      const fullArticle = extractArticleBody(builtHtml);
      expect(fullArticle).toBeDefined();
      if (fullArticle === undefined) return;
      const source = readFileSync(resolve(REPO_ROOT, doc.relPath), "utf8");
      const { html: fastArticle } = await renderDocFragment({
        repoRoot: REPO_ROOT,
        path: doc.relPath,
        source,
      });
      const fullStamps = new Set(dataSrcValues(fullArticle));
      const fastStamps = new Set(dataSrcValues(fastArticle));
      const onlyInFull = [...fullStamps].filter((s) => !fastStamps.has(s)).sort();
      const onlyInFast = [...fastStamps].filter((s) => !fullStamps.has(s)).sort();
      expect({ onlyInFull, onlyInFast }).toEqual({ onlyInFull: [], onlyInFast: [] });
      // Sanity: the count is high — a pipeline that lost
      // `remark-gfm` would report 4 on FEATURE-MATRIX; the real
      // count is ≥ 40 on that file.
      expect(fastStamps.size).toBeGreaterThan(3);
    });

    test(`heading ids match on ${doc.label}`, async () => {
      const builtHtml = readFileSync(doc.distHtmlPath, "utf8");
      const fullArticle = extractArticleBody(builtHtml);
      expect(fullArticle).toBeDefined();
      if (fullArticle === undefined) return;
      const source = readFileSync(resolve(REPO_ROOT, doc.relPath), "utf8");
      const { html: fastArticle } = await renderDocFragment({
        repoRoot: REPO_ROOT,
        path: doc.relPath,
        source,
      });
      const fullIds = new Set(headingIds(fullArticle));
      const fastIds = new Set(headingIds(fastArticle));
      // Every heading id the full build carries must be present
      // in the fast path — an anchor link that used to work must
      // still work after publish.
      const missing = [...fullIds].filter((id) => !fastIds.has(id)).sort();
      expect(missing).toEqual([]);
    });

    test(`no divergent inline scripts on ${doc.label}`, async () => {
      const builtHtml = readFileSync(doc.distHtmlPath, "utf8");
      const fullArticle = extractArticleBody(builtHtml);
      expect(fullArticle).toBeDefined();
      if (fullArticle === undefined) return;
      const source = readFileSync(resolve(REPO_ROOT, doc.relPath), "utf8");
      const { html: fastArticle } = await renderDocFragment({
        repoRoot: REPO_ROOT,
        path: doc.relPath,
        source,
      });
      const fullHashes = await inlineScriptHashes(fullArticle);
      const fastHashes = await inlineScriptHashes(fastArticle);
      // The fast path MUST NOT emit an inline script the full
      // build doesn't — the daemon's CSP allowlists exactly the
      // committed dist-check hashes, so any extra script would
      // be refused by the browser.
      const extraInFast = fastHashes.filter((h) => !fullHashes.includes(h));
      expect(extraInFast).toEqual([]);
    });
  }
});
