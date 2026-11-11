// Parity test for the two `isValidRepoRelativePath` copies (PR #38
// round-2 review). The rail's browser-safe copy in
// `packages/cli/src/data-src-format.ts` cannot import review-core's
// `path.ts` at bundle-time (see the file header for the Bun.build
// reason). This test asserts the two functions agree on a wide
// spread of inputs — if either drifts, this goes red.

import { describe, expect, test } from "bun:test";
import { isValidRepoRelativePath as fromCli, parseDataSrc, formatDataSrc } from "../src/data-src-format.ts";
import { isValidRepoRelativePath as fromCore } from "@revkit/review-core";

const INPUTS: readonly string[] = [
  // Accepted.
  "docs/adr/0006.md",
  "docs/adr/0006-comments-anchoring-event-log.md",
  "site/src/content/docs/index.mdx",
  "a",
  "a/b/c",
  "with space/x.md",
  "hyphens-and_underscores.md",
  "a".repeat(512),
  // Refused.
  "",
  "/absolute.md",
  "..",
  "docs/../etc/passwd",
  "docs/./x.md",
  "a//b",
  "back\\slash.md",
  "quote\".md",
  "col:on.md",
  "star*.md",
  "quest?.md",
  "ang<le.md",
  "ang>le.md",
  "pi|pe.md",
  "control\x01.md",
  "nul\x00.md",
  "tab\there.md",
  "newline\nhere.md",
  "a".repeat(513),
];

describe("isValidRepoRelativePath — parity across cli and review-core", () => {
  for (const input of INPUTS) {
    test(`parity on ${JSON.stringify(input.length > 40 ? input.slice(0, 20) + `...(${input.length} chars)` : input)}`, () => {
      expect(fromCli(input)).toBe(fromCore(input));
    });
  }
});

describe("parseDataSrc — unified rejection when path violates the rule", () => {
  test("MUTATION: a data-src whose path is invalid returns undefined (not a partially-parsed anchor)", () => {
    // `parseDataSrc` used to return `{path, startLine, endLine}` for
    // any string that split into `path:M-N`. Now it also validates
    // the path via `isValidRepoRelativePath` — a `..` path or a
    // control character is rejected here, before the caller
    // constructs an anchor.
    for (const badPath of ["..", "docs/../etc.md", "abs/./x", "quo\"te.md"]) {
      const value = formatDataSrc(badPath, 1, 1);
      expect(parseDataSrc(value)).toBeUndefined();
    }
    // Sanity: a good path still round-trips.
    expect(parseDataSrc(formatDataSrc("docs/adr/0001.md", 1, 5))).toEqual({
      path: "docs/adr/0001.md",
      startLine: 1,
      endLine: 5,
    });
  });
});
