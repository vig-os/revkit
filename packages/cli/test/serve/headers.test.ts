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
  buildMinimalCspHeader,
  hexToBase64,
  PAGEFIND_URL_PREFIX,
  permissionsPolicyValue,
  RAIL_SCRIPT_URL_PATH,
  type HeaderContext,
} from "../../src/serve/headers.ts";

function ctxWith(overrides: Partial<HeaderContext> = {}): HeaderContext {
  return {
    port: 12345,
    inlineScriptHashes: [],
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

  test("script-src names /-/rail.js AND /_astro/ AND /pagefind/ for BOTH loopback aliases", () => {
    const csp = parseCsp(buildCspHeader(ctxWith({ port: 42421 })));
    const sources = csp["script-src"];
    expect(sources).toBeDefined();
    // Both aliases (127.0.0.1 and localhost) x three path prefixes.
    for (const origin of ["http://127.0.0.1:42421", "http://localhost:42421"]) {
      expect(sources).toContain(`${origin}${RAIL_SCRIPT_URL_PATH}`);
      expect(sources).toContain(`${origin}${ASTRO_SCRIPTS_URL_PREFIX}`);
      expect(sources).toContain(`${origin}${PAGEFIND_URL_PREFIX}`);
    }
    // Never widens to a bare `'self'` (which would allow ANY script
    // under the origin) — the mutation partner below asserts the
    // opposite direction.
    expect(sources).not.toContain("'self'");
    expect(sources).not.toContain("'unsafe-inline'");
    // `'unsafe-eval'` (arbitrary JS eval) is refused. The narrow
    // `'wasm-unsafe-eval'` is intentional — pagefind's Worker
    // compiles a .wasm blob.
    expect(sources).not.toContain("'unsafe-eval'");
    expect(sources).toContain("'wasm-unsafe-eval'");
  });

  test("script-src carries the sha256 hashes from `inlineScriptHashes` (base64-encoded)", () => {
    const hex = "a".repeat(64);
    const csp = parseCsp(buildCspHeader(ctxWith({ inlineScriptHashes: [hex] })));
    const sources = csp["script-src"]!;
    expect(sources).toContain(`'sha256-${hexToBase64(hex)}'`);
  });

  test("empty inlineScriptHashes → no sha256 sources (no artefact = no inline allowance)", () => {
    // With the shipped `dist-check-allowlist.json` set the daemon
    // uses in production this array is non-empty; here we prove the
    // header builder emits ZERO `sha256-…` sources when the set is
    // empty — the fail-closed shape.
    const csp = parseCsp(buildCspHeader(ctxWith({ inlineScriptHashes: [] })));
    const sources = csp["script-src"]!;
    expect(sources.some((s) => s.startsWith("'sha256-"))).toBe(false);
  });

  test("style-src includes 'unsafe-inline' (Starlight / expressive-code / KaTeX inject inline styles)", () => {
    // ADR-0012 accepted the trade — styles cannot execute script.
    const csp = parseCsp(buildCspHeader(ctxWith()));
    expect(csp["style-src"]).toEqual(["'self'", "'unsafe-inline'"]);
  });

  test("worker-src is path-scoped to /pagefind/ on BOTH loopback aliases (M2 item 5b: closes the 'any Worker' hole)", () => {
    const csp = parseCsp(buildCspHeader(ctxWith({ port: 42421 })));
    // Path-scope means: only pages under `/pagefind/` may become a
    // Worker script. `worker-src 'self'` (the previous shape) would
    // let a stored HTML instantiate `new Worker("/-/anything.js")`.
    expect(csp["worker-src"]).toEqual([
      "http://127.0.0.1:42421/pagefind/",
      "http://localhost:42421/pagefind/",
    ]);
    // Sanity: the bare 'self' keyword is gone — a mutation that
    // widens it back would trip this.
    expect(csp["worker-src"]).not.toContain("'self'");
  });

  test("img-src is 'self' + data: + github avatars (ADR-0012 verbatim)", () => {
    const csp = parseCsp(buildCspHeader(ctxWith()));
    expect(csp["img-src"]).toEqual(["'self'", "data:", "https://avatars.githubusercontent.com"]);
  });

  test("connect-src covers 'self' AND both explicit ws:// aliases (older browsers)", () => {
    const csp = parseCsp(buildCspHeader(ctxWith({ port: 9999 })));
    expect(csp["connect-src"]).toEqual(["'self'", "ws://127.0.0.1:9999", "ws://localhost:9999"]);
  });

  test("navigation guards: frame-ancestors 'none', base-uri 'none', form-action 'self', object-src 'none'", () => {
    const csp = parseCsp(buildCspHeader(ctxWith()));
    expect(csp["frame-ancestors"]).toEqual(["'none'"]);
    expect(csp["base-uri"]).toEqual(["'none'"]);
    expect(csp["form-action"]).toEqual(["'self'"]);
    expect(csp["object-src"]).toEqual(["'none'"]);
  });

  test("BYTE-EXACT: the emitted header string matches the pinned form (mutation guard on the whole header)", () => {
    // A hex hash and its exact base64 form — pinned so a change in
    // `hexToBase64`'s output goes red here as well.
    const hex = "1cbb968b5e6d5421bb29ba088f699949436448c3a5bd060192062fce0a172aa9";
    const b64 = "HLuWi15tVCG7KboIj2mZSUNkSMOlvQYBkgYvzgoXKqk=";
    expect(hexToBase64(hex)).toBe(b64);
    const value = buildCspHeader({ port: 4321, inlineScriptHashes: [hex] });
    const expected =
      "default-src 'none'; " +
      "script-src " +
        "http://127.0.0.1:4321/-/rail.js " +
        "http://127.0.0.1:4321/_astro/ " +
        "http://127.0.0.1:4321/pagefind/ " +
        "http://localhost:4321/-/rail.js " +
        "http://localhost:4321/_astro/ " +
        "http://localhost:4321/pagefind/ " +
        "'wasm-unsafe-eval' " +
        `'sha256-${b64}'; ` +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: https://avatars.githubusercontent.com; " +
      "font-src 'self'; " +
      "connect-src 'self' ws://127.0.0.1:4321 ws://localhost:4321; " +
      "worker-src http://127.0.0.1:4321/pagefind/ http://localhost:4321/pagefind/; " +
      "frame-ancestors 'none'; " +
      "base-uri 'none'; " +
      "form-action 'self'; " +
      "object-src 'none'";
    expect(value).toBe(expected);
  });
});

describe("buildMinimalCspHeader — SVG + XML (documents that can run script when opened directly)", () => {
  test("XML: default-src 'none' + frame-ancestors 'none'", () => {
    expect(buildMinimalCspHeader("xml")).toBe("default-src 'none'; frame-ancestors 'none'");
  });

  test("SVG gets `sandbox` as well (ADR-0012: SVG can carry <script>, sandbox denies it)", () => {
    expect(buildMinimalCspHeader("svg")).toBe("default-src 'none'; frame-ancestors 'none'; sandbox");
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
    for (const name of ["camera", "microphone", "geolocation", "payment", "usb", "publickey-credentials-get"]) {
      expect(value).toContain(`${name}=()`);
    }
  });
});

describe("applyResponseHeaders — per-kind wiring", () => {
  test("html: FULL CSP + hygiene triplet + no Cache-Control", () => {
    const r = applyResponseHeaders(new Response("x", { status: 200 }), "html", "text/html; charset=utf-8", ctxWith());
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(r.headers.get("content-security-policy")).toContain("script-src ");
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

  test("asset: NO CSP header (browser applies embedding doc's CSP; Workers keep their own fetch)", () => {
    const r = applyResponseHeaders(new Response("x", { status: 200 }), "asset", "text/javascript; charset=utf-8", ctxWith());
    expect(r.headers.get("content-security-policy")).toBeNull();
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  test("svg: MINIMAL CSP with `sandbox` appended", () => {
    const r = applyResponseHeaders(new Response("<svg/>", { status: 200 }), "svg", "image/svg+xml", ctxWith());
    expect(r.headers.get("content-security-policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'; sandbox",
    );
  });

  test("xml: MINIMAL CSP (no sandbox — sitemap.xml is a document but has no untrusted-upload posture)", () => {
    const r = applyResponseHeaders(new Response("<?xml?>", { status: 200 }), "xml", "application/xml; charset=utf-8", ctxWith());
    expect(r.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
  });

  test("json: NO CSP header + nosniff + Cache-Control: no-store", () => {
    const r = applyResponseHeaders(new Response("{}", { status: 200 }), "json", "application/json; charset=utf-8", ctxWith());
    expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-security-policy")).toBeNull();
  });

  test("sse: leaves an explicit Cache-Control alone (no-cache, no-transform > no-store for streams)", () => {
    const source = new Response("", {
      status: 200,
      headers: { "cache-control": "no-cache, no-transform", "content-type": "text/event-stream; charset=utf-8" },
    });
    const r = applyResponseHeaders(source, "sse", undefined, ctxWith());
    expect(r.headers.get("cache-control")).toBe("no-cache, no-transform");
  });

  test("auth: 302 Set-Cookie response is marked Cache-Control: no-store", () => {
    const source = new Response(null, {
      status: 302,
      headers: { location: "/", "set-cookie": "revkit_session_1=abc; HttpOnly" },
    });
    const r = applyResponseHeaders(source, "auth", undefined, ctxWith());
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("set-cookie")).toContain("HttpOnly");
  });
});

describe("MUTATION guards — the tests that fail if a directive is dropped or widened", () => {
  test("MUTATION: removing default-src from the builder leaves nothing to catch script fallbacks", () => {
    const csp = buildCspHeader(ctxWith());
    expect(csp).toContain("default-src 'none'");
  });
  test("MUTATION: neither 'unsafe-inline' nor 'unsafe-eval' may appear in script-src", () => {
    // `style-src` may legitimately carry `'unsafe-inline'`, so we
    // extract the script-src portion. `'wasm-unsafe-eval'` is
    // intentional (pagefind) and is NOT `'unsafe-eval'`.
    const csp = buildCspHeader(ctxWith());
    const scriptSrc = parseCsp(csp)["script-src"]!.join(" ");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    // Regex boundary catches `'unsafe-eval'` but not `'wasm-unsafe-eval'`.
    expect(/(?:^|\s)'unsafe-eval'(?:\s|$)/.test(scriptSrc)).toBe(false);
  });
  test("MUTATION: applyResponseHeaders MUST set x-content-type-options on every response kind", () => {
    for (const kind of ["html", "asset", "svg", "xml", "json", "sse", "auth", "text"] as const) {
      const r = applyResponseHeaders(new Response(""), kind, undefined, ctxWith());
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
  test("MUTATION: document-shaped kinds carry a CSP; asset/JSON/text kinds do NOT (Worker fetch would break)", () => {
    // Split by kind: HTML gets the full policy; SVG and XML get
    // the minimal one (plus optional sandbox on SVG); every other
    // kind (asset, json, sse, auth, text) omits the CSP header.
    const withCsp = ["html", "svg", "xml"] as const;
    const withoutCsp = ["asset", "json", "sse", "auth", "text"] as const;
    for (const kind of withCsp) {
      const r = applyResponseHeaders(new Response(""), kind, undefined, ctxWith());
      expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    }
    for (const kind of withoutCsp) {
      const r = applyResponseHeaders(new Response(""), kind, undefined, ctxWith());
      expect(r.headers.get("content-security-policy")).toBeNull();
    }
  });
});
