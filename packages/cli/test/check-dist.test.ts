// Output-gate (`revkit check-dist`) tests. The tool is an ALLOWLIST
// now (round-3 review), so a payload that survived a denylist —
// `<noscript>…</noscript>` shielding a `<img onerror>`, or a
// `<svg><a><animate attributeName=href values=javascript:…>`
// activation — fails here because neither `noscript` nor `animate`
// is on the elements allowlist.
import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { scanDocument, sha256Hex } from "../src/check-dist.ts";
import ALLOWLIST from "../src/dist-check-allowlist.json" with { type: "json" };

function scan(html: string) {
  const { document } = parseHTML(html);
  return scanDocument(document as unknown as Parameters<typeof scanDocument>[0], "index.html");
}

describe("check-dist — clean pages", () => {
  test("a page with only allowlisted elements + a same-origin script passes", () => {
    const html = `<!doctype html><html lang="en"><head><title>t</title></head><body>
      <h1>hi</h1>
      <p>paragraph</p>
      <script src="/_astro/foo.js"></script>
    </body></html>`;
    expect(scan(html)).toEqual([]);
  });

  test("<link rel=\"shortcut icon\"> is accepted (both tokens on the rel allowlist)", () => {
    const html = `<!doctype html><html><head>
      <link rel="shortcut icon" href="/favicon.ico" type="image/x-icon">
    </head></html>`;
    expect(scan(html)).toEqual([]);
  });
});

describe("check-dist — refused elements", () => {
  test.each([
    "iframe", "object", "embed", "base", "form", "noscript", "style",
    "animate", "animatemotion", "animatetransform", "set", "audio",
    "video", "canvas", "template",
  ])("refused element <%s>", (tag) => {
    // template is on the elements allowlist (Starlight uses it) EXCEPT
    // when it appears without the id attribute Starlight sets. But our
    // per-element check runs even for allowlisted elements, so a bare
    // <template> with no attributes still parses fine. Skip the
    // template case if it's on the allowlist.
    if (tag === "template" && (ALLOWLIST as { elements: Record<string, unknown> }).elements.template) return;
    const html = `<!doctype html><html><body><${tag}></${tag}></body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes(`<${tag}>`))).toBe(true);
  });

  test("<noscript> hiding an <img onerror> is refused at the noscript level", () => {
    // Round-3 payload — Chromium's parser lets the string inside a
    // <noscript title> escape to become live DOM.
    const html = `<!doctype html><html><body>
      <noscript><p title="</noscript><img src=x onerror=alert(41)>"></p></noscript>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("<noscript>"))).toBe(true);
  });

  test("<svg><a><animate attributeName=href values=javascript:...>` refused", () => {
    // Round-3 payload — animate fires an href swap on click. animate
    // is not on the SVG allowlist (rendered by render-plot.ts's
    // ALLOWED_SVG_ELEMENTS), so it fails as "not on the elements
    // allowlist".
    const html = `<!doctype html><html><body>
      <svg><a><animate attributeName="href" values="javascript:alert(43)"/></a></svg>
    </body></html>`;
    const findings = scan(html);
    // Either "not on the elements allowlist" OR "on the
    // refusedElements list" — the message names <animate>.
    expect(findings.some((f) => f.message.includes("<animate>"))).toBe(true);
  });

  test("<form action=...> is refused", () => {
    const html = `<!doctype html><html><body>
      <form action="/submit"><input name="x"/></form>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("<form>"))).toBe(true);
  });
});

describe("check-dist — refused attributes / URL schemes", () => {
  test("inline event handler on an allowed element is refused", () => {
    const html = `<!doctype html><html><body>
      <a href="/x" onclick="alert(1)">click</a>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("onclick"))).toBe(true);
  });

  test("attribute not on the per-element or global allowlist is refused", () => {
    const html = `<!doctype html><html><body>
      <a href="/x" formaction="/y">click</a>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("formaction"))).toBe(true);
  });

  test("javascript: URL in href refused", () => {
    const html = `<!doctype html><html><body>
      <a href="javascript:alert(1)">click</a>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("refused URL"))).toBe(true);
  });

  test("HTML-entity-encoded javascript: URL refused after decoding", () => {
    const html = `<!doctype html><html><body>
      <a href="&#106;avascript:alert(1)">x</a>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("refused URL"))).toBe(true);
  });

  test("data:image/png on <img src> passes (Starlight uses inline SVG icons)", () => {
    const html = `<!doctype html><html><body>
      <img src="data:image/png;base64,iVBORw0KGgo=" alt="icon">
    </body></html>`;
    expect(scan(html)).toEqual([]);
  });

  test("data:text/html on <img src> refused (only image/* allowed)", () => {
    const html = `<!doctype html><html><body>
      <img src="data:text/html,<script>alert(1)</script>" alt="x">
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("refused URL"))).toBe(true);
  });
});

describe("check-dist — CSS style attribute policy", () => {
  test("safe geometry CSS (`height: 1em`, `top: 0.5em`) passes", () => {
    // KaTeX emits values like this on many spans.
    const html = `<!doctype html><html><body>
      <span style="height:1em;top:0.5em;">x</span>
    </body></html>`;
    expect(scan(html)).toEqual([]);
  });

  test("style attribute containing `url(...)` is refused", () => {
    const html = `<!doctype html><html><body>
      <span style="background: url(https://evil.example/x.png);">x</span>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("url("))).toBe(true);
  });

  test("style attribute containing `@import` is refused", () => {
    const html = `<!doctype html><html><body>
      <span style="@import 'https://evil.example/x.css';">x</span>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("@import"))).toBe(true);
  });

  test("style attribute containing `expression(` (IE-era JS) is refused", () => {
    const html = `<!doctype html><html><body>
      <span style="width: expression(alert(1));">x</span>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("expression("))).toBe(true);
  });
});

describe("check-dist — <link> policy", () => {
  test("<link rel=stylesheet href=/x.css> passes (same-origin)", () => {
    const html = `<!doctype html><html><head>
      <link rel="stylesheet" href="/x.css">
    </head></html>`;
    expect(scan(html)).toEqual([]);
  });

  test("<link rel=stylesheet href=https://evil...> refused (external URL)", () => {
    const html = `<!doctype html><html><head>
      <link rel="stylesheet" href="https://evil.example/x.css">
    </head></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("<link"))).toBe(true);
    expect(findings.some((f) => f.message.toLowerCase().includes("external") || f.message.includes("refused"))).toBe(true);
  });

  test("<link rel=dns-prefetch> refused (dns-prefetch not on the rel allowlist)", () => {
    const html = `<!doctype html><html><head>
      <link rel="dns-prefetch" href="//evil.example">
    </head></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.toLowerCase().includes("dns-prefetch"))).toBe(true);
  });

  test("<link rel=preload href=https://evil...> refused (off-site preload)", () => {
    const html = `<!doctype html><html><head>
      <link rel="preload" href="https://evil.example/x.js" as="script">
    </head></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("<link"))).toBe(true);
  });
});

describe("check-dist — scripts", () => {
  test("<script src> pointing outside /_astro/ refused", () => {
    const html = `<!doctype html><html><body>
      <script src="https://evil.example/x.js"></script>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("/_astro/"))).toBe(true);
  });

  test("inline <script> whose hash is off-list refused", () => {
    const html = `<!doctype html><html><body>
      <script>alert(1)</script>
    </body></html>`;
    const findings = scan(html);
    const inline = findings.find((f) => f.message.includes("inline <script>"));
    expect(inline).toBeDefined();
    expect(inline?.message).toContain(sha256Hex("alert(1)"));
  });
});

describe("check-dist — <meta http-equiv> policy", () => {
  test("<meta http-equiv=refresh> refused (not on the http-equiv allowlist)", () => {
    const html = `<!doctype html><html><head>
      <meta http-equiv="refresh" content="0;url=https://evil.example">
    </head></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.toLowerCase().includes("refresh"))).toBe(true);
  });

  test("<meta http-equiv=content-security-policy> passes", () => {
    const html = `<!doctype html><html><head>
      <meta http-equiv="Content-Security-Policy" content="default-src 'self'">
    </head></html>`;
    expect(scan(html)).toEqual([]);
  });
});

describe("check-dist — allowlist file integrity", () => {
  test("every SHA-256 in the allowlist is 64 hex chars", () => {
    for (const key of Object.keys((ALLOWLIST as { sha256: Record<string, string> }).sha256)) {
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("every element entry has an attrs array", () => {
    for (const [tag, entry] of Object.entries((ALLOWLIST as { elements: Record<string, { attrs?: unknown }> }).elements)) {
      expect(Array.isArray(entry.attrs)).toBe(true);
      // Tag names must be lowercase — case-sensitivity matters on
      // the lookup path.
      expect(tag).toBe(tag.toLowerCase());
    }
  });

  test("refusedElements includes noscript, animate, form (round-3 anchors)", () => {
    const refused = new Set((ALLOWLIST as { refusedElements: readonly string[] }).refusedElements);
    for (const tag of ["noscript", "animate", "form", "iframe", "object", "embed", "base"]) {
      expect(refused.has(tag)).toBe(true);
    }
  });
});
