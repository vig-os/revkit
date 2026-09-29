// E2e for the content model (M1 item 2 dogfood, issue #6). The site sources
// the ADRs, DESIGN-0001 and the feature matrix from this repo's own docs/
// directory (ADR-0003) — these tests exercise the built artefact so a
// regression in the loader, the schema layer or the sidebar wiring trips.
//
// Each page assertion also runs an axe-core scan (ADR-0017) so the shared
// docs surface stays WCAG 2.2 AA-clean as pages are added.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/** Blocking axe violations only — matches the landing-page smoke's bar and
 * matches the ADR-0017 gate (advisory findings shouldn't fail CI). */
async function expectNoBlockingViolations(page: import("@playwright/test").Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(
    blocking,
    `serious/critical axe violations: ${JSON.stringify(blocking, null, 2)}`,
  ).toEqual([]);
}

/** Count the ADR source files at the repo's `docs/adr/` — the ADR index
 * table on the built site is derived from this same set, so deriving the
 * expected row count keeps the test correct as ADRs are added or removed
 * (rather than a hardcoded number that drifts silently). */
const ADR_SOURCE_DIR = fileURLToPath(new URL("../../docs/adr/", import.meta.url));
const adrSourceFileCount = readdirSync(ADR_SOURCE_DIR).filter((name) =>
  /^\d{4}-.*\.md$/.test(name),
).length;

test("ADR page renders its title, body status line and sidebar badge", async ({ page }) => {
  await page.goto("/adr/0001-static-first-site-stack/");
  const heading = page.getByRole("heading", { level: 1 }).first();
  await expect(heading).toHaveText(/ADR-0001: Static-first site stack/);
  // The `- Status: Accepted` line from the ADR source renders inside the
  // page body as the first bullet — the loader deliberately preserves the
  // ADR structure so the status is visible without a schema-side render.
  await expect(page.locator("main").getByText(/Status: Accepted/)).toBeVisible();
  // The loader also lifts the status into a Starlight sidebar badge — the
  // signal a scanner sees before opening the page. The current ADR's link
  // has `aria-current="page"` and carries the "Accepted" badge next to it.
  const sidebarLink = page.locator('nav a[aria-current="page"]');
  await expect(sidebarLink).toContainText("ADR-0001");
  await expect(sidebarLink.locator(".sl-badge")).toHaveText("Accepted");
  await expectNoBlockingViolations(page);
});

test("ADR index page renders a table with one row per ADR file on disk", async ({ page }) => {
  await page.goto("/adr/readme/");
  await expect(page.getByRole("heading", { level: 1 }).first()).toHaveText(
    "Architecture decision records",
  );
  const dataRows = page.locator("main table tbody tr");
  await expect(dataRows).toHaveCount(adrSourceFileCount);
  await expect(page.locator("main").getByRole("link", { name: /^0001$/ })).toBeVisible();
  await expectNoBlockingViolations(page);
});

test("ADR index links click through to the sibling ADR page (link rewriting)", async ({ page }) => {
  await page.goto("/adr/readme/");
  // The ADR README source uses relative `.md` hrefs (e.g.
  // `0002-solid-islands-component-registry.md`); the loader must rewrite
  // those to the built site's route. Click one and assert the destination
  // renders — a residual `.md` href would land on a 404.
  const target = page.locator('main').getByRole("link", { name: /^0002$/ }).first();
  await expect(target).toHaveAttribute("href", "/adr/0002-solid-islands-component-registry/");
  await Promise.all([page.waitForURL("**/adr/0002-solid-islands-component-registry/"), target.click()]);
  await expect(page.getByRole("heading", { level: 1 }).first()).toContainText(
    "Solid islands and a single component registry",
  );
});

test("no rendered page contains an internal `.md` href", async ({ request }) => {
  // Regression guard for C3 (links + sets): any residual `.md` href from
  // the repo docs would 404 in the built site. Walk every rendered page
  // this suite already touches; the loader also fails a build if a rewrite
  // is missed, so this check catches the render-time regression bucket.
  const pageRoutes = [
    "/adr/readme/",
    "/adr/0001-static-first-site-stack/",
    "/designs/design-0001-revkit-architecture/",
    "/feature-matrix/",
  ];
  for (const route of pageRoutes) {
    const response = await request.get(route);
    expect(response.ok(), `route ${route} did not respond OK`).toBe(true);
    const html = await response.text();
    // Skip fenced code snippets by stripping `<code>` blocks before scan —
    // otherwise a documented example like `docs/adr/0003.mdx` would trip
    // the check.
    const scannable = html.replace(/<code[\s\S]*?<\/code>/g, "");
    const residual = [...scannable.matchAll(/href="([^"]+\.md(?:#[^"]*)?)"/g)]
      .map((match) => match[1])
      .filter((href) => !/^https?:/i.test(href));
    expect(residual, `route ${route} has residual .md hrefs`).toEqual([]);
  }
});

test("DESIGN-0001 page renders", async ({ page }) => {
  await page.goto("/designs/design-0001-revkit-architecture/");
  await expect(page.getByRole("heading", { level: 1 }).first()).toHaveText(
    /DESIGN-0001/,
  );
  await expect(page.getByRole("heading", { name: "1. User stories" })).toBeVisible();
  await expectNoBlockingViolations(page);
});

test("Feature matrix page renders a table with a row per story", async ({ page }) => {
  await page.goto("/feature-matrix/");
  await expect(page.getByRole("heading", { level: 1 }).first()).toHaveText(
    "Feature matrix",
  );
  // The feature matrix carries the story table used by the adr-matrix gate;
  // the row count is not asserted here (the gate owns that invariant), but
  // the table must render with at least the A1 story row.
  await expect(page.locator("main table tbody").first()).toBeVisible();
  await expect(page.locator("main").getByText(/A1/).first()).toBeVisible();
  await expectNoBlockingViolations(page);
});

test("sidebar groups Design, ADRs and Feature matrix around Start", async ({ page }) => {
  await page.goto("/adr/0001-static-first-site-stack/");
  const nav = page.locator("nav");
  await expect(nav.getByText("Design", { exact: true }).first()).toBeVisible();
  await expect(nav.getByText("ADRs", { exact: true }).first()).toBeVisible();
  await expect(nav.getByText("Feature matrix", { exact: true }).first()).toBeVisible();
  // The current page (ADR-0001) is linked in the ADR group with its full
  // title — a regression in the composed loader would produce a blank label.
  await expect(
    nav.getByRole("link", { name: /ADR-0001: Static-first site stack/ }),
  ).toHaveCount(1);
});
