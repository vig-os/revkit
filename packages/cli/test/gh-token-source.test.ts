// Tests for the CLI's `gh` TokenSource (M3 part 1, ADR-0025).
//
// Uses the injectable `GhRunner` seam (`../src/gh-runner.ts`) so no
// test ever shells out. Exercises the argument construction, the
// happy path, and the failure modes the daemon needs to surface as
// a clean 'gh not authenticated' page.

import { describe, expect, test } from "bun:test";
import type { GhResult } from "../src/gh-runner.ts";
import {
  createGhTokenSource,
  GhTokenSourceError,
  isPlausibleGhToken,
} from "../src/gh-token-source.ts";

function fakeRunner(
  handler: (args: readonly string[]) => GhResult,
): (args: readonly string[]) => Promise<GhResult> {
  return async (args) => handler(args);
}

const TOKEN = "ghp_" + "a".repeat(40);

describe("createGhTokenSource — happy path", () => {
  test("runs `gh auth token` (argv, no shell) and returns the trimmed stdout", async () => {
    const seenArgs: string[][] = [];
    const source = createGhTokenSource({
      gh: fakeRunner((args) => {
        seenArgs.push([...args]);
        return { stdout: `${TOKEN}\n`, stderr: "", exitCode: 0 };
      }),
    });
    expect(await source.getToken()).toBe(TOKEN);
    expect(seenArgs).toEqual([["auth", "token"]]);
  });

  test("passes --hostname when provided", async () => {
    const seen: string[][] = [];
    const source = createGhTokenSource({
      hostname: "ghes.example.com",
      gh: fakeRunner((args) => {
        seen.push([...args]);
        return { stdout: TOKEN, stderr: "", exitCode: 0 };
      }),
    });
    await source.getToken();
    expect(seen[0]).toEqual(["auth", "token", "--hostname", "ghes.example.com"]);
  });

  test("re-runs the runner on every call (no caching between calls)", async () => {
    let calls = 0;
    const source = createGhTokenSource({
      gh: fakeRunner(() => {
        calls++;
        return { stdout: TOKEN, stderr: "", exitCode: 0 };
      }),
    });
    await source.getToken();
    await source.getToken();
    await source.getToken();
    expect(calls).toBe(3);
  });
});

describe("createGhTokenSource — failure modes", () => {
  test("surfaces 'not logged in' from stderr as a GhTokenSourceError", async () => {
    const source = createGhTokenSource({
      gh: fakeRunner(() => ({
        stdout: "",
        stderr: "You are not logged into any GitHub hosts. Run gh auth login to authenticate.\n",
        exitCode: 1,
      })),
    });
    await expect(source.getToken()).rejects.toThrow(GhTokenSourceError);
    await expect(source.getToken()).rejects.toThrow(/not logged into/);
  });

  test("empty stdout with exit 0 is refused (fake shim on PATH)", async () => {
    const source = createGhTokenSource({
      gh: fakeRunner(() => ({ stdout: "\n", stderr: "", exitCode: 0 })),
    });
    await expect(source.getToken()).rejects.toThrow(/empty output/);
  });

  test("implausible token (too short, whitespace inside) is refused", async () => {
    const source = createGhTokenSource({
      gh: fakeRunner(() => ({ stdout: "hi there\n", stderr: "", exitCode: 0 })),
    });
    await expect(source.getToken()).rejects.toThrow(/implausible value/);
  });

  test("a spawn failure (gh missing) is wrapped as GhTokenSourceError", async () => {
    const source = createGhTokenSource({
      gh: async () => {
        throw new Error("spawn gh ENOENT");
      },
    });
    await expect(source.getToken()).rejects.toThrow(GhTokenSourceError);
    await expect(source.getToken()).rejects.toThrow(/ENOENT/);
  });

  test("stderr with a token-shaped substring is redacted in the thrown message", async () => {
    const strayToken = "gho_" + "b".repeat(40);
    const source = createGhTokenSource({
      gh: fakeRunner(() => ({
        stdout: "",
        stderr: `error: token ${strayToken} could not be validated`,
        exitCode: 1,
      })),
    });
    try {
      await source.getToken();
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).not.toContain(strayToken);
      expect((err as Error).message).toContain("<redacted:ghtoken>");
    }
  });
});

describe("isPlausibleGhToken", () => {
  test("accepts a realistic PAT", () => {
    expect(isPlausibleGhToken("ghp_" + "a".repeat(40))).toBe(true);
    expect(isPlausibleGhToken("github_pat_" + "z".repeat(70))).toBe(true);
  });

  test("rejects too-short strings", () => {
    expect(isPlausibleGhToken("")).toBe(false);
    expect(isPlausibleGhToken("short")).toBe(false);
  });

  test("rejects whitespace and non-ASCII", () => {
    expect(isPlausibleGhToken("ghp_" + "a".repeat(30) + " hidden")).toBe(false);
    expect(isPlausibleGhToken("ghp_" + "a".repeat(30) + "é")).toBe(false);
  });

  test("rejects control characters", () => {
    expect(isPlausibleGhToken("ghp_" + "a".repeat(30) + "\n")).toBe(false);
  });

  test("rejects excessively long strings", () => {
    expect(isPlausibleGhToken("x".repeat(1024))).toBe(false);
  });
});
