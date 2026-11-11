// The prepare-release seam's stamping script (#201): what the seam runs on
// `release/X.Y.Z`, tested directly because a workflow-level dry run is not
// available.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain ESM script, no type declarations
import { stampRefPins, stampVersion, stampWorkerVar, TARGETS } from "../../../scripts/set-release-version.mjs";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/set-release-version.mjs");
const manifest = '{\n  "name": "@revkit/cli",\n  "version": "0.0.0",\n  "private": true,\n  "dependencies": { "x": "1.2.3" }\n}\n';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], text = manifest) {
  const dir = mkdtempSync(join(tmpdir(), "revkit-stamp-"));
  dirs.push(dir);
  const file = join(dir, "package.json");
  writeFileSync(file, text);
  const proc = Bun.spawnSync(["node", script, ...args, "--file", file]);
  return { file, code: proc.exitCode, out: proc.stdout.toString().trim().split("\n")[0], err: proc.stderr.toString() };
}

describe("set-release-version", () => {
  test("stamps X.Y.Z and preserves every other byte", () => {
    const r = run(["0.1.0"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("changed");
    expect(readFileSync(r.file, "utf8")).toBe(manifest.replace('"0.0.0"', '"0.1.0"'));
  });

  test("is idempotent (re-running the seam is a no-op)", () => {
    const r = run(["0.0.0"]);
    expect(r.out).toBe("unchanged");
    expect(readFileSync(r.file, "utf8")).toBe(manifest);
  });

  test("--dry-run reports the change and writes nothing", () => {
    const r = run(["2.0.0", "--dry-run"]);
    expect(r.out).toBe("changed");
    expect(readFileSync(r.file, "utf8")).toBe(manifest);
  });

  test("does not touch dependency version strings", () => {
    expect(stampVersion(manifest, "9.9.9")).toContain('"x": "1.2.3"');
  });

  for (const bad of ["0.1.0-rc1", "v0.1.0", "1.2", "01.2.3", ""]) {
    test(`refuses non-release version ${JSON.stringify(bad)}`, () => {
      const r = run([bad]);
      expect(r.code).not.toBe(0);
      expect(readFileSync(r.file, "utf8")).toBe(manifest);
    });
  }

  test("refuses a manifest without a version line", () => {
    const r = run(["0.1.0"], '{ "name": "x" }\n');
    expect(r.code).toBe(1);
  });

  test("rewrites the top-level version, not an earlier nested one", () => {
    const nested = '{\n  "name": "x",\n  "config": { "version": "7.7.7" },\n  "list": [{ "version": "8.8.8" }],\n  "version": "0.0.0"\n}\n';
    const r = run(["0.1.0"], nested);
    expect(r.code).toBe(0);
    expect(readFileSync(r.file, "utf8")).toBe(nested.replace('"version": "0.0.0"', '"version": "0.1.0"'));
  });

  test("ignores a \"version\" string value and escaped quotes before the key", () => {
    const tricky = '{ "note": "say \\"version\\": \\"1.1.1\\"", "version": "0.0.0" }';
    expect(stampVersion(tricky, "0.2.0")).toBe(tricky.replace('"version": "0.0.0"', '"version": "0.2.0"'));
  });

  test("refuses a trailing --file with no value", () => {
    const proc = Bun.spawnSync(["node", script, "0.1.0", "--file"]);
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr.toString()).toContain("--file needs a value");
  });

  test("refuses --file followed by another flag", () => {
    const proc = Bun.spawnSync(["node", script, "0.1.0", "--file", "--dry-run"]);
    expect(proc.exitCode).not.toBe(0);
  });

  test("stampWorkerVar rewrites only REVKIT_VERSION and demands exactly one", () => {
    const cfg = '{\n  // c\n  "vars": { "REVKIT_VERSION": "0.0.0", "OTHER": "0.0.0" }\n}\n';
    expect(stampWorkerVar(cfg, "0.1.0")).toBe(cfg.replace('"REVKIT_VERSION": "0.0.0"', '"REVKIT_VERSION": "0.1.0"'));
    expect(() => stampWorkerVar('{ "vars": {} }', "0.1.0")).toThrow(/exactly one/);
  });

  test("stampRefPins moves every pin and demands at least one", () => {
    const text = 'a "github:vig-os/revkit?ref=0.1.0-rc1" b\nnix flake init -t github:vig-os/revkit?ref=0.0.9\nkeep github:vig-os/revkit/<sha>';
    expect(stampRefPins(text, "0.1.0")).toBe(
      'a "github:vig-os/revkit?ref=0.1.0" b\nnix flake init -t github:vig-os/revkit?ref=0.1.0\nkeep github:vig-os/revkit/<sha>',
    );
    expect(() => stampRefPins("no pin here", "0.1.0")).toThrow(/no `github:vig-os\/revkit\?ref=` pin/);
  });

  test("stamping the repository layout moves the manifest, the Worker var and every pin", () => {
    const repo = resolve(dirname(script), "..");
    const dir = mkdtempSync(join(tmpdir(), "revkit-stamp-root-"));
    dirs.push(dir);
    for (const [path] of TARGETS) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      cpSync(join(repo, path), join(dir, path));
    }
    const proc = Bun.spawnSync(["node", script, "4.5.6", "--root", dir]);
    expect(proc.exitCode).toBe(0);
    const [status, ...changed] = proc.stdout.toString().trim().split("\n");
    expect(status).toBe("changed");
    expect(changed.sort()).toEqual(TARGETS.map(([path]) => path).sort());
    const read = (path: string) => readFileSync(join(dir, path), "utf8");
    expect(JSON.parse(read("packages/cli/package.json")).version).toBe("4.5.6");
    expect(read("packages/worker/wrangler.jsonc")).toContain('"REVKIT_VERSION": "4.5.6"');
    for (const path of ["templates/default/flake.nix", "templates/default/README.md", "README.md", "templates/skills/revkit/SKILL.md"]) {
      expect(read(path)).toContain("github:vig-os/revkit?ref=4.5.6");
      expect(read(path)).not.toMatch(/revkit\?ref=(?!4\.5\.6)/);
    }
    const again = Bun.spawnSync(["node", script, "4.5.6", "--root", dir]);
    expect(again.stdout.toString().trim()).toBe("unchanged");
  });

  test("the repository's real manifest is stampable", () => {
    const real = readFileSync(resolve(dirname(script), "../packages/cli/package.json"), "utf8");
    expect(stampVersion(real, "0.1.0")).toContain('"version": "0.1.0"');
  });
});
