// `revkit build` end-to-end backstop test (issue #237 round-3 review
// item 3). The astro-side render guard throws for every empty entry it
// sees; `check-dist` is the second layer of defense. Both pieces have
// unit coverage, but until this test existed nothing proved the two
// were wired together: mutating `readRenderGuardManifest` to
// `return new Set()` in `cli.ts` still passed the whole CLI suite,
// because every end-to-end test ran an UNCORRUPTED build the gate
// already cleared.
//
// What this file exercises: the astro-side loader writes a manifest
// at the agreed path, `revkit build` reads it with
// `readRenderGuardManifest`, and `checkDistDirectory` fails any page
// in the manifest whose content root rendered empty. The corruption
// is applied AFTER astro has written the manifest and dist, since
// astro itself has no bug here — this is the exact scenario the
// defense-in-depth layer exists for.
//
// Mutation this must catch (run manually once to verify):
// replace `readRenderGuardManifest(renderGuardManifest)` with
// `new Set<string>()` in `packages/cli/src/build/cli.ts` and this
// test flips red (no finding for the corrupted page), because the
// empty content-root scan only runs on paths that are in the set.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDistDirectory, CONTENT_ROOT_CLASS } from "../../src/check-dist.ts";
import { readRenderGuardManifest } from "../../src/build/cli.ts";
import { runPackagedBuild } from "../../src/build/packaged.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scaffold(): { root: string; distDir: string; manifestPath: string } {
  const root = mkdtempSync(join(tmpdir(), "revkit-backstop-"));
  roots.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "consumer", private: true }),
    "utf8",
  );
  const distDir = join(root, ".revkit", "dist");
  mkdirSync(distDir, { recursive: true });
  mkdirSync(join(root, "docs"));
  // Multiple non-empty docs so the manifest is non-empty AND
  // corrupting any one page provides a clean failure target.
  writeFileSync(
    join(root, "docs", "home.md"),
    "---\ntitle: Home\n---\n\n# Home\n\nA minimal document.\n",
    "utf8",
  );
  mkdirSync(join(root, "docs", "sub"));
  writeFileSync(
    join(root, "docs", "sub", "guide.md"),
    "---\ntitle: Guide\n---\n\n# Guide\n\nBody paragraph.\n",
    "utf8",
  );
  const manifestPath = join(root, ".revkit", "build", "render-guard-manifest.json");
  return { root, distDir, manifestPath };
}

describe("render-guard backstop — manifest + check-dist flagship test (round-3)", () => {
  test("the manifest flow catches an empty content root the astro gate did not see", async () => {
    const { root, distDir, manifestPath } = scaffold();

    // 1. Run astro — succeeds (every doc has a non-empty body AND
    //    renders cleanly). The loader writes the manifest.
    await runPackagedBuild({
      consumerRoot: root,
      distOutDir: distDir,
      renderGuardManifestPath: manifestPath,
    });

    // 2. Read the manifest the SAME way `runBuildCommand` does. If
    //    this function were mutated to return `new Set()` the next
    //    step wouldn't flag the corruption.
    const pagesWithNonEmptySource = readRenderGuardManifest(manifestPath);
    expect(pagesWithNonEmptySource.size).toBeGreaterThan(0);
    expect(pagesWithNonEmptySource.has("sub/guide/index.html")).toBe(true);

    // 3. Simulate a silent post-render corruption of ONE page: an
    //    adversarial post-build step (or an astro regression that
    //    strips rendered content without re-throwing) overwrites
    //    the page with an empty `sl-markdown-content`. The astro
    //    build has already finished at this point, so the astro-
    //    side guard has no way to catch this.
    const corruptedPath = join(distDir, "sub", "guide", "index.html");
    const original = readFileSync(corruptedPath, "utf8");
    expect(original).toContain(CONTENT_ROOT_CLASS);
    const corrupted = original.replace(
      new RegExp(
        `<div class="${CONTENT_ROOT_CLASS}"[^>]*>[\\s\\S]*?</div>`,
      ),
      `<div class="${CONTENT_ROOT_CLASS}"></div>`,
    );
    writeFileSync(corruptedPath, corrupted, "utf8");

    // 4. The defense layer: check-dist with the manifest flags it.
    //    Mutation `readRenderGuardManifest → new Set()` makes this
    //    assertion fail (`pagesWithNonEmptySource` would be empty
    //    and the empty-content scan would not touch this page).
    const diagnostics = checkDistDirectory(distDir, { pagesWithNonEmptySource });
    const emptyFinding = diagnostics.find(
      (d) => d.message.includes("empty rendered content"),
    );
    expect(
      emptyFinding,
      `check-dist did not flag the corrupted page; diagnostics: ${JSON.stringify(diagnostics)}`,
    ).toBeDefined();
    expect(emptyFinding?.file).toBe("sub/guide/index.html");
  }, 600_000);
});
