// Shared Playwright fixture for the visual-regression suite (ADR-0016).
//
// Two determinism knobs live here so every screenshot spec picks them up
// without repeating the setup:
//
//   1. Deterministic fonts (`installDeterministicFonts`) — the site build
//      uses Starlight's system-font stack, so on the NixOS dev host the
//      browser lands on one set of glyphs and on the Ubuntu CI runner it
//      lands on another (different fontconfig, different fallback
//      priorities). That non-determinism is what visual-regression baselines
//      cannot tolerate. The fixture forces every element to a font served
//      through Playwright's `page.route()` from the flake-provided DejaVu
//      Sans / DejaVu Sans Mono files (`REVKIT_TEST_FONTS_DIR`, wired in
//      flake.nix). Nix pins the fonts' /nix/store bytes reproducibly, so both
//      hosts render with identical glyph outlines. If the env is missing
//      (someone running outside the dev shell), the fixture throws with a
//      clear message rather than silently falling back to host fonts and
//      corrupting a baseline.
//
//   2. Animation freeze (`disableAnimations`) — a CSS reset injected via
//      `page.addStyleTag` sets every animation/transition/scroll behaviour
//      to zero-duration and instant. Starlight's Kobalte-based menus and
//      Tailwind's utility transitions would otherwise catch mid-frame in a
//      screenshot and drift baselines by a few pixels between runs.
//
// Callers use it like this:
//
//   await preparePageForVisual(page);
//   await page.goto(route);
//   await expect(page).toHaveScreenshot({ /* fullPage, mask, ... */ });
//
// The order matters: the route + style injection must be in place BEFORE
// the goto so the first render already picks them up.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

/** Font family name the injected CSS forces on every element. Kept in one
 * place so the `@font-face` `font-family` and the `* { font-family: ... }`
 * override stay in sync. */
const FONT_FAMILY_SANS = "RevkitTestSans";
const FONT_FAMILY_MONO = "RevkitTestMono";

/** Virtual URL prefix the fixture routes to the on-disk font files. Kept
 * out of `/_astro/` and `/_katex/` so a regression in the site's real
 * asset serving cannot accidentally shadow (or be shadowed by) the test
 * fonts. */
const FONT_ROUTE_PREFIX = "/__revkit-test-fonts/";

interface FontEntry {
  readonly file: string;
  readonly urlName: string;
  readonly weight: number;
  readonly style: "normal" | "italic";
  readonly family: string;
}

/** DejaVu file layout in the nixpkgs `dejavu_fonts` derivation. The four
 * regular/bold/italic combinations for the Sans family cover Starlight's
 * body, heading and inline-emphasis rendering; the Mono equivalents cover
 * code blocks. */
const FONT_MANIFEST: readonly FontEntry[] = [
  { file: "DejaVuSans.ttf", urlName: "sans-regular.ttf", weight: 400, style: "normal", family: FONT_FAMILY_SANS },
  { file: "DejaVuSans-Bold.ttf", urlName: "sans-bold.ttf", weight: 700, style: "normal", family: FONT_FAMILY_SANS },
  { file: "DejaVuSans-Oblique.ttf", urlName: "sans-italic.ttf", weight: 400, style: "italic", family: FONT_FAMILY_SANS },
  { file: "DejaVuSans-BoldOblique.ttf", urlName: "sans-bolditalic.ttf", weight: 700, style: "italic", family: FONT_FAMILY_SANS },
  { file: "DejaVuSansMono.ttf", urlName: "mono-regular.ttf", weight: 400, style: "normal", family: FONT_FAMILY_MONO },
  { file: "DejaVuSansMono-Bold.ttf", urlName: "mono-bold.ttf", weight: 700, style: "normal", family: FONT_FAMILY_MONO },
];

/** Resolve `REVKIT_TEST_FONTS_DIR` (set by the flake shellHook to the
 * pinned dejavu_fonts store path) and validate every file the manifest
 * expects is present. Missing anything => throw with a message that points
 * the operator at the flake env. */
function resolveFontsDir(): string {
  const dir = process.env.REVKIT_TEST_FONTS_DIR;
  if (!dir || !existsSync(dir)) {
    throw new Error(
      "REVKIT_TEST_FONTS_DIR is not set or does not exist. Run the visual " +
        "suite from inside the flake dev shell (`nix develop` or `direnv " +
        "allow`); flake.nix wires the path to the pinned dejavu_fonts " +
        "derivation.",
    );
  }
  const missing = FONT_MANIFEST.filter((entry) => !existsSync(join(dir, entry.file)));
  if (missing.length > 0) {
    throw new Error(
      `REVKIT_TEST_FONTS_DIR (${dir}) is missing expected font files: ${missing
        .map((entry) => entry.file)
        .join(", ")}. The dejavu_fonts derivation layout changed; update FONT_MANIFEST.`,
    );
  }
  return dir;
}

/** Install the test fonts. Registers a `page.route()` for the virtual
 * `/__revkit-test-fonts/*` prefix that serves the raw TTF bytes from disk,
 * then injects an `@font-face` block plus a `*` override so every element
 * uses the deterministic family. The `!important` is load-bearing — the
 * Starlight theme sets `font-family` on many descendants at higher
 * specificity than the `*` selector alone would win against. */
export async function installDeterministicFonts(page: Page): Promise<void> {
  const dir = resolveFontsDir();
  const routePattern = new RegExp(`${FONT_ROUTE_PREFIX}.+\\.ttf$`);
  await page.route(routePattern, async (route) => {
    const url = new URL(route.request().url());
    const file = url.pathname.slice(FONT_ROUTE_PREFIX.length);
    const entry = FONT_MANIFEST.find((manifestEntry) => manifestEntry.urlName === file);
    if (!entry) {
      await route.fulfill({ status: 404, body: `unknown test font: ${file}` });
      return;
    }
    const body = readFileSync(join(dir, entry.file));
    await route.fulfill({
      contentType: "font/ttf",
      // Cache-Control so a rerouted request within the same page (the
      // browser may re-request italic/bold variants) does not thrash.
      headers: { "cache-control": "public, max-age=60" },
      body,
    });
  });

  const fontFaces = FONT_MANIFEST.map(
    (entry) =>
      `@font-face { font-family: "${entry.family}"; src: url("${FONT_ROUTE_PREFIX}${entry.urlName}") format("truetype"); font-weight: ${entry.weight}; font-style: ${entry.style}; font-display: block; }`,
  ).join("\n");

  const overrideCss = `
${fontFaces}
:root {
  --sl-font: "${FONT_FAMILY_SANS}", sans-serif;
  --sl-font-mono: "${FONT_FAMILY_MONO}", monospace;
  --__sl-font: "${FONT_FAMILY_SANS}", sans-serif;
  --__sl-font-mono: "${FONT_FAMILY_MONO}", monospace;
  --font-sans: "${FONT_FAMILY_SANS}", sans-serif;
  --font-mono: "${FONT_FAMILY_MONO}", monospace;
}
*, *::before, *::after {
  font-family: "${FONT_FAMILY_SANS}", sans-serif !important;
}
code, kbd, samp, pre, pre *, .expressive-code *, code * {
  font-family: "${FONT_FAMILY_MONO}", monospace !important;
}
`;

  await page.addInitScript(
    ({ css }) => {
      const install = (): void => {
        if (document.head.querySelector("style[data-revkit-test-fonts]")) return;
        const style = document.createElement("style");
        style.setAttribute("data-revkit-test-fonts", "true");
        style.textContent = css;
        document.head.appendChild(style);
      };
      if (document.head) install();
      else document.addEventListener("DOMContentLoaded", install, { once: true });
    },
    { css: overrideCss },
  );
}

/** Freeze animations, transitions, scroll-behavior and caret blinking so a
 * screenshot taken at time T is identical to one taken at time T+ε. */
export async function disableAnimations(page: Page): Promise<void> {
  const css = `
*, *::before, *::after {
  animation-delay: -0.0001s !important;
  animation-duration: 0s !important;
  animation-iteration-count: 1 !important;
  transition-delay: 0s !important;
  transition-duration: 0s !important;
  scroll-behavior: auto !important;
  caret-color: transparent !important;
}
html { scroll-behavior: auto !important; }
`;
  await page.addInitScript((cssInject) => {
    const install = (): void => {
      if (document.head.querySelector("style[data-revkit-test-no-anim]")) return;
      const style = document.createElement("style");
      style.setAttribute("data-revkit-test-no-anim", "true");
      style.textContent = cssInject;
      document.head.appendChild(style);
    };
    if (document.head) install();
    else document.addEventListener("DOMContentLoaded", install, { once: true });
  }, css);
}

/** Wait for the browser to report that every declared font-face has been
 * loaded — otherwise a screenshot taken before the DejaVu bytes arrive
 * captures the fallback family and drifts baselines. */
export async function waitForFontsReady(page: Page): Promise<void> {
  await page.evaluate(async () => {
    if (typeof document !== "undefined" && document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }
  });
}

/** One call = full determinism prep. Register BEFORE `page.goto`. */
export async function preparePageForVisual(page: Page): Promise<void> {
  await installDeterministicFonts(page);
  await disableAnimations(page);
}

/** Viewport table used by the visual specs. 390 px = iPhone 13 mini
 * (phone), 820 px = iPad mini (tablet), 1440 px = 15" laptop (desktop);
 * matches ADR-0016's three breakpoints. */
export const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "desktop", width: 1440, height: 900 },
] as const;
