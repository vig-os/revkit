// `revkit check-dist <dir>` — output-gate sanitiser, ADR-0012 defence
// in depth. Parses every built HTML with **parse5** — the WHATWG
// spec-compliant tree-construction implementation browsers use.
// Round-4 review closed the linkedom differential this used to
// depend on: linkedom parses `<title>` inside `<svg>` as RCDATA, so
// `<svg><title><img onerror=…></title></svg>` slipped past a
// linkedom-based scan, but Chromium (and parse5) parse SVG > title as
// foreign content — the inner `<img>` is a real element and fires
// on load. Walking the parse5 tree closes the class.
//
// The check remains an allowlist: only element / attribute / rel
// tokens the current Starlight + Astro + KaTeX + Vega-Lite build
// emits pass. `dist-check-allowlist.json` is the enumerated set.
// SVG element / attribute allowlist reuses the source-side
// sanitiser's exports so a single source of truth governs both
// build-time sanitisation and check-dist.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { parse as parse5Parse } from "parse5";
import type { Diagnostic } from "./diagnostics.ts";
import ALLOWLIST_JSON from "./dist-check-allowlist.json" with { type: "json" };
import { parseDataSrc } from "./data-src-format.ts";
import {
  ALLOWED_SVG_ATTRIBUTES,
  ALLOWED_SVG_ELEMENTS,
  CSS_URL_VALUE_REGEX,
  isSameDocumentFragmentRef,
  URL_BEARING_SVG_ATTRIBUTES,
} from "../../../site/src/lib/render-plot.ts";

/** Shape of the shipped allowlist. */
interface ElementEntry {
  readonly attrs: readonly string[];
  readonly attrConstraints?: Readonly<Record<string, readonly string[]>>;
}

interface AllowlistShape {
  readonly globalAttrs: readonly string[];
  readonly elements: Readonly<Record<string, ElementEntry>>;
  readonly customElements: Readonly<Record<string, ElementEntry>>;
  readonly refusedElements: readonly string[];
  readonly sha256: Readonly<Record<string, string>>;
}

const ALLOWLIST = ALLOWLIST_JSON as unknown as AllowlistShape;
const ALLOWED_HASHES: ReadonlySet<string> = new Set(Object.keys(ALLOWLIST.sha256));
const REFUSED_ELEMENTS: ReadonlySet<string> = new Set(
  ALLOWLIST.refusedElements.map((tag) => tag.toLowerCase()),
);
const GLOBAL_ATTR_NAMES: ReadonlySet<string> = new Set(
  ALLOWLIST.globalAttrs
    .filter((name) => !name.endsWith("*"))
    .map((name) => name.toLowerCase()),
);

/** Every script src must start with `/_astro/` (Astro's chunk dir). */
const ALLOWED_SCRIPT_SRC_PREFIX = "/_astro/";

/** URL attributes the DOM walk scheme-checks. */
const URL_ATTRS_HTML: ReadonlySet<string> = new Set([
  "href",
  "src",
  "srcset",
  "action",
  "formaction",
  "poster",
  "background",
  "cite",
  "usemap",
  "manifest",
  "longdesc",
  "classid",
  "codebase",
  "data",
]);

/** URL schemes that a NAVIGATION (anchor) URL may carry. Fetching
 * URL attrs (`src`, `srcset`, `href` on `<link>`, `<script>`,
 * `<img>`, `<source>`, `<video>`, `<audio>`) require same-origin —
 * an external URL there would be a subresource fetch the security
 * model refuses. Navigation attrs (`<a href>`) accept `mailto:` /
 * `tel:` / http(s):. */
const NAVIGATION_ALLOWED_SCHEMES: ReadonlySet<string> = new Set([
  "http:",
  "https:",
  "mailto:",
  "tel:",
]);

/** Element tags whose `src` / `srcset` attributes MUST resolve
 * same-origin — a subresource fetch to an external host is refused
 * regardless of scheme. `<a>` is intentionally NOT here (a link is
 * navigation, not a fetch). `<link>` is handled specially by
 * `linkElementFindings`. */
const FETCH_TAGS_SAME_ORIGIN: ReadonlySet<string> = new Set([
  "audio",
  "img",
  "picture",
  "script",
  "source",
  "track",
  "video",
]);

/** `<link>` rel tokens that fetch a subresource — if ANY of these
 * appears in `rel="..."` the href MUST be same-origin, regardless of
 * whether a metadata token also appears (round-4 review:
 * `rel="stylesheet canonical"` slipped through the metadata-first
 * check). */
const FETCHING_RELS: ReadonlySet<string> = new Set([
  "apple-touch-icon",
  "icon",
  "manifest",
  "mask-icon",
  "modulepreload",
  "preload",
  "prefetch",
  "shortcut",
  "stylesheet",
]);

/** `<link>` rel tokens whose href is metadata (canonical, alternate,
 * sitemap URL). Absolute URLs pass IFF no fetching rel is present. */
const METADATA_LINK_RELS: ReadonlySet<string> = new Set([
  "alternate",
  "canonical",
  "sitemap",
]);

/** CSS token sequences (after unescape) that must NEVER appear in a
 * `style` attribute value or an SVG URL-bearing presentation attribute.
 * `image-set`, `-webkit-image-set` and `src(` can each carry an
 * out-of-origin fetch that a `url(` refusal would miss (round-4
 * review). `url(` is handled separately below because SVG presentation
 * attributes legitimately carry `url(#fragment)`; the shared list here
 * covers every other outbound-shape refusal. */
const CSS_REFUSED_SUBSTRINGS_NON_URL: readonly string[] = [
  // Order matters: longer / more-specific tokens first so a value
  // like `image-set(url(x))` reports as `image-set(` (the outer
  // resource loader) rather than `url(` (the inner). Both would
  // refuse — the ordering only picks which one names the finding.
  "-webkit-image-set(",
  "image-set(",
  "expression(",
  "@import",
  "src(",
  "javascript:",
  "vbscript:",
];

interface Attribute {
  readonly name: string;
  readonly value: string;
  readonly prefix?: string;
  readonly namespace?: string;
}

/** parse5 splits a namespaced attribute (`xmlns:xlink`,
 * `xlink:href`) into `prefix` + `name`. Reconstruct the qualified
 * name for comparison against our lowercase allowlist entries. */
function qualifiedAttrName(attr: Attribute): string {
  return attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
}

interface ParseTreeNode {
  readonly nodeName: string;
  readonly tagName?: string;
  readonly namespaceURI?: string;
  readonly attrs?: readonly Attribute[];
  readonly childNodes?: readonly ParseTreeNode[];
  readonly value?: string;
  readonly content?: ParseTreeNode; // template content
}

interface CheckDistFinding {
  readonly file: string;
  readonly message: string;
}

/** Namespace URIs parse5 emits. */
const SVG_NS = "http://www.w3.org/2000/svg";
const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

/** Is `tagName` a custom element (contains a hyphen)? Per HTML spec,
 * a valid custom element name has at least one `-`. */
function isCustomElementTag(tagName: string): boolean {
  return tagName.includes("-") && /^[a-z]/.test(tagName);
}

/** Attribute-name predicates: `data-*` and `aria-*` are wildcards. */
function isDataAttr(name: string): boolean { return name.startsWith("data-"); }
function isAriaAttr(name: string): boolean { return name.startsWith("aria-"); }

/** Decode HTML numeric character references and strip ASCII
 * whitespace + control characters — matches url-scheme.ts's URL
 * normalization so a `&#106;avascript:` on an href is refused here
 * too. */
function decodeAndStripUrl(input: string): string {
  const decoded = input.replace(/&#(?:x([0-9a-fA-F]+)|(\d+));?/g, (_all, hex, dec) => {
    const cp = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (!Number.isFinite(cp) || cp < 0 || cp > 0x10FFFF) return "";
    try { return String.fromCodePoint(cp); } catch { return ""; }
  });
  return decoded.replace(/[\t\n\r\f\v\u0000-\u001F\u007F ]/g, "");
}

/** CSS-unescape a style attribute value: strip block comments, then
 * fold `\NN`/`\NNNNNN[ws?]` hex escapes into their code points and
 * `\<char>` into the literal char. Round-4 bypass:
 * `u\rl(https://…)` — the backslash-r escape produces `r`, so the
 * effective CSS is `url(…)`; without unescape the `url(` denylist
 * misses it. */
export function cssUnescape(input: string): string {
  const noComments = input.replace(/\/\*[\s\S]*?\*\//g, "");
  let out = "";
  let i = 0;
  while (i < noComments.length) {
    const ch = noComments[i];
    if (ch !== "\\") { out += ch; i += 1; continue; }
    const next = noComments[i + 1];
    if (next === undefined) { out += "\\"; i += 1; continue; }
    if (/[0-9a-fA-F]/.test(next)) {
      let hex = "";
      let j = i + 1;
      while (j < noComments.length && hex.length < 6 && /[0-9a-fA-F]/.test(noComments[j] ?? "")) {
        hex += noComments[j];
        j += 1;
      }
      if (j < noComments.length && /[\t\n\r\f ]/.test(noComments[j] ?? "")) j += 1;
      const cp = Number.parseInt(hex, 16);
      if (Number.isFinite(cp) && cp > 0 && cp <= 0x10FFFF) {
        try { out += String.fromCodePoint(cp); } catch { /* drop */ }
      }
      i = j;
      continue;
    }
    if (next === "\n" || next === "\r" || next === "\f") { i += 2; continue; }
    out += next;
    i += 2;
  }
  return out;
}

/** URL scheme check on an HTML attribute value. Fetching URL attrs
 * (per `FETCH_TAGS_SAME_ORIGIN`) require same-origin — a subresource
 * fetch to an external host is refused regardless of scheme. */
function isAllowedUrl(
  value: string,
  tagName: string,
  attrName: string,
  requireSameOrigin: boolean = false,
): boolean {
  const decoded = decodeAndStripUrl(value).toLowerCase();
  if (decoded.length === 0) return true;
  if (decoded.startsWith("#")) return true;
  if (decoded.startsWith("//")) return false;
  if (decoded.startsWith("/")) return true;
  const firstColon = decoded.indexOf(":");
  const firstSlash = decoded.indexOf("/");
  if (firstColon === -1) return true;
  if (firstSlash !== -1 && firstSlash < firstColon) return true;
  const scheme = decoded.slice(0, firstColon + 1);
  if (scheme === "data:" && tagName === "img" && attrName === "src") {
    return /^data:image\//.test(decoded);
  }
  const isFetchTag = FETCH_TAGS_SAME_ORIGIN.has(tagName);
  if (requireSameOrigin || isFetchTag) return false;
  return NAVIGATION_ALLOWED_SCHEMES.has(scheme);
}

/** Split a `srcset` value into candidate URLs and check each. Splits
 * on commas that separate candidates (following the img srcset
 * grammar loosely — any comma outside a `url()` counts). */
function srcsetFindings(
  tagName: string,
  value: string,
  reportPath: string,
): CheckDistFinding[] {
  const findings: CheckDistFinding[] = [];
  for (const raw of value.split(",")) {
    const candidate = raw.trim();
    if (candidate.length === 0) continue;
    // First whitespace-separated token is the URL; the rest is a
    // descriptor (density / width). Ignore the descriptor.
    const url = candidate.split(/\s+/)[0] ?? "";
    if (!isAllowedUrl(url, tagName, "srcset")) {
      findings.push({
        file: reportPath,
        message: `refused srcset candidate <${tagName} srcset=… ${JSON.stringify(url)}> — refused scheme or off-site.`,
      });
    }
  }
  return findings;
}

/** Percent-decode `input` repeatedly until stable — a nested
 * encoding like `%252e%252e` (double-encoded `..`) survives one
 * `decodeURIComponent` pass. Refuses invalid encodings by throwing;
 * a bounded loop keeps a pathological input from spinning. Round-5
 * review: `/_astro/%2e%2e/evil.js` decodes to `/_astro/../evil.js`,
 * which would then have to fail the `..`-segment check. */
export function decodeUntilStable(input: string, maxRounds: number = 8): string {
  let current = input;
  for (let i = 0; i < maxRounds; i += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      throw new Error(`invalid percent-encoding in ${JSON.stringify(input)}`);
    }
    if (next === current) return next;
    current = next;
  }
  throw new Error(`percent-encoding did not stabilise after ${maxRounds} rounds in ${JSON.stringify(input)}`);
}

/** Script src path normalization: refuse `..` segments (a `..` in
 * `/_astro/../evil.js` would still start with the allowed prefix
 * but escape the chunk directory at request time). Percent-decode
 * first so `%2e%2e` and `%252e%252e` (nested) are also caught. */
function scriptSrcRefusal(src: string): string | null {
  let decoded: string;
  try {
    decoded = decodeUntilStable(src);
  } catch (error) {
    return `refused <script src=${JSON.stringify(src)}> — ${(error as Error).message}.`;
  }
  if (!decoded.startsWith(ALLOWED_SCRIPT_SRC_PREFIX)) {
    return `refused <script src=${JSON.stringify(src)}> — script sources must be under ${JSON.stringify(ALLOWED_SCRIPT_SRC_PREFIX)} (decoded: ${JSON.stringify(decoded)}).`;
  }
  const segments = decoded.split("/");
  if (segments.some((s) => s === "..")) {
    return `refused <script src=${JSON.stringify(src)}> — path traversal (\`..\`) inside script src (decoded: ${JSON.stringify(decoded)}).`;
  }
  return null;
}

/** Compute the SHA-256 hex digest of `text`. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Walk `dir` recursively for `.html` files. */
export function walkHtml(dir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === ".html") {
        out.push(path);
      }
    }
  }
  return out.sort();
}

/** Return true when `attrName` is allowed on `<tagName>` (given the
 * per-element entry). Global attrs, wildcards, and SVG allowlist
 * inclusion pass. */
function isAttrAllowed(
  tagName: string,
  attrName: string,
  entry: ElementEntry | undefined,
  isSvg: boolean,
): boolean {
  const lower = attrName.toLowerCase();
  if (isDataAttr(lower) || isAriaAttr(lower)) return true;
  if (GLOBAL_ATTR_NAMES.has(lower)) return true;
  if (entry !== undefined && entry.attrs.some((a) => a.toLowerCase() === lower)) return true;
  if (isSvg && ALLOWED_SVG_ATTRIBUTES.has(lower)) return true;
  return false;
}

/** Attribute value constraint check. */
function attrValueConstraintFinding(
  tagName: string,
  attrName: string,
  value: string,
  entry: ElementEntry | undefined,
): string | null {
  const constraints = entry?.attrConstraints;
  if (!constraints) return null;
  const lower = attrName.toLowerCase();
  const allowed = constraints[lower];
  if (!allowed) return null;
  const tokens = value.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  const bad = tokens.filter((t) => !allowed.includes(t));
  if (bad.length === 0) return null;
  return `<${tagName} ${attrName}=${JSON.stringify(value)}> — value(s) [${bad.join(", ")}] not on allowlist [${allowed.join(", ")}].`;
}

/** Scan a CSS-shaped value (a `style=` attribute or an SVG
 * presentation attribute that can carry `url(…)`) for refused tokens.
 *
 * One scanner covers both callers, so a bypass class only has to be
 * closed once. Steps:
 *
 * 1. Unescape (`cssUnescape`) so `u\\rl(`, `\\75 rl(` and `/* … *\/url(`
 *    collapse to their effective text before we look at them. Round-4
 *    fixture: `background:u\\rl(https://evil…)`.
 * 2. Lowercase so a mixed-case `URL(` or `Url(` matches too.
 * 3. Refuse the non-URL denylist (`@import`, `expression(`,
 *    `image-set(`, `-webkit-image-set(`, `src(`, `javascript:`,
 *    `vbscript:`).
 * 4. Every `url(…)` in the (unescaped, lowercased) value must be a
 *    same-document `#fragment` reference when `allowFragmentUrl` is
 *    true (SVG presentation attrs); when false (`style=`), every
 *    `url(` is refused outright, matching the source sanitiser's
 *    "no CSS in SVG" decision (render-plot.ts).
 *
 * Returns a short descriptor for the first refused token, or null.
 * Callers build the full finding message with element context. */
function cssValueFinding(value: string, allowFragmentUrl: boolean): string | null {
  const decoded = cssUnescape(value).toLowerCase();
  for (const bad of CSS_REFUSED_SUBSTRINGS_NON_URL) {
    if (decoded.includes(bad)) {
      return `refused CSS token ${JSON.stringify(bad)} (after unescape)`;
    }
  }
  // Rebuild a fresh regex per call — a global regex remembers its
  // lastIndex between uses and would skip matches on the second call.
  const urlRegex = new RegExp(CSS_URL_VALUE_REGEX.source, CSS_URL_VALUE_REGEX.flags);
  for (const match of decoded.matchAll(urlRegex)) {
    if (!allowFragmentUrl) {
      return `refused CSS token "url(" (after unescape)`;
    }
    const inner = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!isSameDocumentFragmentRef(inner)) {
      return `refused url(${JSON.stringify(inner)}) — only same-document url(#id) refs are allowed (after unescape)`;
    }
  }
  return null;
}

/** `style` attribute value check — CSS-unescape, then look for
 * refused substrings. `style` never allows any `url(…)` (matches the
 * source sanitiser, render-plot.ts, which drops `style` entirely). */
function styleAttrFinding(tagName: string, value: string): string | null {
  const inner = cssValueFinding(value, /* allowFragmentUrl */ false);
  if (inner === null) return null;
  return `style attribute on <${tagName}> ${inner}.`;
}

/** SVG presentation attribute value check — same scanner as `style`,
 * but same-document `url(#id)` refs are allowed (Vega emits these for
 * gradient / clip / mask fills). Refuses `url(https://…)`,
 * `url(//…)`, `url(data:…)`, CSS-escaped / mixed-case / whitespace-padded
 * variants, plus the shared non-URL denylist (`@import`,
 * `image-set(`, etc.). Issue #27. */
function svgPresentationAttrFinding(
  tagName: string,
  attrName: string,
  value: string,
): string | null {
  const inner = cssValueFinding(value, /* allowFragmentUrl */ true);
  if (inner === null) return null;
  return `refused <${tagName} ${attrName}=${JSON.stringify(value)}> — ${inner}.`;
}

/** SVG `<use href=…>` / `<use xlink:href=…>` — only a same-document
 * `#fragment` reference is allowed. Browsers already refuse a
 * cross-origin `<use href>` fetch, but a same-origin absolute path or a
 * fragment-in-a-remote-svg (`url#frag`) would silently work; allowing
 * only `#fragment` matches the source sanitiser's decision
 * (render-plot.ts, `keepAttribute`). Issue #27.
 *
 * The value is percent-decoded to a fixed point first (parse5 has
 * already entity-decoded the attribute), so `%23frag` (`#frag` URL-
 * encoded) resolves the same as `#frag`. Both `href` and `xlink:href`
 * are checked when present — SVG 2 says `href` wins over `xlink:href`
 * for rendering, but a stale user agent might follow the xlink form,
 * so either one being non-fragment is a refusal. */
function useHrefFinding(rawValue: string): string | null {
  let decoded: string;
  try {
    decoded = decodeUntilStable(rawValue);
  } catch (error) {
    return (error as Error).message;
  }
  const trimmed = decoded.trim();
  if (trimmed.length === 0) return `empty href value`;
  if (!isSameDocumentFragmentRef(trimmed)) {
    return `must be a same-document #fragment reference (decoded: ${JSON.stringify(decoded)})`;
  }
  return null;
}

/** `<link>` policy handler. Rule of thumb: if `rel` contains ANY
 * fetching token, href must be same-origin (round-4 review closes the
 * `stylesheet canonical` bypass). */
function linkElementFindings(link: ParseTreeNode, findings: CheckDistFinding[], reportPath: string): void {
  const attrs = link.attrs ?? [];
  const rel = getAttr(attrs, "rel").toLowerCase();
  const href = getAttr(attrs, "href");
  if (href.length === 0) return;
  const tokens = rel.split(/\s+/).filter((t) => t.length > 0);
  const anyFetching = tokens.some((t) => FETCHING_RELS.has(t));
  const decoded = decodeAndStripUrl(href).toLowerCase();
  if (decoded.startsWith("javascript:") || decoded.startsWith("vbscript:") || decoded.startsWith("data:")) {
    findings.push({
      file: reportPath,
      message: `refused <link rel=${JSON.stringify(rel)} href=${JSON.stringify(href)}> — refused scheme.`,
    });
    return;
  }
  if (anyFetching) {
    if (!isAllowedUrl(href, "link", "href", /* requireSameOrigin */ true)) {
      findings.push({
        file: reportPath,
        message: `refused <link rel=${JSON.stringify(rel)} href=${JSON.stringify(href)}> — a fetching rel token requires same-origin href (round-4 rel-mix bypass).`,
      });
    }
    return;
  }
  // No fetching token: metadata rels (canonical, alternate, sitemap)
  // pass with an absolute URL; anything else refuses off-origin.
  const anyMetadata = tokens.some((t) => METADATA_LINK_RELS.has(t));
  if (anyMetadata) return;
  if (!isAllowedUrl(href, "link", "href", /* requireSameOrigin */ true)) {
    findings.push({
      file: reportPath,
      message: `refused <link rel=${JSON.stringify(rel)} href=${JSON.stringify(href)}> — external URL and no metadata rel.`,
    });
  }
}

/** Small helper: get attribute value by lowercase name. */
function getAttr(attrs: readonly Attribute[], name: string): string {
  for (const attr of attrs) {
    if (attr.name.toLowerCase() === name) return attr.value;
  }
  return "";
}

/** Recursively walk a parse5 tree, calling `visit` for every element
 * (skips document / text / comment nodes). Template `content` is
 * walked too — a `<template>` body carries live DOM. */
function forEachElement(node: ParseTreeNode, visit: (el: ParseTreeNode) => void): void {
  const nn = node.nodeName;
  if (nn.length > 0 && !nn.startsWith("#") && node.tagName !== undefined) {
    visit(node);
  }
  for (const child of node.childNodes ?? []) forEachElement(child, visit);
  if (node.content !== undefined) forEachElement(node.content, visit);
}

/** Scan one parsed document. */
export function scanDocument(document: ParseTreeNode, reportPath: string): CheckDistFinding[] {
  const findings: CheckDistFinding[] = [];
  forEachElement(document, (element) => {
    const rawTag = element.tagName ?? "";
    const tagName = rawTag.toLowerCase();
    const isSvg = element.namespaceURI === SVG_NS;
    const isMath = element.namespaceURI === MATHML_NS;

    if (REFUSED_ELEMENTS.has(tagName)) {
      findings.push({
        file: reportPath,
        message: `refused element <${tagName}> (on the refusedElements list).`,
      });
      return;
    }

    // Element-allowlist lookup. SVG namespaces defer to
    // ALLOWED_SVG_ELEMENTS. Custom elements go through their own
    // registry. Everything else must be in `elements`.
    let entry: ElementEntry | undefined;
    if (isSvg) {
      // parse5 preserves case for SVG (`clipPath`); allowlist is lowercase.
      if (!ALLOWED_SVG_ELEMENTS.has(tagName)) {
        findings.push({
          file: reportPath,
          message: `refused SVG element <${rawTag}> — not on the SVG allowlist (round-4: foreign-content breakout).`,
        });
        return;
      }
      // SVG attrs fall through to `isAttrAllowed(..., isSvg=true)`.
      entry = undefined;
    } else if (isCustomElementTag(tagName)) {
      entry = ALLOWLIST.customElements[tagName];
      if (!entry) {
        findings.push({
          file: reportPath,
          message: `refused custom element <${tagName}> — not on the customElements allowlist.`,
        });
        return;
      }
    } else {
      entry = ALLOWLIST.elements[tagName];
      if (!entry) {
        // MathML tags that KaTeX emits are enumerated in `elements`
        // above — anything else in the MathML namespace refuses too.
        const label = isMath ? "MathML element" : "element";
        findings.push({
          file: reportPath,
          message: `refused ${label} <${tagName}> — not on the elements allowlist.`,
        });
        return;
      }
    }

    // Attribute walk.
    for (const attr of element.attrs ?? []) {
      const attrName = qualifiedAttrName(attr);
      const attrValue = attr.value;
      const lower = attrName.toLowerCase();

      if (/^on[a-z]/.test(lower)) {
        findings.push({
          file: reportPath,
          message: `refused attribute '${attrName}' on <${tagName}> (inline event handler).`,
        });
        continue;
      }
      if (!isAttrAllowed(tagName, attrName, entry, isSvg)) {
        findings.push({
          file: reportPath,
          message: `refused attribute '${attrName}' on <${tagName}> — not on the per-element or global allowlist.`,
        });
        continue;
      }
      const constraint = attrValueConstraintFinding(tagName, attrName, attrValue, entry);
      if (constraint !== null) {
        findings.push({ file: reportPath, message: constraint });
        continue;
      }
      // srcset is per-candidate; other URL attrs go through the
      // scalar check. `<link>` defers to linkElementFindings.
      if (tagName !== "link" && URL_ATTRS_HTML.has(lower)) {
        if (lower === "srcset") {
          findings.push(...srcsetFindings(tagName, attrValue, reportPath));
        } else if (!isAllowedUrl(attrValue, tagName, lower)) {
          findings.push({
            file: reportPath,
            message: `refused URL on <${tagName} ${attrName}=${JSON.stringify(attrValue)}> — refused scheme or off-site.`,
          });
        }
      }
      if (lower === "style") {
        const styleFinding = styleAttrFinding(tagName, attrValue);
        if (styleFinding !== null) findings.push({ file: reportPath, message: styleFinding });
      }
      // `data-src` value format check — every stamped attribute
      // must parse to `<repo-relative path>:<startLine>-<endLine>`
      // with a valid path (no `..`, no absolute prefix, no `:`
      // in the path, etc). A malformed value would either fail
      // the rail's parser (a dead anchor) or point at a file
      // outside the repo (a leaked absolute path in the built
      // output). PR #38 review.
      if (lower === "data-src") {
        if (parseDataSrc(attrValue) === undefined) {
          findings.push({
            file: reportPath,
            message: `<${tagName} data-src=${JSON.stringify(attrValue)}> — value does not parse as '<repo-relative path>:<startLine>-<endLine>'.`,
          });
        }
      }
      // Issue #27: SVG presentation attributes that can carry
      // `url(…)` get the same CSS URL scan the `style` attribute
      // gets, but same-document `url(#id)` refs are allowed (Vega
      // uses these for gradient / clip fills). Any `url(https://…)`,
      // `url(//…)`, `url(data:…)` or escaped variant is refused.
      if (isSvg && URL_BEARING_SVG_ATTRIBUTES.has(lower)) {
        const svgUrlFinding = svgPresentationAttrFinding(tagName, attrName, attrValue);
        if (svgUrlFinding !== null) findings.push({ file: reportPath, message: svgUrlFinding });
      }
    }

    // Per-tag specials.
    if (tagName === "link") linkElementFindings(element, findings, reportPath);
    // Issue #27: SVG `<use>` — href / xlink:href must be a
    // same-document `#fragment`. Browsers already refuse cross-origin
    // `<use>` fetches, but a same-origin absolute path or a
    // fragment-in-a-remote-svg would silently work; allow only the
    // fragment shape, matching the source sanitiser (render-plot.ts).
    if (isSvg && tagName === "use") {
      // Both attributes are checked when present — either one being
      // a non-fragment is a refusal, regardless of the SVG 2
      // href-over-xlink:href precedence. A stale user agent might
      // follow the xlink form; a maliciously crafted document might
      // set `href="#ok"` alongside `xlink:href="https://evil…"`.
      // parse5 splits namespaced attributes into `prefix` + `name`,
      // so `xlink:href` is `{ prefix: "xlink", name: "href" }` —
      // rebuild the qualified name for the lookup.
      for (const attr of element.attrs ?? []) {
        const qualified = qualifiedAttrName(attr).toLowerCase();
        if (qualified !== "href" && qualified !== "xlink:href") continue;
        if (attr.value.length === 0) continue;
        const message = useHrefFinding(attr.value);
        if (message !== null) {
          findings.push({
            file: reportPath,
            message: `refused <use ${qualified}=${JSON.stringify(attr.value)}> — ${message}.`,
          });
        }
      }
    }
    if (tagName === "script") {
      const src = getAttr(element.attrs ?? [], "src");
      if (src.length > 0) {
        const refusal = scriptSrcRefusal(src);
        if (refusal !== null) findings.push({ file: reportPath, message: refusal });
      } else {
        // Concatenate every text child (parse5 does not merge them).
        let inline = "";
        for (const child of element.childNodes ?? []) {
          if (child.nodeName === "#text" && typeof child.value === "string") inline += child.value;
        }
        const hash = sha256Hex(inline);
        if (!ALLOWED_HASHES.has(hash)) {
          const excerpt = inline.replace(/\s+/g, " ").trim().slice(0, 80);
          findings.push({
            file: reportPath,
            message: `refused inline <script> (sha256=${hash}); add to packages/cli/src/dist-check-allowlist.json if intended. Excerpt: ${JSON.stringify(excerpt)}.`,
          });
        }
      }
    }
    // <meta http-equiv=refresh> is handled by the attrConstraints for
    // `http-equiv` — the value allowlist excludes `refresh`.
  });
  return findings;
}

/** Run check over every `.html` file under `distDir`. */
export function checkDistDirectory(distDir: string): Diagnostic[] {
  const findings: Diagnostic[] = [];
  for (const absolute of walkHtml(distDir)) {
    let html: string;
    try {
      html = readFileSync(absolute, "utf8");
    } catch (error) {
      findings.push({
        file: relative(distDir, absolute),
        line: 0,
        rule: "check-dist",
        message: `cannot read: ${(error as Error).message}`,
      });
      continue;
    }
    const doc = parse5Parse(html) as unknown as ParseTreeNode;
    for (const finding of scanDocument(doc, relative(distDir, absolute))) {
      findings.push({
        file: finding.file,
        line: 0,
        rule: "check-dist",
        message: finding.message,
      });
    }
  }
  return findings;
}

/** `--print-hashes` implementation. */
export function collectInlineScriptHashes(distDir: string): Map<string, { count: number; sample: string }> {
  const seen = new Map<string, { count: number; sample: string }>();
  for (const absolute of walkHtml(distDir)) {
    const doc = parse5Parse(readFileSync(absolute, "utf8")) as unknown as ParseTreeNode;
    forEachElement(doc, (element) => {
      if ((element.tagName ?? "").toLowerCase() !== "script") return;
      const attrs = element.attrs ?? [];
      if (getAttr(attrs, "src").length > 0) return;
      let inline = "";
      for (const child of element.childNodes ?? []) {
        if (child.nodeName === "#text" && typeof child.value === "string") inline += child.value;
      }
      const hash = sha256Hex(inline);
      const existing = seen.get(hash);
      if (existing !== undefined) existing.count += 1;
      else seen.set(hash, { count: 1, sample: inline.slice(0, 100) });
    });
  }
  return seen;
}
