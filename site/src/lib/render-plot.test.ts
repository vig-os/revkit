// Tests for the build-time plot renderer (ADR-0004, C4).
//
// The scope here is real Vega-Lite -> Vega -> SVG output on a fixture spec:
// the returned SVG must carry the marks a bar chart of the fixture would
// produce, expose an accessible name / description, and refuse a data
// path that walks outside the spec's own directory. Rendering that
// silently falls back to an empty scenegraph is the exact regression the
// reviewer bar-chart check catches.
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { renderPlotToSvg, sanitizeSvg } from "./render-plot.ts";

const PLOT_FIXTURE_DIR = fileURLToPath(new URL("../../tests/fixtures/plots/", import.meta.url));
const EXAMPLE_DIR = join(PLOT_FIXTURE_DIR, "example");
const EXAMPLE_SPEC = join(EXAMPLE_DIR, "spec.vl.json");

async function loadExampleSpec(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(EXAMPLE_SPEC, "utf8")) as Record<string, unknown>;
}

/** Return the visible text content of every SVG `<text>` element, in
 * document order. Used to assert Vega-Lite produced the category labels
 * / axis titles the caller expects, rather than an empty scenegraph. */
function textNodes(svg: string): string[] {
  const matches = svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g);
  return Array.from(matches, (m) => m[1]);
}

describe("renderPlotToSvg — happy path against the fixture", () => {
  test("produces an SVG with role=img and the fixture's category labels", async () => {
    const spec = await loadExampleSpec();
    const svg = await renderPlotToSvg(spec, {
      specDir: EXAMPLE_DIR,
      accessibleName: "Fixture bar chart",
    });

    expect(svg).toStartWith("<svg");
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="Fixture bar chart"');
    // The <title> is what makes assistive tech announce the plot — a
    // missing title is a WCAG 1.1.1 fail (ADR-0017), so this is asserted
    // rather than treated as decorative.
    expect(svg).toContain("<title>Fixture bar chart</title>");

    // The fixture data has categories a/b/c; Vega-Lite must render the
    // corresponding axis labels. A regression that ships an empty
    // scenegraph would drop all three.
    const texts = textNodes(svg);
    expect(texts).toContain("a");
    expect(texts).toContain("b");
    expect(texts).toContain("c");

    // A bar chart uses `role-mark-rect` marks in Vega — one per row of
    // data. The fixture has three rows, so at least three mark rects.
    const rectMarks = svg.match(/role="graphics-symbol" aria-roledescription="bar"/g);
    expect((rectMarks ?? []).length).toBeGreaterThanOrEqual(3);
  });

  test("uses the spec's own title as the accessible name when none is passed", async () => {
    const spec = { ...(await loadExampleSpec()), title: "From spec" };
    const svg = await renderPlotToSvg(spec, { specDir: EXAMPLE_DIR });
    expect(svg).toContain('aria-label="From spec"');
    expect(svg).toContain("<title>From spec</title>");
  });

  test("attaches a <desc> from the spec's description", async () => {
    const spec = { ...(await loadExampleSpec()), description: "Alt text for the plot" };
    const svg = await renderPlotToSvg(spec, {
      specDir: EXAMPLE_DIR,
      accessibleName: "Named",
    });
    expect(svg).toContain("<desc>Alt text for the plot</desc>");
  });
});

describe("renderPlotToSvg — failure modes", () => {
  test("fails loudly when data.url points at a missing sibling file", async () => {
    const spec = { ...(await loadExampleSpec()), data: { url: "does-not-exist.csv" } };
    await expect(
      renderPlotToSvg(spec, { specDir: EXAMPLE_DIR, accessibleName: "x" }),
    ).rejects.toThrow(/does-not-exist\.csv|ENOENT/);
  });

  test("refuses a data.url that would escape the spec directory", async () => {
    // Sanity-check the sandbox before we exercise it against a real
    // secret path a local host might have.
    const spec = { ...(await loadExampleSpec()), data: { url: "../../../etc/passwd" } };
    await expect(
      renderPlotToSvg(spec, { specDir: EXAMPLE_DIR, accessibleName: "x" }),
    ).rejects.toThrow(/non-sibling data url/);
  });

  test("refuses an http:// data.url", async () => {
    const spec = { ...(await loadExampleSpec()), data: { url: "http://example.com/x.csv" } };
    await expect(
      renderPlotToSvg(spec, { specDir: EXAMPLE_DIR, accessibleName: "x" }),
    ).rejects.toThrow(/non-sibling data url/);
  });

  test("refuses an absolute data.url", async () => {
    const spec = { ...(await loadExampleSpec()), data: { url: "/etc/passwd" } };
    await expect(
      renderPlotToSvg(spec, { specDir: EXAMPLE_DIR, accessibleName: "x" }),
    ).rejects.toThrow(/non-sibling data url/);
  });

  test("throws with Vega-Lite's own error when a spec is structurally invalid", async () => {
    // A bar spec that references an unknown field trips Vega-Lite's
    // grammar checker before the file loader ever runs.
    const spec = {
      schemaVersion: 1,
      data: { url: "data.csv" },
      // `mark` and `encoding` both missing on purpose.
    };
    await expect(
      renderPlotToSvg(spec, { specDir: EXAMPLE_DIR, accessibleName: "x" }),
    ).rejects.toThrow();
  });

  test("refuses a symlinked data file that resolves outside the spec dir", async () => {
    // A symlink whose target sits above the spec directory would pass a
    // naive `resolve()` prefix check (resolve doesn't follow links). The
    // loader `lstat`s the candidate first and refuses if it is a link,
    // so a plot cannot exfiltrate `/etc/hostname` or similar.
    const specDir = await mkdtemp(join(tmpdir(), "revkit-plot-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "revkit-plot-outside-"));
    try {
      const secret = join(outside, "secret.csv");
      await writeFile(secret, "a,b\n99,99\n");
      await symlink(secret, join(specDir, "data.csv"));
      const spec = {
        schemaVersion: 1,
        data: { url: "data.csv", format: { type: "csv" } },
        mark: "bar",
        encoding: {
          x: { field: "a", type: "nominal" },
          y: { field: "b", type: "quantitative" },
        },
      };
      await expect(
        renderPlotToSvg(spec, { specDir, accessibleName: "x" }),
      ).rejects.toThrow(/symlinked data file/);
    } finally {
      await rm(specDir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("reads a sibling file inside a subdirectory of the spec dir", async () => {
    // A plot spec is allowed to group its data files (data/x.csv) — the
    // schema's `isSiblingFilename` permits subdirectories. Verify the
    // loader lets them through as long as they stay inside specDir.
    const tempDir = await mkdtemp(join(tmpdir(), "revkit-plot-"));
    try {
      const dataDir = join(tempDir, "data");
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, "x.csv"), "a,b\n1,2\n");
      const spec = {
        schemaVersion: 1,
        data: { url: "data/x.csv", format: { type: "csv" } },
        mark: "bar",
        encoding: {
          x: { field: "a", type: "nominal" },
          y: { field: "b", type: "quantitative" },
        },
      };
      const svg = await renderPlotToSvg(spec, {
        specDir: tempDir,
        accessibleName: "subdir",
      });
      expect(svg).toContain("<svg");
      // The x-axis label for the single row should be '1' — a rendered
      // plot has it, an empty scenegraph does not.
      expect(textNodes(svg)).toContain("1");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("sanitizeSvg (DOM-based, allowlist)", () => {
  const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg">';

  test("removes <script> elements anywhere in the tree", () => {
    const dirty = `${SVG_OPEN}<g><script>alert(1)</script><rect/></g></svg>`;
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain("<script");
    expect(clean).toContain("<rect");
  });

  test("removes inline event handlers on any element", () => {
    const dirty = `${SVG_OPEN}<rect onclick="a" onload="b" onmouseover="c"/></svg>`;
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toMatch(/\bon[a-z]+\s*=/i);
  });

  test("strips javascript: URLs on href and xlink:href", () => {
    // <a> is not in the allowlist, so the whole element goes — its text
    // children go with it. This test guards the property "javascript:
    // never survives", not the exact tree shape.
    const dirty = `${SVG_OPEN}<a xlink:href="javascript:alert(1)"><text>x</text></a></svg>`;
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain("javascript:");
  });

  test("removes <a> entirely (not in the element allowlist)", () => {
    // <a> is a link, and revkit plots are static figures (ADR-0004); an
    // element allowlist is stricter than the previous denylist — <a>
    // drops even with an innocent same-page href.
    const dirty = `${SVG_OPEN}<a href="#ok"><text>x</text></a></svg>`;
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain("<a");
    expect(clean).not.toContain("href=");
  });

  test("removes <foreignObject>, <iframe>, <object>, <embed>", () => {
    const dirty =
      `${SVG_OPEN}<foreignObject><div>x</div></foreignObject>` +
      `<iframe src="x"></iframe><object></object><embed></embed>` +
      `<rect/></svg>`;
    const clean = sanitizeSvg(dirty);
    for (const forbidden of ["<foreignObject", "<iframe", "<object", "<embed"]) {
      expect(clean.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(clean).toContain("<rect");
  });

  test("removes SMIL animation elements (<set>, <animate>, <animateTransform>, <animateMotion>)", () => {
    // A previous denylist sanitiser missed these — `<set attributeName=
    // "href" to="javascript:alert(1)"/>` would let SMIL flip an attribute
    // at animation time. The allowlist drops every animation element
    // outright.
    const dirty =
      `${SVG_OPEN}<rect><set attributeName="href" to="javascript:alert(1)"/>` +
      `<animate attributeName="fill" values="red;blue"/>` +
      `<animateTransform attributeName="transform" from="0" to="1"/>` +
      `<animateMotion path="M0,0 L1,1"/></rect></svg>`;
    const clean = sanitizeSvg(dirty);
    for (const forbidden of ["<set", "<animate", "<animatetransform", "<animatemotion"]) {
      expect(clean.toLowerCase()).not.toContain(forbidden);
    }
    // The parent <rect> and no forbidden children remain.
    expect(clean).toContain("<rect");
  });

  test("strips url(https://…) inside presentation attributes, keeps url(#fragment)", () => {
    // Regression guard against the reviewer's finding: `fill="url
    // (https://evil)"` survived the old denylist because the element
    // was benign and neither `on*` nor `href` fired the strip rule. The
    // sanitiser rewrites url(...) values inside presentation attributes,
    // keeping only same-document fragments.
    const dirty =
      `${SVG_OPEN}<rect fill="url('https://evil.example/img.png')" stroke="url(https://evil2.example)"/>` +
      `<circle fill="url(#patternA)" stroke="url(#gradient1)"/></svg>`;
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain("evil.example");
    expect(clean).not.toContain("evil2.example");
    expect(clean).toContain("url(#patternA)");
    expect(clean).toContain("url(#gradient1)");
  });

  test("drops the style attribute entirely (CSS is wider than presentation attrs)", () => {
    // The `style` attribute is not on the allowlist because CSS can
    // smuggle outbound references our url(…) regex would miss — see
    // the two bypasses below. A regression that re-allowed `style`
    // would trip this test even before those bypasses land.
    const dirty = `${SVG_OPEN}<rect x="5" y="10" style="fill:red;stroke:blue"/></svg>`;
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain("style=");
    expect(clean).not.toContain("fill:red");
    // Legitimate presentation still survives.
    expect(clean).toContain('x="5"');
  });

  test("style=\"background-image:image-set('https://evil…' 1x)\" never survives", () => {
    // CSS `image-set()` fetches its argument at read time — the same
    // outbound problem as `url(https://…)`, but the argument is not
    // wrapped in `url(…)`, so the url-rewrite regex wouldn't strip it
    // even if `style` were kept. Dropping `style` outright is what
    // makes this shape inert.
    const dirty =
      `${SVG_OPEN}<rect style="background-image:image-set('https://evil.example/a.png' 1x)"/></svg>`;
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain("evil.example");
    expect(clean).not.toContain("image-set");
    expect(clean).not.toContain("style=");
  });

  test("style with CSS-escape sequences (fill:u\\72l(https://evil/y)) never survives", () => {
    // CSS lets \72 stand in for `r`, so `u\72l(…)` is a valid `url()`
    // call at parse time. A regex that only matches the literal text
    // `url(…)` would miss it — but since `style` is dropped, the
    // whole attribute never reaches the browser to be un-escaped.
    const dirty = String.raw`${SVG_OPEN}<rect style="fill:u\72l(https://evil.example/y)"/></svg>`;
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain("evil.example");
    // The escaped `u\72l` fragment itself must also be gone.
    expect(clean).not.toMatch(/u\\?72l/);
    expect(clean).not.toContain("style=");
  });

  test("removes attributes not in the allowlist while keeping legitimate presentation", () => {
    // `data-*` / arbitrary custom attributes are stripped — an
    // allowlist has no way to know they are safe, and Vega's SVG
    // renderer does not emit them.
    const dirty = `${SVG_OPEN}<rect x="5" y="10" width="20" height="30" fill="#abc" data-tracker="pixel" ping="https://evil"/></svg>`;
    const clean = sanitizeSvg(dirty);
    expect(clean).toContain('x="5"');
    expect(clean).toContain('fill="#abc"');
    expect(clean).not.toContain("data-tracker");
    expect(clean).not.toContain("ping=");
  });

  test("survives the nested <scr<script>ipt> shape (CodeQL js/incomplete-multi-character-sanitization)", () => {
    const dirty = `${SVG_OPEN}<g>scr<script>alert(1)</script>ipt</g></svg>`;
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain("<script");
    expect(clean).not.toContain("</script");
  });

  test("survives an unquoted onload handler", () => {
    const dirty = `${SVG_OPEN}<rect onload=alert(1) x="5"/></svg>`;
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toMatch(/\bonload\b/i);
    expect(clean).toContain('x="5"');
  });

  test("throws when handed something that is not an SVG root", () => {
    expect(() => sanitizeSvg('<div>hi</div>')).toThrow(/expected an <svg> root/i);
  });
});
