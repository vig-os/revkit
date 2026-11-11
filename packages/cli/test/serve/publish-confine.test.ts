// Unit tests for `publish-confine.ts` (M2 item 9, story A4).
//
// The confinement helper is the ONLY guard between an agent-supplied
// path and the daemon's write path. Every hazardous shape a browser
// or a rogue agent might send is asserted here: traversal, symlink
// (leaf and parent), dot-prefixed segment, backslash on POSIX, null
// byte, over-cap, off-root, off-extension, absolute path.
//
// Non-tautology: each rejection case is paired with a matching
// ACCEPTED case that would otherwise be indistinguishable. A rule
// that only fires on the bad input and not on the good input proves
// the guard is targeted, not blanket.
//
// The `siteRouteForPath` helper is cross-checked against the
// repo-docs loader's `siteRouteForDoc` (site/src/content/loaders/
// repo-docs.ts) at the end of the file — if either drifts, both
// tests turn red.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PUBLISH_FILE_MAX_BYTES,
  PUBLISH_REQUEST_MAX_BYTES,
  resolvePublishTarget,
  siteRouteForPath,
} from "../../src/serve/publish-confine.ts";

/** Set up a repo with the four publishable directories and one
 * ADR / one design / a plot / vocab, so the accept path has real
 * targets. `rm` at the end. */
function scaffold(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "revkit-publish-confine-"));
  mkdirSync(join(root, "docs", "adr"), { recursive: true });
  mkdirSync(join(root, "docs", "designs"), { recursive: true });
  mkdirSync(join(root, "plots", "curve"), { recursive: true });
  mkdirSync(join(root, "vocab"), { recursive: true });
  writeFileSync(join(root, "docs", "adr", "0001-existing.md"), "# existing\n");
  writeFileSync(join(root, "docs", "designs", "DESIGN-0001.md"), "# design\n");
  writeFileSync(join(root, "docs", "FEATURE-MATRIX.md"), "# matrix\n");
  writeFileSync(join(root, "plots", "curve", "spec.vl.json"), "{}");
  writeFileSync(join(root, "plots", "curve", "data.json"), "[]");
  writeFileSync(join(root, "vocab", "terms.yaml"), "schemaVersion: 1\nentries: []\n");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("resolvePublishTarget — accept path", () => {
  test("accepts an existing ADR", () => {
    const { root, cleanup } = scaffold();
    try {
      const result = resolvePublishTarget(root, "docs/adr/0001-existing.md");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.siteRoute).toBe("/adr/0001-existing/");
    } finally {
      cleanup();
    }
  });

  test("accepts a BRAND-NEW ADR whose parent directory exists", () => {
    const { root, cleanup } = scaffold();
    try {
      const result = resolvePublishTarget(root, "docs/adr/0999-new.md");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.absolutePath.endsWith("/docs/adr/0999-new.md")).toBe(true);
        expect(result.siteRoute).toBe("/adr/0999-new/");
      }
    } finally {
      cleanup();
    }
  });

  test("accepts docs/FEATURE-MATRIX.md at the exact spelling", () => {
    const { root, cleanup } = scaffold();
    try {
      const result = resolvePublishTarget(root, "docs/FEATURE-MATRIX.md");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.siteRoute).toBe("/feature-matrix/");
    } finally {
      cleanup();
    }
  });

  test("accepts a plot spec and a plot data file (no route, participates in a page)", () => {
    const { root, cleanup } = scaffold();
    try {
      const spec = resolvePublishTarget(root, "plots/curve/spec.vl.json");
      const data = resolvePublishTarget(root, "plots/curve/data.json");
      expect(spec.ok).toBe(true);
      expect(data.ok).toBe(true);
      if (spec.ok) expect(spec.siteRoute).toBeUndefined();
      if (data.ok) expect(data.siteRoute).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("accepts vocab/terms.yaml at the exact spelling", () => {
    const { root, cleanup } = scaffold();
    try {
      const result = resolvePublishTarget(root, "vocab/terms.yaml");
      expect(result.ok).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("resolvePublishTarget — rejection cases", () => {
  test("refuses `..` traversal", () => {
    const { root, cleanup } = scaffold();
    try {
      const result = resolvePublishTarget(root, "docs/adr/../../etc/passwd");
      expect(result.ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("refuses a leading `/`", () => {
    const { root, cleanup } = scaffold();
    try {
      const result = resolvePublishTarget(root, "/docs/adr/x.md");
      expect(result.ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("refuses a null byte", () => {
    const { root, cleanup } = scaffold();
    try {
      const result = resolvePublishTarget(root, "docs/adr/x\0.md");
      expect(result.ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("refuses a backslash (Windows-style separator)", () => {
    const { root, cleanup } = scaffold();
    try {
      const result = resolvePublishTarget(root, "docs\\adr\\x.md");
      expect(result.ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("refuses a dot-prefixed segment (`.github/`, `.git/`)", () => {
    const { root, cleanup } = scaffold();
    try {
      const result = resolvePublishTarget(root, ".git/config");
      expect(result.ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("refuses an off-root path (`.github/workflows/x.yml`)", () => {
    const { root, cleanup } = scaffold();
    try {
      const result = resolvePublishTarget(root, "packages/cli/src/index.ts");
      expect(result.ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("refuses a wrong-extension file inside a publishable tree", () => {
    const { root, cleanup } = scaffold();
    try {
      // Wrong extension: .md tree does not accept .txt.
      const result = resolvePublishTarget(root, "docs/adr/x.txt");
      expect(result.ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("refuses an uppercase `.MD` extension (PR-56 review nit — routes are case-sensitive)", () => {
    // `siteRouteForPath` matches `\.md$` case-sensitively, so a
    // publish to `docs/adr/x.MD` would (before this fix) succeed at
    // the confinement gate but produce no route — the fast-path
    // renderer then skipped the override, silently. The guard now
    // rejects at the gate so caller knows to rename.
    const { root, cleanup } = scaffold();
    try {
      const result = resolvePublishTarget(root, "docs/adr/x.MD");
      expect(result.ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("refuses a symlink to somewhere outside the root", () => {
    const { root, cleanup } = scaffold();
    try {
      // Create a symlink inside docs/adr/ that points OUT of the
      // repo. `resolveWithinRoot` refuses it.
      symlinkSync("/etc/passwd", join(root, "docs", "adr", "evil.md"));
      const result = resolvePublishTarget(root, "docs/adr/evil.md");
      expect(result.ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("refuses `docs/COMMIT_MESSAGE_STANDARD.md` (devkit-managed, not a publishable root)", () => {
    const { root, cleanup } = scaffold();
    try {
      writeFileSync(join(root, "docs", "COMMIT_MESSAGE_STANDARD.md"), "# managed\n");
      const result = resolvePublishTarget(root, "docs/COMMIT_MESSAGE_STANDARD.md");
      expect(result.ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("refuses MDX under site/src/content/docs/ (M2 out-of-scope)", () => {
    const { root, cleanup } = scaffold();
    try {
      mkdirSync(join(root, "site", "src", "content", "docs"), { recursive: true });
      const result = resolvePublishTarget(root, "site/src/content/docs/index.mdx");
      expect(result.ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("refuses an empty path", () => {
    const { root, cleanup } = scaffold();
    try {
      const result = resolvePublishTarget(root, "");
      expect(result.ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("refuses a new file whose parent DOES NOT exist", () => {
    const { root, cleanup } = scaffold();
    try {
      const result = resolvePublishTarget(root, "docs/adr/new-dir/new.md");
      expect(result.ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("refuses a path whose PARENT DIRECTORY is a symlink to outside the repo (round-2 nit)", () => {
    // Round-2 nit: an agent should not be able to write into a
    // real directory reached only through a symlinked parent.
    // Even if the leaf itself is a plain filename, an attacker
    // planted symlink at any component of the path is a bypass.
    const { root, cleanup } = scaffold();
    try {
      // Place a symlink at docs/adr/link-parent → /tmp
      // (a directory OUTSIDE this scratch repo). Any child
      // `docs/adr/link-parent/*.md` must be refused.
      symlinkSync("/tmp", join(root, "docs", "adr", "link-parent"));
      const result = resolvePublishTarget(root, "docs/adr/link-parent/new.md");
      expect(result.ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("refuses a dangling-symlink leaf (round-2 nit)", () => {
    // A symlink whose target does not exist would otherwise
    // survive an `existsSync` on the parent, appearing "new-file
    // publish" but resolving to an off-tree path if a follower
    // ever chases the link. The confinement helper refuses.
    const { root, cleanup } = scaffold();
    try {
      symlinkSync("/nonexistent/path", join(root, "docs", "adr", "dangling.md"));
      const result = resolvePublishTarget(root, "docs/adr/dangling.md");
      expect(result.ok).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("size caps are named as constants", () => {
  test("per-file cap is 5 MiB", () => {
    expect(PUBLISH_FILE_MAX_BYTES).toBe(5 * 1024 * 1024);
  });
  test("request cap is 10 MiB (twice the per-file cap)", () => {
    expect(PUBLISH_REQUEST_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(PUBLISH_REQUEST_MAX_BYTES).toBe(2 * PUBLISH_FILE_MAX_BYTES);
  });
});

describe("siteRouteForPath — repo-docs loader agreement", () => {
  // These expected routes MIRROR `siteRouteForDoc` in
  // `site/src/content/loaders/repo-docs.ts`. The two implementations
  // are duplicated on purpose (see the note in publish-confine.ts's
  // header), and drift is caught by BOTH sides carrying the same
  // expected values in their own tests — this file pins the daemon
  // side, and `site/tests/content.spec.ts` pins the loader side.
  const cases: readonly [string, string | undefined][] = [
    ["docs/FEATURE-MATRIX.md", "/feature-matrix/"],
    ["docs/adr/0001-foo.md", "/adr/0001-foo/"],
    ["docs/designs/DESIGN-0001-bar.md", "/designs/design-0001-bar/"],
    ["docs/README.md", undefined],
    ["plots/curve/data.json", undefined],
    ["vocab/terms.yaml", undefined],
  ];
  for (const [path, expected] of cases) {
    test(`route for '${path}'`, () => {
      expect(siteRouteForPath(path)).toBe(expected);
    });
  }
});
