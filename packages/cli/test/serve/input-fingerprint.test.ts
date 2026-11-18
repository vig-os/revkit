// `computeInputFingerprint` — the cheap deterministic hash the
// MCP side compares against to decide whether a recorded start
// failure is stale (#251 round 3 BLOCKER 2).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeInputFingerprint } from "../../src/serve/input-fingerprint.ts";

describe("computeInputFingerprint", () => {
  let repoRoot: string;
  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "revkit-fp-"));
  });
  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("an empty workspace hashes to a stable value", () => {
    const a = computeInputFingerprint(repoRoot);
    const b = computeInputFingerprint(repoRoot);
    expect(a).toBeDefined();
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  test("adding a docs/ file changes the fingerprint", () => {
    const before = computeInputFingerprint(repoRoot);
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
    writeFileSync(join(repoRoot, "docs", "a.md"), "# hi\n");
    const after = computeInputFingerprint(repoRoot);
    expect(after).not.toBe(before);
  });

  test("editing a docs/ file content changes the fingerprint (via mtime+size)", () => {
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
    writeFileSync(join(repoRoot, "docs", "a.md"), "# hi\n");
    const before = computeInputFingerprint(repoRoot);
    // Tweak mtime by one second and append a byte so both size
    // AND mtime change.
    writeFileSync(join(repoRoot, "docs", "a.md"), "# hi 2\n");
    const now = new Date();
    utimesSync(join(repoRoot, "docs", "a.md"), now, new Date(now.getTime() + 1000));
    const after = computeInputFingerprint(repoRoot);
    expect(after).not.toBe(before);
  });

  test("renaming a file changes the fingerprint", () => {
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
    writeFileSync(join(repoRoot, "docs", "a.md"), "x");
    const before = computeInputFingerprint(repoRoot);
    writeFileSync(join(repoRoot, "docs", "b.md"), "x");
    rmSync(join(repoRoot, "docs", "a.md"));
    const after = computeInputFingerprint(repoRoot);
    expect(after).not.toBe(before);
  });

  test("changes under vocab/ and plots/ also change the fingerprint", () => {
    const base = computeInputFingerprint(repoRoot);
    mkdirSync(join(repoRoot, "vocab"), { recursive: true });
    writeFileSync(join(repoRoot, "vocab", "terms.yaml"), "schemaVersion: 1\n");
    const withVocab = computeInputFingerprint(repoRoot);
    expect(withVocab).not.toBe(base);
    mkdirSync(join(repoRoot, "plots", "p"), { recursive: true });
    writeFileSync(join(repoRoot, "plots", "p", "spec.vl.json"), "{}");
    const withPlots = computeInputFingerprint(repoRoot);
    expect(withPlots).not.toBe(withVocab);
  });

  test("a change to the consumer's package.json flips the fingerprint", () => {
    writeFileSync(join(repoRoot, "package.json"), "{}");
    const before = computeInputFingerprint(repoRoot);
    writeFileSync(join(repoRoot, "package.json"), '{"name":"x"}');
    const after = computeInputFingerprint(repoRoot);
    expect(after).not.toBe(before);
  });

  test("a missing repoRoot returns undefined", () => {
    const bogus = join(repoRoot, "no-such-dir");
    expect(computeInputFingerprint(bogus)).toBeUndefined();
  });
});
