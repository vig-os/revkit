// Plot-structure rule tests (C4, ADR-0004, ADR-0005). Uses a temp-dir
// fixture per test so each spec + data file sits in isolation.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkPlotSpecFile } from "../src/rules/plot-structure.ts";

async function makePlot(specJson: unknown, dataFileName: string | null): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "revkit-plot-"));
  const plotDir = join(dir, "plots", "example");
  await mkdir(plotDir, { recursive: true });
  const specPath = join(plotDir, "spec.vl.json");
  writeFileSync(specPath, JSON.stringify(specJson));
  if (dataFileName !== null) {
    writeFileSync(join(plotDir, dataFileName), "a,b\n1,2\n");
  }
  return specPath;
}

describe("plot-structure", () => {
  test("valid spec + existing sibling data passes", async () => {
    const spec = {
      schemaVersion: 1,
      data: { url: "data.csv" },
      mark: "bar",
      encoding: {},
    };
    const specPath = await makePlot(spec, "data.csv");
    expect(checkPlotSpecFile(specPath, "plots/example/spec.vl.json")).toEqual([]);
  });

  test("missing sibling data file is reported", async () => {
    const spec = {
      schemaVersion: 1,
      data: { url: "missing.csv" },
      mark: "bar",
      encoding: {},
    };
    const specPath = await makePlot(spec, null);
    const diagnostics = checkPlotSpecFile(specPath, "plots/example/spec.vl.json");
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.rule).toBe("plot-structure");
    expect(diagnostics[0]?.message).toContain("does not exist");
  });

  test("inline data.values fails the schema check", async () => {
    const spec = {
      schemaVersion: 1,
      data: { values: [{ a: 1 }] },
      mark: "bar",
    };
    const specPath = await makePlot(spec, null);
    const diagnostics = checkPlotSpecFile(specPath, "plots/example/spec.vl.json");
    expect(diagnostics.some((d) => d.message.includes("schema"))).toBe(true);
  });

  test("symlinked data file is refused", async () => {
    const spec = {
      schemaVersion: 1,
      data: { url: "linked.csv" },
      mark: "bar",
      encoding: {},
    };
    const specPath = await makePlot(spec, "actual.csv");
    // Symlink linked.csv -> actual.csv (inside the spec dir).
    symlinkSync("actual.csv", join(dirname(specPath), "linked.csv"));
    const diagnostics = checkPlotSpecFile(specPath, "plots/example/spec.vl.json");
    expect(diagnostics.some((d) => d.message.includes("symlink"))).toBe(true);
  });

  test("wrong filename (not spec.vl.json) is reported", async () => {
    const dir = mkdtempSync(join(tmpdir(), "revkit-plot-"));
    await mkdir(join(dir, "plots", "example"), { recursive: true });
    const p = join(dir, "plots", "example", "wrong.json");
    writeFileSync(p, "{}");
    const diagnostics = checkPlotSpecFile(p, "plots/example/wrong.json");
    expect(diagnostics[0]?.message).toContain("spec.vl.json");
  });
});
