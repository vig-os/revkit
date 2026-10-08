import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stageAstroRoot } from "../../src/build/packaged.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const outer = mkdtempSync(join(tmpdir(), "revkit-stage-validation-"));
  dirs.push(outer);
  const packageRoot = join(outer, "install");
  const source = join(packageRoot, "site", "node_modules");
  const consumerRoot = join(outer, "consumer");
  const stagingDir = join(consumerRoot, ".revkit", "build");
  mkdirSync(source, { recursive: true });
  mkdirSync(join(packageRoot, "site", "src", "content"), { recursive: true });
  mkdirSync(join(consumerRoot, "docs"), { recursive: true });
  function pkg(slot: string, name: string, manifest: unknown): string {
    const path = join(packageRoot, "node_modules", ".bun", slot, "node_modules", name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "package.json"), JSON.stringify(manifest));
    writeFileSync(join(path, "index.cjs"), `module.exports = ${JSON.stringify(slot)};\n`);
    return path;
  }
  function link(at: string, name: string, to: string): void {
    const path = join(at, name);
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(to, path);
  }
  function stage(): void {
    stageAstroRoot({ packageRoot, consumerRoot, stagingDir,
      trustedStack: { nodeModulesDir: source, astroBin: join(source, ".bin", "astro"), layout: "isolated" },
    });
  }
  return { outer, packageRoot, source, stagingDir, pkg, link, stage };
}

for (const name of ["", "..", "../escape", "/absolute", "bad\\name", "@scope/../escape"]) {
  test(`rejects unsafe package manifest name ${JSON.stringify(name)}`, () => {
    const f = fixture();
    f.link(f.source, "alpha", f.pkg("alpha", "alpha", { name }));
    expect(f.stage).toThrow(/invalid package manifest.*name/i);
  });
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    test(`rejects unsafe ${field} key ${JSON.stringify(name)}`, () => {
      const f = fixture();
      f.link(f.source, "alpha", f.pkg("alpha", "alpha", { name: "alpha", [field]: { [name]: "*" } }));
      expect(f.stage).toThrow(/invalid package manifest.*package name/i);
    });
  }
}

for (const manifest of [null, {}, { name: 42 }, { name: "alpha", dependencies: [] },
  { name: "alpha", dependencies: { beta: 42 } }]) {
  test(`rejects malformed nested package manifest ${JSON.stringify(manifest)}`, () => {
    const f = fixture();
    const alpha = f.pkg("alpha", "alpha", { name: "alpha", dependencies: { beta: "*" } });
    const beta = f.pkg("beta", "beta", manifest);
    f.link(dirname(alpha), "beta", beta);
    f.link(f.source, "alpha", alpha);
    expect(f.stage).toThrow(/invalid package manifest/i);
  });
}

test("root fallback uses Bun's hoisted version while package-local links retain both versions", () => {
  const f = fixture();
  const alpha = f.pkg("alpha", "alpha", { name: "alpha", dependencies: { shared: "1" } });
  const beta = f.pkg("beta", "beta", { name: "beta", dependencies: { shared: "2" } });
  const shared1 = f.pkg("one", "shared", { name: "shared", main: "index.cjs" });
  const shared2 = f.pkg("two", "shared", { name: "shared", main: "index.cjs" });
  f.link(dirname(alpha), "shared", shared1);
  f.link(dirname(beta), "shared", shared2);
  f.link(f.source, "alpha", alpha);
  f.link(f.source, "beta", beta);
  // Make Bun’s choice differ from the first package visited, regardless
  // of the filesystem’s directory enumeration order.
  const hoisted = readdirSync(f.source)[0] === "alpha" ? shared2 : shared1;
  f.link(join(f.packageRoot, "node_modules", ".bun", "node_modules"), "shared", hoisted);
  f.stage();
  function slot(name: string): string {
    return readFileSync(join(f.stagingDir, "node_modules", name, "index.cjs"), "utf8");
  }
  expect(slot("shared")).toBe(readFileSync(join(hoisted, "index.cjs"), "utf8"));
  expect(slot("alpha/node_modules/shared")).toContain('"one"');
  expect(slot("beta/node_modules/shared")).toContain('"two"');
});

test("required dependencies installed only above the trusted root are reported missing", () => {
  const f = fixture();
  const outside = join(f.outer, "node_modules", "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "package.json"), '{"name":"outside"}');
  const alpha = f.pkg("alpha", "alpha", { name: "alpha", dependencies: { outside: "*" } });
  f.link(f.source, "alpha", alpha);
  expect(f.stage).toThrow("dependency 'outside' of 'alpha' is missing from the trusted install");
});
