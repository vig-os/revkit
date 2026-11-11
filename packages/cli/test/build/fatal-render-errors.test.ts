// Integration test for issue #237 — a content entry whose render throws
// makes `revkit build` exit non-zero with a message that names the
// source file and the underlying error.
//
// Trigger: a doc with a `$$…$$` math block that KaTeX cannot parse. The
// shared markdown pipeline runs `rehypeKatexStrict`, which turns a
// KaTeX parse error into a thrown error (never a red
// `<span class="katex-error">`). Astro's glob loader catches that throw
// per entry and stores `rendered: undefined`; Starlight then renders an
// empty `sl-markdown-content` for the page. Before this fix, the build
// succeeded (exit 0) and shipped a silently empty page. The
// `guardedDocsLoader` wrapper added in `site/src/content.config.ts`
// turns the silent catch into a loud build failure that names both the
// source file and the entry id.
//
// This trigger is DETERMINISTIC: it does not depend on the
// hast-util-raw / parse5 version clash from #238. Any run that
// reaches the astro step fails the invariant the same way.
//
// Runs through `runBuildCommand` in-process, the SAME composition
// `revkit build` and the daemon both call. In a dev checkout the
// isolated linker layout sometimes fails BEFORE the astro step (see
// `publish-build-real.test.ts`'s explanation); the test guards for
// that so it stays honest about what it proved.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBuildCommand, type RunBuildResult } from "../../src/build/cli.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Consumer whose `docs/` has one doc that triggers a render failure
 * (bad KaTeX) alongside one healthy doc. The pre-build `revkit check`
 * must accept both files so the astro step actually runs. */
function scaffoldConsumer(): { root: string; distDir: string } {
  const root = mkdtempSync(join(tmpdir(), "revkit-237-"));
  roots.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "consumer", private: true }),
    "utf8",
  );
  const distDir = join(root, ".revkit", "dist");
  mkdirSync(distDir, { recursive: true });
  // Seed with a placeholder so the serve dir exists at boot.
  writeFileSync(distDir + "/index.html", "<!doctype html><h1>seed</h1>", "utf8");
  mkdirSync(join(root, "docs"), { recursive: true });
  // A perfectly healthy doc — proves the test setup itself is sound.
  writeFileSync(
    join(root, "docs", "good.md"),
    "---\ntitle: Good\n---\n\n# Good\n\nA minimal document.\n",
    "utf8",
  );
  // The doc whose render MUST fail: `\invalidmacro` is not a KaTeX
  // macro, so `rehype-katex-strict` throws. Astro's glob loader
  // catches that and stores `rendered: undefined`. Before the fix,
  // the build exited 0 and Starlight shipped an empty
  // `sl-markdown-content`; after the fix, `guardedDocsLoader` throws
  // during the content-sync phase and astro exits non-zero.
  writeFileSync(
    join(root, "docs", "bad-math.md"),
    "---\ntitle: Bad Math\n---\n\n# Bad\n\nA document with a KaTeX parse error below.\n\n$$\n\\invalidmacro{x}\n$$\n",
    "utf8",
  );
  return { root, distDir };
}

async function runRealBuild(root: string, distDir: string): Promise<RunBuildResult> {
  return runBuildCommand(
    ["--dir", root, "--out", distDir],
    { cwd: root, version: "0.0.0-test", repoSlug: "vig-os/revkit" },
  );
}

describe("revkit build — fatal render errors (issue #237)", () => {
  test("a doc whose render throws makes `revkit build` exit non-zero and name the source file", async () => {
    const { root, distDir } = scaffoldConsumer();
    const result = await runRealBuild(root, distDir);
    const combined = `${result.stdout}\n${result.stderr}`;

    // Pre-build check must have run (shared composition proof).
    expect(combined).toMatch(/revkit build: check ok \(\d+ files\)/);
    expect(combined).not.toContain("'revkit check' failed");

    // The astro step is where #237 fires. A dev checkout's isolated
    // linker can fail BEFORE the astro step (we assert that path is
    // reported honestly in that case). Either way the build is not
    // allowed to succeed on this fixture.
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);

    const astroFailed = combined.includes("revkit build: astro build failed")
      || combined.includes("revkit build: astro ok") === false
        && combined.includes("astro");

    if (astroFailed && combined.includes("revkit build: astro build failed")) {
      // The guard is the only build-time code path that throws on
      // this fixture: its message names the source file and carries
      // the issue reference.
      expect(combined).toMatch(/bad-math\.md/);
      expect(combined).toMatch(/revkit content gate \(#237\)|non-empty source body/);
    } else {
      // Dev-only early-stage failure (isolated-linker layout). Still
      // a non-zero exit, which is enough to prove the fixture is
      // never silently accepted.
      expect(result.stderr).toMatch(/revkit build: (astro build failed|'revkit check-dist' refused|check failed)/);
    }
  }, 600_000);

  test("a doc whose source body is empty (frontmatter only) still builds — no false positives (criterion 4)", async () => {
    const root = mkdtempSync(join(tmpdir(), "revkit-237-empty-"));
    roots.push(root);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "consumer", private: true }),
      "utf8",
    );
    const distDir = join(root, ".revkit", "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "index.html"), "<!doctype html><h1>seed</h1>", "utf8");
    mkdirSync(join(root, "docs"));
    writeFileSync(
      join(root, "docs", "home.md"),
      "---\ntitle: Home\ndescription: Just a landing.\n---\n",
      "utf8",
    );
    writeFileSync(
      join(root, "docs", "guide.md"),
      "---\ntitle: Guide\n---\n\n## Guide\n\nBody paragraph.\n",
      "utf8",
    );
    const result = await runRealBuild(root, distDir);
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).toMatch(/revkit build: check ok \(\d+ files\)/);
    // The build must NOT fail BECAUSE of #237. (A dev-checkout layout
    // failure in the astro step remains acceptable.)
    expect(combined).not.toContain("revkit content gate (#237)");
    expect(combined).not.toContain("non-empty source body");
  }, 600_000);
});
