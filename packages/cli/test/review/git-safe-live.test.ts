// Live-git tests: prove the safe wrapper actually blocks the attacks
// its config overrides claim to block. Runs real `git` inside a
// scratch repo and asserts on the observed behaviour.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSafeGit } from "../../src/review/git-safe.ts";
import { spawnGit } from "../../src/git-runner.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* fine */
    }
  }
});

async function initRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "revkit-gitsafe-"));
  dirs.push(dir);
  const args = ["init", "-q", "--initial-branch=main"];
  await Bun.spawn(["git", ...args], { cwd: dir }).exited;
  await Bun.spawn(["git", "-C", dir, "config", "user.name", "t"]).exited;
  await Bun.spawn(["git", "-C", dir, "config", "user.email", "t@t"]).exited;
  return dir;
}

describe("safe git wrapper blocks hooks and refuses file:// protocol", () => {
  test("core.hooksPath=/dev/null: a repo-local hook is ignored on commit", async () => {
    const dir = await initRepo();
    // Write a per-repo hook that would touch a canary if it ran.
    const hooksDir = join(dir, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const canary = join(dir, "canary");
    const preCommit = join(hooksDir, "pre-commit");
    writeFileSync(preCommit, `#!/bin/sh\ntouch "${canary}"\n`);
    chmodSync(preCommit, 0o755);

    // Stage + commit through the safe wrapper.
    writeFileSync(join(dir, "readme"), "hello");
    await runSafeGit(spawnGit, dir, ["add", "readme"]);
    const result = await runSafeGit(spawnGit, dir, ["commit", "-m", "test"]);
    expect(result.exitCode).toBe(0);
    // The hook must NOT have run — canary is absent.
    const { existsSync } = await import("node:fs");
    expect(existsSync(canary)).toBe(false);
  });

  test("protocol.file.allow=never: a file:// fetch is refused", async () => {
    const dir = await initRepo();
    // No matter what we point at, `file://` is refused before the
    // transport is asked. Attempt a fetch of a non-existent local
    // path.
    const result = await runSafeGit(spawnGit, dir, [
      "fetch",
      "--no-tags",
      "file:///tmp/does-not-exist-revkit-test.git",
    ]);
    expect(result.exitCode).not.toBe(0);
    // Git's message includes "file protocol" or "transport" when it
    // refuses the protocol. Different versions phrase it slightly
    // differently; we just check that the fetch DID NOT succeed.
    // (The canary is exit != 0 above.)
    expect(result.stderr.toLowerCase()).toMatch(/protocol|transport|does not allow/);
  });
});
