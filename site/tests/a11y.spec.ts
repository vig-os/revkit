// Site-wide accessibility gate (ADR-0016 axe layer, ADR-0017 WCAG 2.2 AA).
//
// The other e2e specs each run axe on the page they exercise, which keeps
// axe close to the feature the spec is asserting on. This spec covers the
// axis those cannot: it enumerates EVERY built page from the sitemap the
// site emits at build time (`site/dist/sitemap-0.xml`), so a page added to
// the docs collection tomorrow is scanned tomorrow without a test edit. If
// the sitemap file is missing, or if it emits zero URLs, the suite fails
// loudly — silently scanning nothing is the failure mode ADR-0016 warns
// about ("run in CI on every PR" only matters if the scan sees the page).
//
// The bar: fail on ANY violation at WCAG 2.2 A/AA — including 2.0 A/AA,
// 2.1 A/AA and 2.2 AA — regardless of `impact`. The per-page smoke tests
// stayed at `serious|critical` while the M1 site content settled; this
// site-wide gate takes the full AA level from M1 forward (ADR-0017 target)
// with `documentedExceptionsFor()` as the ONLY escape hatch — narrow, per-
// selector, per-rule, and issue-linked.
//
// Verified failure semantics: temporarily removing the deliberate <a>
// underline in `site/src/styles/global.css` reintroduces a Starlight body-
// link contrast violation, and this spec turns red on every ADR/design
// page — confirming the assertion is not tautological.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const SITE_DIR = fileURLToPath(new URL("..", import.meta.url));
const SITEMAP_PATH = fileURLToPath(new URL("../dist/sitemap-0.xml", import.meta.url));

/** Load and parse the sitemap the Astro build emits (`@astrojs/sitemap` is
 * added transitively by Starlight). If the file is missing (cold run before
 * Playwright's webServer has built the site), build the site synchronously
 * so route enumeration succeeds at test-collection time — the `for` loop
 * below needs the routes to exist at module load, and Playwright's
 * `webServer` starts AFTER spec files are imported. The webServer command
 * is guarded on the same sitemap file, so a rebuild here means no double
 * build. Failing after the build => the build shape changed and this suite
 * would silently scan zero pages. */
function loadSitemapRoutes(): string[] {
  if (!existsSync(SITEMAP_PATH)) {
    // eslint-disable-next-line no-console
    console.log(`[a11y] ${SITEMAP_PATH} missing; running 'bun run build' from ${SITE_DIR}`);
    execFileSync("bun", ["run", "build"], { cwd: SITE_DIR, stdio: "inherit" });
  }
  const xml = readFileSync(SITEMAP_PATH, "utf8");
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  if (locs.length === 0) {
    throw new Error(`Sitemap ${SITEMAP_PATH} contained zero <loc> entries.`);
  }
  // The sitemap uses the astro `site:` origin (https://revkit.local); the
  // Playwright baseURL points at the Bun static server. Drop the origin so
  // page.goto lands on the tests' host.
  return locs.map((url) => new URL(url).pathname);
}

const ROUTES = loadSitemapRoutes();

/** Narrowly documented axe exceptions. Each entry is
 *  { rule, selector, issue } — a rule id from axe, a CSS selector for the
 *  ONE node the finding attaches to, and a link to a tracking issue for
 *  the underlying fix. A blanket disable (missing `selector`, or a `*`
 *  selector) is refused by the enforcement below.
 *
 *  Empty at first commit: the deliberate link-underline rule in
 *  `site/src/styles/global.css` covers Starlight's known 1.4.1 finding,
 *  and no other AA violation surfaces on this site. New entries land in
 *  the SAME PR that files the tracking issue. */
interface DocumentedException {
  readonly rule: string;
  readonly selector: string;
  readonly issue: `https://github.com/vig-os/revkit/issues/${number}`;
  readonly note: string;
}

function documentedExceptionsFor(route: string): readonly DocumentedException[] {
  void route;
  return [];
}

/** WCAG 2.2 AA gate tag set. Each tag maps to a normative WCAG level:
 * axe's `wcag2a` / `wcag2aa` cover WCAG 2.0 A/AA, `wcag21a` / `wcag21aa`
 * cover the 2.1 delta, and `wcag22aa` covers the 2.2 delta at AA — the
 * union is the ADR-0017 target surface. */
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] as const;

test.describe("axe-core AA scan on every built page", () => {
  test("sitemap enumerated at least one route", () => {
    // Meta-assertion: catches a build regression that emits an empty
    // sitemap before the per-route tests would silently pass 0 scans.
    expect(ROUTES.length).toBeGreaterThan(0);
  });

  for (const route of ROUTES) {
    test(`axe: ${route}`, async ({ page }) => {
      const response = await page.goto(route);
      expect(response, `no response for ${route}`).not.toBeNull();
      expect(response?.ok(), `${route} responded ${response?.status()}`).toBe(true);

      const results = await new AxeBuilder({ page }).withTags([...WCAG_TAGS]).analyze();

      const exceptions = documentedExceptionsFor(route);
      // Fail loudly on an exception whose target doesn't match the axe
      // finding shape — a stale exception is worse than none, because it
      // hides new violations of the same rule under a different selector.
      for (const exception of exceptions) {
        expect(exception.selector, `documented exception for ${route} needs a non-empty selector`).toBeTruthy();
        expect(exception.selector, `documented exception for ${route} may not blanket-disable via '*'`).not.toBe("*");
      }

      const violations = results.violations.flatMap((violation) =>
        violation.nodes.map((node) => ({
          rule: violation.id,
          impact: violation.impact,
          help: violation.help,
          helpUrl: violation.helpUrl,
          target: node.target.join(" "),
          html: node.html,
        })),
      );

      const unresolved = violations.filter((violation) => {
        return !exceptions.some(
          (exception) => exception.rule === violation.rule && exception.selector === violation.target,
        );
      });

      expect(
        unresolved,
        `axe violations on ${route}:\n${JSON.stringify(unresolved, null, 2)}`,
      ).toEqual([]);
    });
  }
});
