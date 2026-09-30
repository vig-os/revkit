// Site-wide accessibility gate (ADR-0016 axe layer, ADR-0017 WCAG 2.2 AA).
//
// Enumerates EVERY built page by walking `site/dist/` for `*.html` files
// rather than the sitemap (`sitemap-0.xml` omits `404.html`), so "every
// built page" is literally true. `just e2e` builds before Playwright
// starts (justfile.project) — a stale `dist/` cannot mask a regression.
//
// The bar: fail on ANY violation at WCAG 2.2 A/AA — including 2.0 A/AA,
// 2.1 A/AA and 2.2 AA — regardless of `impact` (ADR-0017 accepted note
// on strict-any-violation gating). `documentedExceptionsFor()` is the
// ONLY escape hatch — narrow, per-selector, per-rule, and issue-linked.
//
// Verified failure semantics: temporarily adding `<img src="/favicon.svg" />`
// to `src/content/docs/index.mdx` produces a critical `image-alt`
// violation and this spec turns red on the landing route — confirming
// the assertion is not tautological.
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { DocumentedException } from "./fixtures/axe";
import { filterUnresolved, scanAxe } from "./fixtures/axe";

const DIST_DIR = fileURLToPath(new URL("../dist/", import.meta.url));

/** Depth-first walk of `dist/` gathering every `*.html` file. Fails if
 * the walk starts on a missing directory or ends with zero pages — a
 * silent zero-scan is the failure mode ADR-0016 warns about. */
function loadBuiltRoutes(): string[] {
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        out.push(...walk(full));
        continue;
      }
      if (!name.endsWith(".html")) continue;
      out.push(full);
    }
    return out;
  };
  const htmlFiles = walk(DIST_DIR);
  if (htmlFiles.length === 0) {
    throw new Error(
      `No *.html found under ${DIST_DIR}. \`just e2e\` builds the site before Playwright starts; run it directly, or run \`just build\` first.`,
    );
  }
  return htmlFiles.map(htmlFileToRoute).sort();
}

/** Map an absolute dist HTML path to the route the running server
 * responds on. `<dist>/index.html` → `/`,
 * `<dist>/adr/0001-.../index.html` → `/adr/0001-.../`,
 * `<dist>/404.html` → `/404.html`. */
function htmlFileToRoute(fullPath: string): string {
  const rel = relative(DIST_DIR, fullPath).split("\\").join("/");
  if (rel === "index.html") return "/";
  if (rel.endsWith("/index.html")) return `/${rel.slice(0, -"index.html".length)}`;
  return `/${rel}`;
}

const ROUTES = loadBuiltRoutes();

/** Narrowly documented axe exceptions. Each entry is
 *  { rule, selector, issue, note } and must match the failing finding
 *  EXACTLY (see `matchesException` in `tests/fixtures/axe.ts`). A
 *  blanket disable (empty `selector`, or a `*` selector) is refused
 *  by the enforcement below.
 *
 *  Empty at first commit: the deliberate link-underline rule in
 *  `site/src/styles/global.css` covers Starlight's known 1.4.1 body-
 *  link finding, and no other AA violation surfaces on this site. New
 *  entries land in the SAME PR that files the tracking issue. The
 *  matcher is unit-tested (`src/content/schemas/axe-exceptions.test.ts`)
 *  so the code path stays honest while the list is empty. */
function documentedExceptionsFor(route: string): readonly DocumentedException[] {
  void route;
  return [];
}

test.describe("axe-core AA scan on every built page", () => {
  test("dist walk enumerated at least one page (and includes 404.html)", () => {
    // Meta-assertion: catches a build regression that empties dist
    // before the per-route tests would silently pass 0 scans, and
    // pins the specific expectation that the 404 page is covered
    // (the sitemap omits it, so a switch back to sitemap enumeration
    // would trip here).
    expect(ROUTES.length).toBeGreaterThan(0);
    expect(ROUTES).toContain("/404.html");
  });

  for (const route of ROUTES) {
    test(`axe: ${route}`, async ({ page }) => {
      const response = await page.goto(route);
      expect(response, `no response for ${route}`).not.toBeNull();
      // `dist/404.html` is a real file in dist, served with status 200
      // when requested directly by path (the scan runs against its
      // rendered DOM). tests/server.ts also serves it as the body for
      // unknown paths, at status 404 — a separate assertion below
      // exercises that lane so `not-found` pages are scanned in their
      // actually-served form too.
      expect(response?.ok(), `${route} responded ${response?.status()}`).toBe(true);

      const exceptions = documentedExceptionsFor(route);
      for (const exception of exceptions) {
        expect(exception.selector, `documented exception for ${route} needs a non-empty selector`).toBeTruthy();
        expect(exception.selector, `documented exception for ${route} may not blanket-disable via '*'`).not.toBe("*");
      }

      const { violations } = await scanAxe(page);
      const unresolved = filterUnresolved(violations, exceptions);

      expect(
        unresolved,
        `axe violations on ${route}:\n${JSON.stringify(unresolved, null, 2)}`,
      ).toEqual([]);
    });
  }

  test("axe: unknown path served through the 404 fallback (status 404)", async ({ page }) => {
    // Exercises the OTHER 404 lane: `tests/server.ts` serves the
    // dist/404.html body for any unknown path with an HTTP 404 status.
    // Users hit that lane in normal use; the scan on the direct
    // `/404.html` path above misses whatever the response wrapper
    // itself adds (headers, DOM chrome), so both are covered.
    const response = await page.goto("/__revkit-404-probe/");
    expect(response, "no response for /__revkit-404-probe/").not.toBeNull();
    expect(response?.status(), "fallback should serve as 404").toBe(404);

    const { violations } = await scanAxe(page);
    const unresolved = filterUnresolved(violations, []);
    expect(
      unresolved,
      `axe violations on 404 fallback:\n${JSON.stringify(unresolved, null, 2)}`,
    ).toEqual([]);
  });
});
