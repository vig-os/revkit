// The CLI's version, derived from `packages/cli/package.json` — the ONE place a
// release version is written (ADR-0021; the prepare-release seam stamps it).
// There is deliberately no second literal: the flake package reads the same file.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "../package.json" with { type: "json" };

/** Bare SemVer of this build, from `package.json`. */
export const VERSION: string = manifest.version;

/** Env var the Nix wrapper sets to the flake source's short revision. */
export const BUILD_REV_ENV = "REVKIT_BUILD_REV";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Short source revision of this build, or undefined when unknown.
 * Nix builds carry it in `REVKIT_BUILD_REV` (from `self.shortRev`); a source
 * checkout asks git, and only when the checkout IS this repo. */
export function buildRevision(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const fromEnv = env[BUILD_REV_ENV];
  if (fromEnv && fromEnv !== "unknown") return fromEnv;
  const top = spawnSync("git", ["-C", repoRoot, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (top.status !== 0 || resolve(top.stdout.trim()) !== repoRoot) return undefined;
  const rev = spawnSync("git", ["-C", repoRoot, "rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
  });
  return rev.status === 0 ? rev.stdout.trim() || undefined : undefined;
}

/** What `revkit --version` prints: `X.Y.Z (<rev>)`, or `X.Y.Z` with no known rev.
 * A candidate (`X.Y.Z-rcN` tag) reports the base `X.Y.Z` plus its rev. */
export function versionLine(rev: string | undefined = buildRevision()): string {
  return rev ? `${VERSION} (${rev})` : VERSION;
}
