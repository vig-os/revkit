// The shared header policy (`@revkit/review-core/http-headers`) has zero
// imports and no host globals, because it runs in Bun AND in workerd
// (ADR-0025). That constraint forced `hexToBase64` off `Buffer`, which
// does not exist in workerd without `nodejs_compat`.
//
// "Forced off Buffer" is exactly the kind of change that quietly changes
// a value, and a wrong base64 CSP hash silently breaks every inline
// script on every page while unit tests that only assert shape stay
// green. So this test is DIFFERENTIAL: it checks the hand-written
// encoder against `Buffer.from(hex, "hex").toString("base64")` — the
// implementation it replaced — over every digest length from 1 to 64
// bytes, over both hex cases, and over the real committed allowlist.
// A byte difference here is a browser-visible regression in production
// and nothing else.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  applyResponseHeaders,
  buildCspHeader,
  buildMinimalCspHeader,
  hexToBase64,
  permissionsPolicyValue,
  type HeaderContext,
} from "../src/http-headers.ts";

/** Deterministic pseudo-random hex of `byteLength` bytes. A fixed LCG so
 * a failure reproduces exactly and the vectors do not depend on
 * `Math.random`. */
function hexOfLength(byteLength: number, seed = 1): string {
  let state = seed >>> 0;
  let hex = "";
  for (let i = 0; i < byteLength; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    hex += (state >>> 24).toString(16).padStart(2, "0");
  }
  return hex;
}

function ctxWith(overrides: Partial<HeaderContext> = {}): HeaderContext {
  return {
    scriptOrigins: ["http://127.0.0.1:8787"],
    scriptPaths: ["/-/rail.js", "/_astro/", "/pagefind/"],
    workerPaths: ["/pagefind/"],
    connectOrigins: ["ws://127.0.0.1:8787"],
    inlineScriptHashes: [],
    ...overrides,
  };
}

describe("hexToBase64 — differential against the Buffer implementation it replaced", () => {
  test("matches Buffer for every digest length 1..64 bytes, both hex cases", () => {
    for (let byteLength = 1; byteLength <= 64; byteLength++) {
      const lower = hexOfLength(byteLength, byteLength);
      expect(hexToBase64(lower)).toBe(Buffer.from(lower, "hex").toString("base64"));
      const upper = lower.toUpperCase();
      expect(hexToBase64(upper)).toBe(Buffer.from(upper, "hex").toString("base64"));
    }
  });

  test("matches Buffer on the real committed allowlist's digests", () => {
    const allowlistPath = new URL("../../cli/src/dist-check-allowlist.json", import.meta.url);
    const raw = JSON.parse(readFileSync(allowlistPath, "utf8")) as unknown;
    const hexes = collectHexDigests(raw);
    expect(hexes.length).toBeGreaterThan(0);
    for (const hex of hexes) {
      expect(hexToBase64(hex)).toBe(Buffer.from(hex, "hex").toString("base64"));
    }
  });

  test("matches Buffer on three more LCG seeds at 32 bytes (the SHA-256 length)", () => {
    for (const seed of [7, 4242, 65535]) {
      const hex = hexOfLength(32, seed);
      expect(hexToBase64(hex)).toBe(Buffer.from(hex, "hex").toString("base64"));
    }
  });

  test("a 32-byte digest is 44 base64 chars ending in one pad", () => {
    const encoded = hexToBase64(hexOfLength(32));
    expect(encoded).toHaveLength(44);
    expect(encoded.endsWith("=")).toBe(true);
    expect(encoded.endsWith("==")).toBe(false);
  });

  test("rejects what Buffer would silently accept differently: odd length and non-hex", () => {
    expect(() => hexToBase64("abc")).toThrow(/not a hex string/);
    expect(() => hexToBase64("zz")).toThrow(/not a hex string/);
    expect(() => hexToBase64("")).toThrow(/not a hex string/);
    expect(() => hexToBase64("0x11")).toThrow(/not a hex string/);
  });
});

/** Walk an arbitrary JSON value and collect every string that is a
 * hex digest of even length — as a VALUE or as an OBJECT KEY. The
 * allowlist stores its digests as keys mapping to a reviewer note, so
 * keys are where they live; shape-agnostic collection means this keeps
 * working if the file gains a wrapper or flips to an array. */
function collectHexDigests(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.length > 0 && value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value)) {
      out.push(value);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectHexDigests(item, out);
    return out;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      collectHexDigests(key, out);
      collectHexDigests(nested, out);
    }
  }
  return out;
}

describe("buildCspHeader — the policy is shared, so it is pinned here once", () => {
  function parseCsp(value: string): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const part of value.split(";")) {
      const tokens = part.trim().split(/\s+/).filter((t) => t.length > 0);
      const name = tokens.shift();
      if (name !== undefined) map.set(name, tokens);
    }
    return map;
  }

  test("carries ADR-0012's baseline directives", () => {
    const csp = parseCsp(buildCspHeader(ctxWith()));
    expect(csp.get("default-src")).toEqual(["'none'"]);
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'none'"]);
    expect(csp.get("form-action")).toEqual(["'self'"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("connect-src")).toContain("'self'");
  });

  test("script-src carries every origin x path pair in order, then wasm, then hashes", () => {
    const hash = "a".repeat(64);
    const csp = parseCsp(buildCspHeader(ctxWith({ inlineScriptHashes: [hash] })));
    const sources = csp.get("script-src") ?? [];
    expect(sources.slice(0, 3)).toEqual([
      "http://127.0.0.1:8787/-/rail.js",
      "http://127.0.0.1:8787/_astro/",
      "http://127.0.0.1:8787/pagefind/",
    ]);
    expect(sources).toContain("'wasm-unsafe-eval'");
    expect(sources[sources.length - 1]).toBe(`'sha256-${hexToBase64(hash)}'`);
  });

  test("never emits 'unsafe-eval' — ADR-0012's script-src has no eval at all", () => {
    const sources = parseCsp(buildCspHeader(ctxWith())).get("script-src") ?? [];
    expect(sources).not.toContain("'unsafe-eval'");
  });

  test("omits worker-src entirely when a surface names no worker paths", () => {
    expect(parseCsp(buildCspHeader(ctxWith({ workerPaths: [] }))).has("worker-src")).toBe(false);
  });

  test("connect-src is exactly 'self' when a surface adds no extra origins", () => {
    expect(parseCsp(buildCspHeader(ctxWith({ connectOrigins: [] }))).get("connect-src")).toEqual(["'self'"]);
  });
});

describe("buildMinimalCspHeader", () => {
  test("xml gets no sandbox, svg does", () => {
    expect(buildMinimalCspHeader("xml")).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(buildMinimalCspHeader("svg")).toBe("default-src 'none'; frame-ancestors 'none'; sandbox");
  });
});

describe("applyResponseHeaders — hygiene on every kind", () => {
  const kinds = ["html", "asset", "svg", "xml", "json", "sse", "auth", "text"] as const;

  test("every kind carries the ADR-0012 hygiene set", () => {
    for (const kind of kinds) {
      const response = applyResponseHeaders(new Response("x"), kind, undefined, ctxWith());
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(response.headers.get("permissions-policy")).toBe(permissionsPolicyValue());
    }
  });

  test("assets carry NO CSP — a restrictive one denies the worker's own fetch", () => {
    for (const kind of ["asset", "json", "sse", "auth", "text"] as const) {
      const response = applyResponseHeaders(new Response("x"), kind, undefined, ctxWith());
      expect(response.headers.get("content-security-policy")).toBeNull();
    }
  });

  test("only html/svg/xml carry a CSP at all", () => {
    const seen: Record<string, boolean> = {};
    for (const kind of kinds) {
      const response = applyResponseHeaders(new Response("x"), kind, undefined, ctxWith());
      seen[kind] = response.headers.get("content-security-policy") !== null;
    }
    expect(seen).toEqual({ html: true, asset: false, svg: true, xml: true, json: false, sse: false, auth: false, text: false });
  });

  test("json and auth are no-store; sse is left to the source", () => {
    for (const kind of ["json", "auth"] as const) {
      const response = applyResponseHeaders(new Response("x"), kind, undefined, ctxWith());
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    const sse = applyResponseHeaders(new Response("x"), "sse", undefined, ctxWith());
    expect(sse.headers.get("cache-control")).toBeNull();
  });

  test("Permissions-Policy denies the features ADR-0012's amendment names", () => {
    const value = permissionsPolicyValue();
    for (const feature of ["camera", "microphone", "geolocation", "payment", "usb", "publickey-credentials-create", "display-capture"]) {
      expect(value).toContain(`${feature}=()`);
    }
  });
});
