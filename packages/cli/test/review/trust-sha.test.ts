// `--trust` must be exactly a 40-hex commit id, and must equal the
// fetched head SHA exactly (case-insensitive) — no prefix
// acceptance (PR #48 round-2 blocker 3).

import { describe, expect, test } from "bun:test";
import { isPlausibleSha, trustMatches } from "../../src/review/cli.ts";

describe("isPlausibleSha — strict 40-hex only", () => {
  test("40-hex accepted", () => {
    expect(isPlausibleSha("a".repeat(40))).toBe(true);
    expect(isPlausibleSha("A".repeat(40))).toBe(true);
    expect(isPlausibleSha("0123456789abcdef".repeat(2) + "01234567")).toBe(true); // 32 + 8 = 40
  });
  test("shorter prefixes REFUSED (7, 12, 39)", () => {
    expect(isPlausibleSha("abcdef1")).toBe(false);
    expect(isPlausibleSha("abcdef1234abcd")).toBe(false);
    expect(isPlausibleSha("a".repeat(39))).toBe(false);
  });
  test("64-char (SHA-256) REFUSED — v1 is SHA-1 only", () => {
    expect(isPlausibleSha("a".repeat(64))).toBe(false);
  });
  test("empty / whitespace / non-hex REFUSED", () => {
    expect(isPlausibleSha("")).toBe(false);
    expect(isPlausibleSha(" ".repeat(40))).toBe(false);
    expect(isPlausibleSha("z".repeat(40))).toBe(false);
    expect(isPlausibleSha("a".repeat(39) + "!")).toBe(false);
  });
});

describe("trustMatches — exact equality, no prefix", () => {
  test("exact 40-hex match (case-insensitive) accepted", () => {
    expect(trustMatches("a".repeat(40), "A".repeat(40))).toBe(true);
    expect(trustMatches("0123456789abcdef".repeat(2) + "01234567", "0123456789ABCDEF".repeat(2) + "01234567")).toBe(true);
  });
  test("prefix REFUSED — even a 7-char prefix of a real SHA", () => {
    const head = "abcdef1" + "0".repeat(33);
    expect(trustMatches("abcdef1", head)).toBe(false);
  });
  test("one-char difference REFUSED", () => {
    const head = "a".repeat(40);
    const wrong = "a".repeat(39) + "b";
    expect(trustMatches(wrong, head)).toBe(false);
  });
});
