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

// Zero retries for the visual suite even under CI's default of 2:
// a flaky screenshot is a real signal (nondeterministic rendering,
// masked region drift, font not loading) and hiding it under a retry
// would let the flake grow into a false negative (PR #31 review). The
// rest of the e2e suite keeps CI's retries; only screenshots are
// pinned to strict-one-pass here.
test.describe.configure({ retries: 0 });

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

/** CSS selectors to mask on every page. These regions are user-scoped
 * (theme select state, remembered in localStorage) or would otherwise
 * cause per-run drift. Verified against the built HTML — every selector
 * here matches at least one node on the pages under test; earlier
 * guesses (`[data-theme-selector]`, `.sl-search-button`,
 * `dialog.pagefind-ui`) matched nothing and were removed in PR #31
 * review round 1. */
const GLOBAL_MASK_SELECTORS = [
  // Starlight's theme select emits `<starlight-theme-select>` for the
  // desktop toolbar and again for the mobile menu — its picker state
  // depends on `localStorage.starlight-theme`.
  "starlight-theme-select",
  // Starlight's search entry point renders as `<site-search>` wrapping
  // a `button[data-open-modal]`. The button's disabled/enabled state
  // depends on whether Pagefind's JS has hydrated, which is timing-
  // sensitive on cold caches.
  "site-search button[data-open-modal]",
];

/** Page-specific mask selectors. Every ADR body renders a
 * `- Date: YYYY-MM-DD` line as an `<li>` at the top of the page
 * (verified against `dist/adr/0001-.../index.html`). Masking that
 * one line only — not the whole first paragraph — keeps the
 * surrounding structure in the baseline. `:has-text(...)` is
 * Playwright's engine extension for locators, not a CSS selector, so
 * pass through `page.locator(...)` (which `mask` accepts).
 *
 * DESIGN-0001 has no equivalent `Date:` line in its body — verified:
 * `grep -c "Date:" dist/designs/design-0001-.../index.html` is 0. No
 * entry needed. (PR #31 review round 2 dropped a stale `design` mask
 * that matched nothing.) */
const PAGE_MASK_SELECTORS: Record<string, readonly string[]> = {
  adr: ["main li:has-text('Date:')"],
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
