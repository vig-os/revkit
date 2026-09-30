// Unit tests for the ADR-0012 header builder (issue #22).
//
// `headers.ts` is pure; these tests drive it against fixed inputs and
// assert on the resulting Response's header set. Each guard has a
// paired MUTATION test that goes red if the corresponding directive
// is dropped or widened — the request-body of PR #22 has the table.

import { describe, expect, test } from "bun:test";
import {
  applyResponseHeaders,
  ASTRO_SCRIPTS_URL_PREFIX,
  buildCspHeader,
  hexToBase64,
  permissionsPolicyValue,
  RAIL_SCRIPT_URL_PATH,
  type HeaderContext,
} from "../../src/serve/headers.ts";

function ctxWith(overrides: Partial<HeaderContext> = {}): HeaderContext {
  return {
    port: 12345,
    inlineScriptHashes: [],
    cspHashesLoaded: true,
    ...overrides,
  };
}

/** Parse a CSP header into a directive → sources map so a test can
 * assert on one directive without eyeballing the whole string. */
function parseCsp(header: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of header.split(";").map((s) => s.trim()).filter((s) => s.length > 0)) {
    const [name, ...sources] = part.split(/\s+/);
    if (name === undefined) continue;
    out[name] = sources;
  }
  return out;
}

describe("buildCspHeader — directive shape", () => {
  test("default-src is 'none' (nothing loads without a specific directive)", () => {
    const csp = parseCsp(buildCspHeader(ctxWith()));
    expect(csp["default-src"]).toEqual(["'none'"]);
  });

  test("script-src names /-/rail.js AND /_astro/ AT the daemon origin (path-scoped)", () => {
    const csp = parseCsp(buildCspHeader(ctxWith({ port: 42421 })));
    const sources = csp["script-src"];
    expect(sources).toBeDefined();
    // Both exact-path URLs must be listed. A source without a
    // trailing slash matches exactly one URL; with a trailing slash
    // it matches any file underneath.
    expect(sources).toContain(`http://127.0.0.1:42421${RAIL_SCRIPT_URL_PATH}`);
    expect(sources).toContain(`http://127.0.0.1:42421${ASTRO_SCRIPTS_URL_PREFIX}`);
    // Never widens to a bare `'self'` (which would allow ANY script
    // under the origin) — the mutation partner below asserts the
    // opposite direction.
    expect(sources).not.toContain("'self'");
    // 'unsafe-inline' is REFUSED in script-src regardless of what
    // the site tries to ship inline. Inline scripts run only through
    // a matching sha256 source.
    expect(sources).not.toContain("'unsafe-inline'");
    // ADR-0013 amendment (2026-09-30): the rail bundle is now
    // JSX-compiled at build time with `babel-preset-solid`, so
    // there is no runtime `new Function()` / `eval()` and
    // `'unsafe-eval'` MUST NOT appear in `script-src`. If a
    // regression reintroduces the `solid-js/html` runtime, this
    // assertion flips red.
    expect(sources).not.toContain("'unsafe-eval'");
  });

  test("script-src carries the sha256 hashes from `cspHashesLoaded`", () => {
    const hex = "a".repeat(64);
    const csp = parseCsp(buildCspHeader(ctxWith({ inlineScriptHashes: [hex] })));
    const sources = csp["script-src"]!;
    // The header form uses base64 (not hex) — CSP-hash syntax.
    expect(sources).toContain(`'sha256-${hexToBase64(hex)}'`);
  });

  test("MUTATION: cspHashesLoaded=false removes hash sources (fail-closed)", () => {
    const hex = "a".repeat(64);
    const csp = parseCsp(
      buildCspHeader(ctxWith({ inlineScriptHashes: [hex], cspHashesLoaded: false })),
    );
    const sources = csp["script-src"]!;
    // No sha256- entries — the artefact is missing.
    expect(sources.some((s) => s.startsWith("'sha256-"))).toBe(false);
  });

  test("style-src includes 'unsafe-inline' (Starlight / expressive-code / KaTeX inject inline styles)", () => {
    // Not a nice-to-have: dropping this directive breaks Starlight's
    // theme toggle and the KaTeX math renderer at first paint.
    // ADR-0012 accepted the trade — styles cannot execute script,
    // so widening `style-src` does not enable XSS.
    const csp = parseCsp(buildCspHeader(ctxWith()));
    expect(csp["style-src"]).toEqual(["'self'", "'unsafe-inline'"]);
  });

  test("img-src is 'self' + data: + github avatars (ADR-0012 verbatim)", () => {
    const csp = parseCsp(buildCspHeader(ctxWith()));
    expect(csp["img-src"]).toEqual(["'self'", "data:", "https://avatars.githubusercontent.com"]);
  });

  test("connect-src covers 'self' AND the explicit ws:// origin (older browsers)", () => {
    const csp = parseCsp(buildCspHeader(ctxWith({ port: 9999 })));
    expect(csp["connect-src"]).toEqual(["'self'", "ws://127.0.0.1:9999"]);
  });

  test("navigation guards: frame-ancestors 'none', base-uri 'none', form-action 'self', object-src 'none'", () => {
    const csp = parseCsp(buildCspHeader(ctxWith()));
    expect(csp["frame-ancestors"]).toEqual(["'none'"]);
    expect(csp["base-uri"]).toEqual(["'none'"]);
    expect(csp["form-action"]).toEqual(["'self'"]);
    expect(csp["object-src"]).toEqual(["'none'"]);
  });
});

describe("hexToBase64", () => {
  test("known SHA-256 vector converts correctly", () => {
    // sha256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    // base64 of the same 32 raw bytes: 47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=
    expect(hexToBase64("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"))
      .toBe("47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=");
  });
  test("refuses non-hex input rather than emitting garbage", () => {
    expect(() => hexToBase64("not-hex-")).toThrow(/not a hex string/);
    expect(() => hexToBase64("abc")).toThrow(/not a hex string/); // odd length
  });
});

describe("permissionsPolicyValue", () => {
  test("names every high-risk feature with an empty allowlist", () => {
    const value = permissionsPolicyValue();
    // A handful of representative names — the full list is in
    // `headers.ts` and adding one shouldn't require touching this
    // test. If a name is dropped, one of these fails.
    for (const name of ["camera", "microphone", "geolocation", "payment", "usb", "publickey-credentials-get"]) {
      expect(value).toContain(`${name}=()`);
    }
  });
});

describe("applyResponseHeaders — per-kind wiring", () => {
  test("html: CSP + hygiene triplet + no Cache-Control", () => {
    const r = applyResponseHeaders(new Response("x", { status: 200 }), "html", "text/html; charset=utf-8", ctxWith());
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(r.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(r.headers.get("permissions-policy")).toContain("camera=()");
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    // HTML is not marked no-store — Starlight expects re-fetch on
    // navigation and browsers manage their own cache heuristics.
    expect(r.headers.get("cache-control")).toBeNull();
  });

  test("asset: NO CSP header, but full hygiene triplet still applied", () => {
    const r = applyResponseHeaders(new Response("x", { status: 200 }), "asset", "text/javascript; charset=utf-8", ctxWith());
    expect(r.headers.get("content-security-policy")).toBeNull();
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  test("json: nosniff + Cache-Control: no-store", () => {
    const r = applyResponseHeaders(new Response("{}", { status: 200 }), "json", "application/json; charset=utf-8", ctxWith());
    expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cache-control")).toBe("no-store");
    // No CSP on a JSON body: nothing to load.
    expect(r.headers.get("content-security-policy")).toBeNull();
  });

  test("sse: leaves an explicit Cache-Control alone (no-cache, no-transform > no-store for streams)", () => {
    const source = new Response("", {
      status: 200,
      headers: { "cache-control": "no-cache, no-transform", "content-type": "text/event-stream; charset=utf-8" },
    });
    const r = applyResponseHeaders(source, "sse", undefined, ctxWith());
    // MUTATION check: if headers.ts started overwriting Cache-Control
    // for SSE, this line flips to "no-store" and the test goes red.
    expect(r.headers.get("cache-control")).toBe("no-cache, no-transform");
  });

  test("auth: 302 Set-Cookie response is marked Cache-Control: no-store", () => {
    const source = new Response(null, {
      status: 302,
      headers: { location: "/", "set-cookie": "revkit_session_1=abc; HttpOnly" },
    });
    const r = applyResponseHeaders(source, "auth", undefined, ctxWith());
    expect(r.headers.get("cache-control")).toBe("no-store");
    // Set-Cookie survives.
    expect(r.headers.get("set-cookie")).toContain("HttpOnly");
  });
});

describe("MUTATION guards — the tests that fail if a directive is dropped", () => {
  test("MUTATION: removing default-src from the builder leaves nothing to catch script fallbacks", () => {
    // This test asserts the header CONTAINS the directive, so a
    // patch that drops the `default-src 'none'` line flips it red.
    const csp = buildCspHeader(ctxWith());
    expect(csp).toContain("default-src 'none'");
  });
  test("MUTATION: neither 'unsafe-inline' nor 'unsafe-eval' may appear in script-src", () => {
    // A regression that widened `script-src` to include
    // `'unsafe-inline'` (a plausible "just make it work" patch),
    // or that reintroduced `'unsafe-eval'` (from re-adopting the
    // `solid-js/html` runtime), must fail here. `style-src` may
    // legitimately carry `'unsafe-inline'`, so we extract the
    // script-src portion.
    const csp = buildCspHeader(ctxWith());
    const scriptSrc = parseCsp(csp)["script-src"]!.join(" ");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });
  test("MUTATION: applyResponseHeaders MUST set x-content-type-options on every response kind", () => {
    for (const kind of ["html", "asset", "json", "sse", "auth", "text"] as const) {
      const r = applyResponseHeaders(new Response(""), kind, undefined, ctxWith());
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
});
