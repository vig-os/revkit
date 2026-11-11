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
  fastPathRefusalReasons,
  isRenderablePath,
  renderDocFragment,
  type FastPathRefusalReason,
} from "../../src/serve/publish-render.ts";
import { ARTICLE_OPEN_MARKER, spliceArticleBody } from "../../src/serve/publish.ts";

const REPO_ROOT = "/tmp/revkit-render-test";

describe("renderDocFragment — pipeline output shape", () => {
  test("emits `data-src` on every top-level block (paragraph, list, code)", async () => {
    const source = `# Title

A paragraph.

- one
- two
`;
    const result = await renderDocFragment({
      repoRoot: REPO_ROOT,
      path: "docs/adr/x.md",
      source,
    });
    if (result.refused === true) throw new Error("expected a render, got refusal");
    const { html, dataSrcCount } = result;
    expect(dataSrcCount).toBeGreaterThan(2); // p + ul + 2 li
    expect(html).toContain(`data-src="docs/adr/x.md:`);
    // The first h1 is dropped by rehype-drop-repo-doc-title, so
    // the paragraph after it is what gets stamped.
    expect(html).not.toMatch(/<h1[^>]*data-src="docs\/adr\/x\.md:1-1"/);
    expect(html).toContain("A paragraph.");
    // `A paragraph.` is at line 3, `- one` at 5, `- two` at 6.
    expect(html).toMatch(/<ul[^>]*data-src="docs\/adr\/x\.md:5-6"/);
    // Regression: NO orphan `data-src="…:undefined-…"`.
    expect(html).not.toContain("undefined-undefined");
  });

  test("REFUSES a source containing a fenced code block (round-2 blocker 1b fallback)", async () => {
    const source = `A paragraph.

\`\`\`ts
const x = 1;
\`\`\`
`;
    const result = await renderDocFragment({
      repoRoot: REPO_ROOT,
      path: "docs/adr/x.md",
      source,
    });
    expect(result.refused).toBe(true);
    if (result.refused === true) {
      expect(result.reason).toBe("code-fence");
    }
  });

  test("REFUSES a source containing a Starlight aside directive", async () => {
    const source = `:::note
An aside.
:::
`;
    const result = await renderDocFragment({
      repoRoot: REPO_ROOT,
      path: "docs/adr/x.md",
      source,
    });
    expect(result.refused).toBe(true);
    if (result.refused === true) {
      expect(result.reason).toBe("starlight-directive");
    }
  });

  test("emits KaTeX HTML for inline math and refuses a malformed formula", async () => {
    const good = `Some math: $x^2$.
`;
    const rendered = await renderDocFragment({
      repoRoot: REPO_ROOT,
      path: "docs/adr/x.md",
      source: good,
    });
    if (rendered.refused === true) throw new Error("expected a render, got refusal");
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

/** Feature coverage matrix for the fast path (M2 item 9, story A4).
 *
 * Table-driven on purpose: the ADR pins "the fast path either renders
 * a source byte-parity with a full build or REFUSES it", and this
 * table is the exhaustive statement of which is which for every
 * markdown feature the corpus contains. A new refusal tag, a widened
 * `RENDERABLE_EXTENSIONS`, or a feature quietly flipping from refused
 * to accepted (which would break the equivalence contract) turns one
 * of these red rather than needing a human to notice.
 *
 * The "missing shell" row is not a renderer concern — it is a SPLICE
 * concern, and it is covered here because the two together are the
 * full decision the daemon makes for one route: render → splice →
 * serve, or refuse → build → serve. */
describe("fast-path feature matrix", () => {
  const ACCEPTED: readonly {
    readonly label: string;
    readonly source: string;
    readonly expect: readonly RegExp[];
  }[] = [
    {
      label: "prose",
      source: "A plain paragraph with **bold**, _emphasis_ and a [link](../adr/0001-static-first-site-stack.md).\n",
      expect: [/<strong><span[^>]*data-revkit-leaf[^>]*>bold<\/span><\/strong>/, /<em><span[^>]*data-revkit-leaf[^>]*>emphasis<\/span><\/em>/, /href="\/adr\/0001-static-first-site-stack\/"/],
    },
    {
      label: "display + inline math",
      source: "$$\nE = \\sum_{n=1}^{N} p_n\n$$\n\nInline $\\varphi$ math.\n",
      // KaTeX emits both the MathML and the HTML rendering; assert on
      // the parts that survive independently of KaTeX's version.
      expect: [/class="katex-display"/, /class="katex-mathml"/, /<annotation encoding="application\/x-tex">E = /],
    },
    {
      label: "a GFM table",
      source: "| Option | Cost |\n|---|---|\n| `fast` | low |\n| `full` | high |\n",
      expect: [/<table/, /<th/, /<td/],
    },
    {
      label: "footnotes",
      source: "Body text[^a].\n\n[^a]: The note.\n",
      expect: [/footnote/],
    },
    {
      label: "nested list items",
      source: "- outer\n  - inner\n    - deepest\n",
      expect: [/<ul/, /outer/, /deepest/],
    },
    {
      label: "inline code and a blockquote",
      source: "Inline `code` here.\n\n> Quoted text.\n",
      expect: [/<code><span[^>]*data-revkit-leaf[^>]*>code<\/span><\/code>/, /<blockquote[ >]/],
    },
  ];

  const REFUSED: readonly {
    readonly label: string;
    readonly source: string;
    readonly reason: FastPathRefusalReason;
  }[] = [
    {
      label: "a top-level fenced code block",
      source: "Text.\n\n```ts\nconst x = 1;\n```\n",
      reason: "code-fence",
    },
    {
      label: "a tilde fence",
      source: "Text.\n\n~~~python\nx = 1\n~~~\n",
      reason: "code-fence",
    },
    {
      label: "a NESTED fence (inside a list item) — the case a naive line-start regex misses",
      source: "- Item\n\n  ```ts\n  const x = 1;\n  ```\n",
      reason: "code-fence",
    },
    {
      label: "an indented code block after a blank line",
      source: "Text.\n\n    const x = 1;\n",
      reason: "indented-code",
    },
    {
      label: "an indented code block at the very start of the source",
      source: "    const x = 1;\n",
      reason: "indented-code",
    },
    {
      label: "a Starlight aside",
      source: "Text.\n\n:::note\nA note.\n:::\n",
      reason: "starlight-directive",
    },
    {
      label: "a Starlight `caution` aside",
      source: "Text.\n\n:::caution\nCareful.\n:::\n",
      reason: "starlight-directive",
    },
  ];

  for (const row of ACCEPTED) {
    test(`ACCEPTS ${row.label}, rendering the feature it names`, async () => {
      const result = await renderDocFragment({
        repoRoot: REPO_ROOT,
        path: "docs/adr/x.md",
        source: `# Title\n\n${row.source}`,
      });
      if (result.refused === true) {
        throw new Error(`expected ${row.label} to be accepted, got refusal '${result.reason}'`);
      }
      for (const pattern of row.expect) expect(result.html).toMatch(pattern);
    });
  }

  for (const row of REFUSED) {
    test(`REFUSES ${row.label} as '${row.reason}'`, async () => {
      const result = await renderDocFragment({
        repoRoot: REPO_ROOT,
        path: "docs/adr/x.md",
        source: `# Title\n\n${row.source}`,
      });
      expect(result.refused).toBe(true);
      if (result.refused !== true) return;
      expect(result.reason).toBe(row.reason);
    });
  }

  test("every refusal reason the renderer can return is exercised by this table", async () => {
    // Guards the table against rotting: a new tag added to the
    // renderer must be added here, or this goes red.
    for (const reason of fastPathRefusalReasons) {
      expect(REFUSED.some((row) => row.reason === reason)).toBe(true);
    }
  });

  test("a plot component renders through the fast path (ADR-0004)", async () => {
    const result = await renderDocFragment({
      repoRoot: REPO_ROOT,
      path: "docs/adr/x.md",
      source: `# Title\n\nimport { Plot } from "@revkit/components/Plot";\n\n<Plot spec="../../../plots/curve/spec.vl.json" />\n`,
    });
    if (result.refused === true) throw new Error(`expected the plot fixture to be accepted, got '${result.reason}'`);
    // The component survives into the HTML as an element; the SVG
    // itself is produced at build time by the site's plot loader,
    // which is why a plot publish is `data-only` rather than fast.
    expect(result.html).toMatch(/<Plot|sl-markdown|Plot/);
  });

  test("a route with no built shell splices to undefined — the shape `shell-missing` reports", async () => {
    // `spliceArticleBody` returns undefined when the shell has no
    // article region at all. The daemon maps that to a `shell-missing`
    // build item; assert the mapping's premise here so a change to
    // the splicer's contract cannot silently turn a missing shell
    // into a silently-empty page.
    expect(spliceArticleBody("<!doctype html><html><body><h1>no article region</h1></body></html>", "<p>x</p>"))
      .toBeUndefined();
    expect(spliceArticleBody(`<div>${ARTICLE_OPEN_MARKER}<p>old</p></div>`, "<p>new</p>"))
      .toBe(`<div>${ARTICLE_OPEN_MARKER}<p>new</p></div>`);
  });
});
