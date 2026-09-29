// Tests for the plots loader (ADR-0004, C4). The schema is a structural
// pass; this file exercises the filesystem-dependent half — every
// `data.url` in a spec must resolve to a real sibling file, at any nesting
// depth.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { assertSiblingFiles, collectDataUrls } from "./plots.ts";

const PLOT_FIXTURE_DIR = fileURLToPath(new URL("../../../tests/fixtures/plots/", import.meta.url));
const specAbsolute = `${PLOT_FIXTURE_DIR}example/spec.vl.json`;

async function loadSpec(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(specAbsolute, "utf8")) as Record<string, unknown>;
}

describe("plots loader — assertSiblingFiles", () => {
  test("passes when every data.url resolves to a file next to the spec", async () => {
    const spec = await loadSpec();
    // projectRoot doesn't matter for an absolute filePath — the loader
    // uses it only to resolve relative ones (glob loader shape).
    await expect(
      assertSiblingFiles({ filePath: specAbsolute, data: spec }, "/nonexistent"),
    ).resolves.toBeUndefined();
  });

  test("fails with a message that names the spec when data.url is missing on disk", async () => {
    const spec = await loadSpec();
    const withMissingUrl = { ...spec, data: { url: "does-not-exist.csv" } };
    await expect(
      assertSiblingFiles({ filePath: specAbsolute, data: withMissingUrl }, "/nonexistent"),
    ).rejects.toThrow(/does-not-exist\.csv/);
  });

  test("fails when a nested (layered) data.url is missing on disk", async () => {
    const spec = await loadSpec();
    const withNestedMissing = {
      ...spec,
      layer: [{ data: { url: "no-such-overlay.csv" }, mark: "line" }],
    };
    await expect(
      assertSiblingFiles({ filePath: specAbsolute, data: withNestedMissing }, "/nonexistent"),
    ).rejects.toThrow(/no-such-overlay\.csv/);
  });

  test("resolves a relative filePath against the injected project root", async () => {
    // Mimic Astro's glob output: filePath is relative to the project root.
    // For a project root at PLOT_FIXTURE_DIR, the relative spec path is
    // `example/spec.vl.json`.
    const spec = await loadSpec();
    await expect(
      assertSiblingFiles({ filePath: "example/spec.vl.json", data: spec }, PLOT_FIXTURE_DIR),
    ).resolves.toBeUndefined();
  });
});

describe("plots loader — collectDataUrls (shared with the schema walker)", () => {
  test("collects the top-level data.url", () => {
    const urls = collectDataUrls({ data: { url: "a.csv" } });
    expect(urls).toEqual(["a.csv"]);
  });

  test("collects urls from every nested data block", () => {
    const urls = collectDataUrls({
      data: { url: "top.csv" },
      layer: [{ data: { url: "layer.csv" } }, { data: { url: "layer2.csv" } }],
      concat: [{ data: { url: "concat.csv" } }],
    });
    expect(urls.sort()).toEqual(["concat.csv", "layer.csv", "layer2.csv", "top.csv"]);
  });

  test("ignores data blocks without a url (e.g. { name })", () => {
    const urls = collectDataUrls({ data: { name: "referenced-dataset" } });
    expect(urls).toEqual([]);
  });
});
