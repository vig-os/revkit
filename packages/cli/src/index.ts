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
import { runServeCommand } from "./serve/cli.ts";
import { runBuildCommand } from "./build/cli.ts";
import { runMcpCommand } from "./mcp/cli.ts";
import { runOpenCommand } from "./open-cli.ts";
import { runReviewCommand, defaultReviewEnv } from "./review/cli.ts";
import { spawnGit } from "./git-runner.ts";
import { runEventsCommand } from "./events-cli.ts";
import { runHookCommand } from "./hook-cli.ts";
import { runModeCommand } from "./mode-cli.ts";
import { runSkillCommand } from "./skill-cli.ts";
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
  revkit build [--dir <path>] [--out <path>]
  revkit serve [--dir <path>] [--port <n>] [--no-auto-build]
  revkit mcp [--dir <path>]
  revkit open [<path>]
  revkit review <pr-number|url> [--trust <sha>] [--no-serve] [--repo <slug>]
  revkit mode [handover | live | quiet]
  revkit events --follow [--since <n>] [--dir <path>]
  revkit hook user-prompt-submit
  revkit skill install [--dir <root>] [--force] [--dry-run]

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

build (M5 part 2, D1) renders the consumer's docs/ (plus vocab/,
plots/) through revkit's packaged Astro/Starlight site by absolute
path — no bunx, no npx, no registry fetch. Output lands at
<consumer>/.revkit/dist/. Astro and Vite caches go under
<consumer>/.revkit/cache/ so nothing is written into the nix store
or the packaged site directory. Runs 'revkit check' before and
'revkit check-dist' after (ADR-0012 output gate).

serve boots the local daemon (ADR-0013, ADR-0006/0007): Bun.serve
bound to 127.0.0.1 on a random free port (--port 0), serving
'<consumer>/.revkit/dist' by default with a JSON thread API,
/events (SSE + WebSocket) and the launch-code → session-cookie
flow. Prints the launch URL on stdout; the agent bearer token is
written to .revkit/serve.json at mode 600. When --dir is absent
and <consumer>/.revkit/dist/ does not exist, 'revkit build' runs
automatically first (--no-auto-build refuses instead). Ctrl-C
stops gracefully.

review (ADR-0025, M3 part 2a) resolves a PR through the reviewer's
own 'gh auth token', fetches the head + base commits into the local
object DB, refuses forks and any PR that changes tooling unless
--trust <sha> pins to the current head, then materializes a safe
worktree under .revkit/review/<pr>-<sha>/ with TOOLING files from
base and CONTENT files (docs/, vocab/, plots/, site/src/content/ —
allowlisted extensions only) from the PR head. Symlinks that escape,
submodules and unsupported tree modes are refused. 'revkit check'
runs on the PR content before serving. Existing PR review threads
are imported through the GitHub adapter into the daemon's thread
store; the rail shows them as the docs render today. The daemon
inherits ADR-0013's auth/CSP unchanged. Use --no-serve to prepare
the review without starting the daemon.

mcp is a stdio MCP server (ADR-0007): declares the 'claude/channel'
capability, exposes tools 'threads'/'reply'/'resolve' that proxy to
the daemon, and forwards human comments/replies as
'notifications/claude/channel' events. Auto-starts 'revkit serve'
if '.revkit/serve.json' is missing or stale. Run under Claude Code
with --dangerously-load-development-channels server:revkit until
the plugin lands on an allowlisted marketplace.

mode reads or writes the daemon's delivery mode (ADR-0007 §5.3):
  handover (default) — batch human comments, deliver on hand-over
  live               — push every comment as it lands
  quiet              — nothing pushed; agent pulls via MCP tools
An @agent now marker in a comment body overrides handover / quiet
for that one comment and flushes the pending batch immediately.

events --follow prints one JSON line per daemon event on stdout,
authenticated with the agent bearer token from .revkit/serve.json.
Intended for Claude Code's Monitor tool as a fallback when the
channel path is not available. Reconnects with exponential backoff.

hook user-prompt-submit is the UserPromptSubmit hook: on every
prompt it prints pending review items as additionalContext. Fast
(soft ~400 ms deadline), silent on empty / missing daemon / any
error, escapes every reviewer-authored field. Wire into your
project's .claude/settings.json — never the user's global config.

Subcommands (build, invite, deploy) land in their milestones
(see the roadmap in docs/designs/DESIGN-0001-revkit-architecture.md).
`;

/** Exit codes the CLI returns, named so callers and tests do not repeat integers. */
export const ExitCode = {
  ok: 0,
  findings: 1,
  usage: 2,
} as const;

/** Result of dispatching one CLI invocation — the caller decides how to render it.
 * `blockForever` is set by long-running subcommands (`serve`) — the CLI
 * top-level awaits it so the process does not exit while the daemon
 * is up. Absent on one-shot subcommands. */
export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  blockForever?: Promise<void>;
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

  if (first === "serve") {
    const outcome = await runServeCommand(rest, {
      cwd: env.cwd,
      version: VERSION,
      repoSlug: env.repoSlug,
    });
    return {
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      exitCode: outcome.exitCode,
      ...(outcome.blockForever !== undefined ? { blockForever: outcome.blockForever } : {}),
    };
  }

  if (first === "build") {
    const outcome = await runBuildCommand(rest, {
      cwd: env.cwd,
      version: VERSION,
      repoSlug: env.repoSlug,
    });
    return { stdout: outcome.stdout, stderr: outcome.stderr, exitCode: outcome.exitCode };
  }

  if (first === "mcp") {
    const outcome = await runMcpCommand(rest, { cwd: env.cwd, version: VERSION });
    return {
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      exitCode: outcome.exitCode,
      ...(outcome.blockForever !== undefined ? { blockForever: outcome.blockForever } : {}),
    };
  }

  if (first === "open") {
    const outcome = await runOpenCommand(rest, { cwd: env.cwd });
    return { stdout: outcome.stdout, stderr: outcome.stderr, exitCode: outcome.exitCode };
  }

  if (first === "review") {
    const { startDaemon } = await import("./serve/daemon.ts");
    const { readOrMintLocalUserId } = await import("./serve/cli.ts");
    // Mint / read the local user id EARLY so runReviewCommand
    // receives a stable value and there is no dead-code fallback
    // branch (PR #48 round-2 nit).
    let localUserId: string;
    try {
      const repoRoot = findRepoRootByPackageJson(env.cwd);
      localUserId = readOrMintLocalUserId(repoRoot);
    } catch {
      // No package.json marker means the review command will
      // itself refuse in the same way `just check` does; use a
      // stable string here so the fallback is deterministic.
      localUserId = "local-review";
    }
    const reviewEnv = {
      ...defaultReviewEnv(env.cwd, VERSION, env.repoSlug, localUserId),
      gh: env.gh,
      git: spawnGit,
      // Wire the daemon start to the built `site/dist` inside the
      // materialised worktree. The daemon keeps ADR-0013 auth/CSP
      // unchanged — we only vary the dir it serves and the sqlite
      // it opens.
      startServe: async ({
        distDir,
        sqlitePath,
        repoRoot,
        localUserId,
        reviewMode,
      }: Parameters<NonNullable<Parameters<typeof runReviewCommand>[1]["startServe"]>>[0]) => {
        const handle = await startDaemon({
          dir: distDir,
          repoRoot,
          sqlitePath,
          version: VERSION,
          localUserId,
          port: 0,
          announce: false,
          installSignalHandlers: true,
          ...(reviewMode !== undefined ? { reviewMode } : {}),
        });
        const blockForever = new Promise<void>((resolveDone) => {
          const originalStop = handle.stop.bind(handle);
          handle.stop = async (): Promise<void> => {
            await originalStop();
            resolveDone();
          };
        });
        return {
          url: handle.url,
          port: handle.port,
          launchUrl: handle.launchUrl,
          blockForever,
          stop: () => handle.stop(),
        };
      },
    };
    const outcome = await runReviewCommand(rest, reviewEnv);
    return {
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      exitCode: outcome.exitCode,
      ...(outcome.blockForever !== undefined ? { blockForever: outcome.blockForever } : {}),
    };
  }

  if (first === "events") {
    const outcome = await runEventsCommand(rest, { cwd: env.cwd });
    return {
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      exitCode: outcome.exitCode,
      ...(outcome.blockForever !== undefined ? { blockForever: outcome.blockForever } : {}),
    };
  }

  if (first === "hook") {
    const outcome = await runHookCommand(rest, { cwd: env.cwd });
    return { stdout: outcome.stdout, stderr: outcome.stderr, exitCode: outcome.exitCode };
  }

  if (first === "mode") {
    const outcome = await runModeCommand(rest, { cwd: env.cwd });
    return { stdout: outcome.stdout, stderr: outcome.stderr, exitCode: outcome.exitCode };
  }

  if (first === "skill") {
    const outcome = runSkillCommand(rest, { cwd: env.cwd });
    return { stdout: outcome.stdout, stderr: outcome.stderr, exitCode: outcome.exitCode };
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
