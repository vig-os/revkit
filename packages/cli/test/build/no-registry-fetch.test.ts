// Source-tree regression guard: the packaged `revkit build` path
// must never spawn a package-manager fetch. This test greps the
// CLI source (not just what nix ships) for `bunx ` / `bun x ` /
// `npx `. Kept alongside the build tests so a future refactor
// that introduced a bunx-fallback here would flip red at
// `bun test packages/cli/test/build/` — no nix build required.
//
// This IS the test that the PR #57 owner's "no `bunx` in a trusted
// path" rule refers to. Ran RED against a synthetic weakening
// (see comment inside), then GREEN on the shipping code.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

const CLI_SRC = resolvePath(import.meta.dirname!, "..", "..", "src");

// Strip line comments and block comments. Simplified: good enough
// for a source-tree grep; keeps string literals intact so a real
// use of the forbidden binaries in code still trips.
function stripComments(source: string): string {
  return source
    // block comments (non-greedy across lines)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // line comments to end of line
    .replace(/\/\/[^\n]*/g, "");
}

function scan(dir: string, hits: string[], forbidden: readonly RegExp[]): void {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      scan(abs, hits, forbidden);
      continue;
    }
    if (!/\.(ts|js|mjs|cjs)$/.test(entry)) continue;
    // Skip THIS test file (it names the forbidden tokens).
    if (abs.endsWith("/test/build/no-registry-fetch.test.ts")) continue;
    if (abs.endsWith("/test/build/packaged-e2e.test.ts")) continue;
    const contents = stripComments(readFileSync(abs, "utf8"));
    for (const pattern of forbidden) {
      const match = contents.match(pattern);
      if (match) {
        hits.push(abs.slice(CLI_SRC.length) + ": matched " + String(pattern) + " at " + match[0]);
      }
    }
  }
}

describe("no bunx / bun x / npx in the CLI source (issue #57 rule)", () => {
  test("the trusted-toolchain rule is a source-tree invariant", () => {
    const hits: string[] = [];
    // Match ACTUAL usage: a string literal or shell token starting
    // with one of the forbidden binaries. Any of these in a
    // Bun.spawn or exec call would run a registry fetch. A bare
    // word inside an identifier or URL is left alone. RegExp
    // constructor avoids the parser's confusion around embedded
    // backticks in a slash-delimited literal.
    // Character class for quote / apostrophe / backtick.
    // Built via String.fromCharCode to sidestep the parser's
    // confusion around an inline character class that mixes them.
    const q = String.fromCharCode(34) + String.fromCharCode(39) + String.fromCharCode(96);
    const cls = "[" + q + "]";
    const rBunx = new RegExp(cls + "bunx\\b");
    const rBunSpaceX = new RegExp(cls + "bun\\s+x\\b");
    const rNpx = new RegExp(cls + "npx\\b");
    scan(CLI_SRC, hits, [rBunx, rBunSpaceX, rNpx]);
    // If this array is non-empty, `revkit build` MIGHT spawn a
    // registry-fetching subprocess. The rule from issue #57
    // (packaged build never runs bunx/npx) is a source-tree
    // invariant — every call site uses an absolute path.
    //
    // To prove this test would flip RED on the old code, revert
    // this rule locally by adding `Bun.spawn(['bunx', 'astro',
    // 'build'], ...)` anywhere in packages/cli/src/ and re-run.
    expect(hits).toEqual([]);
  });
});
