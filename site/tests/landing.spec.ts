// M1 smoke test: the site builds, the landing page loads, has a heading, and
// axe-core (ADR-0017) finds no serious/critical accessibility violations.
//
// This is intentionally small — the full e2e suite (comment rail, question
// kinds, re-anchoring across a rebuild) is ADR-0016's job in M2/M3.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("landing page renders with a heading", async ({ page }) => {
  await page.goto("/");
  const heading = page.getByRole("heading", { level: 1 }).first();
  await expect(heading).toBeVisible();
  await expect(heading).toContainText(/revkit/i);
});

test("landing page has no serious/critical axe violations", async ({ page }) => {
  await page.goto("/");
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
});
