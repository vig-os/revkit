// Integration test for issue #237 — a content entry whose render throws
// makes `revkit build` exit non-zero with a message that names the
// SOURCE file (consumer-relative, not the staging path) AND carries the
// underlying render error. The post-#239 packaged build reaches astro
// in both lanes (dev checkout and e2e), so this test asserts the gate's
// message every time.
//
// Trigger: a doc with a `$$…$$` math block that KaTeX cannot parse.
// The shared markdown pipeline runs `rehypeKatexStrict`, which turns a
// KaTeX parse error into a thrown error (never a red
// `<span class="katex-error">`). Astro's glob loader catches that throw
// per entry and stores `rendered: undefined`; Starlight then renders
// an empty `sl-markdown-content`. Before this fix the build exited 0
// and shipped a silently empty page. After the fix the
// `guardedDocsLoader` wrapper throws
// `EmptyRenderedBodyError`, which astro surfaces as a non-zero
// `revkit build` exit code.
//
// This trigger is DETERMINISTIC: it does not depend on the
// hast-util-raw / parse5 version clash from #238. One in-process
// build keeps the test lean on file descriptors (round-2 review).

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
 * (bad KaTeX) alongside healthy docs — including a nested
 * `sub/My_Doc.md` the round-2 reviewer flagged (underscores + nested
 * dir, which the earlier re-implemented slugger silently mapped
 * wrong). The pre-build `revkit check` accepts every file so the
 * astro step actually runs. */
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
  writeFileSync(join(distDir, "index.html"), "<!doctype html><h1>seed</h1>", "utf8");
  mkdirSync(join(root, "docs"), { recursive: true });
  // A perfectly healthy doc — proves the test setup itself is sound.
  writeFileSync(
    join(root, "docs", "good.md"),
    "---\ntitle: Good\n---\n\n# Good\n\nA minimal document.\n",
    "utf8",
  );
  // Round-2 reviewer repro: a nested file whose name carries a
  // `_`. Astro's github-slugger keeps underscores; the previous
  // hand-rolled slug mapper lowered this to `my-doc` and then
  // check-dist never cross-referenced the actual Starlight output
  // (`sub/my_doc/index.html`), so an empty content root slipped
  // through.
  mkdirSync(join(root, "docs", "sub"), { recursive: true });
  writeFileSync(
    join(root, "docs", "sub", "My_Doc.md"),
    "---\ntitle: My Doc\n---\n\n# My Doc\n\nA nested doc with an `_` in its name.\n",
    "utf8",
  );
  // The doc whose render MUST fail. `\invalidmacro` is not a KaTeX
  // macro, so `rehype-katex-strict` throws. Astro's glob loader
  // catches that and stores `rendered: undefined`. Before the fix,
  // the build exited 0 and Starlight shipped an empty
  // `sl-markdown-content`; after the fix, `guardedDocsLoader` throws
  // during the content-sync phase and astro exits non-zero.
  // The doc whose render MUST fail lives in a NESTED directory so
  // the round-3 reviewer's repro is directly exercised (an earlier
  // version of the underlying-error lookup mis-keyed nested docs
  // and missed the message in the thrown error).
  mkdirSync(join(root, "docs", "deep"), { recursive: true });
  writeFileSync(
    join(root, "docs", "deep", "bad-math.md"),
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
  test("a doc whose render throws makes `revkit build` fail with the gate's message (consumer path + underlying error) AND the loader-written manifest lists it under its astro slug (round-2 reviewer repros: `_` and nested dirs)", async () => {
    const { root, distDir } = scaffoldConsumer();
    const result = await runRealBuild(root, distDir);
    const combined = `${result.stdout}\n${result.stderr}`;

    // Pre-build check must have run (shared composition proof).
    expect(combined).toMatch(/revkit build: check ok \(\d+ files\)/);
    expect(combined).not.toContain("'revkit check' failed");

    // The build MUST fail, and the astro step is the one that fails.
    // Any failure before the astro step would hide #237, so this is
    // asserted directly (round-2 review item 3: the else-branch that
    // accepted an earlier failure is gone).
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("revkit build: astro build failed");

    // The gate's own message (not astro's rendering log, which
    // includes the staging path verbatim): the issue reference, the
    // CONSUMER-visible source path (not the `src/content/` staging
    // prefix), the "non-empty source body" clause, and the UNDERLYING
    // render error KaTeX surfaced (round-2 review item 1).
    expect(combined).toContain("revkit content gate (#237)");
    expect(combined).toContain("non-empty source body");
    expect(combined).toContain("Underlying render error:");
    expect(combined).toMatch(/KaTeX parse error|Undefined control sequence|invalidmacro/);

    // Extract ONLY the gate's line (first line of the error message)
    // and assert the consumer path is there. Astro's stderr before
    // the gate's throw legitimately prints the staging path (that's
    // what astro's content-layer passes through to the logger), so
    // we scope the assertion to the gate line itself. Also assert
    // the nested path survives — the round-3 reviewer's repro was a
    // nested doc that lost its underlying-error attribution before
    // the fix landed.
    const gateLineMatch =
      combined.match(/revkit content gate \(#237\)[^\n]+/);
    expect(gateLineMatch, `gate line not found in output: ${combined}`).not.toBeNull();
    const gateLine = gateLineMatch?.[0] ?? "";
    expect(gateLine).toContain("docs/deep/bad-math.md");
    expect(gateLine).not.toContain("src/content/");
  }, 600_000);
});
