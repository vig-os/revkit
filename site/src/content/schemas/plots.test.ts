// Tests for the plot spec schema (`plots/<name>/spec.vl.json`, ADR-0004,
// C4). Rendering to SVG is M1 item 3; this file guards the "spec-plus-side-
// data" contract — inline `data.values` must fail, `data.url` must be a
// sibling file reference, and `schemaVersion` is required.
import { describe, expect, test } from "bun:test";
import { plotSpecSchema } from "./plots.ts";
import { CURRENT_SCHEMA_VERSION } from "./shared.ts";

const validSpec = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  $schema: "https://vega.github.io/schema/vega-lite/v5.json",
  data: { url: "data.csv" },
  mark: "bar",
  encoding: { x: { field: "a", type: "nominal" }, y: { field: "b", type: "quantitative" } },
};

describe("plotSpecSchema", () => {
  test("accepts a spec whose data is a sibling file url", () => {
    expect(plotSpecSchema.safeParse(validSpec).success).toBe(true);
  });

  test("rejects inline data (a `values` array on the data block)", () => {
    const inline = { ...validSpec, data: { values: [{ a: "x", b: 1 }] } };
    const result = plotSpecSchema.safeParse(inline);
    expect(result.success).toBe(false);
    if (result.success) return;
    // The union rejection points at `data` — the exact grammar rule the plot
    // guard (C4) enforces.
    expect(result.error.issues.some((issue) => issue.path.includes("data"))).toBe(true);
  });

  test("rejects a spec missing schemaVersion", () => {
    const missing = { ...validSpec } as Record<string, unknown>;
    delete missing.schemaVersion;
    const result = plotSpecSchema.safeParse(missing);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(JSON.stringify(result.error.issues)).toContain("plots/<name>/spec.vl.json");
  });

  test("preserves unknown Vega-Lite fields so the full grammar remains usable", () => {
    const rich = { ...validSpec, transform: [{ filter: "datum.b > 0" }] };
    const result = plotSpecSchema.safeParse(rich);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as { transform?: unknown }).transform).toEqual([{ filter: "datum.b > 0" }]);
  });
});
