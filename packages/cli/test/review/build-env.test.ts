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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("BUILD_ENV_ALLOWLIST / DENYLIST — the default constants", () => {
  test("allowlist is frozen", () => {
    expect(Object.isFrozen(BUILD_ENV_ALLOWLIST)).toBe(true);
  });
  test("denylist is frozen", () => {
    expect(Object.isFrozen(BUILD_ENV_TOKEN_DENYLIST)).toBe(true);
  });
  test("allowlist contains PATH and NIX_PATH — the baseline (HOME/TMPDIR are overridden per build, not inherited)", () => {
    for (const key of ["PATH", "NIX_PATH"]) {
      expect(BUILD_ENV_ALLOWLIST).toContain(key);
    }
    // HOME is intentionally NOT on the allowlist — it's overridden
    // in `buildChildEnv` to a per-build scratch dir.
    expect(BUILD_ENV_ALLOWLIST).not.toContain("HOME");
    expect(BUILD_ENV_ALLOWLIST).not.toContain("TMPDIR");
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
      HOME: "/home/parent",
      GITHUB_TOKEN: "ghp_" + "a".repeat(40),
      GH_TOKEN: "ghp_" + "b".repeat(40),
      NPM_TOKEN: "npm_" + "c".repeat(40),
      NODE_AUTH_TOKEN: "d".repeat(40),
      HF_TOKEN: "hf_" + "e".repeat(40),
      OPENAI_API_KEY: "sk-" + "f".repeat(40),
    };
    const child = buildChildEnv(source, "/tmp/scratch-home");
    for (const key of BUILD_ENV_TOKEN_DENYLIST) {
      expect(child[key]).toBeUndefined();
    }
    // Sanity: allowlisted vars ARE exported.
    expect(child.PATH).toBe("/usr/bin");
    // HOME is overridden per build — parent's HOME is NOT inherited.
    expect(child.HOME).toBe("/tmp/scratch-home");
    expect(child.HOME).not.toBe("/home/parent");
    expect(child.TMPDIR).toBe("/tmp/scratch-home");
  });

  test("unlisted variables are dropped", () => {
    const source = { PATH: "/usr/bin", NOT_ON_ALLOWLIST: "surprise" };
    const child = buildChildEnv(source, "/tmp/x");
    expect(child.NOT_ON_ALLOWLIST).toBeUndefined();
    expect(child.PATH).toBe("/usr/bin");
  });

  test("CI / GITHUB_ACTIONS are refused even if the parent sets them", () => {
    const source = { CI: "true", GITHUB_ACTIONS: "true", PATH: "/usr/bin" };
    const child = buildChildEnv(source, "/tmp/x");
    expect(child.CI).toBeUndefined();
    expect(child.GITHUB_ACTIONS).toBeUndefined();
  });
});

describe("runSafeBuild — trusted binary + minimal env under spawn injection", () => {
  /** Set up a fake trusted checkout so `runSafeBuild` finds
   * `<trustedCheckoutRoot>/site/node_modules/.bin/astro` (a
   * script we don't actually run — spawn is stubbed).
   *
   * Layout:
   *   trusted/
   *     site/
   *       node_modules/
   *         .bin/astro         (stub executable)
   *   sandbox/
   *     site/                  (empty; runSafeBuild symlinks
   *                             node_modules into this)
   */
  function scaffold(): { trusted: string; sandbox: string; cleanup: () => void } {
    const trusted = mkdtempSync(join(tmpdir(), "safe-build-trusted-"));
    mkdirSync(join(trusted, "site", "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(trusted, "site", "node_modules", ".bin", "astro"), "#!/bin/sh\nexit 0\n");
    const sandbox = mkdtempSync(join(tmpdir(), "safe-build-sandbox-"));
    mkdirSync(join(sandbox, "site"), { recursive: true });
    return {
      trusted,
      sandbox,
      cleanup: () => {
        try { rmSync(trusted, { recursive: true, force: true }); } catch {}
        try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
      },
    };
  }

  test("cmd[0] is the ABSOLUTE trusted astro path (no `bun x`, no `PATH` lookup)", async () => {
    const { trusted, sandbox, cleanup } = scaffold();
    try {
      let seen: { cmd: readonly string[]; env: Readonly<Record<string, string>>; cwd: string } | undefined;
      const spawn: SpawnLike = async ({ cmd, env, cwd }) => {
        seen = { cmd, env, cwd };
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      await runSafeBuild({
        materializedRoot: sandbox,
        distOutDir: join(sandbox, "site", "dist"),
        trustedCheckoutRoot: trusted,
        spawn,
      });
      expect(seen).toBeDefined();
      expect(seen!.cmd[0]).toBe(join(trusted, "site", "node_modules", ".bin", "astro"));
      expect(seen!.cmd[1]).toBe("build");
      // Argv is literal strings; no shell interpolation carrier.
      expect(seen!.cmd.every((a) => !a.includes("$"))).toBe(true);
      // `bun x` / `npx` / `bun install` are NEVER used — the
      // reviewer's own astro is invoked directly, and no
      // registry-fetch machinery is spawned.
      expect(seen!.cmd.some((a) => a === "x")).toBe(false);
      expect(seen!.cmd.some((a) => a === "npx")).toBe(false);
      expect(seen!.cmd.some((a) => a === "install")).toBe(false);
      expect(seen!.cmd.every((a) => !a.startsWith("--registry"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("spawn is called EXACTLY ONCE (no bun install, no fallback tools)", async () => {
    const { trusted, sandbox, cleanup } = scaffold();
    try {
      let calls = 0;
      const spawn: SpawnLike = async () => {
        calls++;
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      await runSafeBuild({
        materializedRoot: sandbox,
        distOutDir: join(sandbox, "site", "dist"),
        trustedCheckoutRoot: trusted,
        spawn,
      });
      expect(calls).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("spawn is called with the safe env and no token variable", async () => {
    const { trusted, sandbox, cleanup } = scaffold();
    try {
      let seen: { env: Readonly<Record<string, string>> } | undefined;
      const spawn: SpawnLike = async ({ env }) => {
        seen = { env };
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      const originalToken = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = "ghp_" + "z".repeat(40);
      try {
        await runSafeBuild({
          materializedRoot: sandbox,
          distOutDir: join(sandbox, "site", "dist"),
          trustedCheckoutRoot: trusted,
          spawn,
        });
      } finally {
        if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = originalToken;
      }
      expect(seen).toBeDefined();
      expect(seen!.env.GITHUB_TOKEN).toBeUndefined();
      for (const key of BUILD_ENV_TOKEN_DENYLIST) {
        expect(seen!.env[key]).toBeUndefined();
      }
      // HOME is overridden — not the parent's HOME.
      expect(seen!.env.HOME).toBeDefined();
      expect(seen!.env.HOME).not.toBe(process.env.HOME);
      expect(seen!.env.HOME).toBe(seen!.env.TMPDIR);
    } finally {
      cleanup();
    }
  });

  test("missing trusted astro binary refuses with an actionable error", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "safe-build-nobin-"));
    mkdirSync(join(sandbox, "site"), { recursive: true });
    const trusted = mkdtempSync(join(tmpdir(), "trusted-nobin-"));
    // Intentionally no astro binary.
    try {
      await expect(
        runSafeBuild({
          materializedRoot: sandbox,
          distOutDir: join(sandbox, "site", "dist"),
          trustedCheckoutRoot: trusted,
          spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        }),
      ).rejects.toThrow(/trusted astro binary not found/);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
      rmSync(trusted, { recursive: true, force: true });
    }
  });

  test("non-zero exit throws with a tail of stderr, no token in the message", async () => {
    const { trusted, sandbox, cleanup } = scaffold();
    try {
      const spawn: SpawnLike = async () => ({ stdout: "", stderr: "boom", exitCode: 42 });
      await expect(
        runSafeBuild({
          materializedRoot: sandbox,
          distOutDir: join(sandbox, "site", "dist"),
          trustedCheckoutRoot: trusted,
          spawn,
        }),
      ).rejects.toThrow(/astro build exited 42/);
    } finally {
      cleanup();
    }
  });
});
