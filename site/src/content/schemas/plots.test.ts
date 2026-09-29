// Tests for the plot spec schema (`plots/<name>/spec.vl.json`, ADR-0004,
// C4). Rendering to SVG is M1 item 3; this file guards the "spec-plus-side-
// data" contract — inline `data.values` must fail at any depth, `data.url`
// must be a bare sibling filename (no scheme, no `/`, no `..`), and
// Vega-Lite grammar keys such as `format` are allowed to pass through.
import { describe, expect, test } from "bun:test";
import { isSiblingFilename, plotSpecSchema } from "./plots.ts";
import { CURRENT_SCHEMA_VERSION } from "./shared.ts";

const validSpec = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  $schema: "https://vega.github.io/schema/vega-lite/v5.json",
  data: { url: "data.csv" },
  mark: "bar",
  encoding: { x: { field: "a", type: "nominal" }, y: { field: "b", type: "quantitative" } },
};

describe("plotSpecSchema — happy paths", () => {
  test("accepts a spec whose data is a sibling file url", () => {
    expect(plotSpecSchema.safeParse(validSpec).success).toBe(true);
  });

  test("accepts data.format alongside data.url (the CSV format hint case)", () => {
    const withFormat = {
      ...validSpec,
      data: { url: "data.csv", format: { type: "csv" } },
    };
    expect(plotSpecSchema.safeParse(withFormat).success).toBe(true);
  });

  test("accepts a nested data.url in a layered spec", () => {
    const layered = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      data: { url: "base.csv" },
      layer: [{ data: { url: "overlay.csv" }, mark: "line" }, { mark: "point" }],
    };
    expect(plotSpecSchema.safeParse(layered).success).toBe(true);
  });

  test("preserves unknown Vega-Lite fields so the full grammar remains usable", () => {
    const rich = { ...validSpec, transform: [{ filter: "datum.b > 0" }] };
    const result = plotSpecSchema.safeParse(rich);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as { transform?: unknown }).transform).toEqual([{ filter: "datum.b > 0" }]);
  });
});

describe("plotSpecSchema — rejections", () => {
  test("rejects top-level inline data (a `values` array on the data block)", () => {
    const inline = { ...validSpec, data: { values: [{ a: "x", b: 1 }] } };
    const result = plotSpecSchema.safeParse(inline);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some((issue) =>
        JSON.stringify(issue.path).includes('"data"') && JSON.stringify(issue.path).includes('"values"'),
      ),
    ).toBe(true);
  });

  test("rejects inline data nested inside a layer[]", () => {
    const layered = {
      ...validSpec,
      layer: [{ data: { values: [{ a: 1 }] }, mark: "line" }],
    };
    const result = plotSpecSchema.safeParse(layered);
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((issue) => issue.path.join("/"));
    expect(paths.some((path) => path.includes("layer/0/data/values"))).toBe(true);
  });

  test("rejects inline data nested inside concat / hconcat / vconcat", () => {
    for (const key of ["concat", "hconcat", "vconcat"]) {
      const spec: Record<string, unknown> = {
        ...validSpec,
        [key]: [{ data: { values: [{ x: 1 }] }, mark: "point" }],
      };
      const result = plotSpecSchema.safeParse(spec);
      expect(result.success).toBe(false);
    }
  });

  test("rejects inline data nested inside a transform lookup's from.data", () => {
    const spec = {
      ...validSpec,
      transform: [{ lookup: "a", from: { data: { values: [{ a: 1, other: 2 }] }, key: "a" } }],
    };
    const result = plotSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
  });

  test("rejects Vega-Lite's `datasets` escape hatch, even when data.url is a sibling", () => {
    // A top-level `datasets` field maps names to inline data arrays, then
    // a `data` block with `name` references one of them. A schema that
    // only guards `data.values` would let this pass — the review flagged
    // it as the last hole in the plot guard.
    const spec = {
      ...validSpec,
      datasets: { table: [{ a: "x", b: 1 }] },
      data: { name: "table" },
    };
    const result = plotSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
    if (result.success) return;
    const message = JSON.stringify(result.error.issues);
    expect(message).toContain("datasets");
  });

  test("rejects a `datasets` block nested inside a spec sub-tree, too", () => {
    const spec = {
      ...validSpec,
      concat: [{ datasets: { t: [{ a: 1 }] }, data: { name: "t" } }],
    };
    const result = plotSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
  });

  test("rejects a remote https url on data.url", () => {
    const remote = { ...validSpec, data: { url: "https://example.com/data.csv" } };
    const result = plotSpecSchema.safeParse(remote);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(JSON.stringify(result.error.issues)).toContain("data.url");
  });

  test("rejects an absolute path or a parent-directory traversal", () => {
    expect(plotSpecSchema.safeParse({ ...validSpec, data: { url: "/tmp/data.csv" } }).success).toBe(false);
    expect(plotSpecSchema.safeParse({ ...validSpec, data: { url: "../shared/data.csv" } }).success).toBe(false);
  });

  test("rejects a spec missing schemaVersion", () => {
    const missing = { ...validSpec } as Record<string, unknown>;
    delete missing.schemaVersion;
    const result = plotSpecSchema.safeParse(missing);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(JSON.stringify(result.error.issues)).toContain("plots/<name>/spec.vl.json");
  });

  test("rejects a spec missing the top-level data block", () => {
    const missing = { ...validSpec } as Record<string, unknown>;
    delete missing.data;
    const result = plotSpecSchema.safeParse(missing);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(JSON.stringify(result.error.issues)).toContain("data");
  });
});

describe("plotSpecSchema — link and image mark rejections", () => {
  test("rejects the top-level `href` encoding channel", () => {
    const withHref = {
      ...validSpec,
      encoding: { ...validSpec.encoding, href: { field: "u", type: "nominal" } },
    };
    const result = plotSpecSchema.safeParse(withHref);
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((issue) => issue.path.join("/"));
    expect(paths.some((path) => path === "encoding/href")).toBe(true);
  });

  test("rejects an `href` encoding channel nested inside a layer[]", () => {
    const layered = {
      ...validSpec,
      layer: [
        {
          mark: "point",
          encoding: { href: { field: "u", type: "nominal" } },
        },
      ],
    };
    const result = plotSpecSchema.safeParse(layered);
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((issue) => issue.path.join("/"));
    expect(paths.some((path) => path.endsWith("encoding/href"))).toBe(true);
  });

  test("rejects `mark: \"image\"` as a string shorthand", () => {
    const image = { ...validSpec, mark: "image" };
    const result = plotSpecSchema.safeParse(image);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(JSON.stringify(result.error.issues)).toContain("'image' mark is forbidden");
  });

  test("rejects `mark: { type: \"image\", url: … }` as an object", () => {
    const image = {
      ...validSpec,
      mark: { type: "image", url: "https://example.com/x.png" },
    };
    const result = plotSpecSchema.safeParse(image);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(JSON.stringify(result.error.issues)).toContain("'image' mark is forbidden");
  });

  test("rejects an image mark nested inside a concat block", () => {
    const nested = {
      ...validSpec,
      hconcat: [{ mark: "image" }, { mark: "point" }],
    };
    const result = plotSpecSchema.safeParse(nested);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(JSON.stringify(result.error.issues)).toContain("'image' mark is forbidden");
  });
});

describe("isSiblingFilename", () => {
  test("accepts bare filenames and subdirectory-relative paths", () => {
    expect(isSiblingFilename("data.csv")).toBe(true);
    expect(isSiblingFilename("nested/data.csv")).toBe(true);
    expect(isSiblingFilename("nested/deeper/x.json")).toBe(true);
  });

  test("rejects absolute paths, URL schemes and parent traversal", () => {
    expect(isSiblingFilename("")).toBe(false);
    expect(isSiblingFilename("/abs.csv")).toBe(false);
    expect(isSiblingFilename("http://example.com/x.csv")).toBe(false);
    expect(isSiblingFilename("data:text/csv,a")).toBe(false);
    expect(isSiblingFilename("../sibling.csv")).toBe(false);
    expect(isSiblingFilename("a/../b.csv")).toBe(false);
  });
});
