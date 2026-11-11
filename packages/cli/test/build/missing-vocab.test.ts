// Issue #57 nit: `revkit check` on a consumer with NO
// `vocab/terms.yaml` must succeed (empty vocab) — matching the
// build's own optional-vocab handling in `content.config.ts`.
// Before this PR, the check emitted a diagnostic `vocab/terms.yaml:
// vocabulary: failed to load vocab: ENOENT: no such file …` and
// exited non-zero, even for a docs tree that never referenced
// `<Term id>`.
//
// **RED on b3832661**: yes — before the ENOENT branch in `check.ts`
// treated a missing file as an empty vocab, `runCheck` on a consumer
// with `docs/index.mdx` + no vocab would return `exitCode: 1` with
// the ENOENT diagnostic.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck, toCheckFiles } from "../../src/check.ts";
import { walkForCheckables } from "../../src/file-discovery.ts";

function scaffoldConsumer(hasVocab: boolean): string {
  const c = mkdtempSync(join(tmpdir(), "revkit-check-vocab-"));
  writeFileSync(join(c, "package.json"), '{"name":"c","revkit":{}}\n');
  mkdirSync(join(c, "docs"));
  writeFileSync(
    join(c, "docs", "index.mdx"),
    `---\ntitle: Index\ndescription: d\n---\n\nBody paragraph.\n`,
  );
  if (hasVocab) {
    mkdirSync(join(c, "vocab"));
    writeFileSync(
      join(c, "vocab", "terms.yaml"),
      "schemaVersion: 1\nentries:\n  - id: anchor\n    term: anchor\n    definition: d\n",
    );
  }
  return c;
}

describe("revkit check treats a missing vocab/terms.yaml as empty (issue #57 nit)", () => {
  test("consumer with no vocab AND no <Term id> usages passes", async () => {
    const c = scaffoldConsumer(false);
    try {
      const discovery = walkForCheckables(c);
      const files = toCheckFiles(discovery.files, c);
      const out = await runCheck(c, files, discovery.symlinks, {
        online: false,
        repoSlug: "vig-os/revkit",
        gh: async () => ({ stdout: "", stderr: "", exitCode: 1 }),
      });
      // No vocab-related diagnostic.
      const vocabLines = out.lines.filter((l) => l.includes("vocabulary"));
      expect(vocabLines).toEqual([]);
      // And exit is clean.
      expect(out.exitCode).toBe(0);
    } finally {
      rmSync(c, { recursive: true, force: true });
    }
  });

  test("consumer with a MALFORMED vocab still fails cleanly (loud, not silent)", async () => {
    const c = scaffoldConsumer(false);
    try {
      mkdirSync(join(c, "vocab"));
      // Missing `entries` — schema-invalid.
      writeFileSync(join(c, "vocab", "terms.yaml"), "schemaVersion: 1\n");
      const discovery = walkForCheckables(c);
      const files = toCheckFiles(discovery.files, c);
      const out = await runCheck(c, files, discovery.symlinks, {
        online: false,
        repoSlug: "vig-os/revkit",
        gh: async () => ({ stdout: "", stderr: "", exitCode: 1 }),
      });
      // A schema violation IS reported (contrast the missing-file case).
      const vocabLines = out.lines.filter((l) => l.includes("vocabulary"));
      expect(vocabLines.length).toBeGreaterThan(0);
      expect(out.exitCode).not.toBe(0);
    } finally {
      rmSync(c, { recursive: true, force: true });
    }
  });

  test("consumer with no vocab BUT a <Term id> reference — the reference is refused", async () => {
    const c = scaffoldConsumer(false);
    try {
      writeFileSync(
        join(c, "docs", "index.mdx"),
        `---\ntitle: Index\ndescription: d\n---\n\nimport { Term } from "@revkit/components";\n\nUses <Term id="missing" />.\n`,
      );
      const discovery = walkForCheckables(c);
      const files = toCheckFiles(discovery.files, c);
      const out = await runCheck(c, files, discovery.symlinks, {
        online: false,
        repoSlug: "vig-os/revkit",
        gh: async () => ({ stdout: "", stderr: "", exitCode: 1 }),
      });
      // The vocab is empty; the `<Term id="missing">` reference is
      // an unknown-id finding rather than a load failure.
      const unknownLines = out.lines.filter((l) => l.includes("unknown term"));
      expect(unknownLines.length).toBeGreaterThan(0);
    } finally {
      rmSync(c, { recursive: true, force: true });
    }
  });
});
