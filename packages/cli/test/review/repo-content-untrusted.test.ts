// Regression: `revkit check` in untrusted mode must accept the
// repo's OWN dev content (PR #48 round-4 blocker 1c). If it flags
// anything the site itself already ships, every PR against this
// repo would exit 1 — the exact bug that surfaced in round 3.
//
// The test scans the workspace's real content trees and asserts
// zero findings under untrusted mode. That freezes the allowlist
// to what revkit itself uses; a future edit that dropped support
// for a documented import specifier, a mark option, or a plot
// shape would fail here.

import { describe, expect, test } from "bun:test";
import { resolve as resolvePath } from "node:path";
import { runCheck, toCheckFiles } from "../../src/check.ts";
import { walkForCheckables } from "../../src/file-discovery.ts";

/** Absolute path to the workspace root — the parent of packages/. */
const REPO_ROOT = resolvePath(import.meta.dirname!, "..", "..", "..", "..");

describe("repo dev content passes untrusted-mode check", () => {
  test("no findings across docs/ + site/src/content/ + plots/ + vocab/", async () => {
    const discovery = walkForCheckables(REPO_ROOT);
    const files = toCheckFiles(discovery.files, REPO_ROOT);
    const output = await runCheck(REPO_ROOT, files, discovery.symlinks, {
      online: false,
      repoSlug: "vig-os/revkit",
      gh: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      trust: "untrusted",
    });
    // Filter out any diagnostic pointing at a stale materialised
    // worktree from a local test run — not part of the workspace.
    const lines = output.lines.filter(
      (l) => !l.includes(".revkit/review/") && !l.includes("site/.revkit-review/"),
    );
    if (lines.length > 0) {
      throw new Error(
        `Untrusted-mode check flagged the repo's own content — the allowlist has drifted from what revkit ships. ` +
          `Fix the rules (or extend the allowlist derivation) so a benign PR against this repo passes.\n${lines.join("\n")}`,
      );
    }
    expect(lines).toEqual([]);
    // Sanity: we actually scanned something.
    expect(files.length).toBeGreaterThan(0);
  });
});
