// Unit tests for `publish-render.ts` and the shell splicer
// (`spliceArticleBody`).
//
// The fast-path renderer is what makes the < 1 s publish latency
// possible without a full `astro build`. These tests pin its
// promises:
//
//   - It runs the same plugin chain as `site/astro.config.mjs`.
//   - `data-src` stamps are emitted at every block position the
//     rail anchors on.
//   - The first `<h1>` of a repo-doc `.md` is dropped in hast (so
//     Starlight can render the title from frontmatter instead).
//   - KaTeX math is emitted; a bad `$…$` throws (rehype-katex-strict).
//
// The splicer test asserts that the shell → article-body swap is
// byte-preserving outside the `sl-markdown-content` region. That is
// the load-bearing property behind the CSP-hold + no-drift claim:
// scripts, styles, headers, footers are all left alone.

import { describe, expect, test } from "bun:test";
import {
  RENDERABLE_EXTENSIONS,
  isRenderablePath,
  renderDocFragment,
} from "../../src/serve/publish-render.ts";
import { ARTICLE_OPEN_MARKER, spliceArticleBody } from "../../src/serve/publish.ts";

const REPO_ROOT = "/tmp/revkit-render-test";

describe("renderDocFragment — pipeline output shape", () => {
  test("emits `data-src` on every top-level block (paragraph, list, code)", async () => {
    const source = `# Title

A paragraph.

- one
- two

\`\`\`ts
const x = 1;
\`\`\`
`;
    const { html, dataSrcCount } = await renderDocFragment({
      repoRoot: REPO_ROOT,
      path: "docs/adr/x.md",
      source,
    });
    expect(dataSrcCount).toBeGreaterThan(3); // p + ul + 2 li + pre
    expect(html).toContain(`data-src="docs/adr/x.md:`);
    // The first h1 is dropped by rehype-drop-repo-doc-title, so
    // the paragraph after it is what gets stamped.
    expect(html).not.toMatch(/<h1[^>]*data-src="docs\/adr\/x\.md:1-1"/);
    expect(html).toContain("A paragraph.");
    // Code block is wrapped in a data-src'd div (see rail's pre
    // survival note in rehype-data-src.ts).
    // The `<h1>` is line 1, line 2 blank, so `A paragraph.` is
    // at line 3, `- one` at 5, `- two` at 6, blank at 7, ``` at 8,
    // code at 9, closing ``` at 10 — matches the emitted stamps.
    expect(html).toMatch(/<div[^>]*data-src="docs\/adr\/x\.md:8-10"[^>]*class="revkit-code-anchor"/);
  });

  test("emits KaTeX HTML for inline math and refuses a malformed formula", async () => {
    const good = `Some math: $x^2$.
`;
    const rendered = await renderDocFragment({
      repoRoot: REPO_ROOT,
      path: "docs/adr/x.md",
      source: good,
    });
    expect(rendered.html).toContain("katex");

    const bad = `Broken math: $\\wrong{missing}$.
`;
    await expect(
      renderDocFragment({
        repoRoot: REPO_ROOT,
        path: "docs/adr/x.md",
        source: bad,
      }),
    ).rejects.toThrow();
  });

  test("throws when path is not a renderable extension", async () => {
    await expect(
      renderDocFragment({
        repoRoot: REPO_ROOT,
        path: "plots/curve/data.json",
        source: "[]",
      }),
    ).rejects.toThrow(/not a renderable extension/);
  });

  test("isRenderablePath: `.md` yes, everything else no", () => {
    expect(isRenderablePath("docs/adr/x.md")).toBe(true);
    expect(isRenderablePath("site/src/content/docs/x.mdx")).toBe(false);
    expect(isRenderablePath("plots/curve/data.json")).toBe(false);
    expect(isRenderablePath("vocab/terms.yaml")).toBe(false);
  });

  test("RENDERABLE_EXTENSIONS is exactly `.md` (guards against silent widening)", () => {
    // A widening to `.mdx` (or anything else) needs a matching ADR
    // amendment and the shell splicer's `<article>` region to
    // survive Starlight's expressive-code pass — pin the surface
    // so a stray commit does not sneak past.
    expect(RENDERABLE_EXTENSIONS).toEqual([".md"]);
  });
});

describe("spliceArticleBody — shell preservation", () => {
  /** A minimal Starlight-shaped shell: page chrome + a
   * markdown-content region + a footer. The splicer replaces
   * only the content region. */
  const shell = `<!doctype html>
<html><head><title>Foo</title><meta name="csp" content="…"></head>
<body>
<header class="sl-header">nav</header>
<div class="content-panel"><div class="sl-container">
${ARTICLE_OPEN_MARKER}<p>OLD</p><div>nested</div></div></div>
</div>
<footer>© 2026</footer>
</body></html>`;

  test("replaces only the sl-markdown-content region", () => {
    const spliced = spliceArticleBody(shell, "<p>NEW</p>");
    expect(spliced).not.toBeUndefined();
    if (spliced === undefined) return;
    expect(spliced).toContain("<p>NEW</p>");
    expect(spliced).not.toContain("<p>OLD</p>");
    // Header + footer + doctype must survive byte for byte.
    expect(spliced).toContain("<header class=\"sl-header\">nav</header>");
    expect(spliced).toContain("<footer>© 2026</footer>");
    expect(spliced.startsWith("<!doctype html>")).toBe(true);
    // The `<meta name="csp">` line (proxy for the daemon's CSP
    // header discipline) is untouched.
    expect(spliced).toContain(`<meta name="csp" content="…">`);
  });

  test("returns undefined when the marker is missing", () => {
    expect(spliceArticleBody("<html><body>no marker</body></html>", "<p>x</p>")).toBeUndefined();
  });

  test("handles NESTED divs inside the article body", () => {
    const nested = `<html><body>
${ARTICLE_OPEN_MARKER}<div><div>a</div><div>b</div></div></div>
</body></html>`;
    const spliced = spliceArticleBody(nested, "<p>replaced</p>");
    expect(spliced).not.toBeUndefined();
    if (spliced === undefined) return;
    expect(spliced).toContain("<p>replaced</p>");
    expect(spliced).not.toContain("<div><div>a</div>");
  });
});
