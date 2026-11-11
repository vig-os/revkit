// Playwright configuration for the revkit site smoke suite.
//
// - Browsers come from the flake's `pkgs.playwright-driver.browsers` via the
//   `PLAYWRIGHT_BROWSERS_PATH` env var set by the dev shell (ADR-0018).
//   `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true` is also exported there
//   so the driver does not try to check host packages on NixOS.
// - `webServer` serves the pre-built static output through `tests/server.ts`
//   — a tiny Bun static server — because Astro 7's `astro preview` daemonises
//   and Playwright's `webServer` cannot manage a command that returns before
//   its server is ready. `just e2e` / `just e2e-update` run `just build`
//   BEFORE Playwright starts, so every run screenshots and axe-scans a
//   freshly built dist. A stale `dist/` from a previous run cannot mask a
//   regression the way a "build only if missing" guard would (PR #31
//   review: an intentional low-contrast paragraph added between builds
//   went undetected). If dist is missing when webServer starts,
//   `tests/server.ts` exits with a clear message pointing at `just e2e`.
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
  // Default expect timeout, raised from Playwright's 5 s.
  //
  // The daemon BUILDS the rail bundle with `Bun.build` on the first
  // request and caches it per daemon, so the first page load of every
  // test pays a one-time compile. Locally `fullyParallel` runs that
  // across Playwright's default worker count (CI pins `workers: 1`),
  // and several daemons compiling at once on a loaded box can push a
  // single cold mount past 5 s — which failed `rail-roundtrip`'s XSS
  // regression once in ten full-suite runs, on a `toBeVisible()` for
  // an element that was about to appear. This is a BUDGET for a real
  // one-time cost, not a way to hide a hang: 15 s still fails a
  // genuinely broken mount, and any assertion waiting on the debounced
  // re-anchor pipeline uses the settle-based helper in
  // `rail-reanchor.spec.ts` instead of a longer sleep.
  expect: {
    timeout: 15_000,
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
    command: "bun tests/server.ts",
    url: "http://127.0.0.1:4321",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
