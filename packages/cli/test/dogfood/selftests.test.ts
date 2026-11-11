// Self-test contract tests. Each self-test is asserted BOTH GREEN
// (shipping guard) AND RED (mutant guard via DI). Together these are
// the RED evidence the SKILL doc calls for.

import { describe, expect, test } from "bun:test";
import { silentLogger } from "../../src/dogfood/logger.ts";
import { runBadFlagsSelftest, okAlwaysVerifier, runDecoyTeardownSelftest, weakArgvOnlyLeakGuard } from "../../src/dogfood/selftests.ts";
import { strictLeakGuard } from "../../src/dogfood/teardown.ts";

const commonOpts = {
  claudeBin: "/nix/store/xxx-claude/bin/claude",
  envBin: "/usr/bin/env",
  path: "/nix/store/y/bin:/usr/bin",
  home: "/home/x",
  claudeConfigDir: "/home/x/.claude",
};

describe("bad-flags self-test", () => {
  test("GREEN: shipping verifier catches the injected forbidden flag", () => {
    const outcome = runBadFlagsSelftest(silentLogger(), commonOpts);
    expect(outcome).toEqual("OK");
  });

  test("RED evidence: substituting the muted verifier makes the self-test FAIL", () => {
    // Verifier that always returns ok=true is the mutant. If the
    // shipping self-test's ASSERTION were vacuous, this would still
    // pass. It doesn't — the RED path returns FAIL, proving the
    // self-test has real teeth.
    const outcome = runBadFlagsSelftest(silentLogger(), {
      ...commonOpts,
      verifier: okAlwaysVerifier,
    });
    expect(outcome).toEqual("FAIL");
  });
});

describe("decoy-teardown self-test", () => {
  test(
    "GREEN: shipping leak-guard ignores an unrelated decoy",
    async () => {
      const outcome = await runDecoyTeardownSelftest(silentLogger(), { leakGuard: strictLeakGuard });
      // On a Nix host without /usr/bin/sleep the test SKIPs — that's a
      // documented environment limitation, not a failure.
      expect(outcome === "OK" || outcome === "SKIP").toBe(true);
    },
    30_000,
  );

  test(
    "RED evidence: substituting the weak argv-only guard makes the self-test FAIL",
    async () => {
      const outcome = await runDecoyTeardownSelftest(silentLogger(), { leakGuard: weakArgvOnlyLeakGuard });
      // Skip environments count as pass (the SKILL doc lists them).
      // When the test actually runs, the weak guard MUST flag the decoy.
      expect(outcome === "FAIL" || outcome === "SKIP").toBe(true);
    },
    30_000,
  );
});
