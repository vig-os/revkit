// Tests for the build-time plot renderer (ADR-0004, C4).
//
// The scope here is real Vega-Lite -> Vega -> SVG output on a fixture spec:
// the returned SVG must carry the marks a bar chart of the fixture would
// produce, expose an accessible name / description, and refuse a data
// path that walks outside the spec's own directory. Rendering that
// silently falls back to an empty scenegraph is the exact regression the
// reviewer bar-chart check catches.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { renderPlotToSvg, stripScriptsFromSvg } from "./render-plot.ts";

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
    ).rejects.toThrow(/plot loader refused to read outside/);
  });

  test("refuses an http:// data.url", async () => {
    const spec = { ...(await loadExampleSpec()), data: { url: "http://example.com/x.csv" } };
    await expect(
      renderPlotToSvg(spec, { specDir: EXAMPLE_DIR, accessibleName: "x" }),
    ).rejects.toThrow(/scheme-qualified/);
  });

  test("refuses an absolute data.url", async () => {
    const spec = { ...(await loadExampleSpec()), data: { url: "/etc/passwd" } };
    await expect(
      renderPlotToSvg(spec, { specDir: EXAMPLE_DIR, accessibleName: "x" }),
    ).rejects.toThrow(/absolute path/);
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

describe("stripScriptsFromSvg", () => {
  test("removes <script> elements", () => {
    const dirty = "<svg><script>alert(1)</script><rect/></svg>";
    expect(stripScriptsFromSvg(dirty)).toBe("<svg><rect/></svg>");
  });

  test("removes inline event handlers (onclick, onload, …)", () => {
    const dirty = '<svg><rect onclick="alert(1)" onload=\'x\'/></svg>';
    expect(stripScriptsFromSvg(dirty)).toBe("<svg><rect/></svg>");
  });

  test("removes javascript: URLs", () => {
    const dirty = '<svg><a xlink:href="javascript:alert(1)">x</a></svg>';
    expect(stripScriptsFromSvg(dirty)).not.toContain("javascript:");
  });
});
