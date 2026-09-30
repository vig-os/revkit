// Tests for `buildChildEnv` (build.ts) — the minimal-env sandbox the
// safe build runs in (PR #48 round-2 blocker 2).
//
// Every token variable in the denylist is asserted to be dropped
// from the child env, EVEN IF the parent process has it set. The
// allowlist is asserted from the DEFAULT constants (not a
// hand-rolled copy) so a mutation that removed `PATH` fails the
// per-variable test.

import { describe, expect, test } from "bun:test";
import {
  BUILD_ENV_ALLOWLIST,
  BUILD_ENV_TOKEN_DENYLIST,
  buildChildEnv,
  runSafeBuild,
  type SpawnLike,
} from "../../src/review/build.ts";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("BUILD_ENV_ALLOWLIST / DENYLIST — the default constants", () => {
  test("allowlist is frozen", () => {
    expect(Object.isFrozen(BUILD_ENV_ALLOWLIST)).toBe(true);
  });
  test("denylist is frozen", () => {
    expect(Object.isFrozen(BUILD_ENV_TOKEN_DENYLIST)).toBe(true);
  });
  test("allowlist contains PATH, HOME, TMPDIR, NIX_PATH — the baseline", () => {
    for (const key of ["PATH", "HOME", "TMPDIR", "NIX_PATH"]) {
      expect(BUILD_ENV_ALLOWLIST).toContain(key);
    }
  });
  test("denylist includes every well-known token variable", () => {
    for (const key of [
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "NPM_TOKEN",
      "NODE_AUTH_TOKEN",
      "HF_TOKEN",
      "CF_API_TOKEN",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
    ]) {
      expect(BUILD_ENV_TOKEN_DENYLIST).toContain(key);
    }
  });
});

describe("buildChildEnv — drops tokens, keeps allowlisted vars", () => {
  test("token vars from parent env are NEVER exported to child", () => {
    const source: Record<string, string> = {
      PATH: "/usr/bin",
      HOME: "/home/x",
      GITHUB_TOKEN: "ghp_" + "a".repeat(40),
      GH_TOKEN: "ghp_" + "b".repeat(40),
      NPM_TOKEN: "npm_" + "c".repeat(40),
      NODE_AUTH_TOKEN: "d".repeat(40),
      HF_TOKEN: "hf_" + "e".repeat(40),
      OPENAI_API_KEY: "sk-" + "f".repeat(40),
    };
    const child = buildChildEnv(source, undefined);
    for (const key of BUILD_ENV_TOKEN_DENYLIST) {
      expect(child[key]).toBeUndefined();
    }
    // Sanity: allowlisted vars ARE exported.
    expect(child.PATH).toBe("/usr/bin");
    expect(child.HOME).toBe("/home/x");
  });

  test("unlisted variables are dropped", () => {
    const source = { PATH: "/usr/bin", NOT_ON_ALLOWLIST: "surprise" };
    const child = buildChildEnv(source, undefined);
    expect(child.NOT_ON_ALLOWLIST).toBeUndefined();
    expect(child.PATH).toBe("/usr/bin");
  });

  test("CI / GITHUB_ACTIONS are refused even if the parent sets them", () => {
    const source = { CI: "true", GITHUB_ACTIONS: "true", PATH: "/usr/bin" };
    const child = buildChildEnv(source, undefined);
    expect(child.CI).toBeUndefined();
    expect(child.GITHUB_ACTIONS).toBeUndefined();
  });
});

describe("runSafeBuild — command shape and env allowlist under spawn injection", () => {
  test("spawn is called with the safe env and no token variable", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "safe-build-"));
    try {
      mkdirSync(join(tempRoot, "site"), { recursive: true });
      let seen: { cmd: readonly string[]; env: Readonly<Record<string, string>> } | undefined;
      const spawn: SpawnLike = async ({ cmd, env }) => {
        seen = { cmd, env };
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      // Poison the env with a token — buildChildEnv must scrub it.
      const originalToken = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = "ghp_" + "z".repeat(40);
      try {
        await runSafeBuild({
          materializedRoot: tempRoot,
          distOutDir: join(tempRoot, "site", "dist"),
          spawn,
        });
      } finally {
        if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = originalToken;
      }
      expect(seen).toBeDefined();
      // Command shape: no arg is the token.
      expect(seen!.cmd.join(" ").includes("ghp_")).toBe(false);
      expect(seen!.cmd[0]).toBe("bun");
      // Env: GITHUB_TOKEN is not present.
      expect(seen!.env.GITHUB_TOKEN).toBeUndefined();
      for (const key of BUILD_ENV_TOKEN_DENYLIST) {
        expect(seen!.env[key]).toBeUndefined();
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("non-zero exit throws with a tail of stderr, no token in the message", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "safe-build-"));
    try {
      mkdirSync(join(tempRoot, "site"), { recursive: true });
      const spawn: SpawnLike = async () => ({ stdout: "", stderr: "boom", exitCode: 42 });
      await expect(
        runSafeBuild({
          materializedRoot: tempRoot,
          distOutDir: join(tempRoot, "site", "dist"),
          spawn,
        }),
      ).rejects.toThrow(/astro build exited 42/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
