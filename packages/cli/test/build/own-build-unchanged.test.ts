// Regression test: with `REVKIT_CONSUMER_ROOT` UNSET, every consumer-
// mode branch in `site/astro.config.mjs` and
// `site/src/content.config.ts` collapses to its pre-#57 value. Issue
// #57's acceptance calls this out explicitly ("this repo's own
// build must behave exactly as today; prove that the built output
// is unchanged").
//
// This test asserts the invariant by shape rather than by running
// two builds and diffing bytes (that's the smoke's job, and it's
// slow). If any of the checks below break, own-repo mode is
// touching a consumer-only branch — the FIRST failure surface for
// the "own build changed" regression.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

const REPO_ROOT = resolvePath(import.meta.dirname!, "..", "..", "..", "..");

function read(rel: string): string {
  return readFileSync(resolvePath(REPO_ROOT, rel), "utf8");
}

describe("own build unchanged when REVKIT_CONSUMER_ROOT is unset", () => {
  test("astro.config.mjs guards CONSUMER_SIDEBAR behind CONSUMER_ROOT", () => {
    const src = read("site/astro.config.mjs");
    // The original sidebar shape (Start / Design / ADRs / Feature
    // matrix) is still the ELSE branch of the ternary — meaning
    // it renders unchanged when CONSUMER_ROOT is null.
    expect(src).toContain("sidebar: CONSUMER_SIDEBAR ??");
    // The explicit MDX integration is only inserted when
    // CONSUMER_ROOT is set — a spread of `[]` in own mode is a
    // no-op.
    expect(src).toMatch(/CONSUMER_ROOT\s*\?\s*\[mdx\(/);
    // vite.cacheDir override is only applied when set (env-driven).
    expect(src).toContain("VITE_CACHE_DIR ?");
    expect(src).toContain("ASTRO_CACHE_DIR ?");
  });

  test("content.config.ts docs loader picks composed vs plain by CONSUMER_ROOT", () => {
    const src = read("site/src/content.config.ts");
    // Own build → composedDocsLoader (Starlight + repoDocsLoader).
    // Consumer build → docsLoader() alone.
    expect(src).toContain("CONSUMER_ROOT ? docsLoader() : composedDocsLoader()");
  });

  test("consumer-root reader rejects a relative path (no silent-cwd-render footgun)", () => {
    const src = read("site/src/lib/consumer-root.ts");
    expect(src).toContain('must be an absolute path');
  });

  test("build.ts still exports the review-path primitive AND the shared spawn", () => {
    const src = read("packages/cli/src/review/build.ts");
    // Both entry points must be present so `revkit review` and
    // `revkit build` share one implementation of the primitive.
    expect(src).toContain("export async function runSafeBuild");
    expect(src).toContain("export async function spawnAstroBuild");
    // The env allow/denylist are read as CONSTANTS at test time —
    // any regression that hard-codes them into `runSafeBuild`
    // instead of the shared primitive fails the constants test in
    // review/build-env.test.ts.
    expect(src).toContain("BUILD_ENV_ALLOWLIST");
    expect(src).toContain("BUILD_ENV_TOKEN_DENYLIST");
  });
});
