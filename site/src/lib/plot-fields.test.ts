// Tests for the plot-field validator (ADR-0004, C4). The scope here is
// the "no silent empty plot" contract: an encoding whose `field` is not
// a column of the data file must fail the build. Runs on real CSV/JSON
// fixtures written to a temp dir so parser edge cases (quoted commas,
// JSON records) are exercised.
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { assertPlotFieldsExist, collectFieldReferences, readDataColumns } from "./plot-fields.ts";

async function makeSpecDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "revkit-plot-fields-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  return dir;
}

describe("collectFieldReferences", () => {
  test("collects every string field from encodings and transforms, sorted, deduped", () => {
    const spec = {
      data: { url: "d.csv" },
      encoding: {
        x: { field: "a", type: "nominal" },
        y: { field: "b", type: "quantitative" },
      },
      transform: [
        { calculate: "datum.a * 2", as: "double" },
        { aggregate: [{ op: "count", as: "n" }], groupby: ["a"] },
      ],
      layer: [{ encoding: { color: { field: "b", type: "nominal" } } }],
    };
    expect(collectFieldReferences(spec)).toEqual(["a", "b"]);
  });

  test("ignores the aggregate wildcard `*` and non-string field values", () => {
    const spec = {
      encoding: {
        y: { aggregate: "count", field: "*" },
        color: { field: { repeat: "layer" } },
      },
    };
    expect(collectFieldReferences(spec)).toEqual([]);
  });
});

describe("readDataColumns", () => {
  test("reads columns from a CSV file (comma-delimited, honouring quotes)", async () => {
    const dir = await makeSpecDir({
      "d.csv": 'library,"kb, gzipped",note\nSolid,4,tiny\n',
    });
    try {
      const columns = await readDataColumns(dir, "d.csv");
      expect(columns).toEqual(["library", "kb, gzipped", "note"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reads columns from a TSV file when format.type is explicit", async () => {
    const dir = await makeSpecDir({
      "d.tsv": "library\tkbGzip\nSolid\t4\n",
    });
    try {
      const columns = await readDataColumns(dir, "d.tsv", { type: "tsv" });
      expect(columns).toEqual(["library", "kbGzip"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reads columns from a JSON array of records (union of keys)", async () => {
    const dir = await makeSpecDir({
      "d.json": JSON.stringify([{ a: 1, b: 2 }, { a: 3, c: 4 }]),
    });
    try {
      const columns = await readDataColumns(dir, "d.json");
      expect(columns).toEqual(["a", "b", "c"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns null for an unknown format so the schema stays authoritative", async () => {
    const dir = await makeSpecDir({ "d.bin": "raw bytes" });
    try {
      expect(await readDataColumns(dir, "d.bin")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("assertPlotFieldsExist", () => {
  test("passes when every referenced field exists in the CSV columns", async () => {
    const dir = await makeSpecDir({
      "d.csv": "library,kbGzip\nSolid,4\n",
    });
    const spec = {
      data: { url: "d.csv", format: { type: "csv" } },
      mark: "bar",
      encoding: {
        y: { field: "library", type: "nominal" },
        x: { field: "kbGzip", type: "quantitative" },
      },
    };
    try {
      await expect(assertPlotFieldsExist(spec, dir)).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("throws when an encoding references a field that is not a column", async () => {
    const dir = await makeSpecDir({ "d.csv": "library,kbGzip\nSolid,4\n" });
    const spec = {
      data: { url: "d.csv", format: { type: "csv" } },
      mark: "bar",
      encoding: {
        x: { field: "notAColumn", type: "quantitative" },
      },
    };
    try {
      await expect(assertPlotFieldsExist(spec, dir)).rejects.toThrow(
        /notAColumn.*not.*columns of d\.csv/i,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("permits a dotted field when its first segment exists as a column", async () => {
    const dir = await makeSpecDir({ "d.json": JSON.stringify([{ meta: { name: "x" } }]) });
    const spec = {
      data: { url: "d.json" },
      mark: "point",
      encoding: {
        x: { field: "meta.name", type: "nominal" },
      },
    };
    try {
      await expect(assertPlotFieldsExist(spec, dir)).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses a symlinked data file and NEVER quotes its contents in the error", async () => {
    // Regression guard: an earlier version of readDataColumns opened the
    // file directly with fs.readFile, so `link.csv -> /etc/passwd` would
    // surface the target's first line inside the "Columns in the file:
    // […]" error message. Routing through the confined-read helper
    // means the error fires BEFORE any bytes leave the file.
    const specDir = await mkdtemp(join(tmpdir(), "revkit-fields-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "revkit-fields-outside-"));
    try {
      const secret = join(outside, "secret.csv");
      const secretContent = "SECRET_HEADER,LEAKED_ROW\nSECRET_VALUE_ONE,SECRET_VALUE_TWO\n";
      await writeFile(secret, secretContent);
      await symlink(secret, join(specDir, "link.csv"));
      const spec = {
        data: { url: "link.csv", format: { type: "csv" } },
        mark: "bar",
        encoding: { x: { field: "SECRET_HEADER", type: "nominal" } },
      };
      let caught: Error | null = null;
      try {
        await assertPlotFieldsExist(spec, specDir);
      } catch (error) {
        caught = error as Error;
      }
      expect(caught, "expected the confined loader to refuse the symlink").not.toBeNull();
      expect(caught?.message ?? "").toMatch(/symlinked data file/i);
      // The critical assertion: no bytes from the target file appear in
      // the error message. Guards against a regression that would open
      // the file BEFORE the containment check.
      for (const secretFragment of ["SECRET_HEADER", "LEAKED_ROW", "SECRET_VALUE_ONE", "SECRET_VALUE_TWO"]) {
        expect(
          caught?.message ?? "",
          `error message must not contain '${secretFragment}' from the symlink target`,
        ).not.toContain(secretFragment);
      }
    } finally {
      await rm(specDir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("skips the check when the top-level data has no url (nothing to validate against)", async () => {
    const dir = await makeSpecDir({});
    const spec = {
      data: { name: "referenced-later" },
      layer: [{ mark: "point", encoding: { x: { field: "x", type: "nominal" } } }],
    };
    try {
      await expect(assertPlotFieldsExist(spec, dir)).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
