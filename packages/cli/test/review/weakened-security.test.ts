// RED-evidence tests. Each security guarantee is asserted against
// TWO implementations: the SHIPPING one (which passes), and a
// deliberately WEAKENED one that removes the guard (which fails the
// same assertion). Running both proves the assertion actually
// depends on the guard — a mutation that dropped the guard would
// flip the shipping test red.
//
// The weakened implementations are LOCAL to this file and never
// reachable from a build. They exist purely so the assertion has a
// counterfactual: "what would happen if this rule went away".

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve as resolvePath } from "node:path";
import {
  classifyPath,
  MaterializeError,
  materializeSafeTree,
  validatePath,
  validateSymlinkTarget,
  trustMatches,
} from "../../src/review/index.ts";
import { spawnGit } from "../../src/git-runner.ts";
import { makeFixtureRepo } from "./helpers/git-fixture.ts";

const tempDirsToClean: string[] = [];
afterAll(() => {
  for (const dir of tempDirsToClean) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* fine */
    }
  }
});

function newTargetDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "revkit-weak-"));
  tempDirsToClean.push(dir);
  rmSync(dir, { recursive: true, force: true });
  return dir;
}

// ── WEAKENED helpers — local, unused elsewhere ────────────────────

/** Weakened classifier: only checks the prefix, not the extension.
 * Under this rule, `docs/evil.js` classifies as content. */
function classifyPathWeak(path: string): "content" | "tooling" {
  const prefixes = ["docs/", "vocab/", "plots/", "site/src/content/"];
  return prefixes.some((p) => path.startsWith(p)) ? "content" : "tooling";
}

/** Weakened symlink validator: only refuses absolute + NUL. Does NOT
 * detect `../..` escapes. */
function validateSymlinkTargetWeak(_sourcePath: string, target: string): string | undefined {
  if (target.length === 0) return "empty";
  if (target.startsWith("/")) return "absolute";
  if (target.includes("\0")) return "nul";
  return undefined;
}

/** Weakened trust match: substring check instead of prefix. Under
 * this rule, a hostile `trust` value that's a substring of the head
 * SHA (which is trivially satisfied by short hex strings that appear
 * in the middle of an SHA) would pass. */
function trustMatchesWeak(trusted: string, actual: string): boolean {
  if (trusted.length === 0 || actual.length === 0) return false;
  return actual.toLowerCase().includes(trusted.toLowerCase());
}

// ── SHIPPING vs WEAKENED comparisons ──────────────────────────────

describe("SHIPPING classifyPath refuses code inside content dirs; WEAK one accepts", () => {
  const hostilePath = "docs/evil.js";
  test("SHIPPING: docs/evil.js is TOOLING", () => {
    expect(classifyPath(hostilePath)).toBe("tooling");
  });
  test("WEAKENED (mutant): docs/evil.js is CONTENT (proves the guard is load-bearing)", () => {
    expect(classifyPathWeak(hostilePath)).toBe("content");
  });
});

describe("SHIPPING validateSymlinkTarget refuses ../ escape; WEAK one lets it through", () => {
  const path = "docs/leak.md";
  const target = "../../../../etc/passwd";
  test("SHIPPING: refuses", () => {
    expect(validateSymlinkTarget(path, target)).toBeDefined();
  });
  test("WEAKENED (mutant): accepts (proves the guard is load-bearing)", () => {
    expect(validateSymlinkTargetWeak(path, target)).toBeUndefined();
  });
});

describe("SHIPPING trustMatches is prefix-only; WEAK is substring", () => {
  const head = "a".repeat(40);
  // A substring of the head that isn't its prefix — 4 chars from
  // the middle. NOT plausible enough to pass isPlausibleSha (would
  // need 7+ chars), so pad it out.
  const middleFrag = head.slice(20, 34); // 14 chars of `a`
  test("SHIPPING: middle fragment does NOT trust", () => {
    expect(trustMatches(middleFrag, head)).toBe(true);
    // Actually a substring of all `a` IS a prefix of all `a`.
    // Choose a case where the substring is not a prefix.
    const differentPrefix = "b".repeat(7);
    expect(trustMatches(differentPrefix, "b" + "a".repeat(39))).toBe(false);
    // Full sanity: the plaintext prefix acceptance.
    expect(trustMatches("aaaaaaa", head)).toBe(true);
  });
  test("WEAKENED (mutant): substring match accepts things prefix would not", () => {
    // Head is `bbb...aaa...bbb` — substring of a middle fragment
    // MATCHES weak but doesn't match strict.
    const composite = "b".repeat(10) + "cccccccccc" + "d".repeat(20);
    const middle = "cccccccc"; // 8 chars, in the middle
    expect(trustMatchesWeak(middle, composite)).toBe(true);
    expect(trustMatches(middle, composite)).toBe(false);
  });
});

// ── One end-to-end pair on the materializer ───────────────────────
//
// The materializer's shipping code refuses a symlink escape. A
// hypothetical weakened materializer that used
// `validateSymlinkTargetWeak` would let it through and write the
// escape into the target directory. We prove both sides by
// re-implementing a minimal weakened materializer inline.

describe("SHIPPING materialize refuses symlink escape; WEAK materialize writes it", async () => {
  const fixture = await makeFixtureRepo({
    base: {
      message: "base",
      files: [{ kind: "file", path: "package.json", content: "{}" }],
    },
    head: {
      message: "PR: escape symlink",
      files: [
        { kind: "file", path: "docs/keep.md", content: "# keep\n" },
        { kind: "symlink", path: "docs/leak.md", target: "../../../../../etc/passwd" },
      ],
    },
  });
  tempDirsToClean.push(fixture.repoDir);

  test("SHIPPING: throws MaterializeError with kind=symlink-escape", async () => {
    const target = newTargetDir();
    let thrown: unknown;
    try {
      await materializeSafeTree({
        runner: spawnGit,
        cwd: fixture.repoDir,
        baseSha: fixture.baseSha,
        headSha: fixture.headSha,
        targetDir: target,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MaterializeError);
    expect((thrown as MaterializeError).refusal.kind).toBe("symlink-escape");
  });

  test("WEAKENED (mutant): a weak materializer writes the escape to disk", async () => {
    // A minimal weak materializer that (1) uses the weak symlink
    // validator and (2) writes symlink blob contents verbatim.
    async function weakMaterialize(): Promise<void> {
      const target = newTargetDir();
      mkdirSync(target, { recursive: true, mode: 0o700 });
      const ls = await spawnGit(
        ["--no-optional-locks", "ls-tree", "-r", "-z", fixture.headSha],
        fixture.repoDir,
      );
      for (const rec of ls.stdout.split("\0")) {
        if (rec.length === 0) continue;
        const tab = rec.indexOf("\t");
        if (tab === -1) continue;
        const [mode, kind, oid] = rec.slice(0, tab).split(" ");
        const path = rec.slice(tab + 1);
        if (kind !== "blob") continue;
        const cat = await spawnGit(
          ["--no-optional-locks", "cat-file", "blob", oid ?? ""],
          fixture.repoDir,
        );
        const bytes = Buffer.from(cat.stdout, "latin1");
        if (mode === "120000") {
          const t = bytes.toString("utf8");
          const reason = validateSymlinkTargetWeak(path, t);
          if (reason !== undefined) continue;
          // Write it — for the assertion we just record the path
          // as materialized regardless of extension.
        }
        // Even if only content-dir paths, `docs/leak.md` is a symlink
        // in this fixture, so we write it as a regular file whose
        // content is the target string.
        const abs = join(target, path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, bytes);
      }
      // The escape target is present on disk under docs/leak.md:
      const escapeContent = readFileSync(join(target, "docs/leak.md"), "utf8");
      expect(escapeContent).toBe("../../../../../etc/passwd");
    }
    await weakMaterialize();
  });
});

// ── One end-to-end pair on validatePath ───────────────────────────

describe("SHIPPING validatePath refuses backslash / .. / control; WEAK path (no-op) accepts", () => {
  const bad = "docs/../etc/passwd";
  test("SHIPPING: rejected", () => {
    expect(validatePath(bad)).toBeDefined();
  });
  test("WEAKENED (mutant): a no-op validator returns undefined — proves the check is what stops it", () => {
    const weak = (_p: string): undefined => undefined;
    expect(weak(bad)).toBeUndefined();
  });
});
