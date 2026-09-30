// Tests for the anchor schema (ADR-0006 dual anchor). Focused on the
// boundary cases the store and the M3 GitHub adapter (ADR-0025) both
// depend on: revision shape, endLine >= startLine, and — new in this
// round — the optional `commit` accepting BOTH git object formats
// (SHA-1, 40 hex; SHA-256, 64 hex) so a revkit anchor round-trips
// unchanged in a `git init --object-format=sha256` repo.
import { describe, expect, test } from "bun:test";
import { anchorSchema } from "../src/index.ts";

const base = {
  path: "docs/x.md",
  startLine: 1,
  endLine: 1,
  quote: { exact: "x", prefix: "", suffix: "" },
  revision: "a".repeat(64),
} as const;

describe("anchorSchema — commit", () => {
  test("no `commit` set — accepted (optional, M2 daemon doesn't record it)", () => {
    expect(anchorSchema.safeParse(base).success).toBe(true);
  });

  test("40-hex commit (SHA-1) — accepted", () => {
    const result = anchorSchema.safeParse({ ...base, commit: "b".repeat(40) });
    expect(result.success).toBe(true);
  });

  test("64-hex commit (SHA-256 repos) — accepted", () => {
    const result = anchorSchema.safeParse({ ...base, commit: "c".repeat(64) });
    expect(result.success).toBe(true);
  });

  test("neither 40 nor 64 hex — rejected (52 hex, upper-case, non-hex)", () => {
    for (const bad of ["d".repeat(52), "A".repeat(40), "not-hex" + "x".repeat(33)]) {
      expect(anchorSchema.safeParse({ ...base, commit: bad }).success).toBe(false);
    }
  });
});

describe("anchorSchema — revision", () => {
  test("64-hex lowercase revision required; upper-case is rejected", () => {
    expect(anchorSchema.safeParse({ ...base, revision: "A".repeat(64) }).success).toBe(false);
  });
});

describe("anchorSchema — line range", () => {
  test("endLine >= startLine required", () => {
    expect(anchorSchema.safeParse({ ...base, startLine: 10, endLine: 5 }).success).toBe(false);
  });
});
