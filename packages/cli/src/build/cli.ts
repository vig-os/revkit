// CLI glue for `revkit build` (M5 part 2, issue #57, DESIGN-0002 §5).
//
// Renders the consumer's `docs/` tree with the packaged site, writing
// HTML to `<consumer>/.revkit/dist/`. Runs `revkit check` first
// (authoring guards) and `revkit check-dist` after (ADR-0012 output
// gate) so the output is fit for `revkit serve`.

import { existsSync } from "node:fs";
import { relative as relativePath, resolve as resolvePath } from "node:path";
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
 * `--skip-check` (M5 hidden — for the serve auto-build path which
 * has already validated the consumer), `--skip-check-dist` (tests
 * only; NEVER surfaced in HELP). */
export interface ParsedBuildArgs {
  readonly dir?: string;
  readonly out?: string;
  readonly skipCheck: boolean;
  readonly skipCheckDist: boolean;
}

export function parseBuildArgs(args: readonly string[]): { ok: true; parsed: ParsedBuildArgs } | { ok: false; message: string } {
  let dir: string | undefined;
  let out: string | undefined;
  let skipCheck = false;
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
    } else if (arg === "--skip-check") {
      skipCheck = true;
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
      skipCheck,
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

  // 1. revkit check on the consumer tree (skip only for the serve
  //    auto-build path, where the caller has already run check).
  if (!parsed.parsed.skipCheck) {
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
  }

  // 2. Packaged build.
  let result;
  try {
    result = await runPackagedBuild({ consumerRoot, distOutDir });
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
    const diagnostics = checkDistDirectory(distOutDir);
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
}

/** Pretty-print a path relative to `cwd` when it lives inside it,
 * else absolute. Matches the shape `revkit review` uses. */
function prettyPath(cwd: string, target: string): string {
  const rel = relativePath(cwd, target);
  if (rel.startsWith("..") || rel.length === 0) return target;
  return rel;
}
