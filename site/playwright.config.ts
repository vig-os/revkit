// Playwright configuration for the revkit site smoke suite.
//
// - Browsers come from the flake's `pkgs.playwright-driver.browsers` via the
//   `PLAYWRIGHT_BROWSERS_PATH` env var set by the dev shell (ADR-0018).
//   `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true` is also exported there
//   so the driver does not try to check host packages on NixOS.
// - `webServer` builds the site once and serves the static output through
//   `astro preview`, so the smoke covers the same artefact CI would deploy.
// - Chromium runs everywhere; WebKit runs when `REVKIT_ENABLE_WEBKIT=1` is
//   set (the nix-provided webkit build sometimes misses shared libs on a
//   NixOS host, and forcing it would fail M1's CI unnecessarily — the M2
//   e2e suite enables it explicitly once the wiring is proven).
import { defineConfig, devices } from "@playwright/test";

const enableWebKit = process.env.REVKIT_ENABLE_WEBKIT === "1";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: "http://127.0.0.1:4321",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    ...(enableWebKit
      ? [
          {
            name: "webkit",
            use: { ...devices["Desktop Safari"] },
          },
        ]
      : []),
  ],
  webServer: {
    // Astro 7's `astro preview` daemonises (see astro CLI reference), which
    // Playwright's `webServer` cannot manage. We build the site, then serve
    // `dist/` in the foreground with a tiny Bun static server — so the smoke
    // still exercises the built artefact, not the dev server.
    command: "bun run build && bun tests/server.ts",
    url: "http://127.0.0.1:4321",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
