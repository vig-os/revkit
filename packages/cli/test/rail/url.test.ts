// `revkitUrl` resolver (#245 part 1 round 3, DECISION c).
//
// Two kinds of test:
//
//   1. Unit tests on the resolver itself, driven through
//      `readBaseMeta(doc)` with a stub `document` so the function
//      works without a browser.
//   2. A static check on the SOURCE of every browser-side bundle:
//      no root-absolute API / SSE / asset path may appear outside
//      a `revkitUrl(...)` call. The brief's bullet (c) spells this
//      out — a test that fails if a client bundle contains a
//      root-absolute `/api`, `/events`, `/-/` path outside the
//      helper. The previous shape (body rewriting on serve) missed
//      template literals; the new shape must be discoverable at
//      build time.
//
// The static check runs on SOURCE (`rail/rail.tsx`,
// `ask-page/ask-page.tsx`) rather than the built bundle because
// `Bun.build` renames `revkitUrl` to a single-character identifier,
// after which the pattern "function name before the literal" is
// unstable. Source tells the whole truth: every literal is either
// inside a comment, inside a `revkitUrl(` call, or a regression.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_META_NAME, readBaseMeta, revkitUrl } from "../../src/rail/url.ts";

/** Stub the slice of the DOM `readBaseMeta` reads. The helper's
 * production path uses `document`, which Bun's test runtime does
 * not provide — passing a stub keeps the unit tests pure. */
function docWith(content: string | null): {
  querySelector: (selector: string) => { getAttribute: (name: string) => string | null } | null;
} {
  return {
    querySelector: (selector: string) => {
      if (selector !== `meta[name="${BASE_META_NAME}"]`) return null;
      if (content === null) return null;
      return {
        getAttribute: (name: string) => (name === "content" ? content : null),
      };
    },
  };
}

describe("readBaseMeta", () => {
  test("missing meta → '/' (root deployment / local daemon)", () => {
    expect(readBaseMeta(docWith(null))).toBe("/");
  });

  test("meta with trailing slash is returned verbatim", () => {
    expect(readBaseMeta(docWith("/review/"))).toBe("/review/");
  });

  test("meta without trailing slash is normalised to end in /", () => {
    expect(readBaseMeta(docWith("/review"))).toBe("/review/");
  });

  test("an empty / non-slash value falls back to '/'", () => {
    expect(readBaseMeta(docWith(""))).toBe("/");
    expect(readBaseMeta(docWith("review"))).toBe("/");
  });
});

describe("revkitUrl", () => {
  // The helper caches the base on module load, so these tests
  // exercise the SHIPPED cached value (no meta tag outside the
  // browser → '/' root). Deep-test the active prefix path via
  // `readBaseMeta` above, which is pure.
  test("under the root deployment (no meta), a root-absolute path is identity", () => {
    expect(revkitUrl("/api/threads")).toBe("/api/threads");
    expect(revkitUrl("/api/threads/abc/replies")).toBe("/api/threads/abc/replies");
    expect(revkitUrl("/events?since=0")).toBe("/events?since=0");
    expect(revkitUrl("/-/health")).toBe("/-/health");
  });

  test("protocol-relative URLs are passed through unchanged", () => {
    expect(revkitUrl("//cdn.example/x.js")).toBe("//cdn.example/x.js");
  });

  test("relative paths are passed through unchanged", () => {
    expect(revkitUrl("api/threads")).toBe("api/threads");
    expect(revkitUrl("")).toBe("");
  });
});

describe("browser-side source — every root-absolute /api, /events, /-/ literal is a revkitUrl() arg", () => {
  // The brief's bullet (c) static check: anywhere the rail or the
  // ask-page bundle opens a root-absolute URL, it MUST go through
  // `revkitUrl(...)`. The helper's own `url.ts` is the one
  // exception (its DEFAULT_BASE / `startsWith("//")` guards carry
  // no API path).
  //
  // We walk each source once per non-blank, non-comment line.
  // Every URL literal `"/api…" | '/api…' | `/api…`` (or events,
  // `/-/`) must be preceded, on the same line, by `revkitUrl(`.
  // The injector lives in a separate file and emits its prefixed
  // paths through string concat (`${basePath}${RAIL_JS_PATH}`),
  // not through this helper — so we don't include it here.
  const HERE = dirname(fileURLToPath(import.meta.url));
  const RAIL_SRC = resolve(HERE, "../../src/rail/rail.tsx");
  const ASK_SRC = resolve(HERE, "../../src/ask-page/ask-page.tsx");

  /** Strip block + line comments from TS/TSX source. The scanner
   * uses a single pass that respects strings (so `"//"` inside a
   * string literal is not treated as a comment start). It is NOT
   * a full tokeniser — we accept one known limitation: a regex
   * literal containing `//` would be falsely stripped. The two
   * source files under test contain no such regex, so this is
   * fine; if that changes a stricter scanner replaces this one. */
  function stripComments(source: string): string {
    let out = "";
    let i = 0;
    const n = source.length;
    while (i < n) {
      const c = source[i];
      const next = source[i + 1];
      // Block comment.
      if (c === "/" && next === "*") {
        const end = source.indexOf("*/", i + 2);
        if (end === -1) break;
        // Keep newlines inside the comment so line numbers in
        // diagnostics line up with the original source.
        for (let k = i; k < end + 2; k++) {
          if (source[k] === "\n") out += "\n";
        }
        i = end + 2;
        continue;
      }
      // Line comment.
      if (c === "/" && next === "/") {
        const end = source.indexOf("\n", i + 2);
        if (end === -1) break;
        i = end;
        continue;
      }
      // String / template literal — skip to the matching close so
      // a `//` or `/*` inside a string is not treated as a
      // comment.
      if (c === '"' || c === "'" || c === "`") {
        const quote = c;
        out += c;
        i++;
        while (i < n) {
          const q = source[i];
          if (q === "\\") {
            // Pass through the next character unchanged.
            out += q;
            if (i + 1 < n) {
              out += source[i + 1];
              i += 2;
              continue;
            }
            i++;
            continue;
          }
          out += q;
          if (q === quote) {
            i++;
            break;
          }
          // Template-literal interpolation: scan into `${…}` with
          // depth tracking so a comment inside an interpolation
          // is still stripped. The URL scanner does not need to
          // see inside interpolations, so we treat them as
          // opaque.
          if (quote === "`" && q === "$" && source[i + 1] === "{") {
            let depth = 1;
            i += 2;
            out += "{";
            while (i < n && depth > 0) {
              const d = source[i];
              if (d === "{") depth++;
              if (d === "}") depth--;
              out += d;
              i++;
            }
            continue;
          }
          i++;
        }
        continue;
      }
      out += c;
      i++;
    }
    return out;
  }

  function scan(filePath: string): string[] {
    const sourceRaw = readFileSync(filePath, "utf8");
    const source = stripComments(sourceRaw);
    // Literal with a leading `/api`, `/events` or `/-/`. Each
    // quote kind is matched separately so a stray `}` inside a
    // template literal is not swallowed into a `"…"` match.
    const literalRe = /(["'`])(\/(?:api|events|-)[^"'`]*?)\1/g;
    const bad: string[] = [];
    for (const match of source.matchAll(literalRe)) {
      const literal = match[2];
      const openQuoteOffset = match.index!;
      // Look backwards up to 48 chars for `revkitUrl(` so a
      // multi-line call (opening paren on the previous line)
      // still matches.
      const prev = source.slice(Math.max(0, openQuoteOffset - 48), openQuoteOffset);
      if (!/revkitUrl\s*\(\s*$/.test(prev)) {
        const lineNumber = source.slice(0, openQuoteOffset).split("\n").length;
        bad.push(`${filePath}:${lineNumber}: ${literal}`);
      }
    }
    return bad;
  }

  test("rail.tsx carries no un-helpered root-absolute paths", () => {
    const bad = scan(RAIL_SRC);
    expect(
      bad,
      bad.length === 0
        ? ""
        : "Root-absolute URL literals not routed through revkitUrl():\n" + bad.join("\n"),
    ).toEqual([]);
  });

  test("ask-page.tsx carries no un-helpered root-absolute paths", () => {
    const bad = scan(ASK_SRC);
    expect(
      bad,
      bad.length === 0
        ? ""
        : "Root-absolute URL literals not routed through revkitUrl():\n" + bad.join("\n"),
    ).toEqual([]);
  });
});
