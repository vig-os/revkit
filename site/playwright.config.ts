// Playwright configuration for the revkit site smoke suite.
//
// - Browsers come from the flake's `pkgs.playwright-driver.browsers` via the
//   `PLAYWRIGHT_BROWSERS_PATH` env var set by the dev shell (ADR-0018).
//   `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true` is also exported there
//   so the driver does not try to check host packages on NixOS.
// - `webServer` builds the site once and serves the static output through
//   `tests/server.ts` — a tiny Bun static server — because Astro 7's
//   `astro preview` daemonises and Playwright's `webServer` cannot manage a
//   command that returns before its server is ready.
// - Chromium always runs. WebKit is opt-in via `REVKIT_ENABLE_WEBKIT=1`:
//   the flake's `pkgs.playwright-driver.browsers` webkit build fails to
//   start on BOTH the NixOS dev host AND CI's Ubuntu runner (CI uses the
//   same nix-provided browsers via PLAYWRIGHT_BROWSERS_PATH), so ADR-0018's
//   Safari coverage is currently deferred to #19.
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
    command: "bun run build && bun tests/server.ts",
    url: "http://127.0.0.1:4321",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
