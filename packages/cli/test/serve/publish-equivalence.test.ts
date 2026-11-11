// Fast-path ↔ full `astro build` equivalence test (M2 item 9,
// story A4, ADR-0001 amendment, PR-56 round-2 blocker 2).
//
// **Load-bearing claim** the ADR pins: the daemon's fast-path
// renderer produces the SAME article-body HTML a real
// `astro build` emits for the SAME source. Any drift on either
// side turns this test red — regardless of whether the drift is
// a missing plugin, a lost heading id, missing smartypants
// punctuation, a cross-doc link that wasn't rewritten, or an
// inline `<script>`/`<style>` the CSP would refuse.
//
// **Round-2 rewrite**: the earlier version only compared
// `data-src` sets + heading ids + inline-script hashes. That
// missed cross-doc link rewriting entirely (all 28 docs had raw
// `.md` hrefs the fast path emitted where the full build had
// site routes) and did not catch code-block chrome divergence
// (`<pre>` vs. Starlight's expressive-code frame). The test now
// compares the FULL article body, whitespace-normalised.
//
// **Coverage** — every `.md` doc under `docs/adr/`, `docs/designs/`
// and `docs/FEATURE-MATRIX.md`, plus a synthesised ADR-9990
// fixture (written before build, cleaned up in `afterAll`) that
// covers math, footnotes, task list and a plot code block.
//
// **Refuse-and-fall-back**: some sources use a Starlight-specific
// feature the shared rehype chain does NOT yet mirror (fenced code
// blocks → expressive-code, `:::note` asides → remark-directive +
// custom transformer). For those docs the fast path is expected
// to REFUSE (`renderDocFragment` returns `{ refused: true }`) —
// the daemon then serves dist untouched. The test asserts BOTH
// contracts: full HTML equality for accepted docs, and a
// refusal for the ones that use those features.
//
// **The negative test** (`removing one step from the fast path
// breaks equivalence`) exercises the "by construction" claim:
// if a maintainer accidentally drops the link-rewriter from the
// shared chain, the equivalence test still catches it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  fastPathRefusalFor,
  fastPathRefusalReasons,
  renderDocFragment,
} from "../../src/serve/publish-render.ts";

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
// before the site build and deleted in `afterAll`.
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

Synthesised fixture the equivalence test writes to disk before
running \`astro build\` and deletes afterwards. It covers markdown
shapes the primary sample docs do not: display math, inline
math, footnotes, and a task list.

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
body — same \`data-src\` stamps, same heading ids, same cross-doc
links.

## A table and a cross-doc link

| Path | Route | Refused fast? |
| --- | --- | --- |
| \`docs/adr/0001-static-first-site-stack.md\` | \`/adr/0001-static-first-site-stack/\` | no |
| \`docs/FEATURE-MATRIX.md\` | \`/feature-matrix/\` | no |

The ADR above is [ADR-0001](./0001-static-first-site-stack.md#decision);
the matrix is [the feature matrix](../FEATURE-MATRIX.md). Both hrefs
must come out rewritten to site routes, which is what the round-3
negative guard (drop the link-rewriter, watch equivalence break)
depends on.
`;

/** Discover every `.md` doc under `docs/adr/`, `docs/designs/` and
 * `docs/FEATURE-MATRIX.md`. Returns them in a stable order so a
 * failing test names the same doc every run. */
function discoverDocs(): Doc[] {
  const out: Doc[] = [];
  out.push({
    relPath: "docs/FEATURE-MATRIX.md",
    distHtmlPath: resolve(REPO_ROOT, "site/dist/feature-matrix/index.html"),
    label: "docs/FEATURE-MATRIX.md",
  });
  for (const dir of ["adr", "designs"] as const) {
    const abs = resolve(REPO_ROOT, "docs", dir);
    for (const name of readdirSync(abs).sort()) {
      if (!name.endsWith(".md")) continue;
      const slug = name.slice(0, -".md".length).toLowerCase();
      out.push({
        relPath: `docs/${dir}/${name}`,
        distHtmlPath: resolve(REPO_ROOT, `site/dist/${dir}/${slug}/index.html`),
        label: `docs/${dir}/${name}`,
      });
    }
  }
  return out;
}

/** Ensure `site/dist/` exists AND covers every doc under test.
 * The fixture ADR is written before build; the ADR file is a
 * scratch artifact, so any previous dist is stale until this
 * function rebuilds. */
async function ensureSiteBuilt(docs: readonly Doc[]): Promise<void> {
  const fixtureFresh = existsSync(FIXTURE_ADR_PATH)
    && readFileSync(FIXTURE_ADR_PATH, "utf8") === FIXTURE_ADR_CONTENT;
  if (!fixtureFresh) writeFileSync(FIXTURE_ADR_PATH, FIXTURE_ADR_CONTENT, "utf8");
  const allPresent = docs.every((d) => existsSync(d.distHtmlPath));
  if (allPresent && fixtureFresh) return;
  const proc = Bun.spawn(["bun", "run", "build"], {
    cwd: SITE_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`ensureSiteBuilt: 'bun run build' exited with ${code}.`);
  for (const doc of docs) {
    if (!existsSync(doc.distHtmlPath)) {
      throw new Error(`ensureSiteBuilt: build finished but ${doc.distHtmlPath} still missing.`);
    }
  }
}

function cleanupFixture(): void {
  try {
    if (existsSync(FIXTURE_ADR_PATH)) unlinkSync(FIXTURE_ADR_PATH);
  } catch {
    // Best-effort.
  }
}

/** Extract the article-body region — `<div class="sl-markdown-content">…</div>`.
 * Balanced-`<div>` walk. */
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

/** Collapse runs of ASCII whitespace to a single space and trim.
 * KaTeX and rehype-stringify differ on inter-tag whitespace in
 * ways that don't affect the rendered page; this normalisation
 * puts both outputs on the same footing. */
function normaliseWhitespace(html: string): string {
  return html.replace(/\s+/g, " ").trim();
}

const DOCS = discoverDocs();

describe("fast-path ↔ full-build FULL HTML equivalence (ADR-0001 amendment)", () => {
  beforeAll(async () => {
    await ensureSiteBuilt([...DOCS, {
      relPath: FIXTURE_ADR_RELPATH,
      distHtmlPath: FIXTURE_ADR_DIST,
      label: "ADR-9990 fixture",
    }]);
  }, 240_000);
  afterAll(() => {
    cleanupFixture();
  });

  test("discovery covers every ADR, design and the feature matrix (~28+ docs)", () => {
    // 25 ADRs (0001–0025) + a README + the 9990 fixture will exist
    // only during the test, plus 2 designs + FEATURE-MATRIX. A drop
    // below 27 real docs means the discovery walker missed a directory.
    expect(DOCS.length).toBeGreaterThanOrEqual(27);
  });

  for (const doc of [...DOCS, {
    relPath: FIXTURE_ADR_RELPATH,
    distHtmlPath: FIXTURE_ADR_DIST,
    label: "ADR-9990 fixture (math + footnotes + task list)",
  }]) {
    test(`full-body equivalence: ${doc.label}`, async () => {
      const builtHtml = readFileSync(doc.distHtmlPath, "utf8");
      const fullArticle = extractArticleBody(builtHtml);
      expect(fullArticle).toBeDefined();
      if (fullArticle === undefined) return;
      const source = readFileSync(resolve(REPO_ROOT, doc.relPath), "utf8");
      const refusal = fastPathRefusalFor(source);
      const result = await renderDocFragment({
        repoRoot: REPO_ROOT,
        path: doc.relPath,
        source,
      });
      if (refusal !== undefined) {
        // Source uses a feature the fast path refuses. The
        // daemon falls back to serving dist; the equivalence
        // contract is "on refusal, dist is served untouched".
        // The test asserts the refusal shape here.
        expect(result.refused).toBe(true);
        if (result.refused === true) {
          // Every tag the renderer can return, not a hardcoded pair —
          // the round-3 `indented-code` tag slipped past the old
          // two-element list and would have failed here had a repo doc
          // used one.
          expect(fastPathRefusalReasons).toContain(result.reason);
        }
        return;
      }
      // Accepted: full HTML must match dist byte-for-byte after
      // whitespace normalisation.
      expect(result.refused).toBeUndefined();
      if (result.refused === true) return;
      const fastArticle = result.html;
      const normalisedFull = normaliseWhitespace(fullArticle);
      const normalisedFast = normaliseWhitespace(fastArticle);
      if (normalisedFast !== normalisedFull) {
        // Emit a small diff hint so a failure names the first
        // diverging position — the full HTML on both sides is
        // large, so a bare `expect(A).toBe(B)` is unreadable.
        const at = firstDiverge(normalisedFast, normalisedFull);
        const window = 120;
        const fastSlice = normalisedFast.slice(Math.max(0, at - window), at + window);
        const fullSlice = normalisedFull.slice(Math.max(0, at - window), at + window);
        throw new Error(
          `Article HTML diverges for ${doc.relPath} at position ${at}\n` +
            `  fast: …${fastSlice}…\n` +
            `  full: …${fullSlice}…\n`,
        );
      }
    });
  }

  test("removing the link-rewriter plugin from the shared chain breaks equivalence on an ACCEPTED doc (round-3 nit)", async () => {
    // Round-2 negative-guard, tightened per round-3 review: pick
    // an ACCEPTED doc (one the fast path renders in full), and
    // rebuild its render WITH THE LINK-REWRITER PLUGIN DROPPED.
    // The equivalence check must fail — that proves the plugin
    // in the shared chain is what makes the two paths agree.
    //
    // Uses ADR-0001 which the fast path accepts (no code fence,
    // no aside) and which has cross-doc `.md` links in prose.
    const doc = DOCS.find((d) => d.relPath === "docs/adr/0001-static-first-site-stack.md");
    expect(doc).toBeDefined();
    if (doc === undefined) return;
    const source = readFileSync(resolve(REPO_ROOT, doc.relPath), "utf8");
    // First confirm the doc is accepted, then run a MINUS-PLUGIN
    // render through a hand-built processor.
    const accepted = await renderDocFragment({
      repoRoot: REPO_ROOT,
      path: doc.relPath,
      source,
    });
    expect(accepted.refused).toBeUndefined();
    if (accepted.refused === true) return;
    // Build a processor with the SAME shared config but WITHOUT
    // the link-rewriter. If dropping it breaks parity, this
    // proves the equivalence test is not tautological — the
    // plugin actually earns its place.
    const { createMarkdownProcessor } = await import("@astrojs/markdown-remark");
    const { buildSharedMarkdownConfig } = await import(
      "../../../../site/src/lib/markdown-processor.ts"
    );
    const shared = buildSharedMarkdownConfig(REPO_ROOT);
    const withoutLinkRewriter = {
      remarkPlugins: shared.remarkPlugins,
      rehypePlugins: shared.rehypePlugins.filter(
        (entry) => {
          // Each entry is `[plugin, options]`; identify by function
          // name so a rename in the source is caught by another test.
          if (!Array.isArray(entry)) return true;
          const plugin = entry[0] as { name?: string } | undefined;
          const name = typeof plugin === "function" ? plugin.name : plugin?.name;
          return name !== "rehypeRewriteMdLinks";
        },
      ),
      syntaxHighlight: false as const,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const processor = await createMarkdownProcessor(withoutLinkRewriter as any);
    const { pathToFileURL } = await import("node:url");
    const rendered = await processor.render(source, {
      fileURL: pathToFileURL(`${REPO_ROOT}/${doc.relPath}`),
    });
    const brokenFast = rendered.code;
    const builtHtml = readFileSync(doc.distHtmlPath, "utf8");
    const fullArticle = extractArticleBody(builtHtml)!;
    // With the plugin dropped, at least one `.md` href must
    // remain in the fast output that isn't in the full one.
    expect(normaliseWhitespace(brokenFast)).not.toBe(normaliseWhitespace(fullArticle));
    // And there should be at least ONE residual `.md` link in
    // the broken render — otherwise the doc had no cross-doc
    // links and this test doesn't prove anything.
    const residual = brokenFast.match(/href="[^"]+\.md(?:#[^"]*)?"/g) ?? [];
    expect(residual.length).toBeGreaterThan(0);
  });
});

function firstDiverge(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}
