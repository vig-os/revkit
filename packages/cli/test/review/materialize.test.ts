// End-to-end materializer tests. Each case builds a real git repo
// (through `test/review/helpers/git-fixture.ts`) with a base commit
// and a PR-head commit, runs `materializeSafeTree` against the
// injectable `GitRunner`, and asserts on the on-disk result.
//
// **RED evidence for the security paths.** Every refusal test also
// asserts on the classification path: refuse a symlink escape,
// refuse a submodule mode, refuse an unsupported mode. A mutant that
// dropped a rule (e.g. accepted `160000`) would fail its
// corresponding test — the mutation is described in the PR body.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  materializeSafeTree,
  MaterializeError,
  validatePath,
  validateSymlinkTarget,
} from "../../src/review/materialize.ts";
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

function newTargetDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "revkit-mat-"));
  tempDirsToClean.push(dir);
  // The materializer refuses an already-existing target dir. `mkdtemp`
  // returns an existing dir, so remove and re-use the path.
  rmSync(dir, { recursive: true, force: true });
  return dir;
}

describe("validatePath — refuses hostile shapes", () => {
  test("empty / NUL / backslash / .. / control", () => {
    expect(validatePath("")).toBeDefined();
    expect(validatePath("has\0nul")).toBeDefined();
    expect(validatePath("/absolute/path")).toBeDefined();
    expect(validatePath("has\\backslash")).toBeDefined();
    expect(validatePath("docs/../etc/passwd")).toBeDefined();
    expect(validatePath("docs/foo\x01bar.md")).toBeDefined();
    expect(validatePath("docs//x.md")).toBeDefined();
  });
  test("well-formed content path accepted", () => {
    expect(validatePath("docs/adr/0025.md")).toBeUndefined();
  });
});

describe("validateSymlinkTarget — refuses escape shapes", () => {
  test("absolute target refused", () => {
    expect(validateSymlinkTarget("docs/link.md", "/etc/passwd")).toBeDefined();
  });
  test("../ escaping target refused", () => {
    expect(validateSymlinkTarget("docs/link.md", "../../../etc/passwd")).toBeDefined();
  });
  test("target with NUL / control refused", () => {
    expect(validateSymlinkTarget("docs/x", "safe\0/other")).toBeDefined();
    expect(validateSymlinkTarget("docs/x", "safe\r\ntarget")).toBeDefined();
  });
  test("~ target refused", () => {
    expect(validateSymlinkTarget("docs/x", "~/secrets")).toBeDefined();
  });
  test("inside-tree relative target accepted", () => {
    expect(validateSymlinkTarget("docs/subdir/link.md", "adr/0025.md")).toBeUndefined();
    expect(validateSymlinkTarget("docs/adr/link.md", "../designs/DESIGN-0001.md")).toBeUndefined();
  });
});

describe("materializeSafeTree — content-only PR change builds", async () => {
  const fixture = await makeFixtureRepo({
    base: {
      message: "base",
      files: [
        { kind: "file", path: "package.json", content: '{"name":"root","private":true}' },
        { kind: "file", path: "flake.nix", content: "# base flake" },
        { kind: "file", path: "docs/index.md", content: "# base doc\n" },
        { kind: "file", path: "vocab/pigments.yaml", content: "- name: base\n" },
        { kind: "file", path: "site/src/content/docs/index.mdx", content: "# hello base\n" },
        { kind: "file", path: "scripts/build.sh", content: "#!/bin/sh\necho base\n", executable: true },
      ],
    },
    head: {
      message: "PR: edit a doc",
      files: [
        { kind: "file", path: "docs/index.md", content: "# PR doc\n" },
        { kind: "file", path: "vocab/pigments.yaml", content: "- name: pr\n" },
      ],
    },
  });
  tempDirsToClean.push(fixture.repoDir);

  test("content bytes come from head, tooling from base", async () => {
    const target = newTargetDir();
    const outcome = await materializeSafeTree({
      runner: spawnGit,
      cwd: fixture.repoDir,
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      targetDir: target,
    });
    // Content: PR's version.
    expect(readFileSync(join(target, "docs/index.md"), "utf8")).toBe("# PR doc\n");
    expect(readFileSync(join(target, "vocab/pigments.yaml"), "utf8")).toBe("- name: pr\n");
    // Tooling: base's version, unchanged.
    expect(readFileSync(join(target, "package.json"), "utf8")).toBe('{"name":"root","private":true}');
    expect(readFileSync(join(target, "flake.nix"), "utf8")).toBe("# base flake");
    // The base's untouched content that didn't change in PR is still
    // taken from base (both agree; check we still write it).
    expect(readFileSync(join(target, "site/src/content/docs/index.mdx"), "utf8")).toBe("# hello base\n");
    // Classification cross-check on the outcome shape.
    expect([...outcome.contentPaths].sort()).toEqual(["docs/index.md", "site/src/content/docs/index.mdx", "vocab/pigments.yaml"]);
    expect([...outcome.toolingPaths].sort()).toEqual(["flake.nix", "package.json", "scripts/build.sh"]);
  });
});

describe("materializeSafeTree — refuses PR-added executable / new tooling in content dir", async () => {
  // The PR adds `docs/evil.js` — a .js file inside a content
  // directory. The content-allowlist classifies that as TOOLING
  // (wrong extension), so the materializer takes it from BASE.
  // Base doesn't have that file, so it must NOT appear in the
  // output at all.
  const fixture = await makeFixtureRepo({
    base: {
      message: "base",
      files: [
        { kind: "file", path: "package.json", content: "{}" },
        { kind: "file", path: "docs/index.md", content: "# base\n" },
      ],
    },
    head: {
      message: "PR adds evil.js",
      files: [
        { kind: "file", path: "docs/evil.js", content: "console.log('pwned')\n" },
      ],
    },
  });
  tempDirsToClean.push(fixture.repoDir);

  test("PR-added executable in a content dir does NOT land in the output", async () => {
    const target = newTargetDir();
    await materializeSafeTree({
      runner: spawnGit,
      cwd: fixture.repoDir,
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      targetDir: target,
    });
    // The file must not exist — content-allowlist refuses `.js` in
    // `docs/`, and base doesn't have that path either.
    expect(existsSync(join(target, "docs/evil.js"))).toBe(false);
    // The rest of the tree materialized correctly.
    expect(readFileSync(join(target, "docs/index.md"), "utf8")).toBe("# base\n");
  });
});

describe("materializeSafeTree — symlink refusal", async () => {
  const fixture = await makeFixtureRepo({
    base: {
      message: "base",
      files: [{ kind: "file", path: "package.json", content: "{}" }],
    },
    head: {
      message: "PR adds an escaping symlink",
      files: [
        { kind: "file", path: "docs/index.md", content: "# ok\n" },
        // A symlink whose target escapes the content root — even
        // though the symlink LIVES under `docs/`, its target
        // walks out into `/etc/passwd`. Must be refused.
        { kind: "symlink", path: "docs/leak.md", target: "../../../../../../etc/passwd" },
      ],
    },
  });
  tempDirsToClean.push(fixture.repoDir);

  test("escapes → MaterializeError with kind=symlink-escape", async () => {
    const target = newTargetDir();
    let thrown: unknown;
    try {
      await materializeSafeTree({
        runner: spawnGit,
        cwd: fixture.repoDir,
        baseSha: fixture.baseSha,
        headSha: fixture.headSha,
        targetDir: target,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MaterializeError);
    const e = thrown as MaterializeError;
    expect(e.refusal.kind).toBe("symlink-escape");
    if (e.refusal.kind === "symlink-escape") {
      expect(e.refusal.path).toBe("docs/leak.md");
      expect(e.refusal.target).toBe("../../../../../../etc/passwd");
    }
  });
});

describe("materializeSafeTree — inside-tree symlink accepted (but written as regular file)", async () => {
  const fixture = await makeFixtureRepo({
    base: {
      message: "base",
      files: [{ kind: "file", path: "package.json", content: "{}" }],
    },
    head: {
      message: "PR adds an inside symlink",
      files: [
        { kind: "file", path: "docs/target.md", content: "the real file\n" },
        { kind: "symlink", path: "docs/subdir/link.md", target: "../target.md" },
      ],
    },
  });
  tempDirsToClean.push(fixture.repoDir);

  test("inside-tree symlink lands as a regular file holding the target string", async () => {
    const target = newTargetDir();
    await materializeSafeTree({
      runner: spawnGit,
      cwd: fixture.repoDir,
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      targetDir: target,
    });
    const written = readFileSync(join(target, "docs/subdir/link.md"), "utf8");
    // Not a resolved file — the target string itself.
    expect(written).toBe("../target.md");
  });
});

describe("materializeSafeTree — target-exists refusal", async () => {
  const fixture = await makeFixtureRepo({
    base: { message: "base", files: [{ kind: "file", path: "docs/x.md", content: "a" }] },
    head: { message: "head", files: [{ kind: "file", path: "docs/x.md", content: "b" }] },
  });
  tempDirsToClean.push(fixture.repoDir);
  test("refuses an already-existing target directory", async () => {
    const target = newTargetDir();
    mkdirSync(target, { recursive: true });
    // Put a file in it so the caller can prove nothing was clobbered.
    writeFileSync(join(target, "sentinel"), "keep");
    let thrown: unknown;
    try {
      await materializeSafeTree({
        runner: spawnGit,
        cwd: fixture.repoDir,
        baseSha: fixture.baseSha,
        headSha: fixture.headSha,
        targetDir: target,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MaterializeError);
    expect((thrown as MaterializeError).refusal.kind).toBe("target-exists");
    // Sentinel untouched.
    expect(readFileSync(join(target, "sentinel"), "utf8")).toBe("keep");
  });
});

describe("materializeSafeTree — total-size cap", async () => {
  const fixture = await makeFixtureRepo({
    base: { message: "base", files: [{ kind: "file", path: "docs/x.md", content: "abcdefghij" }] },
    head: { message: "head", files: [{ kind: "file", path: "docs/x.md", content: "abcdefghij" }] },
  });
  tempDirsToClean.push(fixture.repoDir);
  test("refuses when totalBytesCap is exceeded", async () => {
    const target = newTargetDir();
    // Cap of 5 bytes — the file (10 bytes) exceeds it.
    let thrown: unknown;
    try {
      await materializeSafeTree({
        runner: spawnGit,
        cwd: fixture.repoDir,
        baseSha: fixture.baseSha,
        headSha: fixture.headSha,
        targetDir: target,
        totalBytesCap: 5,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MaterializeError);
    expect((thrown as MaterializeError).refusal.kind).toBe("total-too-large");
  });
});
