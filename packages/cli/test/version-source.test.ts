// Single-source-of-truth guard for the CLI version (#201, ADR-0021).
//
// `packages/cli/package.json` is the ONLY place a release version is written
// (by the prepare-release seam). Everything else derives from it: the CLI's
// `--version`, and the flake package's `version` attribute. These tests fail
// if a second literal appears or if a surface disagrees with the manifest.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatch } from "../src/index.ts";
import type { DispatchEnv } from "../src/index.ts";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(cliRoot, "../..");
const manifest = JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8")) as {
  version: string;
};

const env: DispatchEnv = {
  cwd: "/",
  gh: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  repoSlug: "vig-os/revkit",
};

function filesUnder(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules") return [];
    return statSync(path).isDirectory() ? filesUnder(path, ext) : ext.test(name) ? [path] : [];
  });
}

describe("version source of truth", () => {
  test("package.json carries a SemVer version", () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });

  test("`revkit --version` is the manifest version, optionally with a build revision", async () => {
    const result = await dispatch(["--version"], env);
    const escaped = manifest.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(result.stdout).toMatch(new RegExp(`^${escaped}( \\([0-9a-z-]+\\))?\\n$`));
  });

  test("no second version literal in CLI sources", () => {
    const assignment = /\bVERSION\b[^=\n]*=\s*["'`]\d+\.\d+\.\d+/;
    const offenders = filesUnder(join(cliRoot, "src"), /\.tsx?$/).filter((file) =>
      assignment.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  test("no version literal in the nix package or flake", () => {
    const literal = /^\s*version\s*=\s*"/m;
    const files = [join(repoRoot, "nix/revkit-package.nix"), join(repoRoot, "flake.nix")];
    expect(files.filter((file) => literal.test(readFileSync(file, "utf8")))).toEqual([]);
  });

  test("the scaffolded template pins a tag and does not float on a branch", () => {
    const flake = readFileSync(join(repoRoot, "templates/default/flake.nix"), "utf8");
    const url = flake.match(/^\s*revkit\.url\s*=\s*"([^"]+)"/m)?.[1] ?? "";
    expect(url).toMatch(/^github:vig-os\/revkit\?ref=\d+\.\d+\.\d+(-rc\d+)?$/);
  });

  const hasNix = Bun.which("nix") !== null;
  test.skipIf(!hasNix)(
    "flake package `version` equals the manifest version",
    async () => {
      const proc = Bun.spawn(
        [
          "nix",
          "eval",
          "--raw",
          "--impure",
          "--expr",
          `(builtins.getFlake (toString ${repoRoot})).packages.\${builtins.currentSystem}.revkit.version`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(out).toBe(manifest.version);
    },
    120_000,
  );
});
