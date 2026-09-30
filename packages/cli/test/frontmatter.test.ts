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
  test("returns kind=empty when the file has no frontmatter", () => {
    expect(extractFrontmatterBlock("# hi\n\nbody\n").kind).toBe("empty");
  });

  test("parses the yaml between the two `---` fences via Astro's parser", () => {
    const src = `---\ntitle: t\ndescription: d\n---\n\nbody\n`;
    const block = extractFrontmatterBlock(src);
    expect(block.kind).toBe("ok");
    expect(block.parsed?.title).toBe("t");
    expect(block.startLine).toBe(2);
  });
});

describe("extractFrontmatterBlock — structural refusals (round-3 bypasses)", () => {
  test("BOM before the fence is refused (Astro accepts it)", () => {
    const src = "﻿---\ntitle: t\n---\n";
    const result = extractFrontmatterBlock(src);
    expect(result.kind).toBe("structural-refusal");
    expect(result.message).toContain("BOM");
  });

  test("leading blank line before the fence is refused (Astro accepts it)", () => {
    const src = "\n---\ntitle: t\n---\n";
    const result = extractFrontmatterBlock(src);
    expect(result.kind).toBe("structural-refusal");
    expect(result.message).toContain("byte 0");
  });

  test("`+++` TOML fence is refused (Astro parses it)", () => {
    const src = "+++\ntitle = \"t\"\n+++\n";
    const result = extractFrontmatterBlock(src);
    expect(result.kind).toBe("structural-refusal");
    expect(result.message).toContain("TOML");
  });

  test("indented `---` inside a YAML block scalar does NOT close early (Astro's rule)", () => {
    // Previously our line-based extractor closed on the indented
    // `---` inside the block scalar, hiding the real payload
    // (banner.content) from the allowlist.
    const src = [
      "---",
      "title: t",
      "description: >-",
      "  paragraph with an",
      "  indented ---",
      "  fence inside it",
      "banner:",
      "  content: \"<script>alert(1)</script>\"",
      "---",
      "",
      "body",
      "",
    ].join("\n");
    const block = extractFrontmatterBlock(src);
    expect(block.kind).toBe("ok");
    // The `banner` key survives to the parsed object — proof the
    // guard sees the same block Astro would render.
    expect((block.parsed ?? {})).toHaveProperty("banner");
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

describe("checkFrontmatter — round-3 structural bypasses", () => {
  test("BOM + head[]{tag:script} is refused (BOM caught before parse)", () => {
    const src = "﻿---\nhead:\n  - tag: script\n    content: \"alert(1)\"\n---\n";
    const findings = checkFrontmatter(src, "docs/x.md");
    expect(findings.some((f) => f.message.includes("BOM"))).toBe(true);
  });

  test("leading whitespace + banner is refused (fence placement caught)", () => {
    const src = "\n---\nbanner:\n  content: \"<script>alert(1)</script>\"\n---\n";
    const findings = checkFrontmatter(src, "docs/x.md");
    expect(findings.some((f) => f.message.includes("byte 0"))).toBe(true);
  });

  test("`+++` TOML block with head is refused (TOML never reaches the allowlist)", () => {
    const src = "+++\n[[head]]\ntag = \"script\"\ncontent = \"alert(1)\"\n+++\n";
    const findings = checkFrontmatter(src, "docs/x.md");
    expect(findings.some((f) => f.message.includes("TOML"))).toBe(true);
  });

  test("round-4: hero.tagline containing an svg/title/img payload is refused (string-content check)", () => {
    // Starlight's Hero.astro renders `hero.title` / `hero.tagline`
    // through `set:html`. Even with a strict key allowlist that
    // ACCEPTS `hero.tagline`, the string content must not carry
    // markup. `<` in a frontmatter string refuses.
    const src = [
      "---",
      "title: t",
      "template: splash",
      "hero:",
      "  tagline: '<svg><title><img src=x onerror=alert(61)></title></svg>'",
      "---",
      "",
      "body",
      "",
    ].join("\n");
    const findings = checkFrontmatter(src, "docs/x.md");
    const finding = findings.find((f) => f.message.includes("contains `<`"));
    expect(finding).toBeDefined();
    expect(finding?.rule).toBe("component-registry");
  });

  test("round-4: hero.title containing `&` is refused (string-content check)", () => {
    const src = "---\ntitle: t\nhero:\n  title: 'A & B'\n---\n";
    const findings = checkFrontmatter(src, "docs/x.md");
    expect(findings.some((f) => f.message.includes("contains `<`"))).toBe(true);
  });

  test("round-4: revkitStatus containing `<script>` is refused (string-content check)", () => {
    const src = "---\ntitle: t\nrevkitStatus: '<script>alert(1)</script>'\n---\n";
    const findings = checkFrontmatter(src, "docs/x.md");
    expect(findings.some((f) => f.message.includes("contains `<`"))).toBe(true);
  });

  test("indented `---` inside block scalar does not hide a `banner` payload", () => {
    const src = [
      "---",
      "title: t",
      "description: >-",
      "  paragraph with an",
      "  indented ---",
      "  fence inside it",
      "banner:",
      "  content: \"<script>alert(1)</script>\"",
      "---",
      "",
      "body",
      "",
    ].join("\n");
    const findings = checkFrontmatter(src, "docs/x.md");
    // The line-based extractor missed this — the new extractor
    // (Astro's parser) sees `banner` and the allowlist refuses it.
    expect(findings.some((f) => f.message.includes("banner"))).toBe(true);
  });
});
