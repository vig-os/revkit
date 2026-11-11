// The prepare-release seam's stamping script (#201): what the seam runs on
// `release/X.Y.Z`, tested directly because a workflow-level dry run is not
// available.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain ESM script, no type declarations
import { stampVersion } from "../../../scripts/set-release-version.mjs";

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
  return { file, code: proc.exitCode, out: proc.stdout.toString().trim(), err: proc.stderr.toString() };
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

  test("the repository's real manifest is stampable", () => {
    const real = readFileSync(resolve(dirname(script), "../packages/cli/package.json"), "utf8");
    expect(stampVersion(real, "0.1.0")).toContain('"version": "0.1.0"');
  });
});
