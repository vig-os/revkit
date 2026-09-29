// @revkit/cli — the `revkit` binary (see DESIGN-0001 §7).
//
// M1 wires the surface: `--version`, `--help`, `check` (the C1–C4 guards
// from ADR-0005) and `escalate` (files a component-request issue via
// gh). The remaining subcommands (`serve`, `build`, `mcp`, `invite`,
// `deploy`) land in their milestones. No placeholder stubs.

import type { CheckOutput } from "./check.ts";
import { runCheck, toCheckFiles } from "./check.ts";
import {
  expandPathArgs,
  repoRelative,
  stagedFiles,
  walkForCheckables,
} from "./file-discovery.ts";
import type { GhRunner } from "./gh-runner.ts";
import { spawnGh } from "./gh-runner.ts";
import { runEscalate } from "./escalate.ts";
import { findRepoRootByPackageJson } from "./repo-root.ts";

/** Version rendered by `revkit --version`, kept in lockstep with `package.json`. */
export const VERSION = "0.0.0";

/** Text rendered by `revkit --help`. */
export const HELP = `revkit ${VERSION}

Usage:
  revkit [--version | -v]
  revkit [--help | -h]
  revkit check [--staged | <paths...>] [--online]
  revkit escalate "<need>"

Guards (ADR-0005):
  component-registry, no-hand-rolled-ui, vocabulary, links, plot-structure.

--staged limits check to git-staged files (pre-commit path).
--online verifies revkit-allow annotations via 'gh api' (issue open + labeled 'component-request').

Subcommands (serve, build, mcp, invite, deploy) land in their milestones
(see the roadmap in docs/designs/DESIGN-0001-revkit-architecture.md).
`;

/** Exit codes the CLI returns, named so callers and tests do not repeat integers. */
export const ExitCode = {
  ok: 0,
  findings: 1,
  usage: 2,
} as const;

/** Result of dispatching one CLI invocation — the caller decides how to render it. */
export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Slug of the repo escalate/check target for --online. Overridden in
 * tests via the `dispatch` env argument. */
export const DEFAULT_REPO_SLUG = "vig-os/revkit";

/** Environment the dispatcher accepts — swappable for tests. `cwd`
 * defaults to `process.cwd()`; `gh` to the real `Bun.spawn` runner. */
export interface DispatchEnv {
  readonly cwd: string;
  readonly gh: GhRunner;
  readonly repoSlug: string;
}

/** Default env used at binary entry — real cwd, real gh, real slug. */
export function defaultEnv(): DispatchEnv {
  return {
    cwd: process.cwd(),
    gh: spawnGh,
    repoSlug: DEFAULT_REPO_SLUG,
  };
}

/** Dispatch a single CLI invocation. Async so subcommands may spawn
 * subprocesses; the sync top-level flags return an already-resolved
 * promise. */
export async function dispatch(
  argv: readonly string[],
  env: DispatchEnv = defaultEnv(),
): Promise<CliResult> {
  const [first, ...rest] = argv;

  if (first === "--version" || first === "-v") {
    if (rest.length > 0) {
      return {
        stdout: "",
        stderr: `revkit: --version takes no arguments\n${HELP}`,
        exitCode: ExitCode.usage,
      };
    }
    return { stdout: `${VERSION}\n`, stderr: "", exitCode: ExitCode.ok };
  }

  if (first === "--help" || first === "-h" || first === undefined) {
    return { stdout: HELP, stderr: "", exitCode: ExitCode.ok };
  }

  if (first === "check") {
    return await runCheckCommand(rest, env);
  }

  if (first === "escalate") {
    return await runEscalateCommand(rest, env);
  }

  return {
    stdout: "",
    stderr: `revkit: unknown argument '${first}'\n${HELP}`,
    exitCode: ExitCode.usage,
  };
}

/** Handle `revkit check`. Parses `--staged` / `--online` / positional
 * paths, resolves the repo root, and hands off to `runCheck`. */
async function runCheckCommand(
  args: readonly string[],
  env: DispatchEnv,
): Promise<CliResult> {
  let staged = false;
  let online = false;
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === "--staged") {
      staged = true;
    } else if (arg === "--online") {
      online = true;
    } else if (arg.startsWith("--")) {
      return {
        stdout: "",
        stderr: `revkit check: unknown flag '${arg}'\n${HELP}`,
        exitCode: ExitCode.usage,
      };
    } else {
      positional.push(arg);
    }
  }
  if (staged && positional.length > 0) {
    return {
      stdout: "",
      stderr: "revkit check: --staged does not accept positional paths",
      exitCode: ExitCode.usage,
    };
  }

  let repoRoot: string;
  try {
    repoRoot = findRepoRootByPackageJson(env.cwd);
  } catch (error) {
    return {
      stdout: "",
      stderr: `${(error as Error).message}\n`,
      exitCode: ExitCode.usage,
    };
  }

  let absolutePaths: string[];
  try {
    if (staged) {
      absolutePaths = await stagedFiles(repoRoot);
    } else if (positional.length > 0) {
      absolutePaths = expandPathArgs(positional, env.cwd);
    } else {
      absolutePaths = walkForCheckables(repoRoot);
    }
  } catch (error) {
    return {
      stdout: "",
      stderr: `revkit check: ${(error as Error).message}\n`,
      exitCode: ExitCode.usage,
    };
  }

  const files = toCheckFiles(absolutePaths, repoRoot);
  void repoRelative; // exported for tests; referenced here for tree-shaking safety.

  const output: CheckOutput = await runCheck(repoRoot, files, {
    online,
    repoSlug: env.repoSlug,
    gh: env.gh,
  });
  return {
    stdout: output.lines.length > 0 ? `${output.lines.join("\n")}\n` : "",
    stderr: "",
    exitCode: output.exitCode === 0 ? ExitCode.ok : ExitCode.findings,
  };
}

/** Handle `revkit escalate "<need>"`. */
async function runEscalateCommand(
  args: readonly string[],
  env: DispatchEnv,
): Promise<CliResult> {
  if (args.length !== 1 || args[0] === undefined || args[0].trim().length === 0) {
    return {
      stdout: "",
      stderr: `revkit escalate: expected exactly one non-empty argument (the need)\n${HELP}`,
      exitCode: ExitCode.usage,
    };
  }
  const outcome = await runEscalate(args[0], env.repoSlug, env.gh);
  if (outcome.kind === "failed") {
    return {
      stdout: "",
      stderr: `revkit escalate: gh issue create failed (${outcome.exitCode}): ${outcome.stderr}\n`,
      exitCode: outcome.exitCode === 0 ? ExitCode.findings : outcome.exitCode,
    };
  }
  const lines = [
    `revkit escalate: opened component-request #${outcome.issue}.`,
    `Paste this on the line above the JSX element to silence the guard:`,
    `  ${outcome.annotation}`,
  ];
  return {
    stdout: `${lines.join("\n")}\n`,
    stderr: "",
    exitCode: ExitCode.ok,
  };
}
