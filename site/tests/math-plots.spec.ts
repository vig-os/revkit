// E2e for the math + plots page (M1 item 3, C4 + C5). The site sources
// KaTeX at build time and inlines each Vega-Lite plot as an SVG — this
// suite exercises the built artefact so a regression in the remark /
// rehype pipeline, in the plots loader, in the `<Plot>` component, or in
// the CSP-friendly SVG shape trips.
//
// Accessibility scanning of the math + plots page lives in the site-wide
// gate (`a11y.spec.ts`, ADR-0017); the per-page serious/critical scan
// that used to sit at the end of this file has been removed to avoid
// duplicating the coverage the strict any-violation gate already gives.
import { expect, test } from "@playwright/test";

const PAGE = "/math-and-plots/";

test("KaTeX renders math at build with no raw $ delimiters left over", async ({ page }) => {
  await page.goto(PAGE);
  // A `.katex` span is what KaTeX emits for every equation — its absence
  // would mean the remark-math -> rehype-katex chain never ran.
  const katex = page.locator(".katex").first();
  await expect(katex).toBeVisible();
  // The display equation is wrapped in `.katex-display`; asserting on
  // that class rejects a regression where inline-only worked but display
  // math (double-dollars) fell back to raw text.
  await expect(page.locator(".katex-display")).toHaveCount(1);
  // The MDX source has `E = \sum_{n=1}^{N} …`; a working render surfaces
  // the identifier `E` inside a KaTeX span and no leftover `$$` fence.
  const bodyText = await page.locator("main").innerText();
  expect(bodyText).not.toContain("$$");
  expect(bodyText).not.toMatch(/\$[A-Za-z\\][^$]{0,40}\$/);
});

test("KaTeX stylesheet is self-hosted from /_katex, not a CDN", async ({ page, request }) => {
  await page.goto(PAGE);
  // A `<link rel=stylesheet href="/_katex/katex.min.css">` in the head is
  // the proof the CSS is served from the origin (ADR-0012 CSP: no CDN).
  const hrefs = await page.locator('link[rel="stylesheet"]').evaluateAll(
    (elements: Element[]) =>
      elements.map((element) => (element as HTMLLinkElement).href),
  );
  expect(hrefs.some((href) => href.endsWith("/_katex/katex.min.css"))).toBe(true);
  // The stylesheet itself must resolve; a build-time regression that
  // failed to copy KaTeX assets would ship a broken link.
  const cssResponse = await request.get("/_katex/katex.min.css");
  expect(cssResponse.ok(), "katex.min.css should be served").toBe(true);
  // The CSS references `fonts/KaTeX_Main-Regular.woff2` relative to
  // itself; asserting one representative font is fetchable proves the
  // whole `fonts/` prefix is present.
  const fontResponse = await request.get("/_katex/fonts/KaTeX_Main-Regular.woff2");
  expect(fontResponse.ok(), "KaTeX woff2 fonts should be served").toBe(true);
});

test("the Plot renders as an accessible inline SVG with category labels", async ({ page }) => {
  await page.goto(PAGE);
  // The <Plot> component wraps its SVG in a <figure class="revkit-plot">.
  const figure = page.locator("figure.revkit-plot").first();
  await expect(figure).toBeVisible();

  // The inline SVG must carry role="img" + aria-label so assistive tech
  // announces the plot with the label the MDX author passed.
  const svg = figure.locator("svg[role='img']").first();
  await expect(svg).toBeVisible();
  await expect(svg).toHaveAttribute("aria-label", /JavaScript library bundle sizes/i);

  // Each of the four measured categories from DESIGN-0001 §2 renders as
  // a text label in the SVG. A regression that shipped an empty
  // scenegraph would drop them all.
  for (const label of ["Solid", "uPlot", "Observable Plot", "vega-embed"]) {
    await expect(svg.locator("text", { hasText: label }).first()).toBeVisible();
  }

  // The SVG must not carry a `<script>` element (ADR-0012: served SVG
  // is sandboxed; inline SVG is defence-in-depth for the same rule).
  await expect(svg.locator("script")).toHaveCount(0);
});

test("no vega/katex client-side JS is loaded", async ({ page }) => {
  const requestedScripts: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "script") requestedScripts.push(request.url());
  });
  await page.goto(PAGE);
  // Wait for network to settle so any deferred scripts have a chance to
  // start their request.
  await page.waitForLoadState("networkidle");

  const disallowed = requestedScripts.filter((url) =>
    /(vega|vega-embed|vega-lite|katex\.(?:min\.)?js)/i.test(url),
  );
  expect(
    disallowed,
    `expected no vega/katex JS to be requested; saw ${JSON.stringify(disallowed)}`,
  ).toEqual([]);
});

test("no vega/katex identifiers appear in the built _astro/*.js bundles", async () => {
  // The over-the-wire check above catches "was this URL fetched?"; this
  // one catches "did any bundled chunk sneak vega/katex code in?", which
  // would happen if a component ever accidentally imported the runtime
  // from a client-only script tag. Runs on the on-disk build so a
  // regression trips even for scripts loaded after `networkidle`.
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const astroDir = join(process.cwd(), "dist", "_astro");
  const files = await readdir(astroDir);
  const jsFiles = files.filter((name) => name.endsWith(".js"));
  expect(jsFiles.length, "expected the build to emit some _astro/*.js").toBeGreaterThan(0);

  // Distinctive identifiers from each library. Substrings that only
  // exist in the runtime code, not in incidental strings like `vega` in
  // a comment or an SVG class name.
  const forbiddenPatterns: readonly RegExp[] = [
    /\bkatex\.render\b/,
    /vega-lite/i,
    /vegaLite/,
    /\bVegaView\b/,
    /VEGA_SCHEMA/i,
    /vega\.parse/,
  ];
  const hits: { file: string; pattern: string; excerpt: string }[] = [];
  for (const jsFile of jsFiles) {
    const contents = await readFile(join(astroDir, jsFile), "utf8");
    for (const pattern of forbiddenPatterns) {
      const match = pattern.exec(contents);
      if (match) {
        hits.push({
          file: jsFile,
          pattern: pattern.toString(),
          excerpt: contents.slice(Math.max(0, match.index - 20), match.index + 60),
        });
      }
    }
  }
  expect(hits, `vega/katex identifiers found in built bundles: ${JSON.stringify(hits, null, 2)}`).toEqual([]);
});

test("math + plots page loads the same script set as a page without them", async ({ page }) => {
  // Baseline: any Starlight docs page (an ADR) loads a fixed set of
  // chunks. The math + plots page must load the SAME set — a new chunk
  // there means the math or plot pipeline started shipping runtime code.
  const collectScripts = async (route: string): Promise<Set<string>> => {
    const scripts = new Set<string>();
    page.on("request", (request) => {
      if (request.resourceType() === "script") {
        const url = new URL(request.url());
        scripts.add(url.pathname);
      }
    });
    await page.goto(route);
    await page.waitForLoadState("networkidle");
    return scripts;
  };
  const baseline = await collectScripts("/adr/0001-static-first-site-stack/");
  page.removeAllListeners("request");
  const target = await collectScripts(PAGE);
  const extras = [...target].filter((path) => !baseline.has(path));
  expect(
    extras,
    `math + plots page loaded scripts an ADR page did not: ${JSON.stringify(extras)}`,
  ).toEqual([]);
});
