// Unit tests for the `revkit build` packaged flow (issue #57, M5
// part 2). These cover the parts that DO NOT need a full astro
// spawn — layout, defaults, trusted-binary detection, staging
// symlinks, katex materialisation. An e2e test that spawns astro
// against the real packaged CLI lives in
// `packaged-e2e.test.ts` (guarded by `REVKIT_E2E_BUILD=1`).

import { afterEach, describe, expect, test } from "bun:test";
import {
  consumerCacheDirs,
  defaultConsumerDist,
  defaultConsumerStaging,
  findPackagedAstroBin,
  findPackagedTrustedStack,
  inferPackageRoot,
  stageAstroRoot,
  writeKatexAssets,
} from "../../src/build/packaged.ts";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* fine */
    }
  }
});

function mkdtemp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

describe("defaultConsumerDist / defaultConsumerStaging / consumerCacheDirs", () => {
  test("dist lives at <consumer>/.revkit/dist", () => {
    expect(defaultConsumerDist("/tmp/x")).toBe("/tmp/x/.revkit/dist");
  });
  test("staging lives at <consumer>/.revkit/build", () => {
    expect(defaultConsumerStaging("/tmp/x")).toBe("/tmp/x/.revkit/build");
  });
  test("cache dirs live under <consumer>/.revkit/cache", () => {
    const caches = consumerCacheDirs("/tmp/x");
    expect(caches.astro).toBe("/tmp/x/.revkit/cache/astro");
    expect(caches.vite).toBe("/tmp/x/.revkit/cache/vite");
  });
});

describe("inferPackageRoot — walks 4 dirs up from packages/cli/src/build/", () => {
  test("resolves to the workspace root", () => {
    // Simulate: import.meta.url of packages/cli/src/build/foo.ts
    const fromUrl = `file:///tmp/some-checkout/packages/cli/src/build/foo.ts`;
    expect(inferPackageRoot(fromUrl)).toBe("/tmp/some-checkout");
  });
});

describe("findPackagedTrustedStack — picks hoisted (packaged) OR isolated (dev)", () => {
  function scaffoldPackageRoot(): string {
    const root = mkdtemp("stack-");
    mkdirSync(join(root, "packages", "cli"), { recursive: true });
    mkdirSync(join(root, "site"), { recursive: true });
    return root;
  }
  test("prefers hoisted layout when <root>/node_modules/.bin/astro exists AND @astrojs/starlight is there", () => {
    const root = scaffoldPackageRoot();
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(root, "node_modules", ".bin", "astro"), "#!/bin/sh\n");
    mkdirSync(join(root, "node_modules", "@astrojs", "starlight"), { recursive: true });
    const stack = findPackagedTrustedStack(root);
    expect(stack.layout).toBe("hoisted");
    expect(stack.astroBin).toBe(join(root, "node_modules", ".bin", "astro"));
    expect(stack.nodeModulesDir).toBe(join(root, "node_modules"));
  });
  test("falls back to isolated (dev) layout when only site/node_modules has starlight", () => {
    const root = scaffoldPackageRoot();
    mkdirSync(join(root, "site", "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(root, "site", "node_modules", ".bin", "astro"), "#!/bin/sh\n");
    mkdirSync(join(root, "site", "node_modules", "@astrojs", "starlight"), { recursive: true });
    const stack = findPackagedTrustedStack(root);
    expect(stack.layout).toBe("isolated");
    expect(stack.astroBin).toBe(join(root, "site", "node_modules", ".bin", "astro"));
  });
  test("throws when neither layout is present — NEVER falls back to PATH / bunx", () => {
    const root = scaffoldPackageRoot();
    expect(() => findPackagedTrustedStack(root)).toThrow(/trusted astro stack not found/);
  });
  test("throws when astro binary is there but starlight is not (a misassembled package)", () => {
    const root = scaffoldPackageRoot();
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(root, "node_modules", ".bin", "astro"), "#!/bin/sh\n");
    // No @astrojs/starlight — should fall through.
    expect(() => findPackagedTrustedStack(root)).toThrow(/trusted astro stack not found/);
  });
  test("legacy findPackagedAstroBin still works (delegates)", () => {
    const root = scaffoldPackageRoot();
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(root, "node_modules", ".bin", "astro"), "#!/bin/sh\n");
    mkdirSync(join(root, "node_modules", "@astrojs", "starlight"), { recursive: true });
    expect(findPackagedAstroBin(root)).toBe(join(root, "node_modules", ".bin", "astro"));
  });
});

describe("stageAstroRoot — builds a writable astro root at <staging>", () => {
  function scaffoldPackagedSite(root: string): void {
    // Minimal packaged site: astro.config.mjs, package.json, tsconfig.json,
    // scripts/, src/{content.config.ts, lib/*, content/{schemas,utils,
    // loaders,i18n,index.mdx,docs/*}, styles/}.
    mkdirSync(join(root, "site", "src", "content", "docs"), { recursive: true });
    mkdirSync(join(root, "site", "src", "lib"), { recursive: true });
    mkdirSync(join(root, "site", "src", "content", "schemas"), { recursive: true });
    mkdirSync(join(root, "site", "src", "content", "loaders"), { recursive: true });
    mkdirSync(join(root, "site", "src", "content", "i18n"), { recursive: true });
    mkdirSync(join(root, "site", "src", "content", "utils"), { recursive: true });
    mkdirSync(join(root, "site", "scripts"), { recursive: true });
    writeFileSync(join(root, "site", "astro.config.mjs"), "export default {};\n");
    writeFileSync(join(root, "site", "package.json"), "{}");
    writeFileSync(join(root, "site", "tsconfig.json"), "{}");
    writeFileSync(join(root, "site", "src", "content.config.ts"), "export const collections = {};\n");
    writeFileSync(join(root, "site", "src", "content", "index.mdx"), "---\ntitle: x\n---\n");
    writeFileSync(
      join(root, "site", "src", "content", "docs", "revkit-splash.mdx"),
      "---\ntitle: splash\n---\n",
    );
  }
  function scaffoldPackagedNodeModules(root: string): string {
    const nm = join(root, "node_modules");
    mkdirSync(join(nm, ".bin"), { recursive: true });
    writeFileSync(join(nm, ".bin", "astro"), "#!/bin/sh\n");
    mkdirSync(join(nm, "@astrojs", "starlight"), { recursive: true });
    mkdirSync(join(nm, "@astrojs", "mdx"), { recursive: true });
    mkdirSync(join(nm, "@revkit", "components"), { recursive: true });
    mkdirSync(join(nm, "astro"), { recursive: true });
    return nm;
  }
  test("stages every packaged-site entry as a symlink and copies consumer docs in", () => {
    const packageRoot = mkdtemp("pkg-");
    scaffoldPackagedSite(packageRoot);
    const nodeModulesDir = scaffoldPackagedNodeModules(packageRoot);
    const consumerRoot = mkdtemp("consumer-");
    mkdirSync(join(consumerRoot, "docs"), { recursive: true });
    writeFileSync(join(consumerRoot, "docs", "index.mdx"), "---\ntitle: c\n---\n# consumer\n");
    mkdirSync(join(consumerRoot, "docs", "sub"), { recursive: true });
    writeFileSync(join(consumerRoot, "docs", "sub", "page.md"), "# subpage\n");

    const stagingDir = join(consumerRoot, ".revkit", "build");
    stageAstroRoot({
      consumerRoot,
      packageRoot,
      stagingDir,
      trustedStack: { astroBin: join(nodeModulesDir, ".bin", "astro"), nodeModulesDir, layout: "hoisted" },
    });

    // Top-level: astro.config.mjs is a symlink to packaged.
    const cfg = join(stagingDir, "astro.config.mjs");
    expect(lstatSync(cfg).isSymbolicLink()).toBe(true);
    expect(readlinkSync(cfg)).toBe(join(packageRoot, "site", "astro.config.mjs"));

    // src/ is a REAL dir (not a symlink), src/lib is a symlink.
    expect(lstatSync(join(stagingDir, "src")).isDirectory()).toBe(true);
    expect(lstatSync(join(stagingDir, "src")).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(stagingDir, "src", "lib")).isSymbolicLink()).toBe(true);

    // src/content is a REAL dir; src/content/schemas is a symlink.
    expect(lstatSync(join(stagingDir, "src", "content")).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(stagingDir, "src", "content", "schemas")).isSymbolicLink()).toBe(true);

    // src/content/docs is REAL and contains a COPY of the consumer's tree.
    const stagedDocs = join(stagingDir, "src", "content", "docs");
    expect(lstatSync(stagedDocs).isSymbolicLink()).toBe(false);
    const indexStat = lstatSync(join(stagedDocs, "index.mdx"));
    expect(indexStat.isSymbolicLink()).toBe(false); // COPY, not symlink (issue #57)
    expect(indexStat.isFile()).toBe(true);
    expect(readFileSync(join(stagedDocs, "index.mdx"), "utf8")).toContain("# consumer");
    expect(readFileSync(join(stagedDocs, "sub", "page.md"), "utf8")).toContain("# subpage");

    // node_modules is a REAL dir with per-entry symlinks; scoped
    // packages get their inner entries per-package (real scope dir).
    const nmStaged = join(stagingDir, "node_modules");
    expect(lstatSync(nmStaged).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(nmStaged, "astro")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(nmStaged, "@astrojs")).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(nmStaged, "@astrojs", "starlight")).isSymbolicLink()).toBe(true);

    // public/ is a REAL dir even when packaged has none.
    expect(lstatSync(join(stagingDir, "public")).isSymbolicLink()).toBe(false);
  });
  test("refuses when the consumer has no docs/ tree — no silent-empty output", () => {
    const packageRoot = mkdtemp("pkg-");
    scaffoldPackagedSite(packageRoot);
    const nodeModulesDir = scaffoldPackagedNodeModules(packageRoot);
    const consumerRoot = mkdtemp("consumer-");
    // No docs/ dir.
    const stagingDir = join(consumerRoot, ".revkit", "build");
    expect(() =>
      stageAstroRoot({
        consumerRoot,
        packageRoot,
        stagingDir,
        trustedStack: { astroBin: join(nodeModulesDir, ".bin", "astro"), nodeModulesDir, layout: "hoisted" },
      }),
    ).toThrow(/consumer's docs directory not found/);
  });
  test("nukes a previous staging (stale symlinks / renamed dirs) before re-populating", () => {
    const packageRoot = mkdtemp("pkg-");
    scaffoldPackagedSite(packageRoot);
    const nodeModulesDir = scaffoldPackagedNodeModules(packageRoot);
    const consumerRoot = mkdtemp("consumer-");
    mkdirSync(join(consumerRoot, "docs"), { recursive: true });
    writeFileSync(join(consumerRoot, "docs", "index.mdx"), "---\ntitle: c\n---\n");
    const stagingDir = join(consumerRoot, ".revkit", "build");
    // Seed a stale file that must be nuked.
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(join(stagingDir, "stale-file.txt"), "leftover");

    stageAstroRoot({
      consumerRoot,
      packageRoot,
      stagingDir,
      trustedStack: { astroBin: join(nodeModulesDir, ".bin", "astro"), nodeModulesDir, layout: "hoisted" },
    });
    expect(existsSync(join(stagingDir, "stale-file.txt"))).toBe(false);
  });
});

describe("writeKatexAssets — copies katex.min.css + woff2 fonts into staging public", () => {
  function scaffoldKatex(nodeModulesDir: string): void {
    const dist = join(nodeModulesDir, "katex", "dist");
    mkdirSync(join(dist, "fonts"), { recursive: true });
    writeFileSync(join(nodeModulesDir, "katex", "package.json"), '{"version":"0.42.0"}');
    writeFileSync(join(dist, "katex.min.css"), "/* katex */\n");
    // Some fonts.
    writeFileSync(join(dist, "fonts", "KaTeX_Main-Regular.woff2"), "font-bytes");
    writeFileSync(join(dist, "fonts", "KaTeX_Math-Italic.woff2"), "font-bytes");
    // Non-woff2 must be ignored.
    writeFileSync(join(dist, "fonts", "KaTeX_Main-Regular.ttf"), "ttf-bytes");
  }
  test("copies katex.min.css + only *.woff2 fonts + writes README stamp", () => {
    const packageRoot = mkdtemp("pkg-");
    const nm = join(packageRoot, "node_modules");
    mkdirSync(nm, { recursive: true });
    scaffoldKatex(nm);
    const stagingPublic = mkdtemp("public-");

    const outcome = writeKatexAssets({ nodeModulesDir: nm, stagingPublic });
    expect(outcome).not.toBeNull();
    expect(outcome!.copied).toBe(2);
    expect(outcome!.version).toBe("0.42.0");
    expect(existsSync(join(stagingPublic, "_katex", "katex.min.css"))).toBe(true);
    expect(existsSync(join(stagingPublic, "_katex", "fonts", "KaTeX_Main-Regular.woff2"))).toBe(true);
    expect(existsSync(join(stagingPublic, "_katex", "fonts", "KaTeX_Math-Italic.woff2"))).toBe(true);
    expect(existsSync(join(stagingPublic, "_katex", "fonts", "KaTeX_Main-Regular.ttf"))).toBe(false);
    expect(readFileSync(join(stagingPublic, "_katex", "README.txt"), "utf8")).toContain("katex@0.42.0");
  });
  test("returns null when katex is absent from node_modules (no throw)", () => {
    const nm = mkdtemp("nm-");
    const stagingPublic = mkdtemp("public-");
    expect(writeKatexAssets({ nodeModulesDir: nm, stagingPublic })).toBeNull();
  });
});

describe("consumer-root plumbing — the site's own build is unchanged when the env is unset", () => {
  // A direct integration test would spawn astro; that's covered by
  // packaged-e2e.test.ts. Here we verify the ONE-BIT invariant:
  // `readConsumerRoot()` returns null when the env var is absent
  // (a regression that flipped null to `"" ` would make every
  // consumer-mode branch fire in revkit's own build).
  test("readConsumerRoot returns null when the env is unset", async () => {
    const prev = process.env.REVKIT_CONSUMER_ROOT;
    delete process.env.REVKIT_CONSUMER_ROOT;
    try {
      // Import lazily so the module reads the mutated env.
      const mod = await import("../../../../site/src/lib/consumer-root.ts?empty=" + Date.now());
      expect(mod.readConsumerRoot()).toBeNull();
    } finally {
      if (prev !== undefined) process.env.REVKIT_CONSUMER_ROOT = prev;
    }
  });
  test("readConsumerRoot rejects a relative path — a fat-finger caller must not silently render the cwd", async () => {
    const prev = process.env.REVKIT_CONSUMER_ROOT;
    process.env.REVKIT_CONSUMER_ROOT = "some/relative/path";
    try {
      const mod = await import("../../../../site/src/lib/consumer-root.ts?rel=" + Date.now());
      expect(() => mod.readConsumerRoot()).toThrow(/must be an absolute path/);
    } finally {
      if (prev === undefined) delete process.env.REVKIT_CONSUMER_ROOT;
      else process.env.REVKIT_CONSUMER_ROOT = prev;
    }
  });
  test("readConsumerRoot returns the absolute path when set", async () => {
    const prev = process.env.REVKIT_CONSUMER_ROOT;
    process.env.REVKIT_CONSUMER_ROOT = "/tmp/some-consumer";
    try {
      const mod = await import("../../../../site/src/lib/consumer-root.ts?abs=" + Date.now());
      expect(mod.readConsumerRoot()).toBe("/tmp/some-consumer");
    } finally {
      if (prev === undefined) delete process.env.REVKIT_CONSUMER_ROOT;
      else process.env.REVKIT_CONSUMER_ROOT = prev;
    }
  });
});
