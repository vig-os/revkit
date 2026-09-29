// E2e for the content model (M1 item 2 dogfood, issue #6). The site sources
// the ADRs, DESIGN-0001 and the feature matrix from this repo's own docs/
// directory (ADR-0003) — these tests exercise the built artefact so a
// regression in the loader, the schema layer or the sidebar wiring trips.
//
// Each page assertion also runs an axe-core scan (ADR-0017) so the shared
// docs surface stays WCAG 2.2 AA-clean as pages are added.
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

test("ADR page renders its title and status", async ({ page }) => {
  await page.goto("/adr/0001-static-first-site-stack/");
  const heading = page.getByRole("heading", { level: 1 }).first();
  await expect(heading).toHaveText(/ADR-0001: Static-first site stack/);
  // The `- Status: Accepted` line from the ADR source renders inside the
  // page body as the first bullet — the loader deliberately preserves the
  // ADR structure so the status is visible without a schema-side render.
  await expect(page.locator("main").getByText(/Status: Accepted/)).toBeVisible();
  await expectNoBlockingViolations(page);
});

test("ADR index page renders a table with 24 ADR rows", async ({ page }) => {
  await page.goto("/adr/readme/");
  await expect(page.getByRole("heading", { level: 1 }).first()).toHaveText(
    "Architecture decision records",
  );
  // 25 rows total: one header row + one per ADR (0001..0024). Counting the
  // ADR-linked rows only avoids picking up the header, so the test asserts
  // the domain fact rather than the markup shape.
  const dataRows = page.locator("main table tbody tr");
  await expect(dataRows).toHaveCount(24);
  await expect(page.locator("main").getByRole("link", { name: /^0001$/ })).toBeVisible();
  await expectNoBlockingViolations(page);
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
