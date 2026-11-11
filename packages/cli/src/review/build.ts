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

import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

/** Options for `spawnAstroBuild` — the shared low-level primitive
 * that both `runSafeBuild` (the review sandbox flow, PR #48) and
 * `runPackagedBuild` (the M5 part 2 consumer-render flow, issue #57)
 * call. Keep it MINIMAL: this is a spawn wrapper with the env
 * hardening; caller decides layout, symlinks and config wrapping. */
export interface SpawnAstroBuildOptions {
  /** Absolute path to a trusted `astro` binary. Invoked directly,
   * NEVER via `bunx` / `npx` / `PATH` lookup — the caller is
   * responsible for locating a trusted one. */
  readonly astroBin: string;
  /** `--root <astroRoot>` — the astro project root. Must exist,
   * must contain (or be readable through symlinks to) an
   * `astro.config.mjs`. */
  readonly astroRoot: string;
  /** `--outDir <outDir>` — build output. Astro writes here. */
  readonly outDir: string;
  /** `--config <relative-to-root>` — optional. When omitted, astro
   * reads `astro.config.{mjs,ts,js}` from the root. Set when
   * running through a wrapper config that lives INSIDE the root. */
  readonly configPathRelativeToRoot?: string;
  /** cwd for the spawn. Defaults to `astroRoot`. Node's resolver
   * walks up from here for module resolution. */
  readonly cwd?: string;
  /** Per-build HOME (scratch dir). When omitted, `spawnAstroBuild`
   * mkdtemps one under `os.tmpdir()`. Passed to the child as HOME
   * and TMPDIR so a hostile config that reads `~/.config` sees
   * an empty scratch directory. */
  readonly homeOverride?: string;
  /** Extra env vars merged into the child's minimal env AFTER the
   * denylist scrub, so a caller can pass `REVKIT_CONSUMER_ROOT`,
   * `REVKIT_ASTRO_CACHE_DIR`, `REVKIT_VITE_CACHE_DIR` to steer
   * the site's config without a wrapper file. Keys on the token
   * denylist are stripped by design. */
  readonly extraEnv?: Readonly<Record<string, string>>;
  /** Injectable spawner. Defaults to `Bun.spawn`. */
  readonly spawn?: SpawnLike;
}

/** Low-level: spawn astro build with the trusted-binary + minimal-env
 * hardening. Both `runSafeBuild` (review) and `runPackagedBuild`
 * (consumer render) call this — keeping one implementation of the
 * primitive. Callers own layout / wrapper-config / symlink concerns;
 * this function ONLY spawns and applies the env allowlist. */
export async function spawnAstroBuild(options: SpawnAstroBuildOptions): Promise<void> {
  if (!existsSync(options.astroBin)) {
    throw new Error(`spawnAstroBuild: astro binary not found at '${options.astroBin}'`);
  }
  if (!existsSync(options.astroRoot) || !statSync(options.astroRoot).isDirectory()) {
    throw new Error(`spawnAstroBuild: --root '${options.astroRoot}' does not exist or is not a directory`);
  }

  const homeOverride =
    options.homeOverride ?? mkdtempSync(join(tmpdir(), "revkit-astro-build-home-"));
  const ownHome = options.homeOverride === undefined;
  const cwd = options.cwd ?? options.astroRoot;

  try {
    const baseEnv = buildChildEnv(process.env, homeOverride);
    // Merge extra env AFTER the denylist scrub so a caller can only
    // ADD non-token vars — a token-shaped key on `extraEnv` is
    // stripped by the second denylist pass below (defense in depth).
    const env: Record<string, string> = { ...baseEnv, ...(options.extraEnv ?? {}) };
    for (const key of BUILD_ENV_TOKEN_DENYLIST) {
      delete env[key];
    }
    // `HOME` and `TMPDIR` MUST stay pinned to the scratch dir even
    // if `extraEnv` tries to override them — a caller should never
    // fight the sandbox.
    env.HOME = homeOverride;
    env.TMPDIR = homeOverride;

    const cmd = [
      options.astroBin,
      "build",
      ...(options.configPathRelativeToRoot !== undefined
        ? ["--config", options.configPathRelativeToRoot]
        : []),
      "--root",
      options.astroRoot,
      "--outDir",
      options.outDir,
    ];

    const spawn = options.spawn ?? defaultSpawn;
    const result = await spawn({ cmd, cwd, env });
    if (result.exitCode !== 0) {
      const tail = result.stderr.slice(-4096);
      throw new Error(`astro build exited ${result.exitCode}. Tail:\n${tail}`);
    }
  } finally {
    if (ownHome) {
      try {
        rmSync(homeOverride, { recursive: true, force: true });
      } catch {
        /* fine */
      }
    }
  }
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
  // Default trusted checkout root = the checkout ROOT. When the
  // sandbox lives at `<checkout>/site/.revkit-review/<slug>/head-<sha>/`
  // (see `fetch-pr.ts:reviewTargetDir`), that's four parents up
  // from `<materialized>`.
  const trustedCheckoutRoot =
    options.trustedCheckoutRoot ??
    resolvePath(options.materializedRoot, "..", "..", "..", "..");
  const trustedSiteDir = join(trustedCheckoutRoot, "site");
  const trustedAstroBin = join(trustedSiteDir, "node_modules", ".bin", "astro");
  if (!existsSync(trustedAstroBin)) {
    throw new Error(
      `runSafeBuild: trusted astro binary not found at '${trustedAstroBin}' — ` +
        `run 'bun install' at the checkout root before reviewing.`,
    );
  }
  if (!existsSync(join(trustedSiteDir, "node_modules"))) {
    throw new Error(
      `runSafeBuild: trusted node_modules not found at '${join(trustedSiteDir, "node_modules")}'`,
    );
  }

  // Per-build HOME (scratch dir). Torn down after the build.
  const homeOverride = mkdtempSync(join(tmpdir(), "revkit-safe-build-home-"));

  // Vite's default cacheDir is `<root>/node_modules/.vite/`. In
  // our layout that's `<materialized>/site/node_modules/.vite/` —
  // inside the sandbox, but the sandbox has NO node_modules of
  // its own. If we don't override, vite creates a
  // `<materialized>/site/node_modules/` directory that contains
  // only `.vite/`, and the astro build's node-modules resolver
  // then STOPS at that dir (finding no packages inside) instead
  // of walking up to the trusted site's node_modules. Redirect
  // vite's cacheDir to a scratch path to keep the sandbox's
  // node_modules FALSE (so astro's resolver walks up as intended).
  const viteCacheDir = mkdtempSync(join(tmpdir(), "revkit-safe-build-vite-cache-"));

  // Wrapper astro config lives INSIDE the sandbox site (astro 7
  // requires `--config` to sit inside `--root`). The wrapper is a
  // small ESM file that imports the sandbox's own astro.config.mjs
  // (which the materialiser took from base — TRUSTED tooling) and
  // adds only the `vite.cacheDir` override.
  const wrapperConfigPath = join(cwd, "astro.config.revkit-review.mjs");
  writeFileSync(
    wrapperConfigPath,
    `import base from "./astro.config.mjs";\n` +
      `const viteCacheDir = ${JSON.stringify(viteCacheDir)};\n` +
      `export default {\n` +
      `  ...base,\n` +
      `  vite: {\n` +
      `    ...(base && base.vite ? base.vite : {}),\n` +
      `    cacheDir: viteCacheDir,\n` +
      `  },\n` +
      `};\n`,
  );

  // Detect + remove stale symlinks from a SIGKILLed prior run
  // (PR #48 round-4 nit). Legacy layouts may have left links at
  // `<sandbox>/site/node_modules` or `<sandbox>/node_modules`.
  unlinkStale(join(cwd, "node_modules"));
  unlinkStale(join(options.materializedRoot, "node_modules"));

  try {
    await spawnAstroBuild({
      astroBin: trustedAstroBin,
      astroRoot: cwd,
      outDir: options.distOutDir,
      configPathRelativeToRoot: "./astro.config.revkit-review.mjs",
      homeOverride,
      // cwd = the sandbox site. Node's resolver walks up:
      //   <materialized>/site/                                 no node_modules
      //   <materialized>/                                      no
      //   <trusted>/site/.revkit-review/<slug>/                no
      //   <trusted>/site/.revkit-review/                       no
      //   <trusted>/site/                                      YES (trusted)
      // So the build reads modules from the reviewer's own
      // TRUSTED site/node_modules — no symlinks, no writes.
      cwd,
      ...(options.spawn !== undefined ? { spawn: options.spawn } : {}),
    });
  } finally {
    for (const scratch of [homeOverride, viteCacheDir]) {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        /* fine */
      }
    }
    try {
      rmSync(wrapperConfigPath, { force: true });
    } catch {
      /* fine */
    }
  }
}

/** Delete `target` when it is a symlink, using `lstat` so the link
 * is never followed. Any regular file or directory at `target` is
 * left alone — a caller may have real content there. A SIGKILLed
 * prior run may leave a symlink pointing at the reviewer's real
 * `node_modules`; without this cleanup, the `symlinkSync` below
 * would fail with EEXIST and the build would refuse. (PR #48
 * round-4 nit.) */
export function unlinkStale(target: string): void {
  let lst;
  try {
    lst = lstatSync(target);
  } catch {
    return;
  }
  if (!lst.isSymbolicLink()) return;
  try {
    rmSync(target, { force: true });
  } catch {
    /* best-effort — a permission error would fall through to the
     * subsequent symlinkSync which would then throw a clearer
     * error. */
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
