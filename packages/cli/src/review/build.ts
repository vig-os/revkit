// Safe astro build for a materialised PR-head worktree (ADR-0025,
// PR #48 round-2 blocker 2).
//
// **The rules** — each blocks a concrete attack against the local
// review surface:
//
//   1. **Minimal env.** `Bun.spawn` is called with an explicit `env`
//      object; NOTHING from `process.env` is inherited by default.
//      The allowlist below covers what an astro build genuinely
//      needs (`PATH`, `HOME`, `TMPDIR`, `NIX_*` for the flake dev
//      shell, `NODE_OPTIONS` for a low-memory footprint) and NO
//      token variable. `GITHUB_TOKEN`, `GH_TOKEN`, `NPM_TOKEN`,
//      `HF_TOKEN`, `CF_API_TOKEN`, `NODE_AUTH_TOKEN`, `CI` are
//      NEVER exported to the child.
//
//   2. **No token in argv.** The child gets no positional or
//      `--` argument that carries a bearer.
//
//   3. **Deps stay local.** The child never runs `bun install`
//      inside the materialised worktree (that would execute PR-
//      controlled lifecycle scripts). Node resolution instead
//      points at the reviewer's TRUSTED `node_modules/` — the base
//      checkout's — via `NODE_PATH`. If a per-review `node_modules`
//      exists (a symlink to base's), astro finds it too.
//
//   4. **cwd is the materialised worktree.** Astro is invoked in
//      the sandbox tree; its `astro.config.*` reads from there.
//      Because the materialiser rebuilt every tooling file from
//      base, that config is the reviewer's own.
//
//   5. **Output dir is under the materialised worktree.** The
//      caller passes `distOutDir`; we set `--outDir` on the astro
//      command so its own writes stay contained. `revkit
//      check-dist` runs on that dir before it is served.
//
// If the build fails (non-zero exit, stderr surfaced), the caller
// aborts the review command and does NOT start the daemon.

import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";

/** Input to `runSafeBuild`. */
export interface RunSafeBuildOptions {
  /** Absolute path to the materialised PR-head worktree. */
  readonly materializedRoot: string;
  /** Absolute path where the astro build should write its output. */
  readonly distOutDir: string;
  /** Optional astro entry directory relative to `materializedRoot`.
   * Defaults to `"site"` (revkit's astro project lives there). */
  readonly astroDir?: string;
  /** Reviewer's TRUSTED base checkout — its `node_modules/` roots
   * the child's module resolution. Defaults to the parent of the
   * `.revkit/` directory (three levels above `materializedRoot`).
   * A test can pin this. */
  readonly trustedNodeRoot?: string;
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
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
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
  "NODE_PATH",
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

/**
 * Build the allowlisted env for the child. Reads every allowlisted
 * key from `sourceEnv` (defaults to `process.env`) and drops
 * everything else. Also overrides `NODE_PATH` to point at the
 * trusted `node_modules/` when available.
 */
export function buildChildEnv(
  sourceEnv: Readonly<Record<string, string | undefined>>,
  trustedNodeRoot: string | undefined,
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
  // Astro sometimes reads `NODE_PATH` for global module resolution.
  // Point it at the trusted node_modules if we have one.
  if (trustedNodeRoot !== undefined) {
    const trustedNm = join(trustedNodeRoot, "node_modules");
    if (existsSync(trustedNm)) {
      out.NODE_PATH = trustedNm;
    }
  }
  // Never let CI-shape variables trigger provider-specific paths in
  // astro/vite.
  delete out.CI;
  delete out.GITHUB_ACTIONS;
  return out;
}

/**
 * Run the safe astro build.
 *
 * The command shape is deliberately minimal:
 *   `bun --bun x astro build --root <materializedRoot>/<astroDir>
 *        --outDir <distOutDir>`
 *
 * `--bun x` is bun's `exec`-shaped command; nothing here executes a
 * PR-controlled script. Argv is pure literal strings assembled from
 * the caller's typed options — no positional argument carries a
 * secret.
 */
export async function runSafeBuild(options: RunSafeBuildOptions): Promise<void> {
  const astroDir = options.astroDir ?? "site";
  const cwd = join(options.materializedRoot, astroDir);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(
      `runSafeBuild: astro project dir '${cwd}' does not exist in the materialised worktree`,
    );
  }
  // Default trusted node root = the grandparent of the per-PR
  // review dir, i.e. the reviewer's checkout root. `materializedRoot`
  // ends with `.revkit/review/<slug>/head-<sha>` → four `dirname`
  // hops to the checkout root.
  const trustedNodeRoot =
    options.trustedNodeRoot ??
    resolvePath(options.materializedRoot, "..", "..", "..", "..");

  const env = buildChildEnv(process.env, trustedNodeRoot);
  const spawn = options.spawn ?? defaultSpawn;

  const result = await spawn({
    cmd: [
      "bun",
      "--bun",
      "x",
      "astro",
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
    // reviewer without dumping a many-MiB build log into the CLI
    // response.
    const tail = result.stderr.slice(-4096);
    throw new Error(`astro build exited ${result.exitCode}. Tail:\n${tail}`);
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

void dirname;
