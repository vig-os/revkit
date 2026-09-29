// @revkit/cli — the `revkit` binary (see DESIGN-0001 §7).
//
// M1 (#6, this PR) implements only `--version` and `--help` for real: the
// remaining subcommands (`serve`, `build`, `check`, `mcp`, `invite`,
// `escalate`, `deploy`) land in their milestones. No placeholder stubs.

/** Version rendered by `revkit --version`, kept in lockstep with `package.json`. */
export const VERSION = "0.0.0";

/** Text rendered by `revkit --help`. */
export const HELP = `revkit ${VERSION}

Usage:
  revkit [--version | -v]
  revkit [--help | -h]

M1 (#6) ships only --version and --help. Subcommands (serve, build, check,
mcp, invite, escalate, deploy) land in their milestones (see the roadmap in
docs/designs/DESIGN-0001-revkit-architecture.md).
`;

/** Exit codes the CLI returns, named so callers and tests do not repeat integers. */
export const ExitCode = {
  ok: 0,
  usage: 2,
} as const;

/** Result of dispatching one CLI invocation — the caller decides how to render it. */
export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Dispatch a single CLI invocation.
 *
 * Pure: takes the argv slice (everything after `node`/`bun` and the script
 * name), returns the streams and the exit code. The wrapper in `bin/` prints
 * them and calls `process.exit`, so this function stays testable without
 * spawning a subprocess.
 */
export function dispatch(argv: readonly string[]): CliResult {
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

  return {
    stdout: "",
    stderr: `revkit: unknown argument '${first}'\n${HELP}`,
    exitCode: ExitCode.usage,
  };
}
