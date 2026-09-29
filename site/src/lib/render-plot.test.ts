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

describe("sanitizeSvg (DOM-based, denylist)", () => {
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
    const dirty = `${SVG_OPEN}<a xlink:href="javascript:alert(1)"><text>x</text></a></svg>`;
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain("javascript:");
  });

  test("strips http(s) hrefs on <a>, leaving only same-page # fragments", () => {
    const dirty = `${SVG_OPEN}<a href="https://evil.example"><text>x</text></a><a href="#ok"><text>y</text></a></svg>`;
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain("https://evil.example");
    expect(clean).toContain('href="#ok"');
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

  test("survives the nested <scr<script>ipt> shape (CodeQL js/incomplete-multi-character-sanitization)", () => {
    // A regex sanitiser would strip the inner `<script>` and leave the
    // outer text `scr…ipt`, which combined with the leftover `<` before
    // `scr` could still parse as a script tag in HTML. A DOM parser
    // never re-tokenises its output, so the class of attack is defeated
    // structurally.
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
