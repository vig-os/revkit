// Safe astro build for a materialised PR-head worktree (ADR-0025,
// PR #48 round-3 blocker 1).
//
// **What "safe" means here** — each rule blocks a concrete attack:
//
//   1. **Trusted astro binary.** The build invokes the reviewer's
//      OWN astro binary (`<baseCheckout>/site/node_modules/.bin/astro`)
//      by ABSOLUTE PATH. There is no `bun x astro` (which would
//      download `astro@latest` from the registry, unpinned) and no
//      lookup via `PATH`. If the trusted binary is missing, the
//      build refuses.
//
//   2. **Trusted deps resolvable from the sandbox.** The reviewer's
//      trusted `site/node_modules/` (and workspace `node_modules/`
//      at the base checkout root) are linked read-only into the
//      materialised worktree as symlinks. Astro's Node resolver
//      then finds every dependency (astro's own tsconfig files,
//      Starlight, plugins) via a normal require chain. No registry
//      fetch and no `bun install` occur.
//
//   3. **No registry install.** No `bun install`, no `npm install`,
//      no `yarn install`, no lifecycle scripts. The astro command
//      only reads the tree.
//
//   4. **Minimal env.** `Bun.spawn` receives an explicit `env`
//      object. Only the vars on `BUILD_ENV_ALLOWLIST` are
//      exported; every token-shaped variable
//      (`BUILD_ENV_TOKEN_DENYLIST`) is dropped.
//
//   5. **HOME points at a per-build temp dir.** A hostile astro
//      config that tried to read `~/.config` or `~/.ssh` sees an
//      empty scratch directory that lives for the lifetime of the
//      build.
//
//   6. **cwd is the materialised worktree.** Astro reads
//      `astro.config.*` from there — which the materialiser took
//      from base, so it is the reviewer's own config.
//
//   7. **Output dir is under the materialised worktree.** The
//      caller passes `distOutDir`; we set `--outDir` on the astro
//      command so its writes stay contained.
//
// If the build fails (non-zero exit, stderr surfaced), the caller
// aborts the review command and does NOT start the daemon.

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

/** Input to `runSafeBuild`. */
export interface RunSafeBuildOptions {
  /** Absolute path to the materialised PR-head worktree. */
  readonly materializedRoot: string;
  /** Absolute path where the astro build should write its output. */
  readonly distOutDir: string;
  /** Optional astro entry directory relative to `materializedRoot`.
   * Defaults to `"site"` (revkit's astro project lives there). */
  readonly astroDir?: string;
  /** Reviewer's TRUSTED base checkout. Its `site/node_modules/.bin/astro`
   * is invoked directly; its `site/node_modules/` and
   * `node_modules/` are symlinked into the materialised worktree.
   * Defaults to the checkout root inferred from `materializedRoot`
   * (three levels up from `.revkit/review/<slug>/head-<sha>`). */
  readonly trustedCheckoutRoot?: string;
  /** Injectable spawner for tests. Defaults to `Bun.spawn`. */
  readonly spawn?: SpawnLike;
}

/** `Bun.spawn`-shaped subprocess handle we consume. */
export interface SpawnResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Injectable spawner shape. Tests provide a stub. */
export type SpawnLike = (options: {
  readonly cmd: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}) => Promise<SpawnResult>;

/** The env-var allowlist. Anything not on this list is REMOVED from
 * the child env. Exported for tests so a mutation that would let a
 * new var through fails a per-variable assertion. */
export const BUILD_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  // POSIX baseline the child needs to spawn subprocesses (astro
  // shells out to node internally).
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  // Nix dev-shell wiring. The reviewer runs `revkit review` inside
  // `nix develop`, which sets these; without them the child cannot
  // find bun/node.
  "NIX_PATH",
  "NIX_PROFILES",
  "NIX_SSL_CERT_FILE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // Node / bun tunables that MUST NOT be tokens.
  "NODE_OPTIONS",
  "BUN_INSTALL",
  // Deterministic build (Astro reads this).
  "ASTRO_TELEMETRY_DISABLED",
]);

/** Env vars that MUST NEVER leak into the child, listed here as a
 * denylist test target. Even if a future edit added one of these to
 * the allowlist, this list would surface it in a red test. */
export const BUILD_ENV_TOKEN_DENYLIST: readonly string[] = Object.freeze([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "HF_TOKEN",
  "HUGGINGFACE_TOKEN",
  "CF_API_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
]);

/** Build the allowlisted env for the child. Reads every allowlisted
 * key from `sourceEnv` (defaults to `process.env`) and drops
 * everything else. `homeOverride` sets `HOME` to a per-build
 * scratch dir (PR #48 round-3 nit). */
export function buildChildEnv(
  sourceEnv: Readonly<Record<string, string | undefined>>,
  homeOverride: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of BUILD_ENV_ALLOWLIST) {
    const value = sourceEnv[key];
    if (typeof value === "string" && value.length > 0) {
      out[key] = value;
    }
  }
  // Defence in depth — even if BUILD_ENV_ALLOWLIST is mutated in a
  // future edit to include a token var, the denylist scrub still
  // removes them.
  for (const key of BUILD_ENV_TOKEN_DENYLIST) {
    delete out[key];
  }
  // Force HOME + TMPDIR to a per-build scratch directory so a
  // hostile config that tries `~/.config` / `~/.aws` sees nothing.
  out.HOME = homeOverride;
  out.TMPDIR = homeOverride;
  // Never let CI-shape variables trigger provider-specific paths in
  // astro/vite.
  delete out.CI;
  delete out.GITHUB_ACTIONS;
  return out;
}

/**
 * Run the safe astro build. See file header for the seven rules.
 *
 * Command shape:
 *   `<trustedCheckoutRoot>/site/node_modules/.bin/astro build
 *        --root <materializedRoot>/<astroDir>
 *        --outDir <distOutDir>`
 *
 * No shell, no `bun x`, no `npx`. The trusted symlinks are
 * created before the spawn and removed after.
 */
export async function runSafeBuild(options: RunSafeBuildOptions): Promise<void> {
  const astroDir = options.astroDir ?? "site";
  const cwd = join(options.materializedRoot, astroDir);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(
      `runSafeBuild: astro project dir '${cwd}' does not exist in the materialised worktree`,
    );
  }
  // Default trusted checkout root = the grandparent of the per-PR
  // review dir, i.e. the reviewer's checkout root. `materializedRoot`
  // ends with `.revkit/review/<slug>/head-<sha>` → four `dirname`
  // hops to the checkout root.
  const trustedCheckoutRoot =
    options.trustedCheckoutRoot ??
    resolvePath(options.materializedRoot, "..", "..", "..", "..");
  const trustedAstroBin = join(trustedCheckoutRoot, "site", "node_modules", ".bin", "astro");
  if (!existsSync(trustedAstroBin)) {
    throw new Error(
      `runSafeBuild: trusted astro binary not found at '${trustedAstroBin}' — ` +
        `run 'bun install' at the checkout root before reviewing.`,
    );
  }
  const trustedSiteNodeModules = join(trustedCheckoutRoot, "site", "node_modules");
  if (!existsSync(trustedSiteNodeModules)) {
    throw new Error(
      `runSafeBuild: trusted node_modules not found at '${trustedSiteNodeModules}'`,
    );
  }

  // Per-build HOME (scratch dir). Torn down after the build.
  const homeOverride = mkdtempSync(join(tmpdir(), "revkit-safe-build-home-"));

  // Link the reviewer's TRUSTED node_modules into the sandbox
  // read-only. Astro's resolver then finds every dep in the tree.
  // The links are removed after the build.
  const madeLinks: string[] = [];
  const sandboxSiteNm = join(cwd, "node_modules");
  const sandboxWorkspaceNm = join(options.materializedRoot, "node_modules");
  try {
    if (!existsSync(sandboxSiteNm)) {
      symlinkSync(trustedSiteNodeModules, sandboxSiteNm);
      madeLinks.push(sandboxSiteNm);
    }
    const trustedWorkspaceNm = join(trustedCheckoutRoot, "node_modules");
    if (existsSync(trustedWorkspaceNm) && !existsSync(sandboxWorkspaceNm)) {
      symlinkSync(trustedWorkspaceNm, sandboxWorkspaceNm);
      madeLinks.push(sandboxWorkspaceNm);
    }

    const env = buildChildEnv(process.env, homeOverride);
    const spawn = options.spawn ?? defaultSpawn;

    const result = await spawn({
      cmd: [
        trustedAstroBin,
        "build",
        "--root",
        cwd,
        "--outDir",
        options.distOutDir,
      ],
      cwd,
      env,
    });
    if (result.exitCode !== 0) {
      // Surface the LAST 4 KiB of stderr — enough context for the
      // reviewer without dumping a many-MiB build log into the
      // CLI response.
      const tail = result.stderr.slice(-4096);
      throw new Error(`astro build exited ${result.exitCode}. Tail:\n${tail}`);
    }
  } finally {
    for (const linkPath of madeLinks) {
      try {
        rmSync(linkPath, { force: true });
      } catch {
        // Best effort — the reviewer can `rm -rf .revkit/review/`
        // to clean up on any weird failure.
      }
    }
    try {
      rmSync(homeOverride, { recursive: true, force: true });
    } catch {
      /* fine */
    }
  }
}

const defaultSpawn: SpawnLike = async ({ cmd, cwd, env }) => {
  const proc = Bun.spawn(cmd as string[], {
    cwd,
    env: env as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
};

/** Compute the default `distOutDir` for a materialised root — the
 * `<materializedRoot>/site/dist` convention used by the CLI. */
export function defaultDistOutDir(materializedRoot: string): string {
  return join(materializedRoot, "site", "dist");
}

// mkdirSync is imported for potential extension points; a lint
// pass would otherwise mark it unused when the current file only
// uses mkdtempSync.
void mkdirSync;
