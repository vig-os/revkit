// Output-gate (`revkit check-dist`) tests. Round-4: the tool now
// walks a **parse5** tree (WHATWG spec-compliant), not linkedom, so
// browser-parser-differential payloads that survived the linkedom
// scan — `<svg><title><img onerror=…></title></svg>` — fail here
// because parse5 correctly parses SVG > title as foreign content
// and the inner `<img>` becomes a real HTML element (not RCDATA
// text). Every earlier round's fixtures are still tested.
import { describe, expect, test } from "bun:test";
import { parse as parse5Parse } from "parse5";
import { cssUnescape, scanDocument, sha256Hex } from "../src/check-dist.ts";
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

describe("check-dist — issue #27 SVG url() presentation-attr fixtures", () => {
  // Every fixture in this block is a bypass shape from issue #27
  // that pre-hardening check-dist waved through — the source
  // sanitiser (render-plot.ts) drops each one, but a hand-crafted or
  // build-tool-emitted SVG could still reach the output gate.
  //
  // Mutation-check anchor: deleting the URL_BEARING_SVG_ATTRIBUTES
  // walk in check-dist.ts (or the fresh-regex `for (…) of
  // decoded.matchAll(…)` loop inside `cssValueFinding`) makes every
  // assertion in this block regress to zero findings, so a future
  // refactor that drops the scan trips loudly instead of silently.
  //
  // Each fixture asserts a specific bypass surface — no test just
  // checks "some finding fires". Positive controls at the end of the
  // block prove legitimate `url(#fragment)` refs and `<use
  // href="#id">` are NOT refused (guards against a swing-too-far
  // regression that would also reject Vega's real output).

  test("fill=url(https://…) is refused (external URL in presentation attr)", () => {
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

  test("cursor=url(https://…) is refused (tracker-pixel shape from issue #27)", () => {
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect cursor="url(https://evil.example/pixel.png), pointer"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("evil.example"))).toBe(true);
  });

  test("clip-path=url(data:…) is refused (data URL in presentation attr)", () => {
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect clip-path="url(data:image/svg+xml,<svg/>)"/></svg>
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

  test("CSS-escape variant `u\\rl(https://…)` is refused after cssUnescape", () => {
    // Backslash-r in CSS = literal r, so `u\rl(` tokenizes as `url(`.
    // Without cssUnescape the url regex would not fire on the raw
    // attribute value.
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect fill="u\\rl(https://evil.example/x)"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("evil.example"))).toBe(true);
  });

  test("hex-escape `\\75 rl(https://…)` is refused after cssUnescape", () => {
    // \75 in CSS is 'u' — `\75 rl(` unescapes to `url(`.
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect fill="\\75 rl(https://evil.example/x)"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("evil.example"))).toBe(true);
  });

  test("mixed-case `URL(https://…)` is refused (lowercased before scan)", () => {
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect fill="URL(https://evil.example/x)"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("evil.example"))).toBe(true);
  });

  test("whitespace inside `url( … )` is refused (regex tolerates padding)", () => {
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(   https://evil.example/x   )"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("evil.example"))).toBe(true);
  });

  test("CSS comment inside a presentation attr is stripped, then url() refused", () => {
    // `cssUnescape` strips `/* … */` block comments before it runs
    // the escape fold, so `/* c */url(https://…)` collapses to
    // `url(https://…)` and refuses.
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect fill="/* c */url(https://evil.example/x)"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("evil.example"))).toBe(true);
  });

  test("entity-encoded `&#x75;rl(https://…)` on an SVG presentation attr is refused (parse5 decodes entities)", () => {
    // parse5 decodes HTML entities in attribute values, so the
    // scanner sees the effective `url(https://…)` even though the
    // source had an encoded 'u'.
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect fill="&#x75;rl(https://evil.example/x)"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("evil.example"))).toBe(true);
  });

  test("nested url() inside image-set() is refused (image-set token fires first)", () => {
    // image-set() itself is an out-of-origin fetcher — a value like
    // `image-set(url(x))` refuses at the outer token so the finding
    // names the more-specific loader (round-4 ordering guarantee).
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><rect fill="image-set(url(https://evil.example/x) 1x)"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("image-set"))).toBe(true);
  });

  test("positive control: fill=url(#gradient1) is ACCEPTED (Vega's real output shape)", () => {
    // Vega emits a rect whose fill is a same-document url(#…) ref
    // for gradient marks; a scan that also refused these would fail
    // every real plot build. This is the guard against a
    // swing-too-far regression.
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg">
        <defs><linearGradient id="gradient1"/></defs>
        <rect fill="url(#gradient1)" stroke="url(#gradient1)" clip-path="url(#clip_a)" mask="url(#m)"/>
      </svg>
    </body></html>`;
    expect(scan(html)).toEqual([]);
  });
});

describe("check-dist — issue #27 SVG <use href> fixtures", () => {
  test("<use href=https://…> is refused (cross-origin use, tracked in #27)", () => {
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.example/lib.svg#g"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("<use"))).toBe(true);
    expect(findings.some((f) => f.message.includes("same-document"))).toBe(true);
  });

  test("<use xlink:href=https://…> is refused (xlink form still checked)", () => {
    // A stale user agent might follow the xlink form even when
    // SVG 2 says `href` wins, so a non-fragment `xlink:href` refuses
    // regardless of what `href` says.
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="https://evil.example/lib.svg#g"/></svg>
    </body></html>`;
    const findings = scan(html);
    expect(findings.some((f) => f.message.includes("<use xlink:href"))).toBe(true);
  });

  test("<use href=\"#ok\" xlink:href=https://…> is refused (both attrs checked, not just the SVG 2 precedence winner)", () => {
    // Precedence guard: an attacker sets `href="#ok"` to satisfy a
    // scanner that only checks the SVG 2 winner and hides the
    // outbound URL in `xlink:href`. Both attributes are checked, so
    // this refuses on the xlink form.
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

  test("<use href=%23ok> is accepted after percent-decoding (%23 is the URL-encoded #)", () => {
    // decodeUntilStable folds %23 → #; the fragment identifier is
    // structurally the same as href="#ok", so the check passes.
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><use href="%23ok"/></svg>
    </body></html>`;
    expect(scan(html)).toEqual([]);
  });

  test("<use href=%25%32%33ok> (nested-encoded #) is accepted (decodeUntilStable loops until fixed point)", () => {
    // %25%32%33 → %23 → #. The stable-decode loop mirrors the
    // script-src round-5 behaviour so a nested-encoded attack shape
    // is normalised before the check.
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><use href="%25%32%33ok"/></svg>
    </body></html>`;
    expect(scan(html)).toEqual([]);
  });

  test("<use href=\"\"> is refused (empty is not a #fragment)", () => {
    const html = `<!doctype html><html><body>
      <svg xmlns="http://www.w3.org/2000/svg"><use href=""/></svg>
    </body></html>`;
    // Empty attribute value doesn't reach useHrefFinding (length ==
    // 0 short-circuits). This test documents that intended behavior —
    // an empty href is a no-op reference, not an outbound one.
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
});

describe("cssUnescape", () => {
  test("backslash-r produces literal r", () => {
    expect(cssUnescape("u\\rl(")).toBe("url(");
  });

  test("hex escape with trailing space consumes the space", () => {
    expect(cssUnescape("\\75 rl(")).toBe("url(");
  });

  test("hex escape without trailing space", () => {
    expect(cssUnescape("\\000075rl(")).toBe("url(");
  });

  test("block comments are stripped before unescape", () => {
    expect(cssUnescape("/* u */url(")).toBe("url(");
  });

  test("backslash at end of input passes through as backslash", () => {
    expect(cssUnescape("abc\\")).toBe("abc\\");
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
