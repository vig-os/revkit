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

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
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
import { ensurePrCommits, reviewTargetDir, reviewTargetExists } from "./fetch-pr.ts";
import { computeToolingDiff, formatToolingDiff, type ToolingDiff } from "./tooling-diff.ts";
import { materializeSafeTree, MaterializeError } from "./materialize.ts";
import { populateStoreFromPr, type PopulateOutcome } from "./import-threads.ts";
import { SqliteThreadStore } from "../serve/sqlite-store.ts";
import { ensureRevkitDir } from "../serve/serve-state.ts";

/** Result shape aligned with the dispatcher's `CliResult`. */
export interface RunReviewResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly blockForever?: Promise<void>;
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
  /** Injectable build hook. Called AFTER materialize + check +
   * import; the default is a no-op stub (part 2a does not run the
   * astro build itself; that is done by a follow-up "revkit build"
   * on the reviewer's side). Tests inject a hook that fakes a
   * `dist/`. Returning a rejected promise aborts the command with
   * that error. */
  readonly build?: (materializedRoot: string) => Promise<void>;
  /** Injectable serve start. Defaults to importing `startDaemon`
   * and calling it. Tests set this to a no-op. When absent, the
   * command runs the daemon; when present, tests use their stub.
   * A `--no-serve` flag also skips this. */
  readonly startServe?: (options: { materializedRoot: string; sqlitePath: string; repoRoot: string; localUserId: string }) => Promise<{ url: string; port: number; launchUrl: string; blockForever: Promise<void>; stop(): Promise<void> }>;
  /** Injectable local user id — falls back to reading/minting
   * `.revkit/local-user`. */
  readonly localUserId?: string;
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

/** A hex-only string of length 7..64. Loose enough for short SHAs the
 * reviewer might paste from a PR URL, strict enough to refuse
 * obviously invalid input (spaces, quotes). */
export function isPlausibleSha(value: string): boolean {
  if (value.length < 7 || value.length > 64) return false;
  return /^[0-9a-fA-F]+$/.test(value);
}

/** True when the trusted SHA prefix matches the actual head SHA. */
export function trustMatches(trusted: string, actual: string): boolean {
  if (trusted.length === 0 || actual.length === 0) return false;
  const t = trusted.toLowerCase();
  const a = actual.toLowerCase();
  // Only a genuine prefix match — a 7-char SHA a reviewer pasted
  // from a URL should trust the same commit.
  if (t.length > a.length) return false;
  return a.startsWith(t);
}

/** Build the default `env` used by the top-level CLI dispatcher. */
export function defaultReviewEnv(cwd: string, version: string, repoSlug: string): RunReviewEnv {
  return { cwd, version, gh: spawnGh, git: spawnGit, repoSlug };
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

  // Fork check — refuse without `--trust`.
  const isFork = summary.headRepoFullName !== null && summary.headRepoFullName !== summary.baseRepoFullName;
  if (isFork && trustSha === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        `revkit review: PR #${pr.pullNumber} is from a fork ` +
        `(${summary.headRepoFullName} → ${summary.baseRepoFullName}). ` +
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

  // Tooling diff — refuse without --trust if any tooling file
  // changed. Always compute so we can PRINT it when --trust is
  // given.
  let diff: ToolingDiff;
  try {
    diff = await computeToolingDiff(env.git, repoRoot, summary.baseSha, summary.headSha);
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: `${(error as Error).message}\n` };
  }
  if (diff.tooling.length > 0 && trustSha === undefined) {
    const list = formatToolingDiff(diff);
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        `revkit review: PR #${pr.pullNumber} changes tooling files vs base ` +
        `(${summary.baseSha.slice(0, 12)}..${summary.headSha.slice(0, 12)}). ` +
        `Refusing without --trust <sha>.\n\n` +
        `Tooling files that differ from base:\n${list}\n\n` +
        `If these changes are safe, review them and re-run with:\n` +
        `  revkit review ${pr.pullNumber} --trust ${summary.headSha}\n`,
    };
  }

  const stdoutLines: string[] = [];
  stdoutLines.push(`revkit review: ${pr.owner}/${pr.repo}#${pr.pullNumber} — ${summary.title}`);
  stdoutLines.push(`  head: ${summary.headSha}  (${summary.headRef})`);
  stdoutLines.push(`  base: ${summary.baseSha}  (${summary.baseRef})`);
  if (diff.tooling.length > 0) {
    stdoutLines.push(``);
    stdoutLines.push(`Tooling files taken from BASE (trusted via --trust ${trustSha}):`);
    stdoutLines.push(formatToolingDiff(diff));
  }
  if (diff.content.length > 0) {
    stdoutLines.push(``);
    stdoutLines.push(`Content files taken from PR head: ${diff.content.length}`);
  }

  // Materialize.
  const materializedRoot = reviewTargetDir(repoRoot, pr.pullNumber, summary.headSha);
  ensureRevkitDir(repoRoot);
  // Materialize's target dir must not exist, but its parent
  // (`.revkit/review/`) must. Create the parent tree at mode 0700
  // through the shared helper — the per-review dir is created by
  // the materializer.
  const reviewsParent = join(repoRoot, ".revkit", "review");
  mkdirSync(reviewsParent, { recursive: true, mode: 0o700 });
  // Clean a stale target that a previous crash left behind.
  if (reviewTargetExists(repoRoot, pr.pullNumber, summary.headSha)) {
    rmSync(materializedRoot, { recursive: true, force: true });
  }
  try {
    const outcome = await materializeSafeTree({
      runner: env.git,
      cwd: repoRoot,
      baseSha: summary.baseSha,
      headSha: summary.headSha,
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

  // Run `revkit check` over the materialized content ONLY. The
  // check walks the tree; we point it at the content dirs inside
  // materializedRoot.
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

  // Optional build step (astro build in the materialized worktree).
  // The default is a no-op — the reviewer runs it separately in 2a,
  // and 2b will wire it up as the daemon starts.
  if (env.build !== undefined) {
    try {
      await env.build(materializedRoot);
      stdoutLines.push(`build: ok`);
    } catch (error) {
      return {
        exitCode: 1,
        stdout: `${stdoutLines.join("\n")}\n`,
        stderr: `revkit review: build failed: ${(error as Error).message}\n`,
      };
    }
  }

  // Import existing PR threads.
  const sqlitePath = join(materializedRoot, ".revkit-threads.sqlite");
  const store = SqliteThreadStore.open({ filename: sqlitePath, displayName: `review-${pr.pullNumber}` });
  let populate: PopulateOutcome;
  try {
    const threads = await adapter.listReviewThreads(pr);
    populate = await populateStoreFromPr({
      pr,
      threads,
      headSha: summary.headSha,
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
    // If startServe will re-open the same sqlite path, close ours so
    // there is no double-writer. The daemon opens its own store
    // handle. (If `startServe` is not set, we close now.)
    if (parsed.serve === false || env.startServe === undefined) {
      store.close();
    } else {
      store.close();
    }
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
        (parsed.serve ? "\nSet env.startServe or run 'revkit serve --dir <that path>/site/dist' to serve." : ""),
    );
    return { exitCode: 0, stdout: `${stdoutLines.join("\n")}\n`, stderr: "" };
  }

  const localUserId =
    env.localUserId ??
    // The daemon expects a local user id. If the caller didn't
    // supply one, mint a per-review id from a CSPRNG so it doesn't
    // touch the reviewer's own .revkit/local-user, and so the
    // opaque tag has no predictability the daemon's auth might
    // ever depend on later.
    `review-${randomBytes(9).toString("base64url")}`;

  const serveHandle = await env.startServe({
    materializedRoot,
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
