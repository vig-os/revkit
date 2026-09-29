// Link rule tests (C3, ADR-0005). Uses a temp-dir fixture so filesystem
// resolution is real; heading-slug logic gets its own pure-function
// test.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLinksFile, headingSlug } from "../src/rules/links.ts";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "revkit-links-"));
}

describe("headingSlug", () => {
  test("lowercases and hyphenates", () => {
    expect(headingSlug("Hello World")).toBe("hello-world");
  });

  test("strips punctuation but keeps hyphens", () => {
    expect(headingSlug("Section 3.1 — Guards!")).toBe("section-31-guards");
  });
});

describe("links", () => {
  test("relative link to an existing sibling passes", async () => {
    const dir = makeTempDir();
    await mkdir(dir, { recursive: true });
    writeFileSync(join(dir, "a.md"), "# A\n\n[b](./b.md)\n");
    writeFileSync(join(dir, "b.md"), "# B\n");
    const source = "# A\n\n[b](./b.md)\n";
    expect(checkLinksFile(source, join(dir, "a.md"), "a.md")).toEqual([]);
  });

  test("relative link to a missing file is reported", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "a.md"), "# A\n\n[missing](./missing.md)\n");
    const source = "# A\n\n[missing](./missing.md)\n";
    const diagnostics = checkLinksFile(source, join(dir, "a.md"), "a.md");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.rule).toBe("links");
    expect(diagnostics[0]?.line).toBe(3);
    expect(diagnostics[0]?.message).toContain("broken link");
  });

  test("relative link with a valid heading anchor passes", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "target.md"), "# Title\n\n## Some Section\n\nBody\n");
    writeFileSync(join(dir, "a.md"), "[go](./target.md#some-section)\n");
    const source = "[go](./target.md#some-section)\n";
    expect(checkLinksFile(source, join(dir, "a.md"), "a.md")).toEqual([]);
  });

  test("relative link with a broken heading anchor is reported", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "target.md"), "# Title\n\n## Real\n");
    writeFileSync(join(dir, "a.md"), "[go](./target.md#missing-section)\n");
    const source = "[go](./target.md#missing-section)\n";
    const diagnostics = checkLinksFile(source, join(dir, "a.md"), "a.md");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("broken link anchor");
    expect(diagnostics[0]?.message).toContain("missing-section");
  });

  test("absolute URL is not checked as a file link", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "a.md"), "[gh](https://github.com/vig-os/revkit)\n");
    const source = "[gh](https://github.com/vig-os/revkit)\n";
    expect(checkLinksFile(source, join(dir, "a.md"), "a.md")).toEqual([]);
  });

  test("site-absolute route (`/foo/bar/`) is not checked as a file path", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "a.md"), "[route](/foo/bar/)\n");
    const source = "[route](/foo/bar/)\n";
    // Starlight routes are validated at build time by
    // starlight-links-validator (DESIGN-0001 §2); this rule owns
    // relative-path resolution only.
    expect(checkLinksFile(source, join(dir, "a.md"), "a.md")).toEqual([]);
  });

  test("same-page fragment (`#anchor`) is not resolved as a file", async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "a.md"), "# Top\n\n## Sub\n\n[jump](#sub)\n");
    const source = "# Top\n\n## Sub\n\n[jump](#sub)\n";
    // Same-page anchors are out of scope here (this rule owns file-level
    // resolution) — the check should not fabricate diagnostics.
    expect(checkLinksFile(source, join(dir, "a.md"), "a.md")).toEqual([]);
  });
});
