import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { findPackagedTrustedStack, stageAstroRoot } from "../../src/build/packaged.ts";

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
