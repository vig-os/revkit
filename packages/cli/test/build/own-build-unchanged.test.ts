// Rendering-pipeline digest test (issue #57, round-3 review).
//
// Builds a FIXED docs fixture (`packages/cli/test/build/fixtures/
// pipeline-fixture/`) through the packaged flow (`nix build .#revkit`
// + `revkit build --dir <fixture>`), canonicalises each rendered
// HTML page and compares against a committed digest at
// `packages/cli/test/build/fixtures/pipeline-digest.json`.
//
// **Why a fixture, not the live docs.** An earlier revision hashed
// the live `docs/` tree, which meant every doc edit — an ADR add,
// a matrix row bump — flipped the test red even though the
// rendering pipeline was fine. CLAUDE.md's traceability rule
// pushes most PRs to touch the matrix, so this test would have
// been the noisiest guard in the repo. Fixing the input to a
// checked-in fixture keeps the test focused on what it's ACTUALLY
// testing: the astro config, the two rehype plugins, the docs
// loader, the sidebar autogenerate, the katex asset materialise
// — the pipeline, not the content.
//
// **Why the packaged CLI, not `runPackagedBuild` in-process.** The
// packaged flow's staging strategy (per-entry symlinks into
// `<pkgRoot>/node_modules/`) matches consumer reality: hoisted
// deps in `/nix/store/…`. In a dev checkout, bun's isolated
// linker layout puts transitive deps under `node_modules/.bun/…`
// that the per-entry symlink cannot reach (astro's `require(
// 'piccolore')` walks up from the staged path and fails), so
// this test always runs against the nix-built CLI where the
// hoisted layout matches production.
//
// **What the digest covers.** For each rendered `.html` page,
// three pieces of the reviewer-facing output. First, the
// frontmatter title Starlight renders in the head. Second, every
// `data-src` attribute value stamped by rehype-data-src — a plugin
// mutation that shifted end-line numbers would flip every anchor
// and trip the digest. Third, the visible text of the page —
// heading text, paragraph bodies, list items, link text.
//
// Chrome that shifts with the toolchain (rolldown chunk hashes,
// `astro-<hash>` scope classes, expressive-code's minified inline
// scripts, pagefind fingerprints) is stripped by `canonicalise`.
//
// **Regenerating.** When a legitimate pipeline change lands
// (a new rehype plugin, a Starlight upgrade), set
// `REVKIT_UPDATE_OWN_DIGEST=1` to make the test WRITE the
// fixture-digest file instead of asserting against it. A `just`
// recipe wraps this:
//
//     just update-own-digest
//
// Then commit the resulting `pipeline-digest.json`.
//
// **Guarded by `REVKIT_E2E_BUILD=1`** (which `just test` sets)
// because the test builds the nix package and spawns astro.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve as resolvePath } from "node:path";
import { parseHTML } from "linkedom";

const E2E = process.env.REVKIT_E2E_BUILD === "1";
const UPDATE = process.env.REVKIT_UPDATE_OWN_DIGEST === "1";

const CHECKOUT_ROOT = resolvePath(import.meta.dirname!, "..", "..", "..", "..");
const FIXTURE_SRC = resolvePath(import.meta.dirname!, "fixtures", "pipeline-fixture");
const DIGEST_PATH = resolvePath(import.meta.dirname!, "fixtures", "pipeline-digest.json");

let consumerRoot: string;
let distDir: string;

const cleanup: string[] = [];
afterAll(() => {
  for (const d of cleanup) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* fine */
    }
  }
});

beforeAll(() => {
  if (!E2E) return;
  // Build the nix package to warm the store path. The store output
  // is retained by the daemon, so a follow-up `revkit build` call
  // finds `bin/revkit` fast.
  const store = execSync(`nix build .#revkit --no-link --print-out-paths`, {
    cwd: CHECKOUT_ROOT,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .at(-1)!;
  const revkitBin = join(store, "bin", "revkit");
  expect(existsSync(revkitBin)).toBe(true);

  // Copy the fixture to a scratch dir. Build writes to
  // `<consumer>/.revkit/{build,dist,cache}/`; a build under the
  // committed fixtures dir would leave state the `EXCLUDED_DIRS`
  // walk still surfaces on a re-run.
  consumerRoot = mkdtempSync(join(tmpdir(), "revkit-pipeline-fixture-"));
  cleanup.push(consumerRoot);
  cpSync(FIXTURE_SRC, consumerRoot, {
    recursive: true,
    dereference: true,
    filter: (from) => !from.includes(".revkit/"),
  });
  rmSync(join(consumerRoot, ".revkit"), { recursive: true, force: true });

  execSync(`"${revkitBin}" build --dir "${consumerRoot}"`, {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: mkdtempSync(join(tmpdir(), "revkit-pipeline-home-")),
    },
  });
  distDir = join(consumerRoot, ".revkit", "dist");
  expect(existsSync(distDir)).toBe(true);
}, 15 * 60 * 1000);

/** Canonicalise HTML for the "same pipeline output" check. Uses
 * linkedom to parse (regex-based tag stripping trips CodeQL's
 * `js/bad-tag-filter` on `<SCRIPT>` bypasses; a real parser
 * handles that). Preserves:
 *
 *   - `<title>` text;
 *   - every `data-src` attribute value (order-sensitive within
 *     a page, so a plugin change that reordered anchors would
 *     also trip);
 *   - visible text — every text node NOT inside a
 *     `<script>/<style>/<template>`.
 *
 * Everything else is chrome. */
export function canonicalise(html: string): string {
  const { document } = parseHTML(html);
  const title = document.title ?? "";
  const anchors = Array.from(document.querySelectorAll("[data-src]"))
    .map((el) => el.getAttribute("data-src") ?? "");
  const CHROME: ReadonlySet<string> = new Set(["SCRIPT", "STYLE", "TEMPLATE"]);
  const textFragments: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      const t = (node.textContent ?? "").trim();
      if (t.length > 0) textFragments.push(t.replace(/\s+/g, " "));
      return;
    }
    if (node.nodeType !== 1 /* ELEMENT_NODE */) return;
    const el = node as Element;
    if (CHROME.has(el.tagName.toUpperCase())) return;
    for (const child of Array.from(el.childNodes)) walk(child as Node);
  };
  walk(document.documentElement as unknown as Node);
  return (
    "TITLE:" + title +
    "\nANCHORS:\n" + anchors.join("\n") +
    "\nTEXT:\n" + textFragments.join("\n")
  );
}

/** Walk `root` and return `<rel-path>: sha256(canonicalise(html))`
 * for every `.html` file. `pagefind` is skipped (it changes with
 * Node bumps). */
function digestHtml(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const stack: string[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const entry of readdirSync(cur)) {
      const abs = join(cur, entry);
      const st = statSync(abs);
      if (st.isDirectory()) {
        if (entry === "pagefind") continue;
        stack.push(abs);
      } else if (st.isFile() && entry.endsWith(".html")) {
        const bytes = readFileSync(abs, "utf8");
        const rel = relative(root, abs);
        out[rel] = createHash("sha256").update(canonicalise(bytes)).digest("hex");
      }
    }
  }
  return Object.fromEntries(Object.entries(out).sort());
}

describe.skipIf(!E2E)("pipeline-digest — fixed docs fixture through the packaged flow", () => {
  test("the built page set + per-page canonical hash matches the committed digest", () => {
    const digest = digestHtml(distDir);
    expect(Object.keys(digest).length).toBeGreaterThan(0);

    if (UPDATE) {
      // Regenerate mode. Writes the digest and passes — the
      // developer commits the updated JSON.
      writeFileSync(DIGEST_PATH, JSON.stringify(digest, null, 2) + "\n");
      // eslint-disable-next-line no-console
      console.log( // guardrails-ok(no-debug-leftovers): the recipe wants this
        "REVKIT_UPDATE_OWN_DIGEST=1: wrote " + DIGEST_PATH,
      );
      return;
    }

    if (!existsSync(DIGEST_PATH)) {
      throw new Error(
        "pipeline-digest: missing committed digest at " + DIGEST_PATH + ". " +
          "Run `just update-own-digest` (or `REVKIT_UPDATE_OWN_DIGEST=1 " +
          "REVKIT_E2E_BUILD=1 bun test test/build/own-build-unchanged.test.ts`) " +
          "to generate it, then commit the result.",
      );
    }
    const committed: Record<string, string> = JSON.parse(readFileSync(DIGEST_PATH, "utf8"));
    try {
      expect(Object.entries(digest).sort()).toEqual(Object.entries(committed).sort());
    } catch (error) {
      const hint =
        "\n\nIf this shift is INTENTIONAL (a plugin change, a Starlight upgrade), " +
        "regenerate the digest:\n" +
        "  just update-own-digest\n" +
        "  # or:\n" +
        "  REVKIT_UPDATE_OWN_DIGEST=1 REVKIT_E2E_BUILD=1 bun test test/build/own-build-unchanged.test.ts\n" +
        "and commit fixtures/pipeline-digest.json.\n" +
        "If it is UNINTENTIONAL, look for a change to `astro.config.mjs`, " +
        "the rehype plugins, or the docs loader.\n";
      if (error instanceof Error) {
        error.message += hint;
      }
      throw error;
    }
  }, 15 * 60 * 1000);

  test("digest CATCHES a plugin mutation on line numbers (end.line + 1)", () => {
    // Read the fixture's index.html directly; canonicalise it,
    // then simulate a plugin mutation by rewriting every
    // `data-src` end-line to end.line + 1. If the canonical form
    // is stable across the mutation, the digest is not tied to
    // the plugin output — the guard would be useless. This
    // asserts the mutation flips the canonical output.
    const files = Object.keys(digestHtml(distDir));
    expect(files.length).toBeGreaterThan(0);
    const firstWithAnchor = files.find((f) => {
      const html = readFileSync(join(distDir, f), "utf8");
      return /data-src="[^"]+:\d+-\d+"/.test(html);
    });
    expect(firstWithAnchor).toBeDefined();
    const original = readFileSync(join(distDir, firstWithAnchor!), "utf8");
    const canonicalOriginal = canonicalise(original);

    const mutated = original.replace(
      /(data-src="[^:"]+:\d+-)(\d+)"/g,
      (_m, prefix: string, endLine: string) => `${prefix}${Number(endLine) + 1}"`,
    );
    expect(mutated).not.toBe(original);
    const canonicalMutated = canonicalise(mutated);
    expect(canonicalMutated).not.toBe(canonicalOriginal);
  }, 60_000);
});
