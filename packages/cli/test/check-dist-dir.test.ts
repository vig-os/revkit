// Issue #27 round-2 — end-to-end fixture-directory tests for
// `revkit check-dist`.
//
// Runs `checkDistDirectory` (the same code path `just build` calls
// after `astro build`) against a temp directory populated from the
// `packages/cli/test/fixtures/dist-27/*.html.txt` sources — each
// source file carries one of the round-2 bypass shapes exactly as
// a real astro build would emit it (astro passes raw HTML in MDX
// through verbatim; the bytes parse5 sees are the same).
//
// The fixtures ship as `.html.txt` rather than `.html` because the
// `no-hand-rolled-ui` guardrails gate refuses `.html` files outside
// the site's own UI trees (ADR-0002 / ADR-0005). The test copies
// each source into a `.html` twin inside `Bun.tempDir()` so
// `checkDistDirectory`'s `walkHtml` picks them up. Same bytes, same
// parse5 output, no ADR-0002 exception needed.
//
// This is deliberately a separate file from `check-dist.test.ts`:
// the direct scan tests exercise `scanDocument` on synthetic
// strings; this file exercises the outer plumbing (`walkHtml`,
// `readFileSync`, per-file diagnostics), so a regression in the
// directory walk or the file-relative path reporting trips even
// when the token scanner is fine.
//
// Mutation-check: the assertions below assert BOTH that the bypass
// fixtures produce findings AND that the positive-control fixture
// produces none. A scanner that dropped the SVG url() walk or the
// `<use>` href check would fail every bypass; a scanner that
// swung too far and rejected legitimate `url(#…)` refs would fail
// the positive control.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { checkDistDirectory } from "../src/check-dist.ts";

const FIXTURE_SRC_DIR = resolve(import.meta.dirname, "fixtures", "dist-27");

/** Copy every `*.html.txt` fixture into a fresh temp dir renamed to
 * `*.html` so `walkHtml` picks them up. Returns the temp dir path. */
function materializeFixturesAsHtml(): string {
  const dir = mkdtempSync(join(tmpdir(), "revkit-check-dist-27-"));
  for (const entry of readdirSync(FIXTURE_SRC_DIR)) {
    if (!entry.endsWith(".html.txt")) continue;
    const source = readFileSync(join(FIXTURE_SRC_DIR, entry), "utf8");
    const targetName = basename(entry, ".html.txt") + ".html";
    writeFileSync(join(dir, targetName), source);
  }
  return dir;
}

describe("check-dist — issue #27 fixture-directory end-to-end", () => {
  const distDir = materializeFixturesAsHtml();
  const diagnostics = checkDistDirectory(distDir);

  test("the scan returns at least one finding for every bypass fixture", () => {
    // Fixture filename → substring the finding message must contain.
    // The substring is a load-bearing token from the refusal
    // reasoning (`evil.example`, `percent-encoded`, `same-document`),
    // so this asserts intent, not just count.
    const requiredFindings: Readonly<Record<string, string>> = {
      "style-unterminated-url.html": "evil.example",
      "style-fake-comment.html": "evil.example",
      "svg-fill-unterminated.html": "D.svg",
      "svg-cursor-quoted-unterminated.html": "URL-shaped",
      "use-href-external.html": "same-document",
      "use-href-percent23.html": "percent-encoded",
      "linear-gradient-href-external.html": "evil.example",
    };
    for (const [file, needle] of Object.entries(requiredFindings)) {
      const forFile = diagnostics.filter((d) => d.file === file);
      expect(
        forFile.length > 0,
        `expected at least one finding for ${file}, got none. All diagnostics: ${JSON.stringify(diagnostics)}`,
      ).toBe(true);
      expect(
        forFile.some((d) => d.message.includes(needle)),
        `expected a finding for ${file} to mention ${JSON.stringify(needle)}, got ${JSON.stringify(forFile)}`,
      ).toBe(true);
    }
  });

  test("the positive-control fixture (clean Vega-shape) produces zero findings", () => {
    // A scanner that mistakenly refused legit `url(#gradient1)`
    // presentation-attr refs or a legit `<use href="#gradient1">`
    // would trip this. Keeps the fix from swinging too far.
    const forControl = diagnostics.filter((d) => d.file === "clean-vega-shape.html");
    expect(forControl, `positive-control fixture emitted findings: ${JSON.stringify(forControl)}`).toEqual([]);
  });

  test("every diagnostic names a `check-dist` rule and a file-relative path", () => {
    // Guards against a regression in `checkDistDirectory`'s
    // aggregation (empty rule, absolute path leaking the runner's
    // home directory, missing line).
    for (const diagnostic of diagnostics) {
      expect(diagnostic.rule).toBe("check-dist");
      expect(diagnostic.file.startsWith("/")).toBe(false);
      expect(diagnostic.file.endsWith(".html")).toBe(true);
      expect(diagnostic.message.length).toBeGreaterThan(0);
    }
  });
});
