// URL-scheme classifier tests — the bypass surface a browser accepts
// is what a security-minded reviewer would try. `isRefusedUrl` MUST
// match every trick the browser matches, and REFUSE_URL_SCHEMES must
// include the three schemes (`javascript:`, `data:`, `vbscript:`)
// each of which can carry executable content.
import { describe, expect, test } from "bun:test";
import {
  REFUSED_URL_SCHEMES,
  URL_BEARING_ATTRIBUTES,
  isRefusedUrl,
} from "../src/url-scheme.ts";

describe("REFUSED_URL_SCHEMES", () => {
  test("includes exactly javascript:, data: and vbscript:", () => {
    expect(new Set(REFUSED_URL_SCHEMES)).toEqual(new Set([
      "javascript:",
      "data:",
      "vbscript:",
    ]));
  });
});

describe("URL_BEARING_ATTRIBUTES", () => {
  test("covers href, src, action, formaction, xlink:href, poster, srcset", () => {
    for (const name of ["href", "src", "action", "formaction", "xlink:href", "poster", "srcset"]) {
      expect(URL_BEARING_ATTRIBUTES.has(name)).toBe(true);
    }
  });
});

describe("isRefusedUrl", () => {
  test("plain javascript: URL is refused", () => {
    expect(isRefusedUrl("javascript:alert(1)")).toBe(true);
  });

  test("uppercase JAVASCRIPT: is refused (case-insensitive)", () => {
    expect(isRefusedUrl("JAVASCRIPT:alert(1)")).toBe(true);
  });

  test("leading tab / newline / whitespace before javascript: is refused (browsers ignore it)", () => {
    expect(isRefusedUrl("\tjavascript:alert(1)")).toBe(true);
    expect(isRefusedUrl("\njavascript:alert(1)")).toBe(true);
    expect(isRefusedUrl("   javascript:alert(1)")).toBe(true);
  });

  test("interior tab (`java\\tscript:`) is refused (control chars stripped)", () => {
    expect(isRefusedUrl("java\tscript:alert(1)")).toBe(true);
  });

  test("HTML-entity-encoded `&#106;avascript:` is refused after decoding", () => {
    expect(isRefusedUrl("&#106;avascript:alert(1)")).toBe(true);
  });

  test("hex-entity `&#x6a;avascript:` is refused after decoding", () => {
    expect(isRefusedUrl("&#x6a;avascript:alert(1)")).toBe(true);
  });

  test("data:text/html is refused (data: is on the list)", () => {
    expect(isRefusedUrl("data:text/html,<script>alert(1)</script>")).toBe(true);
  });

  test("vbscript: is refused", () => {
    expect(isRefusedUrl("vbscript:MsgBox 1")).toBe(true);
  });

  test("plain http: / https: / mailto: / relative paths are NOT refused", () => {
    expect(isRefusedUrl("https://example.com/x")).toBe(false);
    expect(isRefusedUrl("http://example.com/x")).toBe(false);
    expect(isRefusedUrl("mailto:me@example.com")).toBe(false);
    expect(isRefusedUrl("/foo/bar")).toBe(false);
    expect(isRefusedUrl("./sibling.md")).toBe(false);
  });

  test("non-string values are not URLs — return false", () => {
    expect(isRefusedUrl(123 as unknown as string)).toBe(false);
    expect(isRefusedUrl({} as unknown as string)).toBe(false);
    expect(isRefusedUrl(null as unknown as string)).toBe(false);
  });
});
