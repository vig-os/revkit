import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { astroNodeOptions, findPackagedTrustedStack, runPackagedBuild, stageAstroRoot, stagedAstroEntry } from "../../src/build/packaged.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "revkit-isolated-"));
  roots.push(root);
  return root;
}
function consumer(): string {
  const root = scratch();
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "package.json"), '{"name":"revkit","private":true}\n');
  writeFileSync(join(root, "docs", "index.md"),
    "---\ntitle: Consumer build reproduction\n---\n\n# Consumer build reproduction\n\nA minimal document.\n");
  return root;
}
function linkPackage(nodeModules: string, name: string, target: string): void {
  const dest = join(nodeModules, name);
  mkdirSync(dirname(dest), { recursive: true });
  symlinkSync(target, dest);
}

// Node must preserve staging aliases, just as Astro/Vite do in consumer mode.
// Walking from physical package paths would hide the missing dependencies.
const probe = `
  const { createRequire } = require('node:module');
  const { readFileSync, realpathSync } = require('node:fs');
  const { dirname, join } = require('node:path');
  const seen = new Set();
  function walk(dir) {
    if (seen.has(realpathSync(dir))) return;
    seen.add(realpathSync(dir));
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const req = createRequire(join(dir, 'package.json'));
    for (const name of Object.keys(manifest.dependencies || {})) {
      walk(dirname(req.resolve(name)));
    }
  }
  const root = process.argv[1];
  walk(join(root, 'alpha'));
  walk(join(root, 'beta'));
  for (const name of ['alpha', 'beta']) {
    const req = createRequire(join(root, name, 'package.json'));
    console.log(name + ':' + req('shared'));
  }
  const bundledRequire = createRequire(join(root, '..', 'prerender.cjs'));
  console.log('bundled:' + bundledRequire('@scope/bridge'));
  console.log('packages:' + seen.size);
`;

test("isolated staging resolves the complete dependency graph, cycles, scopes and conflicting versions", async () => {
  const packageRoot = scratch();
  const site = join(packageRoot, "site");
  mkdirSync(join(site, "src", "content"), { recursive: true });
  writeFileSync(join(site, "package.json"), "{}");
  const nm = join(site, "node_modules");
  mkdirSync(nm);
  function pkg(slot: string, name: string, dependencies: Record<string, string> = {}): string {
    const dir = join(packageRoot, "node_modules", ".bun", slot, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      name, main: "index.cjs", dependencies, optionalDependencies: { "absent-platform-package": "*" },
    }));
    writeFileSync(join(dir, "index.cjs"), `module.exports = ${JSON.stringify(slot)};\n`);
    return dir;
  }
  const alpha = pkg("alpha", "alpha", { shared: "1", "@scope/bridge": "1" });
  const beta = pkg("beta", "beta", { shared: "2" });
  const shared1 = pkg("one", "shared", { "@scope/bridge": "1" });
  const shared2 = pkg("two", "shared");
  const bridge = pkg("bridge", "@scope/bridge", { alpha: "1" });
  linkPackage(dirname(alpha), "shared", shared1);
  linkPackage(dirname(alpha), "@scope/bridge", bridge);
  linkPackage(dirname(beta), "shared", shared2);
  linkPackage(dirname(shared1), "@scope/bridge", bridge);
  linkPackage(resolve(bridge, "../.."), "alpha", alpha);
  linkPackage(nm, "alpha", alpha);
  linkPackage(nm, "beta", beta);
  const consumerRoot = consumer();
  const stagingDir = join(consumerRoot, ".revkit", "build");
  stageAstroRoot({ consumerRoot, packageRoot, stagingDir,
    trustedStack: { nodeModulesDir: nm, astroBin: join(nm, ".bin", "astro"), layout: "isolated" },
  });
  const child = Bun.spawn(["node", "--preserve-symlinks", "-e", probe, join(stagingDir, "node_modules")],
    { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(stdout).toContain("alpha:one");
  expect(stdout).toContain("beta:two");
  expect(stdout).toContain("packages:5");
  expect(stdout).toContain("bundled:bridge");
});

// #238: Bun's shared fallback folder (`node_modules/.bun/node_modules`) holds
// ONE version per name. A package that Astro reaches through a sibling link in
// Astro's own store slot must still resolve its dependencies from its own slot,
// i.e. from revkit's staged graph. The fallback deliberately holds an
// incompatible `leaf`, so a launch that resolves through Bun's store renders
// `leaf@1` (the 9.2.0 hast-util-raw / parse5 7 failure, in miniature).
test("astro launches from the staged graph, never from Bun's fallback folder", async () => {
  const packageRoot = scratch();
  const store = join(packageRoot, "node_modules", ".bun");
  const site = join(packageRoot, "site");
  mkdirSync(join(site, "src", "content"), { recursive: true });
  writeFileSync(join(site, "package.json"), "{}");
  function pkg(slot: string, name: string, manifest: Record<string, unknown>, files: Record<string, string>): string {
    const dir = join(store, slot, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, ...manifest }));
    for (const [file, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), body);
    }
    return dir;
  }
  const leaf1 = pkg("leaf@1", "leaf", { main: "index.cjs" }, { "index.cjs": 'module.exports = "leaf@1";\n' });
  const leaf2 = pkg("leaf@2", "leaf", { main: "index.cjs" }, { "index.cjs": 'module.exports = "leaf@2";\n' });
  const mid = pkg("mid@1", "mid", { main: "index.cjs", dependencies: { leaf: "2" } },
    { "index.cjs": 'module.exports = require("leaf");\n' });
  const astro = pkg("astro@1", "astro", { type: "module", bin: { astro: "./bin/astro.mjs" }, dependencies: { mid: "1" } }, {
    "bin/astro.mjs": [
      "#!/usr/bin/env node",
      'import { writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'import { fileURLToPath } from "node:url";',
      'import leaf from "mid";',
      'const outDir = process.argv[process.argv.indexOf("--outDir") + 1];',
      'writeFileSync(join(outDir, "index.html"), JSON.stringify({ leaf, entry: fileURLToPath(import.meta.url) }));',
      "",
    ].join("\n"),
  });
  chmodSync(join(astro, "bin", "astro.mjs"), 0o755);
  const starlight = pkg("@astrojs+starlight@1", "@astrojs/starlight", { main: "index.cjs" }, { "index.cjs": "" });
  linkPackage(dirname(astro), "mid", mid);
  linkPackage(dirname(mid), "leaf", leaf2);
  // Bun's fallback folder: one hoisted version per name, incompatible with mid.
  linkPackage(join(store, "node_modules"), "leaf", leaf1);
  linkPackage(join(store, "node_modules"), "mid", mid);
  const nm = join(site, "node_modules");
  linkPackage(nm, "astro", astro);
  linkPackage(nm, "@astrojs/starlight", starlight);
  linkPackage(join(nm, ".bin"), "astro", "../astro/bin/astro.mjs");
  expect(findPackagedTrustedStack(packageRoot).layout).toBe("isolated");

  const consumerRoot = consumer();
  const distOutDir = join(consumerRoot, ".revkit", "dist");
  mkdirSync(distOutDir, { recursive: true });
  const { stagingDir } = await runPackagedBuild({ consumerRoot, packageRoot, distOutDir });
  const rendered = JSON.parse(readFileSync(join(distOutDir, "index.html"), "utf8")) as { leaf: string; entry: string };
  expect(rendered.leaf).toBe("leaf@2");
  expect(rendered.entry.startsWith(join(realpathSync(stagingDir), "node_modules") + "/")).toBe(true);
});

test("the staged astro entry honours npm's bin forms and stays inside the package", () => {
  const stagingDir = scratch();
  const astroDir = join(stagingDir, "node_modules", "astro");
  mkdirSync(astroDir, { recursive: true });
  const manifest = (bin: unknown) => writeFileSync(join(astroDir, "package.json"), JSON.stringify({ name: "astro", bin }));
  manifest({ astro: "./bin/astro.mjs" });
  expect(stagedAstroEntry(stagingDir)).toBe(join(astroDir, "bin", "astro.mjs"));
  manifest("cli.js");
  expect(stagedAstroEntry(stagingDir)).toBe(join(astroDir, "cli.js"));
  manifest({ other: "x.js" });
  expect(() => stagedAstroEntry(stagingDir)).toThrow("declares no 'astro' bin");
  manifest({ astro: "../../evil.js" });
  expect(() => stagedAstroEntry(stagingDir)).toThrow("escapes its package");
  expect(astroNodeOptions(undefined)).toBe("--preserve-symlinks-main");
  expect(astroNodeOptions("--max-old-space-size=2048")).toBe("--max-old-space-size=2048 --preserve-symlinks-main");
});

test("the CLI builds the issue's minimal consumer and passes check-dist from a clean temp directory", async () => {
  const root = consumer();
  const cli = resolve(import.meta.dir, "../../bin/revkit.js");
  const child = Bun.spawn([process.execPath, cli, "build", "--dir", root],
    { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(stdout).toContain("revkit build: check-dist ok");
  expect(readFileSync(join(root, ".revkit", "dist", "index.html"), "utf8")).toContain("A minimal document.");
  const stack = findPackagedTrustedStack(resolve(import.meta.dir, "../../../.."));
  expect(stack.layout).toBe("isolated");
});
