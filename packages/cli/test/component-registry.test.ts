// Rule tests for component-registry (C1, ADR-0005). Each bad fixture
// fails for the stated reason (rule id + line asserted).
import { describe, expect, test } from "bun:test";
import { checkComponentRegistryFile } from "../src/rules/component-registry.ts";

describe("component-registry", () => {
  test("clean MDX with an @revkit/components import passes", () => {
    const source = `import { Callout } from "@revkit/components";

<Callout kind="info" title="ok">All good.</Callout>
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    expect(result.diagnostics).toEqual([]);
  });

  test("an @astrojs/starlight/components import passes (seeded set, ADR-0001)", () => {
    const source = `import { Aside } from "@astrojs/starlight/components";

<Aside type="tip">seeded</Aside>
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    expect(result.diagnostics).toEqual([]);
  });

  test("import from a foreign module is reported at the import's line", () => {
    const source = `# header

import { Foo } from "some-other-lib";
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    expect(result.diagnostics).toHaveLength(1);
    const first = result.diagnostics[0];
    expect(first?.rule).toBe("component-registry");
    expect(first?.line).toBe(3);
    expect(first?.message).toContain("some-other-lib");
  });

  test("raw <script> in MDX is reported", () => {
    const source = `# title

<script>alert('x')</script>
`;
    const result = checkComponentRegistryFile(source, "docs/x.md");
    expect(result.diagnostics.length).toBeGreaterThan(0);
    const first = result.diagnostics[0];
    expect(first?.rule).toBe("component-registry");
    expect(first?.line).toBeGreaterThan(0);
  });

  test("inline style= attribute on a JSX element is reported", () => {
    const source = `import { Callout } from "@revkit/components";

<Callout kind="info" title="ok" style="color: red">bad</Callout>
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    expect(result.diagnostics.some((d) => d.message.includes("style"))).toBe(true);
  });

  test("event handler attribute on a JSX element is reported", () => {
    const source = `import { Callout } from "@revkit/components";

<Callout kind="info" title="ok" onClick="alert(1)">bad</Callout>
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    expect(result.diagnostics.some((d) => d.message.includes("onClick"))).toBe(true);
  });

  test("javascript: URL on an anchor tag is reported at the tag line", () => {
    const source = `[click](javascript:alert(1))

<a href="javascript:alert(1)">nope</a>
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    expect(result.diagnostics.some((d) => d.message.toLowerCase().includes("javascript"))).toBe(true);
  });

  test("lowercase JSX element (raw HTML div) is reported", () => {
    const source = `# title

<div>hand-rolled</div>
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    expect(result.diagnostics.some((d) => d.message.includes("div"))).toBe(true);
  });

  test("revkit-allow annotation on the preceding line silences the violation", () => {
    const source = `import { Callout } from "@revkit/components";

{/* revkit-allow: #42 */}
<Callout kind="info" title="ok" onClick="alert(1)">held under escalation</Callout>
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    expect(result.diagnostics).toEqual([]);
    expect(result.usedAllowAnnotations).toHaveLength(1);
    expect(result.usedAllowAnnotations[0]?.annotation.issue).toBe(42);
  });

  test("malformed revkit-allow annotation (no issue number) does NOT silence", () => {
    const source = `import { Callout } from "@revkit/components";

{/* revkit-allow: broken */}
<Callout kind="info" title="ok" style="x">bad</Callout>
`;
    const result = checkComponentRegistryFile(source, "site/src/content/docs/x.mdx");
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  test("raw HTML iframe in markdown is reported", () => {
    const source = `# doc

<iframe src="https://example.com"></iframe>
`;
    const result = checkComponentRegistryFile(source, "docs/x.md");
    expect(result.diagnostics.some((d) => d.message.includes("iframe"))).toBe(true);
  });
});
