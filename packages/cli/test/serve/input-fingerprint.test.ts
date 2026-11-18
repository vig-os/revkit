// `computeInputFingerprint` — the cheap deterministic hash the
// MCP side compares against to decide whether a recorded start
// failure is stale (#251 round 3 BLOCKER 2, round 4 BLOCKER 1).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeInputFingerprint } from "../../src/serve/input-fingerprint.ts";

describe("computeInputFingerprint", () => {
  let repoRoot: string;
  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "revkit-fp-"));
  });
  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("an empty workspace hashes to a stable value", () => {
    const a = computeInputFingerprint(repoRoot);
    const b = computeInputFingerprint(repoRoot);
    expect(a).toBeDefined();
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  test("adding a docs/ file changes the fingerprint", () => {
    const before = computeInputFingerprint(repoRoot);
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
    writeFileSync(join(repoRoot, "docs", "a.md"), "# hi\n");
    const after = computeInputFingerprint(repoRoot);
    expect(after).not.toBe(before);
  });

  test("editing a docs/ file content changes the fingerprint (via mtime+size)", () => {
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
    writeFileSync(join(repoRoot, "docs", "a.md"), "# hi\n");
    const before = computeInputFingerprint(repoRoot);
    // Tweak mtime by one second and append a byte so both size
    // AND mtime change.
    writeFileSync(join(repoRoot, "docs", "a.md"), "# hi 2\n");
    const now = new Date();
    utimesSync(join(repoRoot, "docs", "a.md"), now, new Date(now.getTime() + 1000));
    const after = computeInputFingerprint(repoRoot);
    expect(after).not.toBe(before);
  });

  test("renaming a file changes the fingerprint", () => {
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
    writeFileSync(join(repoRoot, "docs", "a.md"), "x");
    const before = computeInputFingerprint(repoRoot);
    writeFileSync(join(repoRoot, "docs", "b.md"), "x");
    rmSync(join(repoRoot, "docs", "a.md"));
    const after = computeInputFingerprint(repoRoot);
    expect(after).not.toBe(before);
  });

  test("changes under vocab/ and plots/ also change the fingerprint", () => {
    const base = computeInputFingerprint(repoRoot);
    mkdirSync(join(repoRoot, "vocab"), { recursive: true });
    writeFileSync(join(repoRoot, "vocab", "terms.yaml"), "schemaVersion: 1\n");
    const withVocab = computeInputFingerprint(repoRoot);
    expect(withVocab).not.toBe(base);
    mkdirSync(join(repoRoot, "plots", "p"), { recursive: true });
    writeFileSync(join(repoRoot, "plots", "p", "spec.vl.json"), "{}");
    const withPlots = computeInputFingerprint(repoRoot);
    expect(withPlots).not.toBe(withVocab);
  });

  test("a change to the consumer's package.json flips the fingerprint", () => {
    writeFileSync(join(repoRoot, "package.json"), "{}");
    const before = computeInputFingerprint(repoRoot);
    writeFileSync(join(repoRoot, "package.json"), '{"name":"x"}');
    const after = computeInputFingerprint(repoRoot);
    expect(after).not.toBe(before);
  });

  test("a missing repoRoot returns undefined", () => {
    const bogus = join(repoRoot, "no-such-dir");
    expect(computeInputFingerprint(bogus)).toBeUndefined();
  });

  test(
    "#251 round 4 BLOCKER 1: a broken file OUTSIDE docs/ (components/Widget.tsx) flips the fingerprint when fixed or deleted",
    () => {
      // Pre-fix (round 3 shape): only docs/, vocab/, plots/,
      // package.json were hashed. `revkit check` walks the whole
      // consumer tree, so a broken `components/Widget.tsx` fails
      // the build — but the recorded fingerprint did NOT include
      // that path, so fixing or deleting the file left the hash
      // unchanged and MCP kept suppressing. Round 4 widens the
      // fingerprint to the whole repo-root listing.
      mkdirSync(join(repoRoot, "components"), { recursive: true });
      writeFileSync(
        join(repoRoot, "components", "Widget.tsx"),
        "const x: number = 'broken';\n",
      );
      const withBroken = computeInputFingerprint(repoRoot);
      expect(withBroken).toBeDefined();
      // Delete the file — the fingerprint MUST change so a stale
      // start-failed record is cleared on the next ensureDaemon.
      rmSync(join(repoRoot, "components", "Widget.tsx"));
      const afterDelete = computeInputFingerprint(repoRoot);
      expect(afterDelete).not.toBe(withBroken);
      // Separately: a FIX in place (different content + mtime)
      // must also flip the hash.
      writeFileSync(
        join(repoRoot, "components", "Widget.tsx"),
        "export const x: number = 1;\n",
      );
      const now = new Date();
      utimesSync(
        join(repoRoot, "components", "Widget.tsx"),
        now,
        new Date(now.getTime() + 2000),
      );
      const afterFix = computeInputFingerprint(repoRoot);
      expect(afterFix).not.toBe(withBroken);
      expect(afterFix).not.toBe(afterDelete);
    },
  );

  test("#251 round 4 BLOCKER 1 test 4: a revkit version change invalidates the recorded fingerprint", () => {
    writeFileSync(join(repoRoot, "package.json"), '{"name":"x"}');
    const v1 = computeInputFingerprint(repoRoot, { version: "0.1.0" });
    const v2 = computeInputFingerprint(repoRoot, { version: "0.2.0" });
    expect(v1).toBeDefined();
    expect(v2).toBeDefined();
    expect(v2).not.toBe(v1);
    // Same version → stable.
    const v1again = computeInputFingerprint(repoRoot, { version: "0.1.0" });
    expect(v1again).toBe(v1);
  });

  test(
    "#251 round 4 BLOCKER 1: a git-tracked file flips the fingerprint when edited (git listing path)",
    () => {
      // Same expectation as the fallback walk — proves the git
      // `ls-files -co` branch hashes the whole listing (not just
      // docs/vocab/plots).
      execFileSync("git", ["-C", repoRoot, "init", "-q"]);
      execFileSync("git", ["-C", repoRoot, "config", "user.email", "test@example.com"]);
      execFileSync("git", ["-C", repoRoot, "config", "user.name", "test"]);
      mkdirSync(join(repoRoot, "components"), { recursive: true });
      writeFileSync(join(repoRoot, "components", "Widget.tsx"), "a\n");
      writeFileSync(join(repoRoot, "package.json"), "{}");
      execFileSync("git", ["-C", repoRoot, "add", "-A"]);
      execFileSync("git", ["-C", repoRoot, "commit", "-q", "-m", "init"]);
      const before = computeInputFingerprint(repoRoot);
      writeFileSync(join(repoRoot, "components", "Widget.tsx"), "ab\n");
      const now = new Date();
      utimesSync(
        join(repoRoot, "components", "Widget.tsx"),
        now,
        new Date(now.getTime() + 2000),
      );
      const after = computeInputFingerprint(repoRoot);
      expect(after).not.toBe(before);
    },
  );

  test("#251 round 4 BLOCKER 1: git-ignored files do NOT contribute to the fingerprint", () => {
    execFileSync("git", ["-C", repoRoot, "init", "-q"]);
    execFileSync("git", ["-C", repoRoot, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repoRoot, "config", "user.name", "test"]);
    writeFileSync(join(repoRoot, ".gitignore"), "ignored-dir/\n");
    writeFileSync(join(repoRoot, "package.json"), "{}");
    execFileSync("git", ["-C", repoRoot, "add", "-A"]);
    execFileSync("git", ["-C", repoRoot, "commit", "-q", "-m", "init"]);
    const before = computeInputFingerprint(repoRoot);
    mkdirSync(join(repoRoot, "ignored-dir"), { recursive: true });
    writeFileSync(join(repoRoot, "ignored-dir", "garbage.txt"), "ignored\n");
    const after = computeInputFingerprint(repoRoot);
    expect(after).toBe(before);
  });
});
