// CLI glue for `revkit review <pr>` (ADR-0025, M3 part 2a).
//
// The command:
//   1. Parses `<pr-number|url>` and `--trust <sha>` (optional).
//   2. Reads the reviewer's `gh` token in memory (never logs, never
//      writes to disk).
//   3. Calls the GitHub adapter to resolve the PR (`getPullRequest`,
//      `listPullRequestFiles`, `listReviewThreads`).
//   4. Refuses fork PRs and any PR whose tooling files differ from
//      base, unless `--trust <sha>` matches the PR head exactly. Prints
//      the tooling diff either way.
//   5. Fetches head/base commits into the local git object DB (through
//      the safe git wrapper).
//   6. Materializes a safe worktree in `.revkit/review/<pr>-<sha>/`
//      with TOOLING files from base and CONTENT files from the PR
//      head. Refuses symlinks that escape, submodules and other
//      unsupported modes.
//   7. Runs `revkit check` over the materialized content dirs.
//   8. Imports the PR's existing review threads through
//      `adapter.importThreads` and pre-populates the daemon's thread
//      store.
//   9. Prints a summary and (unless `--no-serve` is passed) starts a
//      per-review `revkit serve` daemon over the materialized
//      worktree. The daemon's usual auth/CSP (ADR-0013) is unchanged.
//
// The build step (astro build) is INJECTABLE — the default runs
// `bun run build` inside the materialized worktree; tests inject a
// stub that just creates a `site/dist/` with a marker file. This
// keeps the command's fast paths (parse/resolve/refuse/materialize/
// import) covered by tests without needing a full astro build in CI.

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import {
  GitHubAdapter,
  type PrRef,
  type PullRequestSummary,
} from "@revkit/review-core";
import type { GhRunner } from "../gh-runner.ts";
import type { GitRunner } from "../git-runner.ts";
import { spawnGit } from "../git-runner.ts";
import { spawnGh } from "../gh-runner.ts";
import { createGhTokenSource } from "../gh-token-source.ts";
import { findRepoRootByPackageJson } from "../repo-root.ts";
import { runCheck, toCheckFiles } from "../check.ts";
import { walkForCheckables } from "../file-discovery.ts";
import { parsePrRef } from "./pr-ref.ts";
import {
  ensurePrCommits,
  parseGithubRemoteUrl,
  perPrRoot,
  perPrSqlitePath,
  perPrStateDir,
  readFetchedHeadSha,
  readOriginUrl,
  reviewTargetDir,
  reviewTargetExists,
} from "./fetch-pr.ts";
import { computeToolingDiff, formatToolingDiff, type ToolingDiff } from "./tooling-diff.ts";
import { materializeSafeTree, MaterializeError } from "./materialize.ts";
import { populateStoreFromPr, type PopulateOutcome } from "./import-threads.ts";
import { SqliteThreadStore } from "../serve/sqlite-store.ts";
import { ensureRevkitDir } from "../serve/serve-state.ts";
import { runSafeBuild } from "./build.ts";

/** Result shape aligned with the dispatcher's `CliResult`. */
export interface RunReviewResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly blockForever?: Promise<void>;
}

/** Injectable seam for the astro build (PR #48 round-2 blocker 2).
 * The default (`build.ts:runSafeBuild`) runs the reviewer's trusted
 * astro toolchain against the materialised worktree with a minimal
 * env (no GITHUB_TOKEN / GH_TOKEN / npm_ tokens; `TMPDIR`, `PATH`
 * and the nix profile only). Tests inject a stub that fakes a
 * `site/dist/` without spawning astro. */
export interface BuildHook {
  (options: {
    readonly materializedRoot: string;
    readonly distOutDir: string;
  }): Promise<void>;
}

/** Env `runReviewCommand` needs. Each field has a default that the
 * real CLI provides; tests inject stubs. */
export interface RunReviewEnv {
  readonly cwd: string;
  readonly version: string;
  readonly gh: GhRunner;
  readonly git: GitRunner;
  readonly repoSlug: string;
  /** Injectable adapter factory — tests hand in an adapter whose
   * `fetch` is a fake. Default builds one using `gh auth token`. */
  readonly makeAdapter?: (gh: GhRunner) => GitHubAdapter;
  /** Injectable build hook. When absent, the built-in safe build
   * runs (see `build.ts:runSafeBuild`), and its output lands under
   * `distOutDir`. */
  readonly build?: BuildHook;
  /** Injectable serve start. Defaults to importing `startDaemon`
   * and calling it. Tests set this to a no-op. When absent, the
   * command runs the daemon; when present, tests use their stub.
   * A `--no-serve` flag also skips this. */
  readonly startServe?: (options: {
    readonly materializedRoot: string;
    readonly distDir: string;
    readonly sqlitePath: string;
    readonly repoRoot: string;
    readonly localUserId: string;
  }) => Promise<{ url: string; port: number; launchUrl: string; blockForever: Promise<void>; stop(): Promise<void> }>;
  /** Local user id — required. The daemon's actor-identification
   * boundary needs a stable per-install tag; the caller
   * (`packages/cli/src/index.ts:review`) mints or reads it once. */
  readonly localUserId: string;
  /** Skip `check-dist` — for tests that need to bypass the ADR-0012
   * output-gate sanitiser on a hand-rolled fake dist. NEVER set in
   * production; the CLI dispatcher never sets it. */
  readonly _skipCheckDist?: boolean;
}

/** Parsed argv. `serve: true` means we start the daemon at the end. */
export interface ParsedReviewArgs {
  readonly ok: true;
  readonly prRaw: string;
  readonly trustSha?: string;
  readonly serve: boolean;
  readonly repoSlug?: string;
}

/** Parse `revkit review` argv. Returns either the parsed shape or a
 * usage error. */
export function parseReviewArgs(args: readonly string[]): ParsedReviewArgs | { readonly ok: false; readonly message: string } {
  let prRaw: string | undefined;
  let trustSha: string | undefined;
  let serve = true;
  let repoSlug: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--trust") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { ok: false, message: "revkit review: --trust requires a SHA argument" };
      }
      if (!isPlausibleSha(next)) {
        return { ok: false, message: `revkit review: --trust value '${next}' is not a plausible git SHA` };
      }
      trustSha = next;
      i++;
    } else if (arg?.startsWith("--trust=")) {
      const value = arg.slice("--trust=".length);
      if (!isPlausibleSha(value)) {
        return { ok: false, message: `revkit review: --trust value '${value}' is not a plausible git SHA` };
      }
      trustSha = value;
    } else if (arg === "--no-serve") {
      serve = false;
    } else if (arg === "--repo") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { ok: false, message: "revkit review: --repo requires a value" };
      }
      repoSlug = next;
      i++;
    } else if (arg?.startsWith("--repo=")) {
      repoSlug = arg.slice("--repo=".length);
    } else if (arg === undefined || arg === "") {
      // ignore
    } else if (arg.startsWith("--")) {
      return { ok: false, message: `revkit review: unknown flag '${arg}'` };
    } else if (prRaw === undefined) {
      prRaw = arg;
    } else {
      return { ok: false, message: `revkit review: unexpected extra argument '${arg}'` };
    }
  }
  if (prRaw === undefined) {
    return { ok: false, message: "revkit review: expected a <pr-number|url> argument" };
  }
  return {
    ok: true,
    prRaw,
    ...(trustSha !== undefined ? { trustSha } : {}),
    serve,
    ...(repoSlug !== undefined ? { repoSlug } : {}),
  };
}

/** Strict 40-hex SHA (PR #48 round-2 blocker 3). A `--trust` value
 * must be the FULL commit id: a 7-char prefix could collide with a
 * different commit in a large repo, and every `--trust` shape a
 * reviewer would type comes from `gh pr view` / a PR URL where the
 * full SHA is a `git rev-parse` away. */
export function isPlausibleSha(value: string): boolean {
  return /^[0-9a-fA-F]{40}$/.test(value);
}

/** Exact SHA equality (case-insensitive) — no prefix acceptance
 * (PR #48 round-2 blocker 3). */
export function trustMatches(trusted: string, actual: string): boolean {
  if (trusted.length !== 40 || actual.length !== 40) return false;
  return trusted.toLowerCase() === actual.toLowerCase();
}

/** Build the default `env` used by the top-level CLI dispatcher.
 * `localUserId` is required — the CLI dispatcher mints it via
 * `readOrMintLocalUserId` (see `packages/cli/src/serve/cli.ts`). */
export function defaultReviewEnv(
  cwd: string,
  version: string,
  repoSlug: string,
  localUserId: string,
): RunReviewEnv {
  return { cwd, version, gh: spawnGh, git: spawnGit, repoSlug, localUserId };
}

/** Run `revkit review`. See file-level doc. */
export async function runReviewCommand(args: readonly string[], env: RunReviewEnv): Promise<RunReviewResult> {
  const parsed = parseReviewArgs(args);
  if (!parsed.ok) {
    return { exitCode: 2, stdout: "", stderr: parsed.message + "\n" };
  }

  let repoRoot: string;
  try {
    repoRoot = findRepoRootByPackageJson(env.cwd);
  } catch (error) {
    return { exitCode: 2, stdout: "", stderr: `${(error as Error).message}\n` };
  }

  const defaultSlug = parsed.repoSlug ?? env.repoSlug;
  const prRefResult = parsePrRef(parsed.prRaw, defaultSlug);
  if (!prRefResult.ok) {
    return { exitCode: 2, stdout: "", stderr: `${prRefResult.message}\n` };
  }
  const pr: PrRef = prRefResult.ref;

  const adapter = env.makeAdapter !== undefined ? env.makeAdapter(env.gh) : buildDefaultAdapter(env.gh);

  let summary: PullRequestSummary;
  try {
    summary = await adapter.getPullRequest(pr);
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `revkit review: failed to fetch PR ${pr.owner}/${pr.repo}#${pr.pullNumber}: ${(error as Error).message}\n`,
    };
  }

  const trustSha = parsed.trustSha;

  // --- Fork gate (PR #48 round-2 blocker 4) ---
  // A deleted fork returns `headRepoFullName === null`. Treat that
  // as a fork — refuse fail-closed rather than fall through to the
  // baseRepoFullName-match branch as if the head repo was the base.
  const isFork =
    summary.headRepoFullName === null ||
    summary.headRepoFullName !== summary.baseRepoFullName;
  if (isFork && trustSha === undefined) {
    const headDisplay = summary.headRepoFullName ?? "<deleted fork>";
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        `revkit review: PR #${pr.pullNumber} is from a fork ` +
        `(${headDisplay} → ${summary.baseRepoFullName}). ` +
        `Refusing without an explicit --trust <sha>. ` +
        `If you have reviewed the PR head at ${summary.headSha} and want to build ` +
        `it locally, pass --trust ${summary.headSha}.\n`,
    };
  }
  if (trustSha !== undefined && !trustMatches(trustSha, summary.headSha)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        `revkit review: --trust ${trustSha} does not match the current PR head ${summary.headSha}. ` +
        `The head may have moved since you last reviewed it; re-review and pass --trust ${summary.headSha}.\n`,
    };
  }

  // --- Origin/remote gate (PR #48 round-2 blocker 4) ---
  // The PR must belong to the same `owner/repo` as the checkout's
  // `origin` remote. A reviewer who ran `revkit review 42` from a
  // clone of `foo/bar` and got a PR from `evil/other` would
  // otherwise blindly fetch that repo's `refs/pull/42/head`.
  try {
    const originUrl = await readOriginUrl(env.git, repoRoot);
    if (originUrl === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          `revkit review: no 'origin' remote configured in ${repoRoot}. ` +
          `Set one (e.g. 'git remote add origin git@github.com:${pr.owner}/${pr.repo}.git') and retry.\n`,
      };
    }
    const originSlug = parseGithubRemoteUrl(originUrl);
    if (originSlug === undefined) {
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          `revkit review: 'origin' URL ${originUrl} is not a recognised github.com URL — refusing.\n`,
      };
    }
    if (
      originSlug.owner.toLowerCase() !== pr.owner.toLowerCase() ||
      originSlug.repo.toLowerCase() !== pr.repo.toLowerCase()
    ) {
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          `revkit review: PR ${pr.owner}/${pr.repo}#${pr.pullNumber} does not match the local 'origin' ` +
          `remote (${originSlug.owner}/${originSlug.repo}). Refusing — clone the right repo and retry.\n`,
      };
    }
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `revkit review: origin-remote check failed: ${(error as Error).message}\n`,
    };
  }

  // Fetch commits into the local object DB so ls-tree and cat-file
  // can read from either side.
  try {
    await ensurePrCommits({
      runner: env.git,
      repoCwd: repoRoot,
      pullNumber: pr.pullNumber,
      headSha: summary.headSha,
      baseSha: summary.baseSha,
      baseRef: summary.baseRef,
    });
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: `${(error as Error).message}\n` };
  }

  // --- Post-fetch head-SHA verification (TOCTOU close, PR #48 R2 B3) ---
  // The adapter told us the head was `summary.headSha`. Re-read the
  // ref we just fetched — if it drifted between the adapter call
  // and the fetch, or if the local ref points anywhere other than
  // that SHA, refuse. `--trust <sha>` must equal this AS WELL.
  let fetchedHead: string;
  try {
    fetchedHead = await readFetchedHeadSha(env.git, repoRoot, pr.pullNumber);
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `revkit review: could not verify fetched head SHA: ${(error as Error).message}\n`,
    };
  }
  if (fetchedHead.toLowerCase() !== summary.headSha.toLowerCase()) {
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        `revkit review: fetched head SHA ${fetchedHead} does not match the PR head ${summary.headSha} ` +
        `advertised by GitHub. The head moved between the adapter call and the fetch — refusing (TOCTOU close).\n`,
    };
  }
  if (trustSha !== undefined && !trustMatches(trustSha, fetchedHead)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        `revkit review: --trust ${trustSha} does not match the fetched head ${fetchedHead} — refusing.\n`,
    };
  }

  // Tooling diff — computed against the merge-base of head and
  // base (not the base tip; PR #48 round-2 nit). Refuse without
  // --trust if any tooling file differs there. Always compute so
  // we can PRINT it when --trust is given.
  let diff: ToolingDiff;
  try {
    diff = await computeToolingDiff(env.git, repoRoot, summary.baseSha, fetchedHead);
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: `${(error as Error).message}\n` };
  }
  if (diff.tooling.length > 0 && trustSha === undefined) {
    const list = formatToolingDiff(diff);
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        `revkit review: PR #${pr.pullNumber} changes tooling files vs merge-base ` +
        `(${diff.mergeBase.slice(0, 12)}..${fetchedHead.slice(0, 12)}). ` +
        `Refusing without --trust <sha>.\n\n` +
        `Tooling files that differ from merge-base:\n${list}\n\n` +
        `If these changes are safe, review them and re-run with:\n` +
        `  revkit review ${pr.pullNumber} --trust ${fetchedHead}\n`,
    };
  }

  const stdoutLines: string[] = [];
  stdoutLines.push(`revkit review: ${pr.owner}/${pr.repo}#${pr.pullNumber} — ${summary.title}`);
  stdoutLines.push(`  head: ${fetchedHead}  (${summary.headRef})`);
  stdoutLines.push(`  base: ${summary.baseSha}  (${summary.baseRef})`);
  stdoutLines.push(`  merge-base: ${diff.mergeBase}`);
  if (diff.tooling.length > 0) {
    stdoutLines.push(``);
    stdoutLines.push(`Tooling files taken from BASE (trusted via --trust ${trustSha}):`);
    stdoutLines.push(formatToolingDiff(diff));
  }
  if (diff.content.length > 0) {
    stdoutLines.push(``);
    stdoutLines.push(`Content files taken from PR head: ${diff.content.length}`);
  }

  // --- Path layout (PR #48 round-2 blocker 5) ---
  // Per-PR root is `.revkit/review/<owner>-<repo>-<pr>/`; a rerun
  // reuses this. The **survivable state** (sqlite) lives at
  // `<root>/state/threads.sqlite` and is NEVER removed by a rerun.
  // The materialised head lives at `<root>/head-<sha>/`, and the
  // built dist at `<root>/head-<sha>/dist/`.
  ensureRevkitDir(repoRoot);
  const prRootDir = perPrRoot(repoRoot, pr);
  const stateDir = perPrStateDir(repoRoot, pr);
  const sqlitePath = perPrSqlitePath(repoRoot, pr);
  mkdirSync(prRootDir, { recursive: true, mode: 0o700 });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  // Prune stale head-*/ directories under this PR root (keep only
  // the state/ directory and the current head-<sha>). A rerun on a
  // moved head must not accumulate old worktrees.
  pruneStaleHeadDirs(prRootDir, fetchedHead);

  // Materialize.
  const materializedRoot = reviewTargetDir(repoRoot, pr, fetchedHead);
  // Clean a stale target for THIS head that a previous crash left
  // behind.
  if (reviewTargetExists(repoRoot, pr, fetchedHead)) {
    rmSync(materializedRoot, { recursive: true, force: true });
  }
  try {
    const outcome = await materializeSafeTree({
      runner: env.git,
      cwd: repoRoot,
      // Tooling source = the merge-base tree, so the "reviewer's
      // trusted toolchain" reflects the fork point rather than a
      // base-tip that may have moved.
      baseSha: diff.mergeBase,
      headSha: fetchedHead,
      targetDir: materializedRoot,
    });
    stdoutLines.push(``);
    stdoutLines.push(
      `Materialized ${outcome.contentPaths.length} content + ${outcome.toolingPaths.length} tooling files ` +
        `(${outcome.bytesWritten} bytes) at ${prettyPath(repoRoot, materializedRoot)}`,
    );
  } catch (error) {
    if (existsSync(materializedRoot)) {
      rmSync(materializedRoot, { recursive: true, force: true });
    }
    if (error instanceof MaterializeError) {
      return { exitCode: 1, stdout: "", stderr: `${error.message}\n` };
    }
    return { exitCode: 1, stdout: "", stderr: `revkit review: materialize failed: ${(error as Error).message}\n` };
  }

  // Run `revkit check` over the materialized content, IN UNTRUSTED
  // MODE (PR #48 round-2 blocker 1). Untrusted mode disables the
  // allow-annotation escape hatch and refuses executable vega keys.
  const checkResult = await runCheckOnMaterialized(materializedRoot, env);
  if (checkResult.diagnostics.length > 0) {
    return {
      exitCode: 1,
      stdout: `${stdoutLines.join("\n")}\n`,
      stderr:
        `revkit review: 'revkit check' failed on the PR content:\n${checkResult.diagnostics.join("\n")}\n`,
    };
  }
  stdoutLines.push(`revkit check: PR content passed (${checkResult.filesScanned} files scanned)`);

  // --- Safe build (PR #48 round-2 blocker 2) ---
  // Run astro build on the materialised worktree with a MINIMAL env
  // (no GITHUB_TOKEN / GH_TOKEN / npm_ tokens). The output lands at
  // `<materializedRoot>/site/dist`. If the caller injected a build
  // hook (tests / bench), use that instead. `revkit check-dist`
  // then sanitises the built HTML before we serve it.
  const distOutDir = join(materializedRoot, "site", "dist");
  const buildHook: BuildHook = env.build ?? runSafeBuild;
  try {
    await buildHook({ materializedRoot, distOutDir });
    stdoutLines.push(`build: ok  (${prettyPath(repoRoot, distOutDir)})`);
  } catch (error) {
    return {
      exitCode: 1,
      stdout: `${stdoutLines.join("\n")}\n`,
      stderr: `revkit review: build failed: ${(error as Error).message}\n`,
    };
  }

  // --- check-dist on the built output before serving (ADR-0012) ---
  if (env._skipCheckDist !== true) {
    const { checkDistDirectory } = await import("../check-dist.ts");
    const distDiags = checkDistDirectory(distOutDir);
    if (distDiags.length > 0) {
      const { formatDiagnostic } = await import("../diagnostics.ts");
      return {
        exitCode: 1,
        stdout: `${stdoutLines.join("\n")}\n`,
        stderr:
          `revkit review: 'revkit check-dist' refused the built PR output:\n` +
          distDiags.map(formatDiagnostic).join("\n") +
          "\n",
      };
    }
    stdoutLines.push(`check-dist: PR output passed`);
  }

  // Import existing PR threads — sqlite lives OUTSIDE the
  // materialized tree (see path-layout note above).
  const store = SqliteThreadStore.open({
    filename: sqlitePath,
    displayName: `review-${pr.owner}-${pr.repo}-${pr.pullNumber}`,
  });
  let populate: PopulateOutcome;
  try {
    const threads = await adapter.listReviewThreads(pr);
    populate = await populateStoreFromPr({
      pr,
      threads,
      headSha: fetchedHead,
      baseRef: summary.baseRef,
      adapter,
      materializedRoot,
      store,
    });
  } catch (error) {
    store.close();
    return {
      exitCode: 1,
      stdout: `${stdoutLines.join("\n")}\n`,
      stderr: `revkit review: failed to import PR threads: ${(error as Error).message}\n`,
    };
  } finally {
    // Close our handle either way — the daemon will re-open the
    // same sqlite file with its own handle if serving.
    store.close();
  }
  stdoutLines.push(
    `import: ${populate.appended} new PR thread events, ${populate.skipped} already-present` +
      (populate.refused > 0 ? `, ${populate.refused} refused (see logs)` : ""),
  );

  // Serve.
  if (!parsed.serve || env.startServe === undefined) {
    stdoutLines.push(``);
    stdoutLines.push(
      `Prepared review at ${prettyPath(repoRoot, materializedRoot)}.` +
        (parsed.serve
          ? `\nRun 'revkit serve --dir ${prettyPath(repoRoot, distOutDir)}' to serve.`
          : ""),
    );
    return { exitCode: 0, stdout: `${stdoutLines.join("\n")}\n`, stderr: "" };
  }

  const localUserId = env.localUserId;

  const serveHandle = await env.startServe({
    materializedRoot,
    distDir: distOutDir,
    sqlitePath,
    repoRoot,
    localUserId,
  });
  stdoutLines.push(``);
  stdoutLines.push(`revkit serve: listening on ${serveHandle.url}`);
  stdoutLines.push(`  launch: ${serveHandle.launchUrl}   (single-use)`);
  stdoutLines.push(`  reviewing PR #${pr.pullNumber}`);
  return {
    exitCode: 0,
    stdout: `${stdoutLines.join("\n")}\n`,
    stderr: "",
    blockForever: serveHandle.blockForever,
  };
}

/** Run `revkit check` over the CONTENT subtree of the materialized
 * worktree. Reuses the existing walk + rule pipeline so a PR that
 * would fail `check` on merge fails it in the review too. */
async function runCheckOnMaterialized(
  materializedRoot: string,
  env: RunReviewEnv,
): Promise<{ diagnostics: string[]; filesScanned: number }> {
  const discovery = walkForCheckables(materializedRoot);
  const files = toCheckFiles(discovery.files, materializedRoot);
  const output = await runCheck(materializedRoot, files, discovery.symlinks, {
    online: false,
    repoSlug: env.repoSlug,
    gh: env.gh,
    // PR #48 round-2 blocker 1: content from an untrusted PR MUST
    // NOT get the allow-annotation escape hatch, and must run the
    // vega-untrusted refusal. This is the seam that carries the
    // trust posture down through the whole rule pipeline.
    trust: "untrusted",
  });
  return {
    diagnostics: output.exitCode === 0 ? [] : [...output.lines],
    filesScanned: files.length,
  };
}

/** Build the default adapter — one that reads the token via
 * `gh auth token`. Never caches the token, never logs it. */
function buildDefaultAdapter(gh: GhRunner): GitHubAdapter {
  return new GitHubAdapter({ token: createGhTokenSource({ gh }) });
}

/** Render `absolute` relative to `repoRoot` for stdout. */
function prettyPath(repoRoot: string, absolute: string): string {
  const rel = resolvePath(absolute).slice(resolvePath(repoRoot).length);
  const trimmed = rel.startsWith("/") ? rel.slice(1) : rel;
  return trimmed.length > 0 ? trimmed : absolute;
}

/** Remove any subdirectory of the per-PR root whose name starts
 * with `head-` and is NOT the current head. Keeps `state/` untouched
 * so the survivable per-PR sqlite / snapshot store persists across
 * head moves and reruns (PR #48 round-2 blocker 5). Safe when the
 * root does not exist yet. */
function pruneStaleHeadDirs(prRootDir: string, currentHead: string): void {
  let entries: string[];
  try {
    entries = readdirSync(prRootDir);
  } catch {
    return;
  }
  const currentDir = `head-${currentHead.slice(0, 12)}`;
  for (const entry of entries) {
    if (!entry.startsWith("head-")) continue;
    if (entry === currentDir) continue;
    try {
      rmSync(join(prRootDir, entry), { recursive: true, force: true });
    } catch {
      // best effort — a stale dir the user has open (e.g. an
      // editor viewing a file) is harmless; it will be cleaned on
      // the next rerun.
    }
  }
}
