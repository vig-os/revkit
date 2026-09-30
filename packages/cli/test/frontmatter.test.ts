// Frontmatter rule tests (bypass #4 in PR #23 round-2 review). Every
// Starlight `docsSchema` key that renders raw HTML or a live URL is
// tested with a payload here — if a regression re-adds it, one of
// these named tests fails.
import { describe, expect, test } from "bun:test";
import {
  checkFrontmatter,
  extractFrontmatterBlock,
} from "../src/rules/frontmatter.ts";

describe("extractFrontmatterBlock", () => {
  test("returns null when the file has no frontmatter", () => {
    expect(extractFrontmatterBlock("# hi\n\nbody\n")).toBeNull();
  });

  test("extracts the yaml between the two `---` fences", () => {
    const src = `---\ntitle: t\ndescription: d\n---\n\nbody\n`;
    const block = extractFrontmatterBlock(src);
    expect(block?.yaml).toContain("title: t");
    expect(block?.startLine).toBe(2);
  });
});

describe("frontmatter — accepted shapes", () => {
  test("bare title/description passes", () => {
    const src = `---
title: revkit
description: HTML-first review surface.
---

body
`;
    expect(checkFrontmatter(src, "docs/x.md")).toEqual([]);
  });

  test("hero.tagline is allowed (no actions, no html)", () => {
    const src = `---
title: t
template: splash
hero:
  tagline: friendly line
---
`;
    expect(checkFrontmatter(src, "docs/x.md")).toEqual([]);
  });

  test("sidebar.badge as {text, variant} passes; variant must be a string", () => {
    const src = `---
title: t
sidebar:
  badge:
    text: Accepted
    variant: success
---
`;
    expect(checkFrontmatter(src, "docs/x.md")).toEqual([]);
  });

  test("revkitStatus (revkit-specific) passes", () => {
    const src = `---
title: t
revkitStatus: Accepted
---
`;
    expect(checkFrontmatter(src, "docs/x.md")).toEqual([]);
  });

  test("empty frontmatter is fine (missing title is not this rule's concern)", () => {
    const src = `---\n---\n\nbody\n`;
    expect(checkFrontmatter(src, "docs/x.md")).toEqual([]);
  });
});

describe("frontmatter — bypass #4 payloads (refused)", () => {
  test("`head: [{tag: script, content: ...}]` (Starlight raw-<script> injection) is refused", () => {
    const src = `---
title: t
head:
  - tag: script
    content: "alert(1)"
---
`;
    const findings = checkFrontmatter(src, "docs/x.md");
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.rule).toBe("component-registry");
    expect(findings[0]?.message).toContain("head");
  });

  test("`banner.content: <img onerror=…>` (raw HTML) is refused", () => {
    const src = `---
title: t
banner:
  content: "<img src=x onerror=alert(1)>"
---
`;
    const findings = checkFrontmatter(src, "docs/x.md");
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.message).toContain("banner");
  });

  test("`hero.actions[].link: javascript:...` is refused (hero.actions itself refused)", () => {
    const src = `---
title: t
template: splash
hero:
  tagline: hi
  actions:
    - text: Click
      link: "javascript:alert(1)"
---
`;
    const findings = checkFrontmatter(src, "docs/x.md");
    const heroActions = findings.find((f) => f.message.includes("hero.actions"));
    expect(heroActions).toBeDefined();
    expect(heroActions?.message).toContain("bypasses");
  });

  test("`hero.html: <script>...</script>` is refused", () => {
    const src = `---
title: t
template: splash
hero:
  html: "<script>alert(1)</script>"
---
`;
    const findings = checkFrontmatter(src, "docs/x.md");
    const heroHtml = findings.find((f) => f.message.includes("hero.html"));
    expect(heroHtml).toBeDefined();
  });

  test("unknown top-level key is refused", () => {
    const src = `---
title: t
madeUpKey: value
---
`;
    const findings = checkFrontmatter(src, "docs/x.md");
    const finding = findings.find((f) => f.message.includes("madeUpKey"));
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("Allowed:");
  });

  test("prev.link javascript: URL is refused (scheme-checked)", () => {
    const src = `---
title: t
prev:
  label: Back
  link: "javascript:alert(1)"
---
`;
    const findings = checkFrontmatter(src, "docs/x.md");
    const finding = findings.find((f) => f.message.includes("prev.link"));
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("refused scheme");
  });

  test("hero.image.file javascript: URL is refused", () => {
    const src = `---
title: t
template: splash
hero:
  image:
    file: "javascript:alert(1)"
---
`;
    const findings = checkFrontmatter(src, "docs/x.md");
    expect(findings.some((f) => f.message.includes("refused scheme"))).toBe(true);
  });

  test("template must be splash or doc — an arbitrary string is refused", () => {
    const src = `---\ntitle: t\ntemplate: evil\n---\n`;
    const findings = checkFrontmatter(src, "docs/x.md");
    expect(findings.length).toBeGreaterThan(0);
  });
});
