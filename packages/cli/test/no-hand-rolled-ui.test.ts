// no-hand-rolled-UI rule tests (ADR-0005). Every bad fixture asserts
// the exact rule id and expected path prefix.
import { describe, expect, test } from "bun:test";
import {
  UI_ALLOWED_PREFIXES,
  checkNoHandRolledUiFile,
  isUnderAllowedUIPath,
} from "../src/rules/no-hand-rolled-ui.ts";

describe("no-hand-rolled-ui", () => {
  test("allowlist mentions the registry, site components, pages, layouts", () => {
    expect(UI_ALLOWED_PREFIXES).toEqual([
      "packages/components/src/",
      "site/src/components/",
      "site/src/pages/",
      "site/src/layouts/",
    ]);
  });

  test("packages/components/src/Foo.tsx is allowed", () => {
    expect(checkNoHandRolledUiFile("packages/components/src/Foo.tsx")).toEqual([]);
    expect(isUnderAllowedUIPath("packages/components/src/Foo.tsx")).toBe(true);
  });

  test("site/src/pages/index.astro is allowed", () => {
    expect(checkNoHandRolledUiFile("site/src/pages/index.astro")).toEqual([]);
  });

  test("packages/cli/src/ExampleUI.tsx is rejected", () => {
    const diagnostics = checkNoHandRolledUiFile("packages/cli/src/ExampleUI.tsx");
    expect(diagnostics).toHaveLength(1);
    const first = diagnostics[0];
    expect(first?.rule).toBe("no-hand-rolled-ui");
    expect(first?.message).toContain("packages/components/src/");
  });

  test("docs/example.astro is rejected", () => {
    const diagnostics = checkNoHandRolledUiFile("docs/example.astro");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.rule).toBe("no-hand-rolled-ui");
  });

  test("test files are exempt regardless of location", () => {
    expect(checkNoHandRolledUiFile("packages/cli/test/foo.test.tsx")).toEqual([]);
    expect(checkNoHandRolledUiFile("site/src/lib/render-plot.test.ts")).toEqual([]);
  });

  test(".ts modules are not this rule's concern", () => {
    expect(checkNoHandRolledUiFile("packages/cli/src/index.ts")).toEqual([]);
  });
});
