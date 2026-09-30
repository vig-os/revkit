// Output-gate (`revkit check-dist`) tests. Round-4: the tool now
// walks a **parse5** tree (WHATWG spec-compliant), not linkedom, so
// browser-parser-differential payloads that survived the linkedom
// scan — `<svg><title><img onerror=…></title></svg>` — fail here
// because parse5 correctly parses SVG > title as foreign content
// and the inner `<img>` becomes a real HTML element (not RCDATA
// text). Every earlier round's fixtures are still tested.
import { describe, expect, test } from "bun:test";
import { parse as parse5Parse } from "parse5";
import { scanDocument, sha256Hex } from "../src/check-dist.ts";
import ALLOWLIST from "../src/dist-check-allowlist.json" with { type: "json" };

function scan(html: string) {
  const doc = parse5Parse(html);
  return scanDocument(doc as unknown as Parameters<typeof scanDocument>[0], "index.html");
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

describe("check-dist — round-4 parse5 / rel-mix / CSS-unescape / srcset / script-src fixtures", () => {
  test("h1: <svg><title><img onerror=…></title></svg> is refused (parse5 sees the foreign-content img)", () => {
    // Linkedom parses <title> inside <svg> as RCDATA text — the
    // inner <img> never appears in the DOM tree the scanner sees.
    // parse5 (WHATWG-compliant) treats svg > title as foreign
    // content, so the <img> is a real HTML element. The tag `img`
    // is on the elements allowlist but its `onerror` attribute is
    // not — the finding fires on onerror.
    const html = `<!doctype html><html><body>
      <svg><title><img src=x onerror=alert(61)></title></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("onerror"))).toBe(true);
  });

  test("h2a: style=\"background:u\\rl(https://evil…)\" is refused after CSS unescape", () => {
    // Backslash-r in CSS = literal r, so `u\rl(` tokenizes as
    // `url(`. Without CSS unescape the substring check misses it.
    const html = `<!doctype html><html><body>
      <span style="background:u\\rl(https://evil.example/x.png)">x</span>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("url("))).toBe(true);
  });

  test("h2b: <link rel=\"stylesheet canonical\" href=https://evil…> refused (fetching rel wins over metadata rel)", () => {
    // Metadata token `canonical` alone allows absolute URLs, but
    // any FETCHING token in the rel list requires same-origin.
    const html = `<!doctype html><html><head>
      <link rel="stylesheet canonical" href="https://evil.example/x.css">
    </head></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("fetching rel token"))).toBe(true);
  });

  test("mtext / math title mixed-content payload — parse5 catches the inner <img> in MathML too", () => {
    const html = `<!doctype html><html><body>
      <math><mtext><img src=x onerror=alert(1)></mtext></math>
    </body></html>`;
    const findings = scan(html);
    // mtext is on the allowlist (KaTeX emits it), but the inner
    // img's onerror is refused.
    expect(findings.some((f) => f.message.includes("onerror"))).toBe(true);
  });

  test("srcset per-candidate URL check: one bad candidate refuses the attribute", () => {
    const html = `<!doctype html><html><body>
      <img src="/ok.png" srcset="/one.png 1x, https://evil.example/two.png 2x">
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("srcset candidate"))).toBe(true);
    expect(findings.some((f) => f.message.includes("evil.example"))).toBe(true);
  });

  test("script src with `..` traversal is refused (starts with /_astro/ but escapes)", () => {
    const html = `<!doctype html><html><body>
      <script src="/_astro/../evil.js"></script>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("path traversal"))).toBe(true);
  });

  test("round-5: script src `/_astro/%2e%2e/evil.js` is refused (percent-decoded traversal)", () => {
    // %2e%2e decodes to ..; without percent-decoding the prefix
    // check would pass and the segment check would miss the
    // traversal.
    const html = `<!doctype html><html><body>
      <script src="/_astro/%2e%2e/evil.js"></script>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("path traversal"))).toBe(true);
  });

  test("round-5: nested-encoded script src (`%252e%252e`) is refused (decodeUntilStable)", () => {
    // %252e decodes to %2e, then %2e decodes to `.`. The stable
    // decode loop catches this.
    const html = `<!doctype html><html><body>
      <script src="/_astro/%252e%252e/evil.js"></script>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("path traversal"))).toBe(true);
  });

  test("round-5: invalid percent-encoding in script src is refused", () => {
    const html = `<!doctype html><html><body>
      <script src="/_astro/%zz/evil.js"></script>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("invalid percent-encoding"))).toBe(true);
  });

  test("CSS unescape: image-set(https://evil…) is refused", () => {
    const html = `<!doctype html><html><body>
      <span style="background: image-set(url('https://evil.example/x.png') 1x)">x</span>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("image-set"))).toBe(true);
  });

  test("CSS unescape: -webkit-image-set(…) refused", () => {
    const html = `<!doctype html><html><body>
      <span style="background: -webkit-image-set('x' 1x)">x</span>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("-webkit-image-set"))).toBe(true);
  });

  test("CSS unescape: hex-escape `\\75 rl(` = url(", () => {
    // \75 is 'u' in hex; \75 rl( -> url(
    const html = `<!doctype html><html><body>
      <span style="background:\\75 rl(https://evil.example/x)">x</span>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("url("))).toBe(true);
  });
});

describe("check-dist — issue #27 SVG url() presentation-attr fixtures (round 2, css-tree tokenizer)", () => {
  // Every fixture in this block is a bypass shape from issue #27
  // that pre-hardening check-dist waved through — the source
  // sanitiser (render-plot.ts) drops each one, but a hand-crafted
  // or build-tool-emitted SVG could still reach the output gate.
  //
  // Round-2 reviewer flagged three regex bypasses closed structurally
  // by the CSS Syntax Level 3 tokenizer (css-tree, shared with the
  // source sanitiser through site/src/lib/css-url-scan.ts):
  //
  //   - `url(https://evil/A.png/*);--x:'*/'` — the round-1 pre-pass
  //     stripped `/* … */`, turning the payload benign. CSS does not
  //     treat those characters as a comment inside an unquoted url().
  //   - `url(https://evil/B.png` (no closing `)`) — the regex needed
  //     `\)`; the tokenizer keeps consuming to EOF as a Url token.
  //   - `fill="url(/D.svg#g"` / `cursor='url("https://…'` — same
  //     unterminated-url class in SVG presentation attributes.
  //
  // Mutation-check anchor: deleting the URL_BEARING_SVG_ATTRIBUTES
  // walk in check-dist.ts, or the `Url` / `Function` / `BadUrl`
  // branches in scanCssForUrlRefs, regresses every assertion in
  // this block to zero findings.

  test("fill=url(https://…) is refused", () => {
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://evil.example/x.png)"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("evil.example"))).toBe(true);
    expect(findings.some((f) => f.message.includes("only same-document"))).toBe(true);
  });

  test("stroke=url(//host) is refused (protocol-relative URL)", () => {
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect stroke="url(//evil.example/x.png)"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("//evil.example"))).toBe(true);
  });

  test("cursor=url(https://…) is refused (tracker-pixel shape)", () => {
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect cursor="url(https://evil.example/pixel.png), pointer"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("evil.example"))).toBe(true);
  });

  test("clip-path=url(data:…) is refused (data URL in presentation attr)", () => {
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect clip-path="url(data:image/svg+xml,x)"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("data:"))).toBe(true);
  });

  test("mask=url(https://…#id) is refused (fragment inside a remote SVG is still a remote fetch)", () => {
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect mask="url(https://evil.example/x.svg#m)"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("evil.example"))).toBe(true);
  });

  test("marker-start=url(https://…) is refused", () => {
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><path marker-start="url(https://evil.example/m)"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("evil.example"))).toBe(true);
  });

  test("ROUND-2 unterminated url() (no closing `)`) in fill= is refused (Url token runs to EOF)", () => {
    // Reviewer bypass D: `fill="url(/D.svg#g"` — a URL token that
    // never closes. The old regex needed `\)`; the CSS Syntax Level
    // 3 tokenizer keeps consuming to EOF and emits a Url token.
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(/D.svg#g"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("D.svg"))).toBe(true);
  });

  test("ROUND-2 unterminated quoted url() in cursor= is refused (Function-token walk)", () => {
    // Reviewer bypass: `cursor='url("https://…'` — the opening
    // quote turns `url(` into a Function token whose sole String
    // argument never terminates. The walk finds a URL-shaped
    // function without the exact `<String("#id")> <)>` shape and
    // refuses.
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect cursor='url(&quot;https://evil.example'/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("url(") || f.message.includes("URL-shaped"))).toBe(true);
  });

  test("CSS-escape variant `u\\rl(https://…)` is refused (Function-name is url after escape fold)", () => {
    // css-tree tokenizes `u\rl(` as a Function token whose raw
    // name is `u\rl`; the shared scanner unescapes the name to
    // "url" and treats it as a URL-shaped function.
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect fill="u\\rl(https://evil.example/x)"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("URL-shaped"))).toBe(true);
  });

  test("hex-escape `\\75 rl(https://…)` is refused", () => {
    // \75 in CSS is 'u'; the escape fold on the function name
    // resolves it to "url".
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect fill="\\75 rl(https://evil.example/x)"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("URL-shaped"))).toBe(true);
  });

  test("mixed-case `URL(https://…)` is refused (Url token is case-insensitive)", () => {
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect fill="URL(https://evil.example/x)"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("evil.example"))).toBe(true);
  });

  test("whitespace inside `url( … )` is refused (Url token trims and consumes)", () => {
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(   https://evil.example/x   )"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("evil.example"))).toBe(true);
  });

  test("ROUND-2 CSS `/* … */` inside an unquoted url() is NOT a comment; url token includes the slash-star chars", () => {
    // Reviewer bypass A carries a fake CSS-comment-looking suffix
    // inside the url() value. The old pre-pass mistakenly stripped
    // the slash-star sequence as a CSS block comment; CSS Syntax
    // Level 3 does not recognise comment syntax inside an unquoted
    // url() value, so the tokenizer swallows every character to
    // the closing right-parenthesis and treats the whole span as
    // one Url token.
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://evil.example/A.png/*)"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("evil.example"))).toBe(true);
  });

  test("real CSS `/* comment */` BEFORE a url(#ok) is stripped by the tokenizer (positive control)", () => {
    // Real CSS block comments at the top level ARE tokens the CSS
    // tokenizer skips — `/* c */url(#ok)` still passes because
    // css-tree emits Comment + Url tokens and Url resolves to a
    // safe fragment. The bypass in the previous test is different:
    // there the `/*` sits INSIDE an unquoted url(), where CSS
    // does not recognise comment syntax.
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect fill="/* c */url(#ok)"/></svg>
    </body></html>`;
    expect(scan(html)).toEqual([]);
  });

  test("entity-encoded `&#x75;rl(https://…)` on an SVG presentation attr is refused (parse5 decodes entities before tokenize)", () => {
    // parse5 decodes HTML entities in attribute values; the scanner
    // then tokenizes the effective `url(https://…)` and refuses.
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect fill="&#x75;rl(https://evil.example/x)"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("evil.example"))).toBe(true);
  });

  test("nested url() inside image-set() is refused (URL-shaped function refuses regardless of inner url)", () => {
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect fill="image-set(url(https://evil.example/x) 1x)"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("image-set"))).toBe(true);
  });

  test("bad-url token (`url(x\")` with quote-inside) is refused", () => {
    // css-tree emits a BadUrl token when the url()'s unquoted
    // content contains a `"` or `'`. The scanner refuses BadUrl.
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://evil.example&quot;)"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("bad-url"))).toBe(true);
  });

  test("positive control: fill=url(#gradient1) is ACCEPTED (Vega's real output shape)", () => {
    // Vega emits a rect whose fill is a same-document url(#…) ref
    // for gradient marks; a scan that also refused these would
    // fail every real plot build. Swing-too-far regression guard.
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg">
        <defs><linearGradient id="gradient1"/></defs>
        <rect fill="url(#gradient1)" stroke="url(#gradient1)" clip-path="url(#clip_a)" mask="url(#m)"/>
      </svg>
    </body></html>`;
    expect(scan(html)).toEqual([]);
  });
});

describe("check-dist — issue #27 round-2 style= regressions", () => {
  // Round-2 reviewer confirmed the dev-branch `style="…url(#x)"`
  // and `style="…url(https://…)"` both refused; regressed on the
  // patch. These tests re-lock the M6 mutation the reviewer flagged.

  test("style attribute containing `url(https://…)` is refused (round-1 anchor, restored)", () => {
    const html = `<!doctype html><html><body>
      <span style="background: url(https://evil.example/x.png);">x</span>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("url"))).toBe(true);
  });

  test("style attribute containing `url(#x)` is ALSO refused (M6 mutation the reviewer flagged)", () => {
    // The source sanitiser drops `style=` entirely on SVG; check-dist
    // preserves the flat-refusal semantics for style=: no url() of
    // any kind, fragment or not.
    const html = `<!doctype html><html><body>
      <span style="background: url(#x);">x</span>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("url"))).toBe(true);
  });

  test("ROUND-2 style unterminated url() `url(https://evil/B.png` is refused", () => {
    // Reviewer bypass B: no closing `)`. The CSS Syntax Level 3
    // tokenizer keeps consuming to EOF as a Url token; the flat
    // refusal fires.
    const html = `<!doctype html><html><body>
      <div style="background:url(https://evil.example/B.png"></div>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("evil.example"))).toBe(true);
  });

  test("ROUND-2 style fake-comment trick `url(...A.png/*);--x:'*/'` is refused", () => {
    // Reviewer bypass A: CSS does NOT strip comments inside an
    // unquoted url(); the round-1 pre-pass did. With the tokenizer
    // the whole `url(https://evil/A.png/*)` is one Url token.
    const html = `<!doctype html><html><body>
      <div style="background:url(https://evil.example/A.png/*);--x:'*/'"></div>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("evil.example"))).toBe(true);
  });
});

describe("check-dist — issue #27 SVG href / xlink:href fixtures (round 2, raw check + all SVG elements)", () => {
  test("<use href=https://…> is refused (cross-origin use, tracked in #27)", () => {
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.example/lib.svg#g"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("<use"))).toBe(true);
    expect(findings.some((f) => f.message.includes("same-document"))).toBe(true);
  });

  test("<use xlink:href=https://…> is refused (xlink form still checked)", () => {
    // SVG 2 says `href` wins over `xlink:href` for rendering, but a
    // stale user agent might follow the xlink form; both attributes
    // are checked when present.
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="https://evil.example/lib.svg#g"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("<use xlink:href"))).toBe(true);
  });

  test("<use href=\"#ok\" xlink:href=https://…> is refused (both attrs checked, not just the SVG 2 precedence winner)", () => {
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use href="#ok" xlink:href="https://evil.example/lib.svg#g"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("<use xlink:href"))).toBe(true);
    expect(findings.some((f) => f.message.includes("evil.example"))).toBe(true);
  });

  test("<use href=/same-origin/path> is refused (must be #fragment, not path)", () => {
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><use href="/assets/icons.svg#pencil"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("<use href"))).toBe(true);
    expect(findings.some((f) => f.message.includes("same-document"))).toBe(true);
  });

  test("ROUND-2 <use href=%23ok> is REFUSED (browser resolves %23 as a relative path, NOT as a fragment)", () => {
    // Reviewer showed Chrome requests `/%23a` for `href="%23a"`.
    // A percent-encoded `#` never becomes a fragment; refuse.
    // Round-1 asserted this passes — inverted here.
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><use href="%23ok"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("percent-encoded"))).toBe(true);
  });

  test("ROUND-2 <use href=%25%32%33ok> (nested-encoded #) is REFUSED (percent-encoded characters refuse outright)", () => {
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><use href="%25%32%33ok"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("percent-encoded"))).toBe(true);
  });

  test("<use href=\"\"> is accepted (empty is a no-op self-reference; not an outbound fetch)", () => {
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><use href=""/></svg>
    </body></html>`;
    expect(scan(html)).toEqual([]);
  });

  test("<use href=#ok> is accepted (positive control)", () => {
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg">
        <defs><symbol id="ok"><rect/></symbol></defs>
        <use href="#ok"/>
      </svg>
    </body></html>`;
    expect(scan(html)).toEqual([]);
  });

  // ROUND-2 nit: extend the #fragment-only rule to every SVG
  // element that can carry href / xlink:href. Reviewer showed
  // `<linearGradient href="https://evil/g.svg#g">` passed round 1.
  // Only elements ON the SVG allowlist appear here — anything else
  // is refused at the element level already, and the extra href
  // check would be dead cover.
  test.each([
    "linearGradient",
    "radialGradient",
    "pattern",
    "mask",
    "clipPath",
    "marker",
    "symbol",
  ])("ROUND-2 <%s href=https://…> is refused (fragment-only rule applies to every SVG href element)", (tag) => {
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><${tag} href="https://evil.example/x.svg#g"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("evil.example"))).toBe(true);
  });
});

describe("check-dist — issue #27 round-3 nit fixtures", () => {
  // Nit 1a: mutation-check anchor for the M11 branch — turning
  // REFUSED_SCHEME_IDENTS off must regress a real test. Round-2's
  // scanner code had the check but no fixture asserted its effect.
  test("ROUND-3 fill=javascript:alert(1) is refused (M11 mutation guard — REFUSED_SCHEME_IDENTS)", () => {
    // A `javascript:` scheme in a CSS-shaped attribute value
    // tokenises as `Ident("javascript") Colon <rest>`; the scanner
    // refuses on that Ident+Colon pair. Without REFUSED_SCHEME_IDENTS
    // the whole value passes and a real browser would execute the
    // JS on any element that treats the value as a URL (SVG paint
    // servers historically did).
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect fill="javascript:alert(1)"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("javascript:"))).toBe(true);
  });

  test("ROUND-3 cursor=vbscript:x is refused (M11 mutation guard — vbscript scheme)", () => {
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect cursor="vbscript:x"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("vbscript:"))).toBe(true);
  });

  // Nit 1b: mutation-check anchor for the string-termination
  // handling around `url("…")`. Round-2's `collectSingleStringArg`
  // had a `first !== last` unterminated-string check (M9); the
  // round-3 rewrite folds this into the "next non-whitespace token
  // must be `)`" branch. A fixture that requires that terminating
  // `)` check catches both mutations at once.
  test("ROUND-3 fill=url(\"#ok\"a) is refused (extra token after quoted fragment before `)`)", () => {
    // The url() call has the right String content and a `)`, but
    // an extra Ident sits between them; the shape isn't the
    // permitted `url("#ident")` and the scanner refuses. Turning
    // off either the M9 termination check OR the "next-non-ws is
    // `)`" check regresses this fixture.
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect fill='url("#ok"a)'/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("only"))).toBe(true);
  });

  test("ROUND-3 fill=url(\"#ok\"     ) is ACCEPTED (whitespace-padded quoted fragment; positive control)", () => {
    // The permissive counterpart of the previous test: the ONE
    // allowed shape (whitespace between the closing quote and the
    // closing paren) must not regress under the terminating-`)`
    // check.
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg">
        <defs><linearGradient id="ok"/></defs>
        <rect fill='url("#ok"     )'/>
      </svg>
    </body></html>`;
    expect(scan(html)).toEqual([]);
  });

  // Nit 2: structural rule — refuse every String token that sits
  // inside a function unless it forms the exact url-with-fragment
  // shape. The round-2 scanner keyed on a small function-name
  // denylist and let the rest through, so image(), cross-fade()
  // and any made-up future function taking a URL string arg all
  // slipped past. All refuse now.
  test("ROUND-3 fill=image('https://…') is refused (structural rule)", () => {
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect fill="image('https://evil.example/x.png')"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("evil.example"))).toBe(true);
  });

  test("ROUND-3 fill=cross-fade('https://…' 50%, red) is refused (structural rule)", () => {
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect fill="cross-fade('https://evil.example/x.png' 50%, red)"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("evil.example"))).toBe(true);
  });

  test("ROUND-3 fill=foo('https://…') is refused (structural rule catches unknown functions too)", () => {
    // A future URL-shaped function name we've never heard of. The
    // structural rule refuses on the String argument alone, no
    // denylist update required.
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect fill="foo('https://evil.example/x')"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("evil.example"))).toBe(true);
  });

  // Nit 3: `href` / `xlink:href` on EVERY SVG element must be a
  // same-document `#ident` fragment. Round-2 restricted the check
  // to a subset of elements and let `<tspan href>`, `<rect href>`
  // and `<svg xlink:href>` through.
  test("ROUND-3 <tspan href=https://…> is refused (href check applies to every SVG element)", () => {
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><text><tspan href="https://evil.example/x.svg#g">x</tspan></text></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("evil.example"))).toBe(true);
  });

  test("ROUND-3 <rect href=https://…> is refused (rect isn't a traditional href element; still refused)", () => {
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect href="https://evil.example/x.svg#g"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("evil.example"))).toBe(true);
  });

  test("ROUND-3 <svg xlink:href=https://…> is refused (the root <svg> element itself)", () => {
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://evil.example/x.svg#g"><rect/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("evil.example"))).toBe(true);
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
