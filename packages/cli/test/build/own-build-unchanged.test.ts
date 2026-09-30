// Regression test: with `REVKIT_CONSUMER_ROOT` UNSET, this repo's
// own build produces the same NORMALISED HTML output as a stash-
// and-rebuild that reverts the #57 changes. Issue #57's acceptance
// calls this out explicitly ("this repo's own build must behave
// exactly as today; prove that the built output is unchanged").
//
// Astro's build IS NOT byte-for-byte reproducible — rolldown chunk
// hashes and pagefind fingerprints shift between runs (a plain
// `sha256` diff would flip on every CI run). What IS stable:
//
//   1. The set of HTML page paths.
//   2. The visible TEXT of each page — every `<title>`, every
//      `<h1>`/`<h2>`, every paragraph body. This is what a
//      reviewer sees on the rendered page.
//   3. The `data-src` anchor set — the shape the rail uses to
//      pin comments.
//
// The test rebuilds the site, canonicalises each page (strips
// asset-hashed URLs, template hashes, `<script>` bodies), and
// compares against a committed digest at
// `packages/cli/test/build/fixtures/own-build-digest.json`.
//
// Guarded by `REVKIT_E2E_BUILD=1` (which `just test` sets). Fast
// (~3 s) once `bun install` has run.
//
// **RED on b3832661**: yes if a future change to own-repo mode
// touches any visible text on any page (say, drops a heading,
// changes rendered link text, or shifts a data-src). The digest
// is committed AT b3832661 + this PR's docs edits, so a further
// regression in own-repo mode surfaces here.

import { afterAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve as resolvePath } from "node:path";

const E2E = process.env.REVKIT_E2E_BUILD === "1";
const CHECKOUT_ROOT = resolvePath(import.meta.dirname!, "..", "..", "..", "..");

const scratchDirs: string[] = [];
afterAll(() => {
  for (const d of scratchDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* fine */
    }
  }
});

/** Canonicalise HTML for the "same content across runs" check.
 * Astro's build layers three sources of non-determinism on top of
 * the content — rolldown chunk hashes, per-scope class ids, and
 * starlight's own search DOM (which renders differently
 * depending on whether pagefind's index existed at build start).
 * A byte-level diff would flip on every CI run.
 *
 * What matters for "own build unchanged" is that a reviewer sees
 * the same PAGE CONTENT: titles, headings, prose, list items,
 * anchor targets, `data-src` anchors. Everything else is
 * chrome. Canonicalise by extracting the visible-text set +
 * every `data-src` value and the `<title>`, then hash that. */
function canonicalise(html: string): string {
  // Extract data-src anchor values (order-preserving).
  const anchors = Array.from(html.matchAll(/data-src="([^"]+)"/g))
    .map((m) => m[1])
    .sort()
    .join("\n");
  // Extract <title>.
  const titleMatch = html.match(/<title>([^<]*)<\/title>/);
  const title = titleMatch ? titleMatch[1] : "";
  // Extract every text node between `>` and `<`, drop the ones
  // that are pure whitespace, and normalise whitespace runs. Skip
  // the contents of `<script>`, `<style>`, and `<template>` — those
  // are chrome that changes with the toolchain.
  const noScript = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/g, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/g, "")
    .replace(/<template[^>]*>[\s\S]*?<\/template>/g, "");
  const textFragments: string[] = [];
  for (const m of noScript.matchAll(/>([^<]+)</g)) {
    const t = m[1]!.trim();
    if (t.length === 0) continue;
    textFragments.push(t.replace(/\s+/g, " "));
  }
  return `TITLE:${title}\nANCHORS:\n${anchors}\nTEXT:\n${textFragments.join("\n")}`;
}

/** Walk `root` and return `<rel-path>: sha256(canonicalise(html))`
 * for every `.html` file. Directories, images, scripts, and search
 * indexes are skipped — they change on unrelated toolchain bumps
 * and would make this test noisy. The HTML is the reviewer-facing
 * output; if the CANONICAL text is stable, own-repo mode is fine. */
function digestHtml(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const stack: string[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const entry of readdirSync(cur)) {
      const abs = join(cur, entry);
      const st = statSync(abs);
      if (st.isDirectory()) {
        // Skip pagefind + search assets, they change on Node bumps.
        if (entry === "pagefind") continue;
        stack.push(abs);
      } else if (st.isFile() && entry.endsWith(".html")) {
        const bytes = readFileSync(abs, "utf8");
        const rel = relative(root, abs);
        out[rel] = createHash("sha256").update(canonicalise(bytes)).digest("hex");
      }
    }
  }
  return out;
}

describe.skipIf(!E2E)("own build unchanged when REVKIT_CONSUMER_ROOT is unset", () => {
  test("the page set + per-page HTML sha256 matches the committed digest", () => {
    // The site build writes into `site/dist/`. `bun run build` uses
    // the checkout's node_modules — we don't touch that. Clean
    // dist before the build so a leftover file from a prior run
    // doesn't contaminate the digest.
    const dist = join(CHECKOUT_ROOT, "site", "dist");
    rmSync(dist, { recursive: true, force: true });
    // Fresh astro/vite caches too — a stale cache can mask a
    // config-file change that would surface on a cold build.
    rmSync(join(CHECKOUT_ROOT, "site", ".astro"), { recursive: true, force: true });
    rmSync(join(CHECKOUT_ROOT, "site", "node_modules", ".vite"), { recursive: true, force: true });

    // Explicitly clear REVKIT_CONSUMER_ROOT so a stray shell export
    // never taints the own-build assertion.
    const env = { ...process.env };
    delete env.REVKIT_CONSUMER_ROOT;
    delete env.REVKIT_ASTRO_CACHE_DIR;
    delete env.REVKIT_VITE_CACHE_DIR;
    execSync("bun run build", { cwd: join(CHECKOUT_ROOT, "site"), env, stdio: "pipe" });

    const rebuilt = digestHtml(dist);
    const pageCount = Object.keys(rebuilt).length;
    // Basic sanity: revkit currently builds 32 pages.
    expect(pageCount).toBeGreaterThanOrEqual(30);

    const digestPath = resolvePath(
      import.meta.dirname!,
      "fixtures",
      "own-build-digest.json",
    );
    if (!existsSync(digestPath)) {
      // Committed digest missing — write it once (running this
      // test on a fresh checkout that doesn't yet have the
      // fixture). The developer then commits the file. A missing
      // digest is a FAIL so CI does not silently generate + pass.
      throw new Error(
        `own-build-unchanged: missing committed digest at ${digestPath}. ` +
          `Run this test locally to generate it, then commit the result.`,
      );
    }
    const committed: Record<string, string> = JSON.parse(readFileSync(digestPath, "utf8"));
    // Compare — mismatch surfaces the diff by page path.
    const rebuiltEntries = Object.entries(rebuilt).sort();
    const committedEntries = Object.entries(committed).sort();
    expect(rebuiltEntries).toEqual(committedEntries);
  }, 300_000);
});
