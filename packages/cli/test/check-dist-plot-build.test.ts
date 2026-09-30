// Issue #27 — real-build end-to-end guard for `revkit check-dist`.
//
// The bypass fixtures in check-dist.test.ts crafted HTML directly:
// the content guards (registry-only MDX, plots schema, Vega
// sanitiser) refuse every one of them at the source, so the only
// realistic way one could reach the output gate is a build-tool
// regression or a hand-edited artefact.
//
// This suite is the counterpart: it runs the REAL Vega-Lite render
// pipeline (site/src/lib/render-plot.ts, the same code
// `<Plot name=… />` invokes during `astro build`), wraps the
// resulting SVG in the same HTML shape Astro emits (an <svg> child
// of the page's <main>), and asserts check-dist reports zero
// findings. It guards the swing-too-far regression: a URL scanner
// that also refused Vega's legitimate `<rect clip-path="url(#clip_a)"/>`
// output would fail every real plot build. The presence of at least
// one legitimate `url(#…)` reference in the rendered SVG (verified
// below) proves the new SVG url() scan is actually exercised on real
// output.
//
// The plot fixture reuses site/tests/fixtures/plots/example — a
// two-column CSV bar chart that produces the same shapes Vega emits
// under real builds. `just build` (called from `just e2e`) is the
// out-of-band end-to-end assertion: it runs `astro build` over the
// real site content and pipes the resulting `site/dist/` through
// `revkit check-dist`, so a regression in either the source guards
// or the output gate would fail the build there. This suite adds a
// fast bun-test analogue that does not require Astro or Playwright.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parse5Parse } from "parse5";
import { scanDocument } from "../src/check-dist.ts";
import { renderPlotToSvg } from "../../../site/src/lib/render-plot.ts";

function scan(html: string) {
  const doc = parse5Parse(html);
  return scanDocument(doc as unknown as Parameters<typeof scanDocument>[0], "index.html");
}

// The real bundle-sizes plot (the one the /math-and-plots page
// renders in production, ADR-0004) is used here rather than the
// smaller fixture: Vega emits `<g clip-path="url(#clip1)">` for
// its axis-clipping only under specs with multiple named-scale
// tooltips / grid layers, and the trivial fixture would produce an
// SVG with no `url(…)` at all — which would still pass check-dist
// but would not EXERCISE the new SVG url() scan (see the
// anti-tautology test below).
const FIXTURE_DIR = resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "plots",
  "bundle-sizes",
);

describe("check-dist — issue #27 real-render (Vega) plot output passes the SVG url() scan", () => {
  test("a real Vega plot render produces zero check-dist findings", async () => {
    const spec = JSON.parse(readFileSync(resolve(FIXTURE_DIR, "spec.vl.json"), "utf8"));
    const svg = await renderPlotToSvg(spec, {
      specDir: FIXTURE_DIR,
      accessibleName: "bundle-sizes plot",
    });
    // Wrap in the same page shape Astro produces so parse5 walks
    // the SVG in its foreign-content branch (matching what
    // check-dist sees in `site/dist/*.html`).
    const html = `<!doctype html><html lang="en"><head><title>t</title></head><body><main>${svg}</main></body></html>`;
    expect(scan(html)).toEqual([]);
  });

  test("the rendered SVG actually contains a url(#…) reference (exercises the new scan)", async () => {
    // This is the anti-tautology guard: the "zero findings" assertion
    // above would still pass on an SVG that carried NO url(…) refs,
    // and check-dist's new scan would never have to run. Vega emits
    // clip-path="url(#clip1)" for a chart with axes, so a real render
    // is a real exercise of the scan. Assert the shape here so a
    // future Vega version that dropped clip refs would be noticed and
    // the build test replaced with a spec that still emits them.
    const spec = JSON.parse(readFileSync(resolve(FIXTURE_DIR, "spec.vl.json"), "utf8"));
    const svg = await renderPlotToSvg(spec, {
      specDir: FIXTURE_DIR,
      accessibleName: "bundle-sizes plot",
    });
    expect(/url\(#[^)]+\)/.test(svg)).toBe(true);
  });
});
