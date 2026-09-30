// @revkit/cli — the `revkit` binary (see DESIGN-0001 §7).
//
// M1 wires the surface: `--version`, `--help`, `check` (the C1–C4 guards
// from ADR-0005) and `escalate` (files a component-request issue via
// gh). The remaining subcommands (`serve`, `build`, `mcp`, `invite`,
// `deploy`) land in their milestones. No placeholder stubs.

import type { CheckOutput } from "./check.ts";
import { runCheck, toCheckFiles } from "./check.ts";
import {
  checkDistDirectory,
  collectInlineScriptHashes,
} from "./check-dist.ts";
import { formatDiagnostic } from "./diagnostics.ts";
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
import { resolve as resolvePath } from "node:path";

/** Version rendered by `revkit --version`, kept in lockstep with `package.json`. */
export const VERSION = "0.0.0";

/** Text rendered by `revkit --help`. */
export const HELP = `revkit ${VERSION}

Usage:
  revkit [--version | -v]
  revkit [--help | -h]
  revkit check [--staged | <paths...>] [--online]
  revkit check-dist <dist-dir> [--print-hashes]
  revkit escalate "<need>"

Guards (ADR-0005):
  component-registry, no-hand-rolled-ui, vocabulary, links, plot-structure,
  vendored-code (ADR-0022: vendor tree + NOTICE contract).

check-dist is the ADR-0012 output-gate sanitiser: parses every built
HTML with a real DOM parser and refuses on* attrs, javascript: /
data: / vbscript: URLs, off-list <script> hashes, <iframe>/<object>/
<embed>/<base>/<meta http-equiv=refresh> and external stylesheets.

--staged limits check to git-staged files (pre-commit path).
--online verifies revkit-allow annotations via 'gh api'.
--print-hashes prints every distinct inline-script hash in the dir so
  a maintainer can update dist-check-allowlist.json after an upgrade.

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

  if (first === "check-dist") {
    return runCheckDistCommand(rest, env);
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

  let discovery;
  try {
    if (staged) {
      discovery = await stagedFiles(repoRoot);
    } else if (positional.length > 0) {
      discovery = expandPathArgs(positional, env.cwd);
    } else {
      discovery = walkForCheckables(repoRoot);
    }
  } catch (error) {
    return {
      stdout: "",
      stderr: `revkit check: ${(error as Error).message}\n`,
      exitCode: ExitCode.usage,
    };
  }

  const files = toCheckFiles(discovery.files, repoRoot);
  void repoRelative; // exported for tests; referenced here for tree-shaking safety.

  const output: CheckOutput = await runCheck(repoRoot, files, discovery.symlinks, {
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

/** Handle `revkit check-dist <dir>`. Kept sync — the DOM parser and
 * fs walks are all sync — so the caller's process exits promptly on a
 * finding. */
function runCheckDistCommand(
  args: readonly string[],
  env: DispatchEnv,
): CliResult {
  let printHashes = false;
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === "--print-hashes") printHashes = true;
    else if (arg.startsWith("--")) {
      return {
        stdout: "",
        stderr: `revkit check-dist: unknown flag '${arg}'\n${HELP}`,
        exitCode: ExitCode.usage,
      };
    } else positional.push(arg);
  }
  if (positional.length !== 1 || positional[0] === undefined) {
    return {
      stdout: "",
      stderr: `revkit check-dist: expected exactly one <dist-dir> argument\n${HELP}`,
      exitCode: ExitCode.usage,
    };
  }
  const distDir = resolvePath(env.cwd, positional[0]);
  if (printHashes) {
    const seen = collectInlineScriptHashes(distDir);
    const lines: string[] = [];
    for (const [hash, info] of seen) {
      lines.push(`${hash}  count=${info.count}  ${JSON.stringify(info.sample.slice(0, 60))}`);
    }
    return { stdout: `${lines.sort().join("\n")}\n`, stderr: "", exitCode: ExitCode.ok };
  }
  const diagnostics = checkDistDirectory(distDir);
  const lines = diagnostics.map(formatDiagnostic);
  return {
    stdout: lines.length > 0 ? `${lines.join("\n")}\n` : "",
    stderr: "",
    exitCode: diagnostics.length > 0 ? ExitCode.findings : ExitCode.ok,
  };
}
