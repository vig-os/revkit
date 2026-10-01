// Containment check for the per-run profile-dir removal.

import { describe, expect, test } from "bun:test";
import { isSafeToRemoveProfileDir, projectDirFor, projectDirSlug } from "../../src/dogfood/containment.ts";

describe("projectDirSlug", () => {
  test("maps /run/user/1004/revkit-dogfood-XYZ to the claude-slug shape", () => {
    expect(projectDirSlug("/run/user/1004/revkit-dogfood-XYZ")).toEqual(
      "-run-user-1004-revkit-dogfood-XYZ",
    );
  });
});

describe("projectDirFor", () => {
  test("assembles the projects/<slug> path", () => {
    expect(projectDirFor("/home/x/.claude", "/tmp/revkit-dogfood-abc")).toEqual(
      "/home/x/.claude/projects/-tmp-revkit-dogfood-abc",
    );
  });
});

describe("isSafeToRemoveProfileDir", () => {
  const projectsRoot = "/home/x/.claude/projects";
  const runBase = "revkit-dogfood-abc";
  const validCandidate = "/home/x/.claude/projects/-tmp-revkit-dogfood-abc";
  test("permits the current run's profile dir", () => {
    expect(isSafeToRemoveProfileDir(validCandidate, projectsRoot, runBase)).toBe(true);
  });
  test("rejects a path outside the projects root", () => {
    expect(isSafeToRemoveProfileDir("/home/x/other/-tmp-revkit-dogfood-abc", projectsRoot, runBase)).toBe(false);
  });
  test("rejects a path that doesn't carry the revkit-dogfood marker", () => {
    expect(isSafeToRemoveProfileDir("/home/x/.claude/projects/-tmp-something-else", projectsRoot, runBase)).toBe(false);
  });
  test("rejects a path whose basename doesn't match this run", () => {
    expect(
      isSafeToRemoveProfileDir(
        "/home/x/.claude/projects/-tmp-revkit-dogfood-OLD",
        projectsRoot,
        runBase,
      ),
    ).toBe(false);
  });
  test("rejects a projects-root prefix that isn't followed by /", () => {
    expect(isSafeToRemoveProfileDir("/home/x/.claude/projectsX/-tmp-revkit-dogfood-abc", projectsRoot, runBase)).toBe(
      false,
    );
  });
});
