import { expect, test } from "@playwright/test";
import { runDifferential } from "./provenance-differential-runner.ts";

for (const seed of [157, 113, 146]) test(`independent browser/source interval oracle: seed ${seed}`, async ({ page }) => {
  await page.route("**/*", (route) => route.abort());
  const result = await runDifferential(page, seed, 24);
  console.info(`PROVENANCE_DIFFERENTIAL ${JSON.stringify(result)}`);
  expect(result.WRONG, JSON.stringify(result.examples)).toBe(0);
  expect(result.agree + result.refused).toBe(result.ranges);
  expect(result.agree).toBeGreaterThan(0);
});
