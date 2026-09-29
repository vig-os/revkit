// Rule tests for component-registry (C1, ADR-0005). Allowlist model —
// every bad fixture asserts rule id + line, and every bypass surfaced
// in PR #23 review is here as a negative test so a regression fails
// loudly instead of quietly re-opening the hole.
import { describe, expect, test } from "bun:test";
import { checkComponentRegistryFile } from "../src/rules/component-registry.ts";

describe("component-registry — allowed shapes", () => {
  test("clean MDX with an @revkit/components import passes", () => {
    const source = `import { Callout } from "@revkit/components";

<Callout kind="info" title="ok">All good.</Callout>
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    expect(result.diagnostics).toEqual([]);
  });

  test("subpath import from @revkit/components/Plot passes", () => {
    const source = `import Plot from "@revkit/components/Plot";

<Plot name="bundle-sizes" />
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    expect(result.diagnostics).toEqual([]);
  });

  test("import from @astrojs/starlight/components passes (seeded set, ADR-0001)", () => {
    const source = `import { Aside } from "@astrojs/starlight/components";

<Aside type="tip">seeded</Aside>
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    expect(result.diagnostics).toEqual([]);
  });

  test("statically-evaluable object/array attribute values pass", () => {
    const source = `import { Callout } from "@revkit/components";

<Callout kind="info" title="ok" data={{a: 1, b: [true, null, "x"]}} />
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    expect(result.diagnostics).toEqual([]);
  });
});

describe("component-registry — imports (allowlist)", () => {
  test("bare import from a foreign npm module is reported", () => {
    const source = `# header

import { Foo } from "some-other-lib";

<Foo />
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    const importFinding = result.diagnostics.find((d) => d.message.includes("some-other-lib"));
    expect(importFinding).toBeDefined();
    expect(importFinding?.rule).toBe("component-registry");
    expect(importFinding?.line).toBe(3);
  });

  test("relative import from content is refused", () => {
    const source = `import Plot from "../../components/Plot.astro";

<Plot />
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    const finding = result.diagnostics.find((d) => d.message.includes("Plot.astro"));
    expect(finding).toBeDefined();
    expect(finding?.rule).toBe("component-registry");
  });

  test("import from a *.test.* path is refused even under an allowed root", () => {
    const source = `import { Callout } from "@revkit/components/Callout.test";

<Callout />
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    const finding = result.diagnostics.find((d) => d.message.includes("Callout.test"));
    expect(finding).toBeDefined();
    expect(finding?.rule).toBe("component-registry");
  });

  test("side-effect-only import (no bindings) is refused", () => {
    const source = `import "@revkit/components";

# body
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    const finding = result.diagnostics.find((d) => d.message.includes("side-effect-only"));
    expect(finding).toBeDefined();
    expect(finding?.rule).toBe("component-registry");
  });

  test("top-level `export` in an ESM block is refused", () => {
    const source = `export const Evil = () => "no";

# body
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    const finding = result.diagnostics.find((d) => d.message.includes("export"));
    expect(finding).toBeDefined();
    expect(finding?.rule).toBe("component-registry");
  });
});

describe("component-registry — JSX elements", () => {
  test("uppercase component used without an import is refused", () => {
    const source = `# header

<UnknownComponent />
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    const finding = result.diagnostics.find((d) => d.message.includes("UnknownComponent"));
    expect(finding).toBeDefined();
    expect(finding?.rule).toBe("component-registry");
    expect(finding?.line).toBe(3);
  });

  test("lowercase JSX element (raw HTML div) is refused", () => {
    const source = `# title

<div>hand-rolled</div>
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    expect(result.diagnostics.some((d) => d.message.includes("<div>"))).toBe(true);
  });

  test("raw <script> in MDX is refused", () => {
    const source = `# title

<script>
alert('x')
</script>
`;
    const result = checkComponentRegistryFile(source, "docs/x.md");
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]?.rule).toBe("component-registry");
  });
});

describe("component-registry — attributes (allowlist)", () => {
  test("inline style= attribute is refused", () => {
    const source = `import { Callout } from "@revkit/components";

<Callout kind="info" title="ok" style="color: red" />
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    expect(result.diagnostics.some((d) => d.message.includes("'style'"))).toBe(true);
  });

  test("event handler attribute is refused", () => {
    const source = `import { Callout } from "@revkit/components";

<Callout kind="info" title="ok" onClick="alert(1)" />
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    expect(result.diagnostics.some((d) => d.message.includes("onClick"))).toBe(true);
  });

  test("spread attribute is refused", () => {
    const source = `import { Callout } from "@revkit/components";

<Callout {...{style:{}}} kind="info" title="ok" />
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    expect(result.diagnostics.some((d) => d.message.includes("spread"))).toBe(true);
  });

  test("non-static expression value (identifier reference) is refused", () => {
    const source = `import { Callout } from "@revkit/components";

<Callout kind={someVariable} title="ok" />
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    expect(result.diagnostics.some((d) => d.message.includes("non-static"))).toBe(true);
  });

  test("javascript: URL as a string on href is refused (raw)", () => {
    const source = `import { Callout } from "@revkit/components";

<Callout kind="info" title="t" href="javascript:alert(1)" />
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    expect(result.diagnostics.some((d) => d.message.toLowerCase().includes("refused url scheme"))).toBe(true);
  });

  test("javascript: URL as an expression (`href={\"javascript:...\"}`) is refused", () => {
    const source = `import { Callout } from "@revkit/components";

<Callout kind="info" title="t" href={"javascript:alert(1)"} />
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    expect(result.diagnostics.some((d) => d.message.toLowerCase().includes("refused url scheme"))).toBe(true);
  });

  test("data:text/html URL is refused (data: is on the refused-schemes list)", () => {
    const source = `import { Callout } from "@revkit/components";

<Callout kind="info" title="t" href="data:text/html,<script>alert(1)</script>" />
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    expect(result.diagnostics.some((d) => d.message.toLowerCase().includes("refused url scheme"))).toBe(true);
  });

  test("HTML-entity-encoded javascript: URL is refused after decoding", () => {
    const source = `import { Callout } from "@revkit/components";

<Callout kind="info" title="t" href="&#106;avascript:alert(1)" />
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    expect(result.diagnostics.some((d) => d.message.toLowerCase().includes("refused url scheme"))).toBe(true);
  });
});

describe("component-registry — MDX expressions (allowlist)", () => {
  test("comment-only expression is allowed", () => {
    const source = `# hello

{/* a note */}

More text.
`;
    const result = checkComponentRegistryFile(source, "docs/x.md");
    expect(result.diagnostics).toEqual([]);
  });

  test("executable expression `{<div onClick={()=>alert(1)}/>}` is refused", () => {
    const source = `# hello

{<div onClick={()=>alert(1)}/>}
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    expect(result.diagnostics.some((d) => d.message.includes("expression in content"))).toBe(true);
  });

  test("call expression `{React.createElement(\"script\",{},\"x\")}` is refused", () => {
    const source = `# hello

{React.createElement("script",{},"x")}
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    expect(result.diagnostics.some((d) => d.message.includes("expression in content"))).toBe(true);
  });

  test("dynamic import expression `{await import(\"evil-pkg\")}` is refused", () => {
    const source = `# hello

{await import("evil-pkg")}
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    expect(result.diagnostics.some((d) => d.message.includes("dynamic"))).toBe(true);
  });

  test("`export const Evil = () => <div/>` followed by `<Evil />` is refused twice (export + component-not-imported)", () => {
    const source = `export const Evil = () => "hi";

<Evil />
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    expect(result.diagnostics.some((d) => d.message.includes("export"))).toBe(true);
    expect(result.diagnostics.some((d) => d.message.includes("Evil"))).toBe(true);
  });
});

describe("component-registry — escape hatch (sibling-only)", () => {
  test("annotation on the preceding sibling silences the immediately-following JSX element", () => {
    const source = `import { Callout } from "@revkit/components";

{/* revkit-allow: #42 */}

<Callout kind="info" title="ok" onClick="alert(1)">
held under escalation
</Callout>
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    expect(result.diagnostics).toEqual([]);
    expect(result.usedAllowAnnotations).toHaveLength(1);
    expect(result.usedAllowAnnotations[0]?.annotation.issue).toBe(42);
  });

  test("malformed annotation (no issue number) does NOT silence", () => {
    const source = `import { Callout } from "@revkit/components";

{/* revkit-allow: broken */}

<Callout kind="info" title="ok" style="x">
bad
</Callout>
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  test("annotation before three elements only silences the first — subsequent elements are flagged", () => {
    const source = `import { Callout } from "@revkit/components";

{/* revkit-allow: #7 */}

<Callout kind="info" title="one" onClick="a">
first
</Callout>

<Callout kind="info" title="two" onClick="b">
second
</Callout>

<Callout kind="info" title="three" onClick="c">
third
</Callout>
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    // The second and third element each raise one 'onClick' violation.
    const onClickFindings = result.diagnostics.filter((d) => d.message.includes("onClick"));
    expect(onClickFindings).toHaveLength(2);
    expect(result.usedAllowAnnotations).toHaveLength(1);
  });
});

describe("component-registry — raw HTML in .md (allowlist)", () => {
  test("<!-- HTML comment --> is allowed", () => {
    const source = `# header

<!-- guardrails:derived cmd="scripts/adr-index.sh" -->
| a | b |
| - | - |
| 1 | 2 |
`;
    const result = checkComponentRegistryFile(source, "docs/adr/README.md");
    expect(result.diagnostics).toEqual([]);
  });

  test("<div><img src=…> is refused", () => {
    const source = `# header

<div><img src="/x.png"/></div>
`;
    const result = checkComponentRegistryFile(source, "docs/x.md");
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]?.rule).toBe("component-registry");
  });

  test("`<img onerror=alert(1)>` is refused (inline event handler in raw HTML)", () => {
    // CommonMark's HTML-inline rule refuses `<img/onerror=…>` outright
    // (the `/` is not a valid attribute-name character), so it renders
    // as plain text and never reaches the DOM as HTML. The dangerous
    // sibling is `<img onerror=…>` (space, valid HTML), which reaches
    // the DOM — the allowlist here (comments only) refuses it.
    const source = `# header

<img onerror=alert(1)>
`;
    const result = checkComponentRegistryFile(source, "docs/x.md");
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]?.rule).toBe("component-registry");
  });

  test("unquoted `<a href=javascript:...>` is refused", () => {
    const source = `# header

<a href=javascript:alert(1)>click</a>
`;
    const result = checkComponentRegistryFile(source, "docs/x.md");
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  test("`<link rel=stylesheet>` is refused", () => {
    const source = `# header

<link rel="stylesheet" href="/x.css">
`;
    const result = checkComponentRegistryFile(source, "docs/x.md");
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  test("`<form action=…>` is refused", () => {
    const source = `# header

<form action="/submit"><input name="x"/></form>
`;
    const result = checkComponentRegistryFile(source, "docs/x.md");
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  test("pathological `<!--<!--…<!--` runs in O(n) and does not classify as comments-only", () => {
    // Regression guard: an earlier regex-based check
    // (`^\s*(?:<!--[\s\S]*?-->\s*)+$`) exponentially backtracked on
    // this shape (CodeQL js/redos). The linear scanner returns fast
    // and refuses the input because there is no closing `-->`.
    const source = "# hi\n\n" + "<!--".repeat(200) + "\n";
    const start = performance.now();
    const result = checkComponentRegistryFile(source, "docs/x.md");
    const elapsed = performance.now() - start;
    // A backtracking regex on this input takes seconds; the linear
    // scanner takes microseconds. Cap generously.
    expect(elapsed).toBeLessThan(1000);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  test("nested `<!--<!-- --> -->` — outer content after inner `-->` is not comments-only", () => {
    // Defense against a smuggled tag hiding after a comment close.
    const source = "# hi\n\n<!-- outer <!-- inner --> <script>alert(1)</script> -->\n";
    const result = checkComponentRegistryFile(source, "docs/x.md");
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});
