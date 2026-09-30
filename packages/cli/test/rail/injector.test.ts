// Injector + bundle tests.
//
// The daemon appends the rail's script + stylesheet tags to every
// served HTML's `<head>`. We drive the injector against fixture
// HTML and assert on the resulting body. Separately, we build the
// real rail bundle with `Bun.build` and check it parses as ES
// module syntax with the expected side effect (mounts to <body>).

import { describe, expect, test } from "bun:test";
import { injectRail, RAIL_CSS_PATH, RAIL_INJECT_MAX_BYTES, RAIL_JS_PATH } from "../../src/rail/injector.ts";
import { buildRailBundle, _resetRailBundleForTests } from "../../src/rail/bundle.ts";

describe("rail injector — HTMLRewriter", () => {
  test("appends <link> and <script> tags to <head>", async () => {
    const html = "<!doctype html><html><head><title>x</title></head><body><h1>hi</h1></body></html>";
    const response = new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    const injected = await injectRail(response);
    const out = await injected.text();
    expect(out).toContain(`<script type="module" src="${RAIL_JS_PATH}"></script>`);
    expect(out).toContain(`<link rel="stylesheet" href="${RAIL_CSS_PATH}">`);
    // Original body preserved.
    expect(out).toContain("<h1>hi</h1>");
  });

  test("HTML without <head> passes through unchanged", async () => {
    const html = "<h1>fragment</h1>";
    const response = new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    const out = await (await injectRail(response)).text();
    // No <head> → no injection, but no crash either.
    expect(out).toBe("<h1>fragment</h1>");
  });

  test("drops Content-Length so the injected bytes don't get truncated", async () => {
    const html = "<!doctype html><html><head></head><body>x</body></html>";
    const response = new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8", "content-length": String(html.length) },
    });
    const injected = await injectRail(response);
    expect(injected.headers.get("content-length")).toBeNull();
    // Sanity: the body is longer than the original.
    const outLen = (await injected.text()).length;
    expect(outLen).toBeGreaterThan(html.length);
  });

  test("large body still injects (correctness — the buffer path handles multi-hundred-KB HTML)", async () => {
    const body = "<!doctype html><html><head></head><body>" + "x".repeat(200_000) + "</body></html>";
    const out = await (await injectRail(new Response(body))).text();
    expect(out).toContain(RAIL_JS_PATH);
    // Tag lands inside <head>, not appended at the end.
    expect(out.indexOf(RAIL_JS_PATH)).toBeLessThan(out.indexOf("</body>"));
  });

  test("MUTATION: a body over RAIL_INJECT_MAX_BYTES is served WITHOUT the rail (and reports oversize)", async () => {
    // Just above 8 MiB — the cap. We assemble a fake HTML page big
    // enough to trip the cap. The response must come back unchanged
    // (no `/-/rail.js` injected) AND `onOversize` fired with the
    // body size.
    const filler = "x".repeat(RAIL_INJECT_MAX_BYTES + 100);
    const body = `<!doctype html><html><head></head><body>${filler}</body></html>`;
    let reportedBytes = 0;
    const out = await injectRail(new Response(body), {
      onOversize: (bytes) => {
        reportedBytes = bytes;
      },
    });
    const outText = await out.text();
    expect(outText.length).toBeGreaterThanOrEqual(body.length);
    // Rail tags NOT present — the guard bypassed injection.
    expect(outText).not.toContain(RAIL_JS_PATH);
    expect(outText).not.toContain(RAIL_CSS_PATH);
    expect(reportedBytes).toBeGreaterThan(RAIL_INJECT_MAX_BYTES);
  });

  test("only trusted script src / stylesheet href are injected — nothing user-controllable", async () => {
    // `injectRail` composes its own tag strings from RAIL_JS_PATH /
    // RAIL_CSS_PATH constants; nothing from the caller reaches the
    // template. Sanity: assert the output contains ONLY these two
    // src/href values as URL attributes and no javascript:/data:
    // scheme, no inline onhandler, no third-party origin.
    const html = "<!doctype html><html><head></head><body></body></html>";
    const out = await (await injectRail(new Response(html))).text();
    expect(out).toMatch(new RegExp(`src="${RAIL_JS_PATH}"`));
    expect(out).toMatch(new RegExp(`href="${RAIL_CSS_PATH}"`));
    // Refused patterns must be absent — this is a bun-side XSS
    // regression net for the injector itself. The rail's own DOM
    // escaping is exercised by the Playwright roundtrip.
    expect(out).not.toMatch(/on[a-z]+=/i);
    expect(out).not.toMatch(/javascript:/i);
    expect(out).not.toMatch(/data:/i);
  });
});

describe("rail bundle — Bun.build", () => {
  test("builds a browser ES module that mentions the mount hook", async () => {
    _resetRailBundleForTests();
    const bundle = await buildRailBundle();
    expect(bundle.js.byteLength).toBeGreaterThan(0);
    expect(bundle.css.byteLength).toBeGreaterThan(0);
    const text = new TextDecoder().decode(bundle.js);
    // The bundle must at minimum reference `data-revkit-rail-mount`
    // (the mount marker) and NOT reference node: modules — the
    // browser can't load those, and their presence in the bundle
    // would mean we accidentally imported a server-only module.
    expect(text).toContain("data-revkit-rail-mount");
    expect(text).not.toContain("node:");
    // No process.env leaks either — Bun.build should tree-shake
    // any dead branches, but a static asserts guard against a
    // regression.
    expect(text).not.toContain("process.env.NODE_ENV");
  });

  test("MUTATION: bundle contains NO `eval(` / `Function(` (CSP without 'unsafe-eval')", async () => {
    // If someone reintroduces `solid-js/html` (its tagged-template
    // runtime compiles templates via `new Function(...)`) OR
    // imports another runtime template compiler, the browser
    // refuses those calls under the daemon's CSP — and this test
    // catches it BEFORE that reaches the runtime. The rail is
    // JSX-compiled at build time (see `bundle.ts` +
    // `babel-preset-solid`), so the built bundle must not carry a
    // literal `eval(` or `Function(` anywhere.
    //
    // A guard on the JS text alone is sufficient because Solid's
    // DOM-expressions runtime is emitter output: it produces
    // `template()`, `insert()`, `createComponent()` calls, never
    // `eval()` / `new Function()`. If a future dependency adds
    // one, the daemon's `script-src` (which does NOT include
    // `'unsafe-eval'`) would refuse it — this test surfaces the
    // regression at build time, one step earlier.
    _resetRailBundleForTests();
    const bundle = await buildRailBundle();
    const text = new TextDecoder().decode(bundle.js);
    const findAll = (needle: RegExp): string[] => {
      const out: string[] = [];
      for (const m of text.matchAll(needle)) {
        // 40-char excerpt for a helpful message; the match position
        // is enough to locate a regression in the built output.
        const start = Math.max(0, m.index! - 20);
        out.push(text.slice(start, m.index! + 40));
      }
      return out;
    };
    const evalHits = findAll(/\beval\s*\(/g);
    const funcHits = findAll(/\bFunction\s*\(/g);
    expect(evalHits, `bundle contains eval(): ${evalHits.join(" | ")}`).toEqual([]);
    expect(funcHits, `bundle contains Function(): ${funcHits.join(" | ")}`).toEqual([]);
  });

  test("bundle is memoised (second call returns same bytes)", async () => {
    _resetRailBundleForTests();
    const one = await buildRailBundle();
    const two = await buildRailBundle();
    expect(one.js).toBe(two.js);
  });
});
