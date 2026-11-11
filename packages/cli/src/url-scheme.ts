// URL-scheme classifier for the component-registry rule.
//
// A `javascript:` URL that survived the guard would run when the reader
// clicked the link, so the check has to normalize the same way a
// browser's URL parser does before it looks at the scheme:
//
//   1) Decode HTML entities (`&#106;avascript:` → `javascript:`).
//   2) Strip ASCII whitespace (`\t\n\r\f ` per URL Standard) AND all
//      ASCII control characters (U+0000–U+001F, U+007F). Both are
//      ignored by browsers when parsing a URL's scheme part —
//      `\tjavascript:…` still runs script.
//   3) Lowercase the scheme (schemes are case-insensitive per RFC 3986).
//
// After normalization, a URL that starts with a refused scheme
// (`javascript:`, `data:`, `vbscript:`) is a violation. `data:` is on
// the refused list because a `data:text/html,` URL can carry inline
// script the browser will run.

/** Schemes an author must not put in a content URL. Kept as a `const`
 * set so tests assert against the same collection the rule uses. */
export const REFUSED_URL_SCHEMES: ReadonlySet<string> = new Set([
  "javascript:",
  "data:",
  "vbscript:",
]);

/** Attribute names whose value is a URL the browser would fetch or
 * navigate to. Coverage matches the HTML5/SVG spec — every attribute
 * that a `javascript:` URL could hide behind. Case-insensitive lookup;
 * the check lowercases the attribute name before consulting the set. */
export const URL_BEARING_ATTRIBUTES: ReadonlySet<string> = new Set([
  "action",
  "background",
  "cite",
  "classid",
  "codebase",
  "data",
  "formaction",
  "href",
  "longdesc",
  "manifest",
  "poster",
  "src",
  "srcset",
  "usemap",
  "xlink:href",
]);

/** Decode `&#NNN;` / `&#xHH;` numeric character references. Named
 * entities (`&amp;` etc.) are not decoded — none of them produces a
 * scheme character that survives the subsequent strip / lowercase, so
 * the shorter regex is enough. */
function decodeNumericEntities(input: string): string {
  return input.replace(/&#(?:x([0-9a-fA-F]+)|(\d+));?/g, (_all, hex, dec) => {
    const codePoint = hex !== undefined
      ? Number.parseInt(hex, 16)
      : Number.parseInt(dec, 10);
    if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10FFFF) return "";
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return "";
    }
  });
}

/** Strip ASCII whitespace and ASCII control characters (the WHATWG URL
 * parser removes both from the URL prefix before it reads the scheme). */
function stripWhitespaceAndControls(input: string): string {
  return input.replace(/[\t\n\r\f\v\u0000-\u001F\u007F ]/g, "");
}

/** Normalize a candidate URL and check whether it starts with any
 * refused scheme. `null` = not a string (an expression value that
 * evaluated to a number or object — refuse those as URL values too, but
 * the caller reports that separately). */
export function isRefusedUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const decoded = decodeNumericEntities(value);
  const stripped = stripWhitespaceAndControls(decoded);
  const lower = stripped.toLowerCase();
  for (const scheme of REFUSED_URL_SCHEMES) {
    if (lower.startsWith(scheme)) return true;
  }
  return false;
}
