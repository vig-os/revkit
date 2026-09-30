// Regression tests for repo-root resolution (ADR-0010, D1 one-line adoption).
//
// A consumer docs repo that adopts revkit from the flake template MUST
// be recognized as a workspace root without renaming its own package.json
// to "revkit". The "revkit" top-level key is the opt-in signal.
//
// The RED case here is the D1 acceptance test: a consumer repo whose
// package.json is named "docs-site" (or anything else) — with the
// revkit key present — must resolve. That path fails on the old code
// (which only matched `name === "revkit"`) and passes on the new one.

import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findRepoRootByPackageJson } from "../src/repo-root.ts";

const scratchDirs: string[] = [];

function scratch(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `revkit-repo-root-${prefix}-`));
  scratchDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of scratchDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe("findRepoRootByPackageJson", () => {
  test("resolves a package.json with name === 'revkit' (revkit's own repo)", () => {
    const root = scratch("name");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "revkit" }));
    mkdirSync(join(root, "docs"), { recursive: true });

    expect(findRepoRootByPackageJson(join(root, "docs"))).toBe(root);
  });

  test("resolves a consumer package.json carrying a top-level 'revkit' key (D1)", () => {
    // The consumer flake-template case. Old code refuses this because
    // the manifest's `name` is not "revkit"; the fix accepts any
    // package.json whose `revkit` key is present (any object value).
    const root = scratch("key");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "acme-docs", revkit: {} }),
    );
    mkdirSync(join(root, "docs"), { recursive: true });

    expect(findRepoRootByPackageJson(join(root, "docs"))).toBe(root);
  });

  test("accepts 'revkit: true' as an opt-in signal too", () => {
    const root = scratch("true");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "docs", revkit: true }),
    );
    expect(findRepoRootByPackageJson(root)).toBe(root);
  });

  test("REFUSES 'revkit: false' — explicit opt-out is not a root", () => {
    // Guards against a downstream node_modules manifest with a
    // meaningful-looking key from silently binding.
    const outer = scratch("false-outer");
    writeFileSync(join(outer, "package.json"), JSON.stringify({ name: "revkit" }));
    const inner = join(outer, "packages", "child");
    mkdirSync(inner, { recursive: true });
    writeFileSync(
      join(inner, "package.json"),
      JSON.stringify({ name: "child", revkit: false }),
    );

    // Walk finds the outer 'revkit' root, not the inner refuser.
    expect(findRepoRootByPackageJson(inner)).toBe(outer);
  });

  test("throws when no package.json in the walk carries either marker", () => {
    const root = scratch("nomarker");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "unrelated" }));

    expect(() => findRepoRootByPackageJson(root)).toThrow(/could not find the workspace root/);
  });

  test("skips malformed package.json and keeps walking", () => {
    const outer = scratch("malformed-outer");
    writeFileSync(join(outer, "package.json"), JSON.stringify({ revkit: {} }));
    const inner = join(outer, "app");
    mkdirSync(inner);
    writeFileSync(join(inner, "package.json"), "{ not json");

    expect(findRepoRootByPackageJson(inner)).toBe(outer);
  });
});
