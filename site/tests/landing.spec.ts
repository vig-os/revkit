// M1 smoke test: the site builds, the landing page loads, the registered
// Callout component from `@revkit/components` renders through the Astro +
// Solid pipeline, and axe-core (ADR-0017) finds no serious/critical
// accessibility violations.
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

test("landing page renders the Callout from @revkit/components", async ({ page }) => {
  await page.goto("/");

  // The Callout renders `<div role="note" data-callout-kind="info"
  // class="revkit-callout revkit-callout--info">…</div>` (see
  // packages/components/src/Callout.tsx). Assert the semantic role, the tone
  // markers and the body text so a regression in the registry, in the Astro
  // integration, or in the MDX pipeline all trip this test.
  const callout = page.locator('[role="note"][data-callout-kind="info"]');
  await expect(callout).toBeVisible();
  await expect(callout).toHaveClass(/\brevkit-callout\b/);
  await expect(callout).toHaveClass(/\brevkit-callout--info\b/);
  await expect(callout.locator(".revkit-callout__title")).toHaveText("M1 preview");
  await expect(callout.locator(".revkit-callout__body")).toContainText("M1 scaffold");
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
