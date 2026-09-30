// The safe git wrapper is enforced by the DEFAULT arg-list constants.
// Every rule from git-safe.ts' file header gets one assertion here so
// a mutation that drops (say) `core.hooksPath=/dev/null` fails
// immediately. Nothing spawns git — these are pure-argv tests.

import { describe, expect, test } from "bun:test";
import {
  buildSafeGitArgs,
  runSafeGitOrThrow,
  SAFE_GIT_CONFIG_OVERRIDES,
  SAFE_GIT_TOPLEVEL_FLAGS,
  SafeGitError,
} from "../../src/review/git-safe.ts";
import type { GitRunner } from "../../src/git-runner.ts";

describe("safe-git argv construction — DEFAULT constants", () => {
  test("the top-level flags array is frozen and contains --no-optional-locks", () => {
    expect(Object.isFrozen(SAFE_GIT_TOPLEVEL_FLAGS)).toBe(true);
    expect(SAFE_GIT_TOPLEVEL_FLAGS).toContain("--no-optional-locks");
  });

  test("SAFE_GIT_CONFIG_OVERRIDES is frozen so a mutation cannot silently disable a rule", () => {
    expect(Object.isFrozen(SAFE_GIT_CONFIG_OVERRIDES)).toBe(true);
  });

  test("each hardening rule from the file header is present", () => {
    // Read the constants as `key=value` pairs (each rule is `-c`
    // followed by a `key=value`).
    const pairs: string[] = [];
    for (let i = 0; i < SAFE_GIT_CONFIG_OVERRIDES.length; i++) {
      if (SAFE_GIT_CONFIG_OVERRIDES[i] === "-c" && i + 1 < SAFE_GIT_CONFIG_OVERRIDES.length) {
        const pair = SAFE_GIT_CONFIG_OVERRIDES[i + 1];
        if (pair !== undefined) pairs.push(pair);
      }
    }
    const expected = [
      "core.hooksPath=/dev/null",
      "protocol.file.allow=never",
      "protocol.ext.allow=never",
      "core.attributesFile=/dev/null",
      "core.excludesFile=/dev/null",
      "fetch.recurseSubmodules=no",
      "submodule.recurse=false",
      "gpg.program=/bin/false",
    ];
    for (const rule of expected) {
      expect(pairs).toContain(rule);
    }
  });

  test("buildSafeGitArgs interleaves toplevel flags, overrides and the subcommand", () => {
    const argv = buildSafeGitArgs(["fetch", "origin", "refs/pull/1/head"]);
    expect(argv[0]).toBe("--no-optional-locks");
    // Subcommand is at the tail — no reordering.
    expect(argv.slice(-3)).toEqual(["fetch", "origin", "refs/pull/1/head"]);
    // Every override rule is present in the assembled command.
    for (let i = 0; i < SAFE_GIT_CONFIG_OVERRIDES.length; i++) {
      expect(argv[i + 1]).toBe(SAFE_GIT_CONFIG_OVERRIDES[i]);
    }
  });
});

describe("runSafeGitOrThrow", () => {
  test("wraps a non-zero exit in a SafeGitError with exitCode and stderr", async () => {
    const runner: GitRunner = async () => ({ stdout: "", stderr: "fatal: nope\n", exitCode: 128 });
    await expect(runSafeGitOrThrow(runner, "/tmp", ["fetch"], "context")).rejects.toThrow(SafeGitError);
    try {
      await runSafeGitOrThrow(runner, "/tmp", ["fetch"], "context");
    } catch (err) {
      const e = err as SafeGitError;
      expect(e.name).toBe("SafeGitError");
      expect(e.exitCode).toBe(128);
      expect(e.stderr).toBe("fatal: nope\n");
      expect(e.message).toContain("context");
    }
  });

  test("passes the safe argv to the runner and returns stdout on success", async () => {
    let seen: readonly string[] | undefined;
    const runner: GitRunner = async (args) => {
      seen = args;
      return { stdout: "ok\n", stderr: "", exitCode: 0 };
    };
    const out = await runSafeGitOrThrow(runner, "/tmp", ["status", "-s"], "status");
    expect(out).toBe("ok\n");
    // The runner MUST have been called with the hardening args
    // prefixed.
    expect(seen).toBeDefined();
    expect(seen![0]).toBe("--no-optional-locks");
    expect(seen!.slice(-2)).toEqual(["status", "-s"]);
  });
});
