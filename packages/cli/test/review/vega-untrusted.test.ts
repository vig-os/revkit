// Untrusted vega-lite allowlist walker (PR #48 round-3 blocker 2).
//
// The old denylist missed several vega expression carriers
// (`filter`, `test`, `param`, `labelExpr`, `datum.<x>` string
// predicates, and every future `…Expr` addition). This suite
// exercises each vector against the SHIPPING `checkVegaUntrusted`.
// Every case in `refusalVectors` is RED against a denylist-only
// walker (the reviewer's reproduction) — it flips green only when
// the walker allowlists structure and refuses expression strings.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkVegaUntrusted, MAX_DATA_FILE_BYTES, MAX_INLINE_DATA_ROWS } from "../../src/rules/vega-untrusted.ts";

function writeSpec(spec: unknown): { specPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "vega-untrusted-"));
  const abs = join(dir, "spec.vl.json");
  writeFileSync(abs, JSON.stringify(spec));
  // A stub sibling data file so `data.url` size checks don't miss.
  writeFileSync(join(dir, "data.json"), "[]");
  return {
    specPath: abs,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("checkVegaUntrusted — refusal vectors from the reviewer", () => {
  const cases: Array<{ name: string; spec: unknown; needle: string }> = [
    {
      name: "transform.filter (the reviewer's `sequence(0,3e7)` DoS shape)",
      spec: {
        data: { url: "data.json" },
        mark: "bar",
        transform: [{ filter: "sequence(0, 30000000)" }],
        encoding: { x: { field: "a", type: "quantitative" } },
      },
      needle: "'filter'",
    },
    {
      name: "transform.calculate",
      spec: {
        data: { url: "data.json" },
        mark: "bar",
        transform: [{ calculate: "1+1", as: "x" }],
        encoding: {},
      },
      needle: "'calculate'",
    },
    {
      name: "transform.regression",
      spec: {
        data: { url: "data.json" },
        mark: "line",
        transform: [{ regression: "y", on: "x" }],
        encoding: {},
      },
      needle: "'regression'",
    },
    {
      name: "transform.loess",
      spec: {
        data: { url: "data.json" },
        mark: "line",
        transform: [{ loess: "y", on: "x" }],
        encoding: {},
      },
      needle: "'loess'",
    },
    {
      name: "transform.density",
      spec: {
        data: { url: "data.json" },
        mark: "line",
        transform: [{ density: "y" }],
        encoding: {},
      },
      needle: "'density'",
    },
    {
      name: "transform.quantile",
      spec: {
        data: { url: "data.json" },
        mark: "line",
        transform: [{ quantile: "y" }],
        encoding: {},
      },
      needle: "'quantile'",
    },
    {
      name: "transform.sample",
      spec: {
        data: { url: "data.json" },
        mark: "line",
        transform: [{ sample: 100 }],
        encoding: {},
      },
      needle: "'sample'",
    },
    {
      name: "params/selections",
      spec: {
        data: { url: "data.json" },
        mark: "bar",
        params: [{ name: "p", expr: "utcnow()" }],
        encoding: {},
      },
      needle: "'params'",
    },
    {
      name: "axis.labelExpr (any …Expr key)",
      spec: {
        data: { url: "data.json" },
        mark: "bar",
        encoding: {
          x: {
            field: "a",
            type: "quantitative",
            axis: { labelExpr: "'x=' + datum.value" },
          },
        },
      },
      needle: "labelExpr",
    },
    {
      name: "axis.tooltipExpr",
      spec: {
        data: { url: "data.json" },
        mark: "bar",
        encoding: {
          x: { field: "a", type: "quantitative", axis: { tooltipExpr: "1" } },
        },
      },
      needle: "tooltipExpr",
    },
    {
      name: "encoding.condition with test/param",
      spec: {
        data: { url: "data.json" },
        mark: "point",
        encoding: {
          color: {
            condition: { test: "datum.a > 0", value: "red" },
            value: "grey",
          },
        },
      },
      needle: "condition",
    },
    {
      name: "string-predicate that starts with datum.",
      spec: {
        data: { url: "data.json" },
        mark: "bar",
        encoding: {
          x: {
            field: "a",
            type: "quantitative",
            axis: { title: "datum.value" },
          },
        },
      },
      needle: "vega expression",
    },
    {
      name: "sort with an expression-shaped string",
      spec: {
        data: { url: "data.json" },
        mark: "bar",
        encoding: {
          x: {
            field: "a",
            type: "quantitative",
            sort: "datum.a",
          },
        },
      },
      needle: "vega expression",
    },
    {
      name: "unknown top-level key (default-deny)",
      spec: {
        data: { url: "data.json" },
        mark: "bar",
        newFutureKey: { anything: "x" },
        encoding: {},
      },
      needle: "unknown top-level key 'newFutureKey'",
    },
    {
      name: "unknown encoding channel",
      spec: {
        data: { url: "data.json" },
        mark: "bar",
        encoding: { madeUpChannel: { field: "a", type: "quantitative" } },
      },
      needle: "unknown encoding channel 'madeUpChannel'",
    },
    {
      name: "unknown channel-def key (labelExprAlt)",
      spec: {
        data: { url: "data.json" },
        mark: "bar",
        encoding: {
          x: { field: "a", type: "quantitative", labelExprAlt: "1" },
        },
      },
      needle: "labelExprAlt",
    },
  ];

  test.each(cases)("refuses $name", ({ spec, needle }) => {
    const { specPath, cleanup } = writeSpec(spec);
    try {
      const diags = checkVegaUntrusted(specPath, "plots/x/spec.vl.json");
      expect(diags.length).toBeGreaterThan(0);
      expect(diags.some((d) => d.message.includes(needle))).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("checkVegaUntrusted — accepts a minimal static chart", () => {
  test("bar chart with encoding + sibling data url — no findings", () => {
    const { specPath, cleanup } = writeSpec({
      $schema: "https://vega.github.io/schema/vega-lite/v5.json",
      description: "a static chart",
      data: { url: "data.json" },
      mark: "bar",
      encoding: {
        x: { field: "a", type: "quantitative", axis: { title: "A" } },
        y: {
          field: "b",
          type: "quantitative",
          scale: { type: "linear", zero: true },
        },
      },
    });
    try {
      const diags = checkVegaUntrusted(specPath, "plots/x/spec.vl.json");
      expect(diags).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("mark object with primitive fields, no expressions", () => {
    const { specPath, cleanup } = writeSpec({
      data: { url: "data.json" },
      mark: { type: "point", filled: true, size: 40, color: "steelblue" },
      encoding: { x: { field: "a", type: "quantitative" } },
    });
    try {
      const diags = checkVegaUntrusted(specPath, "plots/x/spec.vl.json");
      expect(diags).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("checkVegaUntrusted — data caps", () => {
  test("inline data.values above MAX_INLINE_DATA_ROWS refused", () => {
    const values = Array.from({ length: MAX_INLINE_DATA_ROWS + 1 }, (_, i) => ({ a: i }));
    const { specPath, cleanup } = writeSpec({
      data: { values },
      mark: "bar",
      encoding: { x: { field: "a", type: "quantitative" } },
    });
    try {
      const diags = checkVegaUntrusted(specPath, "plots/x/spec.vl.json");
      expect(diags.some((d) => d.message.includes(`(cap ${MAX_INLINE_DATA_ROWS})`))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("data.url pointing at a too-large sibling file refused", () => {
    // Build a sibling file bigger than the cap and reference it.
    const dir = mkdtempSync(join(tmpdir(), "vega-untrusted-big-"));
    try {
      writeFileSync(join(dir, "big.json"), "x".repeat(MAX_DATA_FILE_BYTES + 1));
      const spec = { data: { url: "big.json" }, mark: "bar", encoding: {} };
      const specPath = join(dir, "spec.vl.json");
      writeFileSync(specPath, JSON.stringify(spec));
      const diags = checkVegaUntrusted(specPath, "plots/x/spec.vl.json");
      expect(diags.some((d) => d.message.includes("cap"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
