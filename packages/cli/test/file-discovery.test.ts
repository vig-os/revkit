// File-discovery tests. Focus of this suite: bypass #5 (symlinks
// under content/UI trees), which had slipped past `entry.isFile()`
// because a symlink to a file reports `isFile === true`.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandPathArgs, walkForCheckables } from "../src/file-discovery.ts";

function makeTempRepo(): string {
  return mkdtempSync(join(tmpdir(), "revkit-discovery-"));
}

describe("walkForCheckables — symlinks under content/UI trees", () => {
  test("returns real files and reports symlinks separately", () => {
    const repo = makeTempRepo();
    // Real content file.
    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(join(repo, "docs", "real.md"), "# real\n");
    // Symlink inside `docs/` pointing outside the repo — Astro would
    // follow this; discovery must NOT walk it as a file.
    const target = mkdtempSync(join(tmpdir(), "revkit-target-"));
    writeFileSync(join(target, "secret.md"), "SECRET\n");
    symlinkSync(join(target, "secret.md"), join(repo, "docs", "smuggled.md"));
    // Real code file NOT under a content dir (should not be reported).
    mkdirSync(join(repo, "scripts"), { recursive: true });
    writeFileSync(join(repo, "scripts", "helper.sh"), "#!/bin/sh\n");
    // package.json marker for repo-root walkers (not needed here but
    // realistic).
    writeFileSync(join(repo, "package.json"), '{"name":"x"}\n');

    const result = walkForCheckables(repo);
    expect(result.files.some((f) => f.endsWith("real.md"))).toBe(true);
    expect(result.files.some((f) => f.endsWith("smuggled.md"))).toBe(false);
    expect(result.symlinks.some((s) => s.posixPath === "docs/smuggled.md")).toBe(true);
  });

  test("symlinks OUTSIDE content/UI trees are ignored (not reported)", () => {
    const repo = makeTempRepo();
    mkdirSync(join(repo, "scripts"), { recursive: true });
    writeFileSync(join(repo, "scripts", "target.sh"), "\n");
    symlinkSync(join(repo, "scripts", "target.sh"), join(repo, "scripts", "link.sh"));
    const result = walkForCheckables(repo);
    // `scripts/` is not a content/UI tree; the symlink is silent.
    expect(result.symlinks).toEqual([]);
  });

  test("expandPathArgs also reports symlinks under content dirs", () => {
    const repo = makeTempRepo();
    mkdirSync(join(repo, "site", "src", "content", "docs"), { recursive: true });
    writeFileSync(join(repo, "site", "src", "content", "docs", "a.md"), "# a\n");
    const target = mkdtempSync(join(tmpdir(), "revkit-target-"));
    writeFileSync(join(target, "evil.md"), "SECRET\n");
    symlinkSync(join(target, "evil.md"), join(repo, "site", "src", "content", "docs", "linked.md"));
    // Call with `cwd = repo` so the posix-relative check hits
    // `site/src/content/`.
    const result = expandPathArgs(["site/src/content/docs"], repo);
    expect(result.files.some((f) => f.endsWith("a.md"))).toBe(true);
    expect(result.symlinks.some((s) => s.posixPath.includes("linked.md"))).toBe(true);
  });
});
