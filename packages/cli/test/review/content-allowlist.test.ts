// The content allowlist is a load-bearing security boundary: an
// executable file wrongly classified as "content" gets its PR-head
// bytes trusted, which is exactly the attack surface ADR-0025 closes.
// Every prefix and extension is asserted from the DEFAULT constants
// so a regression in the source is caught without a per-test rewrite.

import { describe, expect, test } from "bun:test";
import {
  CONTENT_ALLOWED_EXTENSIONS,
  CONTENT_ALLOWLIST_PREFIXES,
  classifyPath,
  isUnderContentPrefix,
} from "../../src/review/content-allowlist.ts";

describe("CONTENT_ALLOWLIST_PREFIXES — the committed set", () => {
  test("is frozen so callers cannot mutate it at runtime", () => {
    expect(Object.isFrozen(CONTENT_ALLOWLIST_PREFIXES)).toBe(true);
  });
  test("contains the four content-owning directories from ADR-0025", () => {
    // Assert on the CONTENT of the exported constant, not a
    // hand-rolled copy — a regression that dropped `plots/` used
    // to slip past a duplicated fixture.
    expect([...CONTENT_ALLOWLIST_PREFIXES].sort()).toEqual([
      "docs/",
      "plots/",
      "site/src/content/",
      "vocab/",
    ]);
  });
});

describe("CONTENT_ALLOWED_EXTENSIONS", () => {
  test("includes MDX, JSON, YAML and common image types", () => {
    // Ordered by category so a change reads as an intent shift.
    const expected = new Set([
      ".md",
      ".mdx",
      ".json",
      ".yaml",
      ".yml",
      ".svg",
      ".png",
      ".jpg",
      ".jpeg",
      ".webp",
      ".gif",
      ".avif",
    ]);
    for (const ext of expected) {
      expect(CONTENT_ALLOWED_EXTENSIONS.has(ext)).toBe(true);
    }
  });
  test("excludes code-shaped extensions that would smuggle logic into content", () => {
    for (const ext of [".js", ".ts", ".mjs", ".cjs", ".astro", ".tsx", ".sh", ".py", ".rb", ".wasm"]) {
      expect(CONTENT_ALLOWED_EXTENSIONS.has(ext)).toBe(false);
    }
  });
});

describe("classifyPath — allow/deny decisions on the DEFAULT constants", () => {
  test("MDX inside docs/ is content", () => {
    expect(classifyPath("docs/adr/0025.md")).toBe("content");
    expect(classifyPath("docs/designs/DESIGN-0001.mdx")).toBe("content");
  });
  test("JSON inside plots/ is content", () => {
    expect(classifyPath("plots/foo/spec.vl.json")).toBe("content");
    expect(classifyPath("plots/foo/data.json")).toBe("content");
  });
  test("YAML inside vocab/ is content", () => {
    expect(classifyPath("vocab/pigments.yaml")).toBe("content");
  });
  test("Starlight collection MDX is content", () => {
    expect(classifyPath("site/src/content/docs/index.mdx")).toBe("content");
  });

  test("a JS file inside docs/ is TOOLING (extension check)", () => {
    // This is the mutant killer — if the allowlist were a pure
    // prefix check, this would classify as content and let a PR
    // smuggle executable bytes into the build.
    expect(classifyPath("docs/evil.js")).toBe("tooling");
    expect(classifyPath("docs/index.astro")).toBe("tooling");
  });
  test("a TS file inside plots/ is TOOLING", () => {
    expect(classifyPath("plots/inject.ts")).toBe("tooling");
  });
  test("a shell script inside vocab/ is TOOLING", () => {
    expect(classifyPath("vocab/hack.sh")).toBe("tooling");
  });

  test("outside every prefix is TOOLING", () => {
    for (const path of [
      "package.json",
      "bun.lock",
      "flake.nix",
      "flake.lock",
      ".github/workflows/ci.yml",
      "site/astro.config.mjs",
      "site/package.json",
      "site/src/pages/index.astro",
      "site/src/components/Foo.astro",
      "packages/cli/src/index.ts",
      "justfile",
      "justfile.project",
      ".githooks/pre-commit",
      "scripts/copy-katex.ts",
    ]) {
      expect(classifyPath(path)).toBe("tooling");
    }
  });

  test("absolute paths, backslashes and .. segments are TOOLING (refused)", () => {
    expect(classifyPath("/etc/passwd")).toBe("tooling");
    expect(classifyPath("docs\\foo.md")).toBe("tooling");
    expect(classifyPath("docs/../../../etc/passwd")).toBe("tooling");
  });

  test("dotfiles under a content dir with no extension are TOOLING", () => {
    // A `.gitkeep` in docs/ isn't content; nothing renders from it.
    expect(classifyPath("docs/.gitkeep")).toBe("tooling");
    expect(classifyPath("docs/Makefile")).toBe("tooling");
  });

  test("package-manager manifests under a content dir are TOOLING (defense-in-depth)", () => {
    // A `package.json` at ANY path is tooling — the belt in
    // classifyPath forces this classification even when the
    // prefix + extension would otherwise pass (PR #48 round-4
    // adversarial-e2e nit: refuse content-directory smuggle of
    // package-manager metadata).
    expect(classifyPath("docs/x/package.json")).toBe("tooling");
    expect(classifyPath("site/src/content/docs/x/package.json")).toBe("tooling");
    expect(classifyPath("plots/adv/package.json")).toBe("tooling");
    expect(classifyPath("vocab/adv/package-lock.json")).toBe("tooling");
    expect(classifyPath("docs/adv/bun.lock")).toBe("tooling");
    expect(classifyPath("docs/adv/pnpm-lock.yaml")).toBe("tooling");
    expect(classifyPath("site/src/content/docs/adv/.npmrc")).toBe("tooling");
  });

  test("node_modules/ segment anywhere is TOOLING (defense-in-depth)", () => {
    // A `node_modules/` under content classifies as tooling by
    // segment name, so tooling-diff catches the smuggle even for
    // basenames whose extension IS in CONTENT_ALLOWED_EXTENSIONS
    // (e.g. `.json`, `.md`) (PR #48 round-4 adversarial-e2e nit).
    expect(classifyPath("docs/x/node_modules/evil.js")).toBe("tooling");
    expect(classifyPath("docs/x/node_modules/pkg/package.json")).toBe("tooling");
    expect(classifyPath("site/src/content/docs/x/node_modules/pwn.md")).toBe("tooling");
    expect(classifyPath("plots/x/node_modules/pwn.json")).toBe("tooling");
    // `.git/` and `.direnv/` segments too — never valid inside a PR.
    expect(classifyPath("docs/x/.git/config")).toBe("tooling");
    expect(classifyPath("docs/x/.direnv/lib/foo.js")).toBe("tooling");
  });
});

describe("isUnderContentPrefix — reports directory-only match for diagnostics", () => {
  test("returns true when the prefix matches even if extension is code", () => {
    expect(isUnderContentPrefix("docs/evil.js")).toBe(true);
    expect(isUnderContentPrefix("plots/injector.ts")).toBe(true);
  });
  test("returns false outside every prefix", () => {
    expect(isUnderContentPrefix("package.json")).toBe(false);
    expect(isUnderContentPrefix("site/src/pages/index.astro")).toBe(false);
  });
  test("refuses malformed paths", () => {
    expect(isUnderContentPrefix("/docs/x.md")).toBe(false);
    expect(isUnderContentPrefix("docs\\x.md")).toBe(false);
    expect(isUnderContentPrefix("docs/../y.md")).toBe(false);
    expect(isUnderContentPrefix("")).toBe(false);
  });
});
