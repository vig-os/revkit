// End-to-end test for the `revkit build` packaged flow (issue #57,
// M5 part 2). Runs the REAL packaged CLI (via `nix build .#revkit`)
// against a temp consumer repo and asserts:
//
//   1. Astro produced HTML at `<consumer>/.revkit/dist/` — a page
//      whose body contains the consumer's own doc text.
//   2. The packaged CLI store path is unchanged after the build
//      (mtimes / sizes / directory listing). The nix store is
//      READ-ONLY; if `revkit build` writes anywhere inside it, this
//      test flips to red.
//   3. The staging tree includes `.revkit/dist/`, `.revkit/build/`,
//      `.revkit/cache/{astro,vite}/` — the layout documented in
//      DESIGN-0002 §5.
//   4. NO `bunx` / `npx` / `bun x` string is anywhere in the built
//      CLI's source under $out — the "trusted toolchain, absolute
//      path" rule is enforced.
//
// Guarded by `REVKIT_E2E_BUILD=1` (which `just test` sets) so a
// lightweight test lane can opt out. The test builds the package
// with `nix build --no-link --print-out-paths` before running.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

const E2E = process.env.REVKIT_E2E_BUILD === "1";
const CHECKOUT_ROOT = resolvePath(import.meta.dirname!, "..", "..", "..", "..");

let PKG_STORE: string | null = null;
const cleanupDirs: string[] = [];

// `beforeAll` is bounded by a default 5s hook timeout in bun.
// `nix build .#revkit` on a cold cache takes minutes. Give it 20
// minutes explicitly (bun's second arg to beforeAll). CI's `Tests`
// job passes REVKIT_E2E_BUILD=1 which flips this test on; the
// revkit-flake matrix already builds `.#revkit` in a sibling job so
// the store path is warm-cached in the same nix daemon.
beforeAll(async () => {
  if (!E2E) return;
  // Build the package. Captures the store path so the test can
  // invoke `$STORE/bin/revkit` directly.
  const output = execSync(`nix build .#revkit --no-link --print-out-paths`, {
    cwd: CHECKOUT_ROOT,
    encoding: "utf8",
  }).trim();
  PKG_STORE = output.split("\n").at(-1)!.trim();
}, 20 * 60 * 1000);

afterAll(() => {
  for (const d of cleanupDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* fine */
    }
  }
});

function scaffoldConsumer(): string {
  const c = mkdtempSync(join(tmpdir(), "revkit-e2e-consumer-"));
  cleanupDirs.push(c);
  writeFileSync(join(c, "package.json"), JSON.stringify({ name: "e2e-consumer", revkit: {} }));
  mkdirSync(join(c, "docs"));
  writeFileSync(
    join(c, "docs", "index.mdx"),
    `---\ntitle: E2E Consumer\ndescription: A test.\n---\n\nimport { Callout } from "@revkit/components";\n\n## Distinct Marker Text 12345\n\nBody paragraph.\n\n<Callout kind="info">Rail-tested content.</Callout>\n`,
  );
  mkdirSync(join(c, "vocab"));
  writeFileSync(
    join(c, "vocab", "terms.yaml"),
    `schemaVersion: 1\nentries:\n  - id: anchor\n    term: anchor\n    definition: The point a comment attaches to.\n`,
  );
  return c;
}

/** Snapshot every regular file's `size:mtimeMs` under `root`. Used
 * to prove the packaged CLI store path was NOT touched during the
 * build (nix store is read-only; a write would corrupt the closure). */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
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
        out.set(abs.slice(root.length), `${st.size}:${st.mtimeMs}`);
      }
    }
  }
  return out;
}

describe.skipIf(!E2E)("revkit build — packaged CLI e2e", () => {
  test("builds consumer docs to .revkit/dist and does not touch the packaged store path", () => {
    expect(PKG_STORE).not.toBeNull();
    const store = PKG_STORE!;
    const revkitBin = join(store, "bin", "revkit");
    expect(existsSync(revkitBin)).toBe(true);

    const consumer = scaffoldConsumer();

    // The claim this test now pins EXPLICITLY (M2 item 9, PR-56): a
    // normal consumer has no `site/` directory and therefore no
    // `site/node_modules/.bin/astro`. Any build path that shelled out
    // to that binary works in the revkit checkout — where the dev
    // shell has it — and fails for every consumer. The daemon's
    // background builds go through this same primitive, so proving
    // the primitive works WITHOUT the consumer-side binary is what
    // makes a background build safe to schedule.
    expect(existsSync(join(consumer, "site"))).toBe(false);
    expect(existsSync(join(consumer, "site", "node_modules", ".bin", "astro"))).toBe(false);
    expect(existsSync(join(consumer, "node_modules"))).toBe(false);

    // Snapshot the packaged libexec BEFORE the build. Under the
    // read-only-store contract, this must be byte-identical after.
    const before = snapshot(join(store, "libexec"));

    // Run: revkit build --dir <consumer>
    const stdout = execSync(`"${revkitBin}" build --dir "${consumer}"`, {
      encoding: "utf8",
      env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), "e2e-home-")) },
    });
    expect(stdout).toContain("astro ok");
    expect(stdout).toContain("check-dist ok");

    // Consumer dist has HTML with the consumer's marker text.
    const distIndex = join(consumer, ".revkit", "dist", "index.html");
    expect(existsSync(distIndex)).toBe(true);
    const body = readFileSync(distIndex, "utf8");
    expect(body).toContain("Distinct Marker Text 12345");
    expect(body).toContain("Rail-tested content");
    // The title should include the frontmatter title.
    expect(body).toMatch(/<title>[^<]*E2E Consumer[^<]*<\/title>/);

    // Staging + cache dirs exist under `.revkit/`.
    expect(existsSync(join(consumer, ".revkit", "build"))).toBe(true);
    expect(existsSync(join(consumer, ".revkit", "cache", "astro"))).toBe(true);
    expect(existsSync(join(consumer, ".revkit", "cache", "vite"))).toBe(true);

    // Packaged store path is byte-for-byte unchanged. Nothing was
    // written under the nix store during the build.
    const after = snapshot(join(store, "libexec"));
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
  }, 360_000);

  test("packaged CLI source contains no `bunx` / `bun x` / `npx` — trusted-toolchain-by-abs-path rule", () => {
    expect(PKG_STORE).not.toBeNull();
    const store = PKG_STORE!;
    const libexec = join(store, "libexec");
    // Scan every JS/TS file in the packaged CLI source for
    // command-shell tokens that would spawn a registry-fetching
    // subprocess. `packages/cli/` is the only part that could
    // dispatch a subprocess. Comments are stripped first — the
    // rule is about ACTUAL usage; a comment that explains "no
    // bunx" should not trip the guard.
    const cliDir = join(libexec, "revkit", "packages", "cli", "src");
    const stack: string[] = [cliDir];
    const hits: string[] = [];
    // Character class for quote / apostrophe / backtick, built by
    // char code to sidestep the parser's confusion with an inline
    // mixed-quote character class.
    const q = String.fromCharCode(34) + String.fromCharCode(39) + String.fromCharCode(96);
    const cls = "[" + q + "]";
    const patterns = [
      new RegExp(cls + "bunx\\b"),
      new RegExp(cls + "bun\\s+x\\b"),
      new RegExp(cls + "npx\\b"),
    ];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const entry of readdirSync(cur)) {
        const abs = join(cur, entry);
        const st = statSync(abs);
        if (st.isDirectory()) {
          stack.push(abs);
          continue;
        }
        if (!/\.(ts|js|mjs|cjs)$/.test(entry)) continue;
        const raw = readFileSync(abs, "utf8");
        const stripped = raw
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/[^\n]*/g, "");
        for (const pattern of patterns) {
          const match = stripped.match(pattern);
          if (match) {
            hits.push(abs.slice(cliDir.length) + " matched " + String(pattern));
          }
        }
      }
    }
    expect(hits).toEqual([]);
  }, 60_000);

  test("consumer with no docs/ fails cleanly (never writes an empty dist)", () => {
    expect(PKG_STORE).not.toBeNull();
    const store = PKG_STORE!;
    const revkitBin = join(store, "bin", "revkit");
    const consumer = mkdtempSync(join(tmpdir(), "e2e-nodocs-"));
    cleanupDirs.push(consumer);
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "no-docs", revkit: {} }));
    // No docs/ dir.
    let exit = 0;
    try {
      execSync(`"${revkitBin}" build --dir "${consumer}"`, {
        encoding: "utf8",
        env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), "e2e-home-")) },
      });
    } catch (err) {
      exit = (err as { status?: number }).status ?? 1;
    }
    expect(exit).not.toBe(0);
    expect(existsSync(join(consumer, ".revkit", "dist", "index.html"))).toBe(false);
  }, 120_000);
});
