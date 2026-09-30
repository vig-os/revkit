// End-to-end: builds the REAL revkit site through the safe build,
// then runs check-dist against the output, and additionally proves
// that the reviewer's own `site/node_modules/.astro` and
// `.../.vite` are byte-for-byte unchanged after the build (PR #48
// round-4 blocker 2).
//
// The test:
//   1. Copies the current checkout's `site/`, `packages/components`
//      exports map, `plots/`, `vocab/`, `docs/` and root
//      `package.json` into a scratch "materialised" tree that
//      mirrors what `materializeSafeTree` would produce for a
//      one-line PR change to `site/src/content/docs/index.mdx`.
//   2. Snapshots the file list + mtimes of the reviewer's real
//      `site/node_modules/.astro` and `.../.vite`.
//   3. Runs `runSafeBuild` — the real one, no spawn injection.
//   4. Re-snapshots those two dirs and asserts they are
//      byte-for-byte unchanged.
//   5. Runs `check-dist` on the built output.
//
// Guarded by `REVKIT_E2E_BUILD=1` so a lightweight test lane can
// opt out; `just test` sets the flag.

import { afterAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative as relativePath, resolve as resolvePath } from "node:path";
import { defaultDistOutDir, runSafeBuild } from "../../src/review/build.ts";
import { checkDistDirectory } from "../../src/check-dist.ts";

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

/** Build a materialised worktree that mirrors the checkout for a
 * benign one-line PR change to `docs/index.mdx`. The "PR" change is
 * a single character appended to a paragraph, well inside the
 * `<Callout>` island — enough for astro to build a page. */
function scaffoldMaterialisedPr(): string {
  // Under `<trusted-checkout>/site/.revkit-review/<slug>/head-<sha>/`
  // — the SAME layout production `revkit review` uses, so node
  // module resolution walking up from `<sandbox>/site/` reaches
  // the trusted `site/node_modules/` naturally. The scaffold uses
  // an e2e-specific slug so it never collides with a real review.
  const materialised = join(
    CHECKOUT_ROOT,
    "site",
    ".revkit-review",
    "vig-os-revkit-e2e",
    "head-abcdef012345",
  );
  // If a prior test run left the tree behind, remove it before
  // rebuilding.
  try {
    rmSync(materialised, { recursive: true, force: true });
  } catch {
    /* fine */
  }
  mkdirSync(materialised, { recursive: true });
  // Copy in the tooling from the reviewer's checkout — this is
  // what `materializeSafeTree` would do for a content-only PR
  // (tooling from base). We copy top-level pieces first, then
  // walk `site/` MANUALLY, skipping `.revkit-review/` (which is
  // itself where the sandbox lives — recursively copying it
  // would loop).
  for (const path of ["packages", "plots", "vocab", "docs", "package.json", "bun.lock"]) {
    const src = join(CHECKOUT_ROOT, path);
    const dst = join(materialised, path);
    if (!existsSync(src)) continue;
    cpSync(src, dst, {
      recursive: true,
      dereference: false,
      filter: (from) =>
        !from.includes("node_modules") &&
        !from.includes(".astro") &&
        !from.includes(".vite") &&
        !from.endsWith("/dist"),
    });
  }
  // Copy `site/` piece by piece, skipping `.revkit-review/`.
  const siteSrc = join(CHECKOUT_ROOT, "site");
  const siteDst = join(materialised, "site");
  mkdirSync(siteDst, { recursive: true });
  for (const entry of readdirSync(siteSrc)) {
    if (entry === "node_modules" || entry === ".astro" || entry === ".vite" || entry === "dist") continue;
    if (entry === ".revkit-review") continue;
    const entrySrc = join(siteSrc, entry);
    const entryDst = join(siteDst, entry);
    cpSync(entrySrc, entryDst, {
      recursive: true,
      dereference: false,
      filter: (from) =>
        !from.includes("node_modules") &&
        !from.includes(".astro") &&
        !from.includes(".vite") &&
        !from.endsWith("/dist"),
    });
  }
  // The "PR change": append one paragraph to index.mdx.
  const indexPath = join(materialised, "site", "src", "content", "docs", "index.mdx");
  const base = readFileSync(indexPath, "utf8");
  writeFileSync(indexPath, base + "\n\nA one-line PR change appended by the e2e test.\n");
  dirs.push(materialised);
  return materialised;
}

/** Snapshot of {path → sha256(bytes), mtime} for every regular
 * file inside `root`. Directories, symlinks and non-regular entries
 * are ignored — we only care about content and timestamps of files
 * astro / vite might write. */
function snapshotTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(root)) return out;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = join(cur, entry);
      let st;
      try {
        st = statSync(abs, { throwIfNoEntry: false });
      } catch {
        continue;
      }
      if (st === undefined) continue;
      if (st.isDirectory()) {
        stack.push(abs);
      } else if (st.isFile()) {
        // Hash + size + mtimeMs — a build that touched the file
        // would move mtime OR change contents.
        const hash = new Bun.CryptoHasher("sha256").update(readFileSync(abs)).digest("hex");
        const rel = relativePath(root, abs);
        out.set(rel, `${hash}:${st.size}:${st.mtimeMs}`);
      }
    }
  }
  return out;
}

const E2E = process.env.REVKIT_E2E_BUILD === "1";

describe.skipIf(!E2E)("real safe-build against the checkout's own site", () => {
  test("builds the materialised site, produces HTML, check-dist passes, and does NOT touch reviewer's node_modules cache dirs", async () => {
    // Preflight: trusted astro must exist.
    const trustedAstro = join(CHECKOUT_ROOT, "site", "node_modules", ".bin", "astro");
    expect(existsSync(trustedAstro)).toBe(true);

    // Snapshot the "cache" dirs inside the reviewer's real
    // node_modules BEFORE the build. Under the old bug, astro
    // wrote `.astro/data-store.json` and `.vite/deps/*` here via
    // the symlink.
    const trustedAstroCache = join(CHECKOUT_ROOT, "site", "node_modules", ".astro");
    const trustedViteCache = join(CHECKOUT_ROOT, "site", "node_modules", ".vite");
    const beforeAstro = snapshotTree(trustedAstroCache);
    const beforeVite = snapshotTree(trustedViteCache);

    const materialised = scaffoldMaterialisedPr();
    const distOutDir = defaultDistOutDir(materialised);
    await runSafeBuild({
      materializedRoot: materialised,
      distOutDir,
      trustedCheckoutRoot: CHECKOUT_ROOT,
    });

    // Some HTML got written.
    // Astro writes the site root as `docs/index.html` when the
    // `base` is `/revkit` (starlight config). Walk the dist to
    // find any index.html — that's proof the build produced pages.
    let firstHtml: string | undefined;
    const stack: string[] = [distOutDir];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const entry of readdirSync(cur)) {
        const abs = join(cur, entry);
        const st = statSync(abs);
        if (st.isDirectory()) stack.push(abs);
        else if (entry.endsWith(".html") && firstHtml === undefined) firstHtml = abs;
      }
    }
    expect(firstHtml).toBeDefined();
    expect(readFileSync(firstHtml!, "utf8").length).toBeGreaterThan(100);

    // Reviewer's caches — byte-for-byte unchanged. Under the old
    // symlink-writes-through-to-trusted bug this would flip.
    const afterAstro = snapshotTree(trustedAstroCache);
    const afterVite = snapshotTree(trustedViteCache);
    expect([...afterAstro.entries()].sort()).toEqual([...beforeAstro.entries()].sort());
    expect([...afterVite.entries()].sort()).toEqual([...beforeVite.entries()].sort());

    // check-dist on the built output.
    const diags = checkDistDirectory(distOutDir);
    // Any surprise inline handlers / off-list script hashes
    // would fail here; we expect none.
    expect(diags).toEqual([]);
  }, 240_000);
});
