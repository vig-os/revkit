// mdx-imports tests — the analyser that decides which ESM blocks a
// content author is allowed to write. Every failure kind gets a
// dedicated test so a regression that silently opens the door
// (default-only import misclassified, export misdetected) blows up
// with a named diagnostic.
import { describe, expect, test } from "bun:test";
import { analyseEsm, looksLikeDynamicImport } from "../src/mdx-imports.ts";
import { parseSourceFor } from "../src/mdx-parse.ts";

/** Extract the single mdxjsEsm node's estree from an MDX source. */
function firstEsmEstree(mdxSource: string): unknown {
  const root = parseSourceFor("x.mdx", mdxSource);
  for (const child of (root as { children: readonly { type: string; data?: { estree?: unknown } }[] }).children) {
    if (child.type === "mdxjsEsm") return child.data?.estree ?? null;
  }
  return null;
}

describe("analyseEsm", () => {
  test("named import binds its local name and specifier (importedName mirrors localName)", () => {
    const estree = firstEsmEstree(`import { Callout } from "@revkit/components";\n\ntext\n`);
    const analysis = analyseEsm(estree, 1);
    expect(analysis.violations).toEqual([]);
    expect(analysis.bindings).toHaveLength(1);
    expect(analysis.bindings[0]).toEqual({
      localName: "Callout",
      importedName: "Callout",
      specifier: "@revkit/components",
      line: 1,
    });
  });

  test("renamed named import binds `localName` but tracks the original `importedName`", () => {
    const estree = firstEsmEstree(`import { LinkCard as X } from "@astrojs/starlight/components";\n\ntext\n`);
    const analysis = analyseEsm(estree, 1);
    expect(analysis.bindings[0]?.localName).toBe("X");
    expect(analysis.bindings[0]?.importedName).toBe("LinkCard");
  });

  test("default import binds its local name", () => {
    const estree = firstEsmEstree(`import Plot from "@revkit/components/Plot";\n\ntext\n`);
    const analysis = analyseEsm(estree, 1);
    expect(analysis.bindings[0]?.localName).toBe("Plot");
    expect(analysis.bindings[0]?.specifier).toBe("@revkit/components/Plot");
  });

  test("namespace import is refused (round-5: `import * as X` would sidestep the named-export denylist)", () => {
    const estree = firstEsmEstree(`import * as C from "@revkit/components";\n\ntext\n`);
    const analysis = analyseEsm(estree, 1);
    expect(analysis.bindings).toEqual([]);
    expect(analysis.violations[0]?.kind).toBe("unexpected-top-level");
    expect(analysis.violations[0]?.message).toContain("namespace import");
  });

  test("side-effect-only import (`import \"foo\"`) is a violation", () => {
    const estree = firstEsmEstree(`import "@revkit/components";\n\ntext\n`);
    const analysis = analyseEsm(estree, 1);
    expect(analysis.violations[0]?.kind).toBe("side-effect-import");
    expect(analysis.bindings).toEqual([]);
  });

  test("export declaration is a violation", () => {
    const estree = firstEsmEstree(`export const Evil = () => "no";\n\ntext\n`);
    const analysis = analyseEsm(estree, 1);
    expect(analysis.violations.some((v) => v.kind === "export-declaration")).toBe(true);
  });

  test("top-level non-import (e.g. `const x = 1`) is refused", () => {
    // MDX v3 rejects such a top-level declaration in an ESM block at
    // parse time, so `firstEsmEstree` returns `null` — the analyser's
    // unparsable-estree kind fires.
    const estree = firstEsmEstree(`import { Callout } from "@revkit/components";\n\ntext\n`);
    // Simulate a Program body that carries a VariableDeclaration.
    const spiked = {
      type: "Program",
      body: [
        ...(estree as { body?: readonly unknown[] }).body ?? [],
        { type: "VariableDeclaration", loc: { start: { line: 3 } } },
      ],
    };
    const analysis = analyseEsm(spiked, 1);
    expect(analysis.violations.some((v) => v.kind === "unexpected-top-level")).toBe(true);
  });

  test("unparsable estree (undefined) is a visible violation, not a silent pass", () => {
    const analysis = analyseEsm(undefined, 5);
    expect(analysis.violations[0]?.kind).toBe("unparsable-estree");
    expect(analysis.bindings).toEqual([]);
  });
});

describe("looksLikeDynamicImport", () => {
  test("`await import(\"x\")` is detected", () => {
    expect(looksLikeDynamicImport("await import(\"x\")")).toBe(true);
  });

  test("`import(\"x\")` at expression start is detected", () => {
    expect(looksLikeDynamicImport("import(\"x\")")).toBe(true);
  });

  test("plain word `import` is NOT a dynamic import", () => {
    expect(looksLikeDynamicImport("someone.import = 1")).toBe(false);
    expect(looksLikeDynamicImport("importantValue")).toBe(false);
  });
});
