// Adversarial end-to-end tests for `revkit review` (PR #48 round-4
// APPROVAL requirement). Each case drives the REAL `runReviewCommand`
// with the DEFAULT `runSafeBuild` (no build injection) on a fixture
// PR of THIS repo and asserts the properties below (five bullets):
//
//   1) exit code is non-zero
//   2) stderr names the rule or refusal reason
//   3) NO built dist directory was created (build never ran because
//      the check aborts before it)
//   4) the canary side-effect file NEVER exists on disk
//   5) the reviewer's `<checkout>/site/.astro/` and
//      `<checkout>/site/node_modules/{.astro,.vite}` are byte-for-byte
//      unchanged (the sandbox never wrote through the trusted tree)
//
// **RED evidence.** Every case has a companion run that INJECTS a
// weakened `runCheck` via `env._runCheck` — the seam
// `runCheckOnMaterialized` uses. With the guard removed the same
// `runReviewCommand` accepts the fixture (proves the SHIPPING guard
// is what refuses it). The RED run stubs the build hook so no astro
// process actually runs — the guard-level counterfactual is what we
// want to show, not a full build.
//
// Guarded by `REVKIT_E2E_BUILD=1`; `just test` sets it. Each test
// creates a real commit on top of the local `origin/dev` and points
// `refs/revkit/pr-<n>/head` at it — the CLI's fetch step is
// intercepted by a git-runner shim that short-circuits the network
// call. Every other git command (ls-tree, cat-file, merge-base,
// diff, remote get-url, rev-parse) runs against the real repo.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative as relativePath, resolve as resolvePath } from "node:path";
import type { GitResult } from "../../src/git-runner.ts";
import { spawnGit } from "../../src/git-runner.ts";
import { runCheck } from "../../src/check.ts";
import { GitHubAdapter, type GhReviewThread, type PullRequestSummary } from "@revkit/review-core";
import { runReviewCommand, type RunReviewEnv } from "../../src/review/cli.ts";

const CHECKOUT_ROOT = resolvePath(import.meta.dirname!, "..", "..", "..", "..");
const E2E = process.env.REVKIT_E2E_BUILD === "1";

/** Snapshot of `<root>` — sha256 + size + mtimeMs per regular file.
 * Directories are walked recursively; symlinks and non-regular
 * entries are ignored. Used to prove the reviewer's real trusted
 * caches (`site/.astro`, `site/node_modules/.astro`,
 * `site/node_modules/.vite`) are byte-for-byte unchanged across a
 * review run. */
function snapshotTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(root)) return out;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = join(cur, entry);
      let st;
      try {
        st = statSync(abs, { throwIfNoEntry: false });
      } catch {
        continue;
      }
      if (st === undefined) continue;
      if (st.isDirectory()) {
        stack.push(abs);
      } else if (st.isFile()) {
        const hash = new Bun.CryptoHasher("sha256").update(readFileSync(abs)).digest("hex");
        out.set(relativePath(root, abs), `${hash}:${st.size}:${st.mtimeMs}`);
      }
    }
  }
  return out;
}

/** Snapshot the reviewer's trusted caches — the three dirs the safe
 * build MUST NOT write through to. */
function snapshotTrustedCaches(): {
  astro: Map<string, string>;
  nmAstro: Map<string, string>;
  nmVite: Map<string, string>;
} {
  return {
    astro: snapshotTree(join(CHECKOUT_ROOT, "site", ".astro")),
    nmAstro: snapshotTree(join(CHECKOUT_ROOT, "site", "node_modules", ".astro")),
    nmVite: snapshotTree(join(CHECKOUT_ROOT, "site", "node_modules", ".vite")),
  };
}

/** Build a real git commit on top of `origin/dev` that adds/modifies
 * one or more files. Returns the commit SHA and the base SHA
 * (origin/dev). Uses a scratch index so the reviewer's real working
 * index is untouched. */
async function buildAdversarialCommit(input: {
  readonly slug: string;
  readonly changes: ReadonlyArray<{ readonly path: string; readonly content: string; readonly mode?: string }>;
}): Promise<{ readonly headSha: string; readonly baseSha: string }> {
  const baseSha = (await spawnGit(["rev-parse", "origin/dev"], CHECKOUT_ROOT)).stdout.trim();
  // Scratch index in a per-test tempdir — outside `.git/` because
  // this checkout is a git worktree (`.git` is a FILE that
  // redirects to the main repo's `worktrees/<name>/`, so `.git/foo`
  // can't be a directory here). git writes a sibling `.lock` next
  // to the index during write-tree, so the containing dir must be
  // writable and outside the working tree.
  const scratchDir = mkdtempSync(join(tmpdir(), `revkit-adv-${input.slug}-`));
  const scratchIdx = join(scratchDir, "index");
  const commonEnv = {
    ...process.env,
    GIT_INDEX_FILE: scratchIdx,
    GIT_AUTHOR_NAME: "adv",
    GIT_AUTHOR_EMAIL: "adv@example.invalid",
    GIT_COMMITTER_NAME: "adv",
    GIT_COMMITTER_EMAIL: "adv@example.invalid",
  } as const;
  const spawnScratch = async (args: readonly string[], stdinBytes?: Buffer): Promise<GitResult> => {
    const proc = Bun.spawn(["git", "-C", CHECKOUT_ROOT, ...args], {
      env: commonEnv,
      stdout: "pipe",
      stderr: "pipe",
      ...(stdinBytes !== undefined ? { stdin: stdinBytes } : {}),
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  };
  // Seed the scratch index from `baseSha` — the "before" tree.
  const readTree = await spawnScratch(["read-tree", baseSha]);
  if (readTree.exitCode !== 0) throw new Error(`git read-tree failed: ${readTree.stderr}`);
  // Hash each new blob into the object DB, then update-index for
  // its intended path.
  for (const change of input.changes) {
    const hashProc = Bun.spawn(
      ["git", "-C", CHECKOUT_ROOT, "hash-object", "-w", "--stdin"],
      { env: commonEnv, stdin: Buffer.from(change.content, "utf8"), stdout: "pipe", stderr: "pipe" },
    );
    const [hashStdout, hashStderr, hashExit] = await Promise.all([
      new Response(hashProc.stdout).text(),
      new Response(hashProc.stderr).text(),
      hashProc.exited,
    ]);
    if (hashExit !== 0) throw new Error(`git hash-object failed: ${hashStderr}`);
    const blobSha = hashStdout.trim();
    const mode = change.mode ?? "100644";
    const updateIdx = await spawnScratch([
      "update-index",
      "--add",
      "--cacheinfo",
      `${mode},${blobSha},${change.path}`,
    ]);
    if (updateIdx.exitCode !== 0) throw new Error(`git update-index failed for ${change.path}: ${updateIdx.stderr}`);
  }
  const writeTree = await spawnScratch(["write-tree"]);
  if (writeTree.exitCode !== 0) throw new Error(`git write-tree failed: ${writeTree.stderr}`);
  const treeSha = writeTree.stdout.trim();
  const commitTree = await spawnScratch([
    "commit-tree",
    treeSha,
    "-p",
    baseSha,
    "-m",
    `adversarial-e2e: ${input.slug}`,
  ]);
  if (commitTree.exitCode !== 0) throw new Error(`git commit-tree failed: ${commitTree.stderr}`);
  const headSha = commitTree.stdout.trim();
  // Clean up scratch dir.
  try {
    rmSync(scratchDir, { recursive: true, force: true });
  } catch {
    /* fine */
  }
  return { headSha, baseSha };
}

/** Point `refs/revkit/pr-<n>/head` at `sha`. `ensurePrCommits` will
 * NOT overwrite it because our fake `git` runner short-circuits the
 * `fetch` — that's how the CLI proceeds without hitting the network. */
async function pinPrHeadRef(pullNumber: number, sha: string): Promise<void> {
  const ref = `refs/revkit/pr-${pullNumber}/head`;
  const res = await spawnGit(["update-ref", ref, sha], CHECKOUT_ROOT);
  if (res.exitCode !== 0) {
    throw new Error(`update-ref ${ref} ${sha} failed: ${res.stderr}`);
  }
  if (!refsToClean.includes(ref)) refsToClean.push(ref);
}

/** Fake `GitHubAdapter` — everything the CLI reads from the adapter is
 * static. `owner/vig-os` + `repo/revkit` match the reviewer's own
 * origin URL so the origin-remote gate passes. */
function installFakeAdapter(summary: PullRequestSummary): void {
  GitHubAdapter.prototype.getPullRequest = async function () {
    return summary;
  };
  GitHubAdapter.prototype.listReviewThreads = async function () {
    return [] as GhReviewThread[];
  };
  GitHubAdapter.prototype.listPullRequestFiles = async function () {
    return [];
  };
}

/** Detect the safe-git `fetch <remote> +refs/pull/<n>/head:refs/revkit/pr-<n>/head`
 * pattern in the argv (the safe prefix rides in front of the
 * subcommand). We return exit code 0 with no output — the ref has
 * been pre-set by the test. Every other git call falls through to
 * the real `spawnGit`. */
function makeInterceptingGitRunner(): (args: readonly string[], cwd: string) => Promise<GitResult> {
  return async (args, cwd) => {
    const isPrHeadFetch =
      args.includes("fetch") &&
      args.some((a) => /^\+refs\/pull\/\d+\/head:refs\/revkit\/pr-\d+\/head$/.test(a));
    if (isPrHeadFetch) {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return await spawnGit(args, cwd);
  };
}

/** Weakened `runCheck` — forces the trust posture to "trusted" so
 * the SHIPPING untrusted guards (component-registry, plot-structure
 * vega walk) are bypassed. Everything ELSE about `runCheck` is
 * unchanged — this is the injection seam
 * `runCheckOnMaterialized` uses. */
const weakenedRunCheck: typeof runCheck = async (repoRoot, files, symlinks, options) => {
  return runCheck(repoRoot, files, symlinks, { ...options, trust: "trusted" });
};

/** Stub build hook — records invocation, writes NOTHING, so a RED
 * run cannot leak files to disk. The SHIPPING-mode assertions never
 * trigger this — the check refuses before build. */
function makeStubBuild(record: { called: boolean }): NonNullable<RunReviewEnv["build"]> {
  return async () => {
    record.called = true;
  };
}

/** Build a `RunReviewEnv` for one adversarial run. */
function makeAdversarialEnv(input: {
  readonly weakened?: boolean;
  readonly stubBuild?: { called: boolean };
}): RunReviewEnv {
  const staticToken = { async getToken() { return "ghp_" + "a".repeat(40); } };
  const env: RunReviewEnv = {
    cwd: CHECKOUT_ROOT,
    version: "0.0.0",
    gh: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    git: makeInterceptingGitRunner(),
    repoSlug: "vig-os/revkit",
    makeAdapter: () => new GitHubAdapter({ token: staticToken, fetch: globalThis.fetch }),
    localUserId: "review-adv-e2e",
    ...(input.weakened === true ? { _runCheck: weakenedRunCheck } : {}),
    ...(input.stubBuild !== undefined ? { build: makeStubBuild(input.stubBuild) } : {}),
    // Skip check-dist in the RED path — the stub build writes no
    // dist, so check-dist would fail on the missing directory. The
    // SHIPPING assertions never reach check-dist (they abort at the
    // check step), so this flag is only observed on RED runs.
    ...(input.weakened === true ? { _skipCheckDist: true } : {}),
  };
  return env;
}

/** One-shot summary factory. */
function makeSummary(pr: { pullNumber: number; headSha: string; baseSha: string }): PullRequestSummary {
  return {
    number: pr.pullNumber,
    nodeId: "PR",
    title: "adversarial",
    state: "open",
    draft: false,
    headSha: pr.headSha,
    headRef: "adv",
    baseSha: pr.baseSha,
    baseRef: "dev",
    headRepoFullName: "vig-os/revkit",
    baseRepoFullName: "vig-os/revkit",
    url: `https://github.com/vig-os/revkit/pull/${pr.pullNumber}`,
  };
}

/** After each vector, remove its sandbox and its per-PR state — the
 * reviewer's real caches are asserted-untouched, but this run's
 * generated `head-<sha>/` and `.revkit/review/<slug>/` dirs are
 * ours to clean. */
const dirsToClean: string[] = [];
const refsToClean: string[] = [];
afterAll(async () => {
  for (const d of dirsToClean) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
  // Remove the `refs/revkit/pr-<n>/head` refs we pinned so a later
  // legitimate `revkit review` on the same PR numbers starts clean.
  for (const ref of refsToClean) {
    try { await spawnGit(["update-ref", "-d", ref], CHECKOUT_ROOT); } catch {}
  }
});

/** Restore adapter prototype methods after this file — a defensive
 * belt in case bun's test runner shares module state with other
 * test files. */
const originalAdapterMethods = {
  getPullRequest: GitHubAdapter.prototype.getPullRequest,
  listReviewThreads: GitHubAdapter.prototype.listReviewThreads,
  listPullRequestFiles: GitHubAdapter.prototype.listPullRequestFiles,
};
afterAll(() => {
  GitHubAdapter.prototype.getPullRequest = originalAdapterMethods.getPullRequest;
  GitHubAdapter.prototype.listReviewThreads = originalAdapterMethods.listReviewThreads;
  GitHubAdapter.prototype.listPullRequestFiles = originalAdapterMethods.listPullRequestFiles;
});

const PR_ATTR_RCE = 9101;
const PR_VEGA_FILTER = 9102;
const PR_VEGA_DOS = 9103;
const PR_NODE_MODULES = 9104;
const PR_TOOLING = 9105;
const PR_CONTENT_PKG = 9106;

/** Canary file paths — each vector's malicious side effect points at
 * a distinct path so a bug in one vector cannot accidentally satisfy
 * another vector's assertions. */
const HOME_DIR = process.env.HOME ?? "/tmp";
const CANARY_ATTR = join(HOME_DIR, ".revkit-canary-attr-rce");
const CANARY_TOOLING = join(HOME_DIR, ".revkit-canary-tooling");
const CANARY_NODE_MODULES = join(HOME_DIR, ".revkit-canary-node-modules");

beforeAll(() => {
  // Every canary file MUST NOT exist before we run. If a previous
  // run left one behind, remove it — a stale file from an unrelated
  // run must not fail the "canary never exists" assertion here.
  for (const c of [CANARY_ATTR, CANARY_TOOLING, CANARY_NODE_MODULES]) {
    try { rmSync(c, { force: true }); } catch {}
  }
});

/** Shared driver for the SHIPPING case. Runs `runReviewCommand`
 * end-to-end and returns the result + the trusted-cache snapshots
 * before/after. */
async function driveShipping(input: {
  readonly slug: string;
  readonly pullNumber: number;
  readonly changes: ReadonlyArray<{ readonly path: string; readonly content: string; readonly mode?: string }>;
}): Promise<{
  readonly result: Awaited<ReturnType<typeof runReviewCommand>>;
  readonly beforeCaches: ReturnType<typeof snapshotTrustedCaches>;
  readonly afterCaches: ReturnType<typeof snapshotTrustedCaches>;
  readonly headSha: string;
  readonly materializedRoot: string;
}> {
  const commit = await buildAdversarialCommit({ slug: input.slug, changes: input.changes });
  await pinPrHeadRef(input.pullNumber, commit.headSha);
  installFakeAdapter(makeSummary({ pullNumber: input.pullNumber, headSha: commit.headSha, baseSha: commit.baseSha }));
  const beforeCaches = snapshotTrustedCaches();
  const env = makeAdversarialEnv({});
  const result = await runReviewCommand([String(input.pullNumber), "--no-serve"], env);
  const afterCaches = snapshotTrustedCaches();
  const materializedRoot = join(
    CHECKOUT_ROOT,
    "site",
    ".revkit-review",
    `vig-os-revkit-${input.pullNumber}`,
    `head-${commit.headSha.slice(0, 12)}`,
  );
  dirsToClean.push(
    join(CHECKOUT_ROOT, "site", ".revkit-review", `vig-os-revkit-${input.pullNumber}`),
    join(CHECKOUT_ROOT, ".revkit", "review", `vig-os-revkit-${input.pullNumber}`),
  );
  return { result, beforeCaches, afterCaches, headSha: commit.headSha, materializedRoot };
}

/** Shared driver for the WEAKENED case. Uses the SAME commit +
 * pinned ref pattern as the shipping driver but injects both
 * `_runCheck` (weakened) AND a stub build. The point: prove the
 * SHIPPING guard is what refuses the fixture. */
async function driveWeakened(input: {
  readonly slug: string;
  readonly pullNumber: number;
  readonly changes: ReadonlyArray<{ readonly path: string; readonly content: string; readonly mode?: string }>;
}): Promise<{
  readonly result: Awaited<ReturnType<typeof runReviewCommand>>;
  readonly buildCalled: boolean;
}> {
  const commit = await buildAdversarialCommit({ slug: input.slug + "-red", changes: input.changes });
  await pinPrHeadRef(input.pullNumber, commit.headSha);
  installFakeAdapter(makeSummary({ pullNumber: input.pullNumber, headSha: commit.headSha, baseSha: commit.baseSha }));
  const stubBuild = { called: false };
  const env = makeAdversarialEnv({ weakened: true, stubBuild });
  const result = await runReviewCommand([String(input.pullNumber), "--no-serve"], env);
  dirsToClean.push(
    join(CHECKOUT_ROOT, "site", ".revkit-review", `vig-os-revkit-${input.pullNumber}`),
    join(CHECKOUT_ROOT, ".revkit", "review", `vig-os-revkit-${input.pullNumber}`),
  );
  return { result, buildCalled: stubBuild.called };
}

/** Assert the reviewer's trusted caches are byte-for-byte unchanged. */
function expectCachesUnchanged(
  before: ReturnType<typeof snapshotTrustedCaches>,
  after: ReturnType<typeof snapshotTrustedCaches>,
): void {
  expect([...after.astro.entries()].sort()).toEqual([...before.astro.entries()].sort());
  expect([...after.nmAstro.entries()].sort()).toEqual([...before.nmAstro.entries()].sort());
  expect([...after.nmVite.entries()].sort()).toEqual([...before.nmVite.entries()].sort());
}

// -------------------------------------------------------------------------
// Vector A — MDX attribute expression that calls child_process
// -------------------------------------------------------------------------
describe.skipIf(!E2E)("adversarial e2e — MDX attribute expression (RCE-shape)", () => {
  // Multi-line `<Callout>` so the parser emits an mdxJsxFlowElement
  // at root level — a single-line Callout gets wrapped in a
  // paragraph and its `prev` sibling is text, not the annotation.
  const mdxNoAnnotation = (canary: string) =>
    `---\ntitle: attr\ndescription: attr-rce\n---\n\n` +
    `import { Callout } from "@revkit/components";\n\n` +
    `<Callout kind="info" title={globalThis.process.getBuiltinModule('node:child_process').execSync('touch ${canary}')}>\ninside\n</Callout>\n`;
  const mdxWithAnnotation = (canary: string) =>
    `---\ntitle: attr\ndescription: attr-rce\n---\n\n` +
    `import { Callout } from "@revkit/components";\n\n` +
    `{/* revkit-allow: #9999 */}\n\n` +
    `<Callout kind="info" title={globalThis.process.getBuiltinModule('node:child_process').execSync('touch ${canary}')}>\ninside\n</Callout>\n`;

  test("SHIPPING refuses the attribute expression WITHOUT a revkit-allow annotation", async () => {
    const path = "site/src/content/docs/attr-rce.mdx";
    const { result, beforeCaches, afterCaches, materializedRoot } = await driveShipping({
      slug: "attr-no-anno",
      pullNumber: PR_ATTR_RCE,
      changes: [{ path, content: mdxNoAnnotation(CANARY_ATTR) }],
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("component-registry");
    expect(result.stderr).toContain("non-static expression");
    expect(existsSync(join(materializedRoot, "site", "dist"))).toBe(false);
    expect(existsSync(CANARY_ATTR)).toBe(false);
    expectCachesUnchanged(beforeCaches, afterCaches);
  }, 180_000);

  test("SHIPPING refuses the attribute expression EVEN WITH a revkit-allow annotation (untrusted mode disables the escape hatch)", async () => {
    const path = "site/src/content/docs/attr-rce-anno.mdx";
    const { result, beforeCaches, afterCaches, materializedRoot } = await driveShipping({
      slug: "attr-with-anno",
      pullNumber: PR_ATTR_RCE,
      changes: [{ path, content: mdxWithAnnotation(CANARY_ATTR) }],
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("component-registry");
    expect(existsSync(join(materializedRoot, "site", "dist"))).toBe(false);
    expect(existsSync(CANARY_ATTR)).toBe(false);
    expectCachesUnchanged(beforeCaches, afterCaches);
  }, 180_000);

  test("WEAKENED (trust flipped to 'trusted') accepts the fixture — the untrusted guard is load-bearing", async () => {
    const path = "site/src/content/docs/attr-rce-red.mdx";
    const { result, buildCalled } = await driveWeakened({
      slug: "attr-red",
      pullNumber: PR_ATTR_RCE,
      changes: [{ path, content: mdxWithAnnotation(CANARY_ATTR) }],
    });
    // With trust: trusted, the annotation escape hatch fires and
    // the file passes the check. `revkit check: PR content passed`
    // is emitted BEFORE the build step; the stub build then runs
    // (proves the guard is what refused shipping — nothing else).
    expect(result.stdout).toContain("revkit check: PR content passed");
    expect(buildCalled).toBe(true);
    expect(existsSync(CANARY_ATTR)).toBe(false);
  }, 180_000);
});

// -------------------------------------------------------------------------
// Vector B — Vega spec with `filter` expression + `sequence(0, 3e7)` DoS
// -------------------------------------------------------------------------
describe.skipIf(!E2E)("adversarial e2e — Vega untrusted spec (filter, sequence DoS)", () => {
  const filterSpec = JSON.stringify({
    schemaVersion: 1,
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    data: { url: "data.json" },
    mark: "bar",
    transform: [{ filter: "datum.a > 0" }],
    encoding: { x: { field: "a", type: "quantitative" } },
  });
  const dosSpec = JSON.stringify({
    schemaVersion: 1,
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    data: { url: "data.json" },
    mark: "line",
    transform: [{ filter: "sequence(0, 30000000)" }],
    encoding: { x: { field: "a", type: "quantitative" } },
  });
  const dataJson = JSON.stringify([{ a: 1, b: 2 }]);

  test("SHIPPING refuses transform.filter", async () => {
    const { result, beforeCaches, afterCaches, materializedRoot } = await driveShipping({
      slug: "vega-filter",
      pullNumber: PR_VEGA_FILTER,
      changes: [
        { path: "plots/adv-filter/spec.vl.json", content: filterSpec },
        { path: "plots/adv-filter/data.json", content: dataJson },
      ],
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("plot-structure");
    expect(result.stderr).toContain("'filter'");
    expect(existsSync(join(materializedRoot, "site", "dist"))).toBe(false);
    expectCachesUnchanged(beforeCaches, afterCaches);
  }, 180_000);

  test("SHIPPING refuses transform.filter with sequence(0, 3e7) DoS payload", async () => {
    const { result, beforeCaches, afterCaches, materializedRoot } = await driveShipping({
      slug: "vega-dos",
      pullNumber: PR_VEGA_DOS,
      changes: [
        { path: "plots/adv-dos/spec.vl.json", content: dosSpec },
        { path: "plots/adv-dos/data.json", content: dataJson },
      ],
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("plot-structure");
    expect(result.stderr).toContain("'filter'");
    expect(existsSync(join(materializedRoot, "site", "dist"))).toBe(false);
    expectCachesUnchanged(beforeCaches, afterCaches);
  }, 180_000);

  test("WEAKENED accepts transform.filter — the untrusted vega walk is load-bearing", async () => {
    const { result, buildCalled } = await driveWeakened({
      slug: "vega-filter-red",
      pullNumber: PR_VEGA_FILTER,
      changes: [
        { path: "plots/adv-filter-red/spec.vl.json", content: filterSpec },
        { path: "plots/adv-filter-red/data.json", content: dataJson },
      ],
    });
    expect(result.stdout).toContain("revkit check: PR content passed");
    expect(buildCalled).toBe(true);
  }, 180_000);
});

// -------------------------------------------------------------------------
// Vector C — `node_modules/` under content; `package.json` under content
// -------------------------------------------------------------------------
describe.skipIf(!E2E)("adversarial e2e — package-manager smuggle under content root", () => {
  test("SHIPPING refuses a `node_modules/evil.js` planted under docs/", async () => {
    const { result, beforeCaches, afterCaches, materializedRoot } = await driveShipping({
      slug: "node-modules",
      pullNumber: PR_NODE_MODULES,
      changes: [
        {
          path: "docs/x/node_modules/evil.js",
          content: `require('child_process').execSync('touch ${CANARY_NODE_MODULES}');\n`,
        },
      ],
    });
    expect(result.exitCode).not.toBe(0);
    // node_modules segment forces classifyPath → "tooling" (defense-in-depth
    // belt in content-allowlist.ts); tooling-diff then refuses without --trust.
    expect(result.stderr).toContain("Tooling files that differ from merge-base");
    expect(result.stderr).toContain("docs/x/node_modules/evil.js");
    expect(existsSync(join(materializedRoot, "site", "dist"))).toBe(false);
    expect(existsSync(CANARY_NODE_MODULES)).toBe(false);
    expectCachesUnchanged(beforeCaches, afterCaches);
  }, 180_000);

  test("SHIPPING refuses a `package.json` planted under site/src/content/docs/x/", async () => {
    // `package.json` under a content prefix would otherwise pass
    // (`.json` is in CONTENT_ALLOWED_EXTENSIONS); the always-tooling
    // basenames belt refuses it.
    const { result, beforeCaches, afterCaches, materializedRoot } = await driveShipping({
      slug: "content-pkg",
      pullNumber: PR_CONTENT_PKG,
      changes: [
        {
          path: "site/src/content/docs/x/package.json",
          content: JSON.stringify({
            name: "smuggled",
            scripts: { preinstall: `touch ${CANARY_NODE_MODULES}` },
          }),
        },
      ],
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Tooling files that differ from merge-base");
    expect(result.stderr).toContain("site/src/content/docs/x/package.json");
    expect(existsSync(join(materializedRoot, "site", "dist"))).toBe(false);
    expect(existsSync(CANARY_NODE_MODULES)).toBe(false);
    expectCachesUnchanged(beforeCaches, afterCaches);
  }, 180_000);
});

// -------------------------------------------------------------------------
// Vector D — Tooling change without --trust
// -------------------------------------------------------------------------
describe.skipIf(!E2E)("adversarial e2e — tooling change without --trust", () => {
  test("SHIPPING refuses a package.json change and names the tooling diff", async () => {
    // Modify the ROOT package.json — a genuine tooling file. Add a
    // hostile `preinstall` script; the safe build never runs
    // `bun install`, but the tooling-diff refusal fires first.
    const originalPkg = JSON.parse(readFileSync(join(CHECKOUT_ROOT, "package.json"), "utf8"));
    const modifiedPkg = {
      ...originalPkg,
      scripts: { ...(originalPkg.scripts ?? {}), preinstall: `touch ${CANARY_TOOLING}` },
    };
    const { result, beforeCaches, afterCaches, materializedRoot } = await driveShipping({
      slug: "tooling",
      pullNumber: PR_TOOLING,
      changes: [{ path: "package.json", content: JSON.stringify(modifiedPkg, null, 2) + "\n" }],
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Tooling files that differ from merge-base");
    expect(result.stderr).toContain("package.json");
    expect(existsSync(join(materializedRoot, "site", "dist"))).toBe(false);
    expect(existsSync(CANARY_TOOLING)).toBe(false);
    expectCachesUnchanged(beforeCaches, afterCaches);
  }, 180_000);
});
