// no-hand-rolled-UI rule tests (ADR-0005). Two allowlists — UI-shaped
// files outside the registered UI trees are refused; code modules
// inside a content directory are refused. Case-insensitive.
import { describe, expect, test } from "bun:test";
import {
  UI_ALLOWED_PREFIXES,
  checkNoHandRolledUiFile,
  isUnderAllowedUIPath,
} from "../src/rules/no-hand-rolled-ui.ts";

describe("no-hand-rolled-ui — UI-shaped files", () => {
  test("allowlist contents (order-independent) match the four registered trees", () => {
    expect(new Set(UI_ALLOWED_PREFIXES)).toEqual(new Set([
      "packages/components/src/",
      "site/src/components/",
      "site/src/pages/",
      "site/src/layouts/",
    ]));
  });

  test("packages/components/src/Foo.tsx is allowed", () => {
    expect(checkNoHandRolledUiFile("packages/components/src/Foo.tsx")).toEqual([]);
    expect(isUnderAllowedUIPath("packages/components/src/Foo.tsx")).toBe(true);
  });

  test("site/src/pages/index.astro is allowed", () => {
    expect(checkNoHandRolledUiFile("site/src/pages/index.astro")).toEqual([]);
  });

  test("case-mismatched UI extension (Component.TSX) is still refused if outside the allowlist", () => {
    const diagnostics = checkNoHandRolledUiFile("packages/cli/src/Component.TSX");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.rule).toBe("no-hand-rolled-ui");
  });

  test("case-mismatched prefix (Site/Src/Components/Foo.tsx) is still allowed", () => {
    // macOS/Windows filesystem: the same file may be reached via different
    // case. The allowlist match must not depend on case.
    expect(checkNoHandRolledUiFile("Site/Src/Components/Foo.tsx")).toEqual([]);
  });

  test("packages/cli/src/ExampleUI.tsx (outside allowlist) is refused", () => {
    const diagnostics = checkNoHandRolledUiFile("packages/cli/src/ExampleUI.tsx");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.rule).toBe("no-hand-rolled-ui");
    expect(diagnostics[0]?.message).toContain("packages/components/src/");
  });

  test("docs/example.astro is refused", () => {
    const diagnostics = checkNoHandRolledUiFile("docs/example.astro");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.rule).toBe("no-hand-rolled-ui");
  });

  test("docs/example.vue is refused (extended extension set)", () => {
    const diagnostics = checkNoHandRolledUiFile("docs/example.vue");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.rule).toBe("no-hand-rolled-ui");
  });

  test("docs/example.svelte is refused (extended extension set)", () => {
    const diagnostics = checkNoHandRolledUiFile("docs/example.svelte");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.rule).toBe("no-hand-rolled-ui");
  });

  test("docs/example.html is refused (raw HTML doesn't belong in content)", () => {
    const diagnostics = checkNoHandRolledUiFile("docs/example.html");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.rule).toBe("no-hand-rolled-ui");
  });

  test("test files are exempt regardless of location", () => {
    expect(checkNoHandRolledUiFile("packages/cli/test/foo.test.tsx")).toEqual([]);
    expect(checkNoHandRolledUiFile("packages/cli/test/foo.test.jsx")).toEqual([]);
    expect(checkNoHandRolledUiFile("site/src/lib/render-plot.test.ts")).toEqual([]);
  });
});

describe("no-hand-rolled-ui — code modules in content directories", () => {
  test("plain .ts under docs/ is refused", () => {
    const diagnostics = checkNoHandRolledUiFile("docs/util.ts");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.rule).toBe("no-hand-rolled-ui");
    expect(diagnostics[0]?.message).toContain("code module");
  });

  test(".js under site/src/content/docs is refused", () => {
    const diagnostics = checkNoHandRolledUiFile("site/src/content/docs/foo.js");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.rule).toBe("no-hand-rolled-ui");
  });

  test(".ts under site/src/content/schemas is allowed (Astro content-collection infrastructure)", () => {
    // Astro's `defineCollection` schemas / loaders / utils MUST live
    // under `src/content/` — they are code, not content.
    expect(checkNoHandRolledUiFile("site/src/content/schemas/plots.ts")).toEqual([]);
    expect(checkNoHandRolledUiFile("site/src/content/loaders/plots.ts")).toEqual([]);
    expect(checkNoHandRolledUiFile("site/src/content/utils/vega-lite-walk.ts")).toEqual([]);
  });

  test(".mjs under docs/ is refused", () => {
    const diagnostics = checkNoHandRolledUiFile("docs/loader.mjs");
    expect(diagnostics).toHaveLength(1);
  });

  test(".ts under packages/cli/src is allowed (not a content dir)", () => {
    expect(checkNoHandRolledUiFile("packages/cli/src/index.ts")).toEqual([]);
  });
});

describe("no-hand-rolled-ui — test files inside content dirs (round-3 nit)", () => {
  test("docs/foo.test.md is flagged (any *.test.* under a content dir)", () => {
    const diagnostics = checkNoHandRolledUiFile("docs/foo.test.md");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("test file inside a content directory");
  });

  test("site/src/content/docs/foo.test.mdx is flagged", () => {
    const diagnostics = checkNoHandRolledUiFile("site/src/content/docs/foo.test.mdx");
    expect(diagnostics).toHaveLength(1);
  });

  test("docs/foo.test.ts is flagged (test file under content dir, even though the code-module branch exempts .test.*)", () => {
    const diagnostics = checkNoHandRolledUiFile("docs/foo.test.ts");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("test file inside a content directory");
  });

  test("packages/cli/test/foo.test.ts is NOT flagged (outside content dir)", () => {
    expect(checkNoHandRolledUiFile("packages/cli/test/foo.test.ts")).toEqual([]);
  });

  test("pathological `..test...test.` repetition runs in O(n) (ReDoS regression)", () => {
    // CodeQL flagged the earlier regex `/(^|\/)([^/]+\.)?test\.[jt]sx?$/i`
    // as potentially superlinear on this shape. The linear-scan
    // replacement returns immediately.
    const path = "docs/" + "..test.".repeat(500) + "md";
    const start = performance.now();
    const _ = checkNoHandRolledUiFile(path);
    void _;
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(200);
  });
});
