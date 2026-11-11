// CLI glue for `revkit build` (M5 part 2, issue #57, DESIGN-0002 §5).
//
// Renders the consumer's `docs/` tree with the packaged site, writing
// HTML to `<consumer>/.revkit/dist/`. Runs `revkit check` first
// (authoring guards) and `revkit check-dist` after (ADR-0012 output
// gate) so the output is fit for `revkit serve`.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, relative as relativePath, resolve as resolvePath } from "node:path";
import { checkDistDirectory } from "../check-dist.ts";
import { runCheck, toCheckFiles } from "../check.ts";
import { formatDiagnostic } from "../diagnostics.ts";
import { walkForCheckables } from "../file-discovery.ts";
import { findRepoRootByPackageJson } from "../repo-root.ts";
import { defaultConsumerDist, runPackagedBuild } from "./packaged.ts";

/** Result shape aligned with the dispatcher's `CliResult`. */
export interface RunBuildResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Env `runBuildCommand` needs. */
export interface RunBuildEnv {
  readonly cwd: string;
  readonly version: string;
  readonly repoSlug: string;
}

/** Parse args: `--dir <consumer-root>`, `--out <dist-dir>`,
 * `--skip-check-dist` (test-only escape hatch; NEVER documented in
 * HELP). No `--skip-check`: the authoring guards are load-bearing
 * for build safety — see the confined staging walker below, which
 * catches escaping symlinks BEFORE the check would have anyway.
 * Removing --skip-check makes the two lines of defense
 * unbypassable together (a reviewer that flipped a flag would
 * otherwise skip the check and rely only on the staging refusal). */
export interface ParsedBuildArgs {
  readonly dir?: string;
  readonly out?: string;
  readonly skipCheckDist: boolean;
}

export function parseBuildArgs(args: readonly string[]): { ok: true; parsed: ParsedBuildArgs } | { ok: false; message: string } {
  let dir: string | undefined;
  let out: string | undefined;
  let skipCheckDist = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dir") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { ok: false, message: "revkit build: --dir requires a value" };
      }
      dir = next;
      i++;
    } else if (arg?.startsWith("--dir=")) {
      dir = arg.slice("--dir=".length);
    } else if (arg === "--out") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { ok: false, message: "revkit build: --out requires a value" };
      }
      out = next;
      i++;
    } else if (arg?.startsWith("--out=")) {
      out = arg.slice("--out=".length);
    } else if (arg === "--skip-check-dist") {
      // Test-only escape hatch. Not documented in HELP; a caller
      // that sets this MUST have another output-gate in front of
      // the daemon.
      skipCheckDist = true;
    } else {
      return { ok: false, message: `revkit build: unknown argument '${arg}'` };
    }
  }
  return {
    ok: true,
    parsed: {
      ...(dir !== undefined ? { dir } : {}),
      ...(out !== undefined ? { out } : {}),
      skipCheckDist,
    },
  };
}

/** Run `revkit build`. */
export async function runBuildCommand(
  args: readonly string[],
  env: RunBuildEnv,
): Promise<RunBuildResult> {
  const parsed = parseBuildArgs(args);
  if (!parsed.ok) {
    return { exitCode: 2, stdout: "", stderr: parsed.message + "\n" };
  }

  // Resolve consumer root: --dir wins; otherwise walk up from cwd
  // to the workspace marker (same rule as `revkit check`).
  let consumerRoot: string;
  if (parsed.parsed.dir !== undefined) {
    consumerRoot = resolvePath(env.cwd, parsed.parsed.dir);
    if (!existsSync(consumerRoot)) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: `revkit build: --dir '${consumerRoot}' does not exist\n`,
      };
    }
  } else {
    try {
      consumerRoot = findRepoRootByPackageJson(env.cwd);
    } catch (error) {
      return { exitCode: 2, stdout: "", stderr: `${(error as Error).message}\n` };
    }
  }

  const distOutDir =
    parsed.parsed.out !== undefined
      ? resolvePath(env.cwd, parsed.parsed.out)
      : defaultConsumerDist(consumerRoot);

  const stdoutLines: string[] = [];
  stdoutLines.push(`revkit build: consumer=${prettyPath(env.cwd, consumerRoot)}`);
  stdoutLines.push(`revkit build: dist=${prettyPath(env.cwd, distOutDir)}`);

  // 1. revkit check on the consumer tree. ALWAYS runs — no
  //    --skip-check: the authoring guards catch symlink escapes,
  //    hand-rolled UI, unknown vocab, missing links and inline
  //    plot data BEFORE the build sees them. The confined staging
  //    walker (`copyConfined` in packaged.ts) is a second line of
  //    defense against escaping symlinks; both must run.
  try {
    const discovery = walkForCheckables(consumerRoot);
    const files = toCheckFiles(discovery.files, consumerRoot);
    const output = await runCheck(consumerRoot, files, discovery.symlinks, {
      online: false,
      repoSlug: env.repoSlug,
      gh: async () => ({ stdout: "", stderr: "", exitCode: 1 }),
    });
    if (output.exitCode !== 0) {
      return {
        exitCode: 1,
        stdout: stdoutLines.join("\n") + "\n",
        stderr:
          `revkit build: 'revkit check' failed on the consumer tree:\n` +
          output.lines.join("\n") +
          "\n",
      };
    }
    stdoutLines.push(`revkit build: check ok (${files.length} files)`);
  } catch (error) {
    return {
      exitCode: 1,
      stdout: stdoutLines.join("\n") + "\n",
      stderr: `revkit build: check failed: ${(error as Error).message}\n`,
    };
  }

  // 2. Packaged build.
  //
  //    The astro build also writes a side-channel manifest listing
  //    the dist-relative page paths whose source doc bodies were
  //    non-empty (issue #237 defense in depth): we give the loader
  //    the path via `REVKIT_RENDER_GUARD_MANIFEST_PATH`, the loader
  //    writes it from astro's own content store (so its slug
  //    choices — github-slugger + any `slug:` frontmatter override
  //    — are honoured), and we read it back here to hand
  //    `check-dist` the exact page set. The file lives under the
  //    build state dir, not inside dist, so nothing extra ships.
  //
  //    The manifest is build-scoped scratch and is removed on
  //    EVERY exit path below (try / finally) so a stale one from
  //    a prior run never masks a future fresh build — round-3
  //    review item 4.
  const renderGuardManifest = join(consumerRoot, ".revkit", "build", "render-guard-manifest.json");
  try {
    let result;
    try {
      result = await runPackagedBuild({
        consumerRoot,
        distOutDir,
        renderGuardManifestPath: renderGuardManifest,
      });
    } catch (error) {
      return {
        exitCode: 1,
        stdout: stdoutLines.join("\n") + "\n",
        stderr: `revkit build: astro build failed: ${(error as Error).message}\n`,
      };
    }
    stdoutLines.push(`revkit build: astro ok — packaged site ${prettyPath(env.cwd, result.packagedSiteDir)}`);
    stdoutLines.push(`revkit build: staging ${prettyPath(env.cwd, result.stagingDir)}`);

    // 3. check-dist on the built output (ADR-0012 output-gate).
    if (!parsed.parsed.skipCheckDist) {
      const pagesWithNonEmptySource = readRenderGuardManifest(renderGuardManifest);
      const diagnostics = checkDistDirectory(distOutDir, { pagesWithNonEmptySource });
      if (diagnostics.length > 0) {
        return {
          exitCode: 1,
          stdout: stdoutLines.join("\n") + "\n",
          stderr:
            `revkit build: 'revkit check-dist' refused the built output:\n` +
            diagnostics.map(formatDiagnostic).join("\n") +
            "\n",
        };
      }
      stdoutLines.push(`revkit build: check-dist ok`);
    }

    stdoutLines.push(``);
    stdoutLines.push(
      `Built at ${prettyPath(env.cwd, distOutDir)}. Run 'revkit serve' to review.`,
    );
    return { exitCode: 0, stdout: stdoutLines.join("\n") + "\n", stderr: "" };
  } finally {
    try {
      rmSync(renderGuardManifest, { force: true });
    } catch {
      /* fine */
    }
  }
}

/** Read the render-guard manifest the astro loader wrote. Returns an
 * empty set when the file is absent or malformed — the empty-content
 * defense then does nothing, which is strictly weaker than the
 * build-time guard (which is the primary check anyway). Issue #237.
 *
 * Exported so a dedicated regression test (round-3 review item 3)
 * exercises the exact function `runBuildCommand` relies on: mutating
 * this to return `new Set()` must flip a test red. */
export function readRenderGuardManifest(manifestPath: string): ReadonlySet<string> {
  if (!existsSync(manifestPath)) return new Set();
  try {
    const raw = readFileSync(manifestPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null
      && typeof parsed === "object"
      && Array.isArray((parsed as { pages?: unknown }).pages)
    ) {
      const pages = (parsed as { pages: readonly unknown[] }).pages;
      return new Set(pages.filter((p): p is string => typeof p === "string"));
    }
  } catch {
    /* fall through to empty */
  }
  return new Set();
}

/** Pretty-print a path relative to `cwd` when it lives inside it,
 * else absolute. Matches the shape `revkit review` uses. */
function prettyPath(cwd: string, target: string): string {
  const rel = relativePath(cwd, target);
  if (rel.startsWith("..") || rel.length === 0) return target;
  return rel;
}
