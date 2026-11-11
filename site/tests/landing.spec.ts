// M1 smoke test: the site builds, the landing page loads, the registered
// Callout component from `@revkit/components` renders through the Astro +
// Solid pipeline. The dedicated site-wide axe gate lives in
// `a11y.spec.ts` (ADR-0017), so the per-page serious/critical scan that
// used to sit here has been removed — the strict any-violation gate on
// the site-wide spec covers the landing page along with the other 30.
//
// This is intentionally small — the full e2e suite (comment rail, question
// kinds, re-anchoring across a rebuild) is ADR-0016's job in M2/M3.
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
