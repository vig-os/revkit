// Single-source-of-truth guard for the CLI version (#201, ADR-0021).
//
// `packages/cli/package.json` is the ONLY place a release version is written
// (by the prepare-release seam). Everything else derives from it: the CLI's
// `--version`, and the flake package's `version` attribute. These tests fail
// if a second literal appears or if a surface disagrees with the manifest.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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

/** Quoted strings that are a whole SemVer (`"1.2.3"`, `"1.2.3-rc1"`, `"1.2.3+b"`), comments skipped. */
const SEMVER_LITERAL = /(["'`])\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?\1/g;
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;

function semverLiteralsIn(source: string): string[] {
  return source
    .split("\n")
    .filter((line) => !COMMENT_LINE.test(line))
    .flatMap((line) => line.match(SEMVER_LITERAL) ?? []);
}

/** `file: literal` for every semver literal in package sources and the Worker config. The
 * only allowed one is the Worker's `REVKIT_VERSION` binding, which the release script
 * stamps and `worker-config.test.ts` pins to the manifest. */
function semverLiteralOffenders(root: string): string[] {
  const sources = readdirSync(join(root, "packages")).flatMap((pkg) =>
    ["src", "bin"].flatMap((dir) => {
      const base = join(root, "packages", pkg, dir);
      return existsSync(base) ? filesUnder(base, /\.(tsx?|mjs|js)$/) : [];
    }),
  );
  const wrangler = join(root, "packages/worker/wrangler.jsonc");
  const stampedBinding = /"REVKIT_VERSION"\s*:\s*"[^"]*"/;
  return [...sources, wrangler].flatMap((file) => {
    const text = readFileSync(file, "utf8");
    const scanned = file === wrangler ? text.replace(stampedBinding, "") : text;
    return semverLiteralsIn(scanned).map((literal) => `${relative(root, file)}: ${literal}`);
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

  test("no semver literal in CLI/worker sources or the worker config beyond the stamped binding", () => {
    const offenders = semverLiteralOffenders(repoRoot);
    expect(offenders).toEqual([]);
  });

  test("the detector catches a second literal under any name (mutation)", () => {
    const hits = (source: string) => semverLiteralsIn(source);
    expect(hits('const cliVersion = "0.0.0"; export const VERSION = cliVersion')).toHaveLength(1);
    expect(hits("const v = `1.2.3-rc1`")).toHaveLength(1);
    expect(hits("export const pinned = '10.20.30+build.5'")).toHaveLength(1);
    expect(hits('// the "1.4.0" example in a comment\n/* "2.0.0" */\n * "3.0.0"')).toEqual([]);
    expect(hits('const dotted = "1.2"; const ip = "10.0.0.1"')).toEqual([]);
  });

  test("no version literal in the nix package or flake", () => {
    const literal = /^\s*version\s*=\s*"/m;
    const files = [join(repoRoot, "nix/revkit-package.nix"), join(repoRoot, "flake.nix")];
    expect(files.filter((file) => literal.test(readFileSync(file, "utf8")))).toEqual([]);
  });

  test("the scaffolded template pins a final X.Y.Z tag and does not float on a branch", () => {
    const flake = readFileSync(join(repoRoot, "templates/default/flake.nix"), "utf8");
    const url = flake.match(/^\s*revkit\.url\s*=\s*"([^"]+)"/m)?.[1] ?? "";
    expect(url).toMatch(/^github:vig-os\/revkit\?ref=\d+\.\d+\.\d+$/);
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
