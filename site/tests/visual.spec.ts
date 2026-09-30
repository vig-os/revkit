// Visual regression baselines for the review site (ADR-0016).
//
// A small set of pages spans the layout surfaces revkit relies on: the
// landing page (Starlight hero + Callout island), an ADR (the docs shell
// most reviewers see), the DESIGN-0001 page (long-form prose with headings
// / TOC), and the math + plots page (KaTeX math + inline-SVG plot). Each
// renders at phone (390 px), tablet (820 px) and desktop (1440 px) — the
// three breakpoints called out in ADR-0016.
//
// Determinism is enforced by `site/tests/fixtures/visual.ts`:
//   - a bundled DejaVu font served via `page.route()`, forced onto every
//     element so both dev and CI render the same glyph outlines;
//   - animations / transitions / scroll behaviour frozen so no mid-frame
//     gradient drifts a screenshot;
//   - `document.fonts.ready` awaited before the snapshot so the fallback
//     family never captures.
//
// Volatile regions are `mask`ed rather than assertion-tuned: the Starlight
// version footer, the theme select (its state persists via localStorage
// and can flip between runs), the search widget, and the ADR/design
// "Date:" body line (every ADR has one). A masked region contributes zero
// pixels to the diff, so we can keep `maxDiffPixelRatio` small.
//
// Verified failure semantics: temporarily bumping `body { font-size }` by
// 1 px in the injected CSS turns every screenshot red, confirming the
// assertion is not tautological. Restore the baseline afterwards.
//
// `bun run test:e2e -- --update-snapshots visual.spec.ts` (or
// `just e2e-update`) regenerates baselines when the change is intentional.
import { expect, test } from "@playwright/test";
import { preparePageForVisual, VIEWPORTS, waitForFontsReady } from "./fixtures/visual";

interface PageCase {
  readonly slug: string;
  readonly route: string;
  readonly description: string;
  /** `fullPage: false` clips the screenshot to the viewport. Used for the
   * long-form design doc where a fullPage capture is ~2.4 MB per breakpoint
   * (>7 MB per baseline set) and yields diminishing regression signal after
   * the fold — the above-the-fold layout is where Starlight upgrades break.
   * Defaults to true elsewhere. */
  readonly fullPage?: boolean;
}

const PAGES: readonly PageCase[] = [
  { slug: "home", route: "/", description: "landing page (Starlight hero + Callout island)" },
  { slug: "adr", route: "/adr/0001-static-first-site-stack/", description: "ADR docs shell" },
  {
    slug: "design",
    route: "/designs/design-0001-revkit-architecture/",
    description: "long-form design doc (viewport-only)",
    fullPage: false,
  },
  { slug: "math-plots", route: "/math-and-plots/", description: "math + inline-SVG plot" },
];

/** CSS selectors to mask on every page. These regions are either
 * environmental (dates, versions), user-scoped (theme, search), or would
 * otherwise cause deterministic-but-unwanted per-run drift. Kept in one
 * place so a new case does not have to relist them. */
const GLOBAL_MASK_SELECTORS = [
  // Starlight's persistent theme select — its selected value depends on
  // localStorage state from previous navigations.
  '[data-theme-selector], starlight-theme-select',
  // Starlight's search input placeholder can shift width by a pixel across
  // Pagefind index rebuilds.
  '.sl-search-button, dialog.pagefind-ui',
];

/** Page-specific mask selectors. The ADR + design body renders a
 * `- Date: YYYY-MM-DD` line at the top; masking that line only (not the
 * whole first paragraph) preserves surrounding structure in the baseline. */
const PAGE_MASK_SELECTORS: Record<string, readonly string[]> = {
  adr: ["main :is(p, li):has-text('Date:')"],
  design: ["main :is(p, li):has-text('Date:')"],
};

for (const pageCase of PAGES) {
  test.describe(`visual: ${pageCase.slug} (${pageCase.description})`, () => {
    for (const viewport of VIEWPORTS) {
      test(`${pageCase.slug} @ ${viewport.name} (${viewport.width}x${viewport.height})`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await preparePageForVisual(page);
        await page.goto(pageCase.route);
        await waitForFontsReady(page);

        const maskSelectors = [
          ...GLOBAL_MASK_SELECTORS,
          ...(PAGE_MASK_SELECTORS[pageCase.slug] ?? []),
        ];
        const mask = maskSelectors.map((selector) => page.locator(selector));

        await expect(page).toHaveScreenshot(`${pageCase.slug}-${viewport.name}.png`, {
          fullPage: pageCase.fullPage ?? true,
          mask,
          // Small tolerance for anti-aliasing at glyph edges (identical
          // font bytes, identical Chromium build, but subpixel positioning
          // can vary by one pixel row on wide layouts). Anything > this
          // ratio has to be a real content change, not noise.
          maxDiffPixelRatio: 0.01,
          // Threshold per pixel — 0.2 tolerates 20% RGB difference for a
          // single pixel before counting it, matching the Playwright default
          // reasoning for text-heavy pages.
          threshold: 0.2,
          animations: "disabled",
        });
      });
    }
  });
}
