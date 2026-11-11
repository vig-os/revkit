// PR #38 round-3 nit — prune expired / used launch codes, cap the
// outstanding set at MAX_OUTSTANDING_LAUNCH_CODES.

import { describe, expect, test } from "bun:test";
import { AuthState, MAX_OUTSTANDING_LAUNCH_CODES } from "../../src/serve/auth.ts";

describe("AuthState launch-code pruning", () => {
  test("startup code stays present after other codes are minted and consumed", () => {
    let now = 0;
    const state = new AuthState({
      agentToken: "t".repeat(43),
      launchCode: "startup",
      launchCodeTtlMs: 100,
      clock: () => now,
    });
    // Mint + consume 3 fresh codes.
    for (let i = 0; i < 3; i++) {
      const minted = state.mintLaunchCode();
      const exchange = state.exchangeLaunchCode(minted.value);
      expect(exchange.ok).toBe(true);
    }
    // The startup code should still be redeemable (once).
    const startup = state.exchangeLaunchCode("startup");
    expect(startup.ok).toBe(true);
    // Its `launchCodeUsed()` diagnostic reports true after it lands.
    expect(state.launchCodeUsed()).toBe(true);
  });

  test("MUTATION: expired minted codes are pruned on the next mint", () => {
    let now = 0;
    const state = new AuthState({
      agentToken: "t".repeat(43),
      launchCode: "startup",
      launchCodeTtlMs: 100,
      clock: () => now,
    });
    // Mint 5 codes; then advance past TTL; then mint one more.
    for (let i = 0; i < 5; i++) state.mintLaunchCode();
    expect(state.outstandingLaunchCodeCount()).toBe(6); // 5 fresh + startup
    now += 200;
    state.mintLaunchCode();
    // Only startup + the new mint remain.
    expect(state.outstandingLaunchCodeCount()).toBe(2);
  });

  test("used minted codes are pruned on the next exchange", () => {
    let now = 0;
    const state = new AuthState({
      agentToken: "t".repeat(43),
      launchCode: "startup",
      launchCodeTtlMs: 60_000,
      clock: () => now,
    });
    const first = state.mintLaunchCode().value;
    const second = state.mintLaunchCode().value;
    expect(state.exchangeLaunchCode(first).ok).toBe(true);
    // Prune on this exchange drops `first`, so only startup +
    // `second` remain.
    state.exchangeLaunchCode(second);
    expect(state.outstandingLaunchCodeCount()).toBe(1); // startup only after `second` marked used
  });

  test("MUTATION: outstanding count is capped at MAX_OUTSTANDING_LAUNCH_CODES", () => {
    let now = 0;
    const state = new AuthState({
      agentToken: "t".repeat(43),
      launchCode: "startup",
      launchCodeTtlMs: 60_000_000,
      clock: () => now,
    });
    // Mint 100 codes rapidly — count must never exceed the cap.
    for (let i = 0; i < 100; i++) state.mintLaunchCode();
    expect(state.outstandingLaunchCodeCount()).toBeLessThanOrEqual(MAX_OUTSTANDING_LAUNCH_CODES);
    // Sanity: at least the startup code + one other survived (the
    // most recent mints are preserved; the oldest evicted).
    expect(state.outstandingLaunchCodeCount()).toBeGreaterThan(1);
  });

  test("MAX_OUTSTANDING_LAUNCH_CODES is 32 (kills a mutation that flips the cap)", () => {
    expect(MAX_OUTSTANDING_LAUNCH_CODES).toBe(32);
  });
});
