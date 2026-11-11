// Full-size falsifier: nix develop -c bun site/tests/provenance-differential-manual.ts
// Keep the same independent oracle and browser endpoints as the CI-sized test.
import { chromium } from "@playwright/test";
import { runDifferential } from "./provenance-differential-runner.ts";

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.route("**/*", (route) => route.abort());
  for (const seed of [157, 113, 146]) {
    const result = await runDifferential(page, seed, 140);
    console.info(`PROVENANCE_DIFFERENTIAL ${JSON.stringify(result)}`);
    if (result.WRONG > 0) process.exitCode = 1;
  }
} finally { await browser.close(); }
