// Tests for the TokenSource interface and the token-redaction helper
// (M3 part 1, ADR-0025). The interface itself has no behaviour to
// test; these tests pin the redaction rules, since a leak in an error
// message is the most likely way a token escapes the daemon.

import { describe, expect, test } from "bun:test";
import { redactTokenInMessage, type TokenSource } from "../src/token-source.ts";

describe("redactTokenInMessage", () => {
  test("replaces every occurrence of the active token", () => {
    const token = "ghp_" + "x".repeat(40);
    const msg = `sending ${token} and again ${token}`;
    const scrubbed = redactTokenInMessage(msg, token);
    expect(scrubbed).not.toContain(token);
    expect(scrubbed.split("<redacted:token>").length - 1).toBe(2);
  });

  test("redacts a GitHub-shaped token even if it doesn't equal the active one", () => {
    const active = "ghp_" + "a".repeat(40);
    const stray = "gho_" + "b".repeat(40);
    const scrubbed = redactTokenInMessage(`leaked ${stray}`, active);
    expect(scrubbed).not.toContain(stray);
    expect(scrubbed).toContain("<redacted:ghtoken>");
  });

  test("redacts Authorization: Bearer headers verbatim", () => {
    const msg = 'the request had `Authorization: Bearer secret-token-xyz` set';
    const scrubbed = redactTokenInMessage(msg, "");
    expect(scrubbed).not.toContain("secret-token-xyz");
    expect(scrubbed).toContain("Authorization: Bearer <redacted>");
  });

  test("handles the empty active token without throwing (initial spawn errors)", () => {
    // The gh spawn path calls redactTokenInMessage with token = ""
    // when the spawn itself fails; we must never touch the input.
    expect(redactTokenInMessage("no gh on path", "")).toBe("no gh on path");
  });

  test("supports classic PAT prefix `github_pat_`", () => {
    const pat = "github_pat_" + "z".repeat(40);
    const scrubbed = redactTokenInMessage(`token=${pat} end`, "");
    expect(scrubbed).not.toContain(pat);
    expect(scrubbed).toContain("<redacted:ghtoken>");
  });

  test("catches all five GitHub prefixes at a word boundary", () => {
    for (const prefix of ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"]) {
      const token = prefix + "x".repeat(40);
      const scrubbed = redactTokenInMessage(`saw ${token} here`, "");
      expect(scrubbed).not.toContain(token);
      expect(scrubbed).toContain("<redacted:ghtoken>");
    }
  });

  test("redacts at various leak-shaped boundaries (space, =, :, \", newline, quote, start)", () => {
    const token = "ghp_" + "a".repeat(40);
    for (const preamble of ["", "token=", '"', 'msg: "', "value=\n", "prefix ", "prefix\t"]) {
      const scrubbed = redactTokenInMessage(`${preamble}${token}`, "");
      expect(scrubbed).not.toContain(token);
      expect(scrubbed).toContain("<redacted:ghtoken>");
    }
  });

  test("does NOT scrub prose collisions where the prefix sits mid-word", () => {
    // PR-43 round-4: the earlier rule scrubbed `highs_and_lows...`
    // because `ghs_` + `and_lows...` is a legal token shape. With
    // the word-boundary check, prose shapes are safe.
    const long = "and_lows_" + "A".repeat(30);
    const before = `highs_${long}`;
    const scrubbed = redactTokenInMessage(before, "");
    // Nothing was redacted.
    expect(scrubbed).toBe(before);
    expect(scrubbed).not.toContain("<redacted:ghtoken>");
  });

  test("does NOT scrub letter- or digit-adjacent joins (aghp_..., 4ghs_...)", () => {
    // Real tokens don't appear in these shapes; refusing the
    // scrub is the safer default.
    for (const preamble of ["a", "z", "9", "4"]) {
      const s = `${preamble}ghp_${"a".repeat(40)}`;
      const scrubbed = redactTokenInMessage(s, "");
      expect(scrubbed).toBe(s);
    }
  });

  test("does NOT scrub short strings shaped like a prefix (min tail 30)", () => {
    // A 20-char tail (the round-3 minimum) was too short and
    // caught prose. Now 30+ required.
    const s = `ghp_${"a".repeat(20)}`;
    const scrubbed = redactTokenInMessage(s, "");
    expect(scrubbed).toBe(s);
  });
});

describe("TokenSource interface", () => {
  test("a minimal implementation only needs an async getToken", async () => {
    // A structural test — the interface must be nominally satisfied
    // by any {getToken(): Promise<string>} object, so a fake in a
    // test suite (no class, no runtime dep) is enough.
    const fake: TokenSource = {
      async getToken(): Promise<string> {
        return "fake-token-value-with-enough-length-01234567";
      },
    };
    expect(await fake.getToken()).toContain("fake-token-value");
  });
});
