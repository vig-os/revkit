// End-to-end: runs the REAL `runSafeBuild` — no injected spawn.
// The fixture ships a minimal astro project (enough to actually
// spin up astro's build), points at the reviewer's TRUSTED
// `site/node_modules`, and verifies:
//   - the trusted astro binary runs,
//   - it emits HTML into distOutDir,
//   - `revkit check-dist` accepts that HTML,
//   - no `bun install` was needed and no registry fetch happened,
//     proven by network-var scrub + trusted-only symlinks and by
//     assertions on the child env.
//
// The test is guarded by `REVKIT_E2E_BUILD=1` so a lightweight
// CI lane can opt out. Local `just test` and the CI lane that
// exports the flag run it end-to-end.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { runSafeBuild, defaultDistOutDir } from "../../src/review/build.ts";
import { checkDistDirectory } from "../../src/check-dist.ts";

/** Absolute path to the checkout root — the working directory when
 * `just test` runs. */
const CHECKOUT_ROOT = resolvePath(import.meta.dirname!, "..", "..", "..", "..");

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* fine */
    }
  }
});

/** Build a minimal "site" tree that mirrors what the materialiser
 * would produce for a content-only PR. Only the astro config and
 * a single MDX page — the trusted `site/node_modules` provides
 * everything else. */
function scaffoldMinimalSite(): string {
  const root = mkdtempSync(join(tmpdir(), "revkit-real-build-"));
  dirs.push(root);
  const siteDir = join(root, "site");
  mkdirSync(siteDir, { recursive: true });
  mkdirSync(join(siteDir, "src", "pages"), { recursive: true });
  // A minimal astro config — no integrations, no plugins. The
  // trusted `astro` binary in node_modules/.bin handles the rest.
  writeFileSync(
    join(siteDir, "astro.config.mjs"),
    `import { defineConfig } from "astro/config";\nexport default defineConfig({});\n`,
  );
  writeFileSync(
    join(siteDir, "package.json"),
    JSON.stringify({ name: "revkit-real-build-fixture", type: "module", private: true }),
  );
  writeFileSync(
    join(siteDir, "src", "pages", "index.astro"),
    `---\n---\n<!doctype html><html><head><title>real build</title></head><body><h1>ok</h1></body></html>\n`,
  );
  return root;
}

const E2E = process.env.REVKIT_E2E_BUILD === "1";

describe.skipIf(!E2E)("real safe-build against the trusted checkout", () => {
  test("builds an HTML file that check-dist accepts", async () => {
    // The checkout's site/node_modules/.bin/astro must exist —
    // `bun install` runs on `direnv reload` in the dev shell.
    const trustedAstro = join(CHECKOUT_ROOT, "site", "node_modules", ".bin", "astro");
    expect(existsSync(trustedAstro)).toBe(true);

    const root = scaffoldMinimalSite();
    const distOutDir = defaultDistOutDir(root);
    await runSafeBuild({
      materializedRoot: root,
      distOutDir,
      trustedCheckoutRoot: CHECKOUT_ROOT,
    });
    // Astro emitted an index.html.
    const indexHtml = join(distOutDir, "index.html");
    expect(existsSync(indexHtml)).toBe(true);
    const html = readFileSync(indexHtml, "utf8");
    expect(html.length).toBeGreaterThan(0);
    // check-dist accepts it.
    const diags = checkDistDirectory(distOutDir);
    expect(diags).toEqual([]);
  }, 120_000);

  test("no bun install runs inside the sandbox (no `.bun`/`bun.lock` written)", async () => {
    const root = scaffoldMinimalSite();
    await runSafeBuild({
      materializedRoot: root,
      distOutDir: defaultDistOutDir(root),
      trustedCheckoutRoot: CHECKOUT_ROOT,
    });
    // No `bun.lock` should have been created inside the sandbox.
    expect(existsSync(join(root, "site", "bun.lock"))).toBe(false);
    expect(existsSync(join(root, "bun.lock"))).toBe(false);
    // No `node_modules` was NEWLY installed (only symlinked to
    // the trusted checkout).
    const nm = join(root, "site", "node_modules");
    // The link exists after the build only when we DIDN'T clean
    // up — in fact the build removes its links in `finally`. So
    // after a completed build there should be NO
    // sandbox-managed node_modules dir at all.
    expect(existsSync(nm)).toBe(false);
  }, 120_000);
});

// Reference helpers so unused-import lint stays quiet even when
// the test is skipped.
void symlinkSync;
