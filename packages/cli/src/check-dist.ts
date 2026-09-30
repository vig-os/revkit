// `revkit check-dist <dir>` — output-gate sanitiser, ADR-0012 defence
// in depth. Parses every built HTML file with linkedom (the same DOM
// parser the site's SVG sanitiser uses, so no parser differential
// between this tool and the source-side guards) and applies an
// **allowlist**: only element names / attributes we know the current
// Starlight + Astro + KaTeX + Vega-Lite build emits pass, everything
// else refuses.
//
// Denylist mode lost to parser differentials in round-3 review
// (`<noscript><p title="</noscript><img …onerror=…>">`,
// `<svg><a><animate attributeName=href values=javascript:…>`), so
// this rewrite consults `dist-check-allowlist.json` — the file
// enumerates every element / attribute the current build emits, plus
// the SHA-256 hashes of every inline script. A regression that
// introduces `<iframe>`, `<noscript>` or an `animate` element fails
// the guard because none of them is on the list — no matter how the
// payload is packaged.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { parseHTML } from "linkedom";
import type { Diagnostic } from "./diagnostics.ts";
import ALLOWLIST_JSON from "./dist-check-allowlist.json" with { type: "json" };
import {
  ALLOWED_SVG_ATTRIBUTES,
  ALLOWED_SVG_ELEMENTS,
} from "../../../site/src/lib/render-plot.ts";

/** Shape of the shipped allowlist. `elements` and `customElements`
 * carry a per-tag attr list; `globalAttrs` applies to every element;
 * `refusedElements` names tag names we refuse even if a future
 * upgrade emits them; `sha256` maps inline-script hashes to their
 * feature label. */
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

/** Attribute-name predicates: `data-*` and `aria-*` are wildcards
 * (globalAttrs lists them literally with the `*` suffix but the
 * predicate has to match every real attribute one at a time). */
function isDataAttr(name: string): boolean {
  return name.startsWith("data-");
}
function isAriaAttr(name: string): boolean {
  return name.startsWith("aria-");
}

/** Build the fixed set of global attribute names, minus the wildcards
 * (which the predicate handles). */
const GLOBAL_ATTR_NAMES: ReadonlySet<string> = new Set(
  ALLOWLIST.globalAttrs
    .filter((name) => !name.endsWith("*"))
    .map((name) => name.toLowerCase()),
);

/** Every script src must start with `/_astro/` (Astro's chunk dir). */
const ALLOWED_SCRIPT_SRC_PREFIX = "/_astro/";

/** URL attributes on HTML elements — the DOM-side URL check runs on
 * these AND enforces same-origin (starts with `/`) OR one of the
 * scheme allowlist below. */
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

/** URL schemes an HTML URL attribute may use. Same-origin (starts
 * with `/` or a bare relative path) is checked separately. */
const ALLOWED_URL_SCHEMES: ReadonlySet<string> = new Set([
  "http:",
  "https:",
  "mailto:",
  "tel:",
]);

/** CSS token sequences that must NEVER appear in a `style` attribute
 * value (they can smuggle a URL fetch, an import, or IE-era JS). */
const CSS_REFUSED_SUBSTRINGS: readonly string[] = ["url(", "@import", "expression(", "javascript:", "vbscript:"];

/** Minimal DOM projections. */
interface DomAttribute {
  readonly name: string;
  readonly value: string;
}

interface DomElement {
  readonly tagName?: string;
  readonly namespaceURI?: string | null;
  readonly attributes?: { readonly length: number; readonly [index: number]: DomAttribute };
  readonly textContent?: string;
  getAttribute?(name: string): string | null;
}

interface DomDocument {
  querySelectorAll(selector: string): Iterable<DomElement>;
}

interface CheckDistFinding {
  readonly file: string;
  readonly message: string;
}

/** Is `tagName` a custom element (contains a hyphen)? Per HTML spec,
 * a valid custom element name has at least one `-` and starts with
 * an ASCII letter. */
function isCustomElementTag(tagName: string): boolean {
  return tagName.includes("-") && /^[a-z]/.test(tagName);
}

/** Tags whose URL attrs must ALWAYS resolve same-origin in the
 * generic URL walk. `<script>` is one (its src is checked with the
 * stricter `/_astro/` prefix in the script-specific handler too).
 * `<link>` is NOT here — its href policy is owned by
 * `linkElementFindings` so metadata rels (canonical / alternate) can
 * carry an absolute URL. */
const SAME_ORIGIN_ONLY_TAGS: ReadonlySet<string> = new Set(["script"]);

/** Tags where the generic URL walk should skip and defer to a
 * per-tag handler. `<link>` — its rel value determines whether the
 * href may be absolute (metadata) or must be same-origin (fetching). */
const URL_CHECK_DEFERRED_TAGS: ReadonlySet<string> = new Set(["link"]);

/** URL scheme check on an HTML attribute. Same-origin (leading `/`
 * or scheme-less relative path) passes for most tags; SAME_ORIGIN_
 * ONLY_TAGS and `requireSameOrigin` refuse any scheme. Fragment-only
 * (`#foo`) and empty are fine everywhere. javascript / data /
 * vbscript refuse everywhere; `data:image/…` on `<img src>` is the
 * only exception. */
function isAllowedUrl(
  value: string,
  tagName: string,
  attrName: string,
  requireSameOrigin: boolean = false,
): boolean {
  const decoded = decodeAndStrip(value).toLowerCase();
  if (decoded.length === 0) return true;
  if (decoded.startsWith("#")) return true;
  if (decoded.startsWith("/")) {
    // Protocol-relative (`//host/…`) is scheme-carrying too — refuse.
    if (decoded.startsWith("//")) return false;
    return true;
  }
  // A scheme-less relative path (`../foo`, `./x.png`, `foo/bar`) is
  // fine everywhere. Detect by "no colon before the first slash".
  const firstColon = decoded.indexOf(":");
  const firstSlash = decoded.indexOf("/");
  if (firstColon === -1) return true;
  if (firstSlash !== -1 && firstSlash < firstColon) return true;
  const scheme = decoded.slice(0, firstColon + 1);
  // `<img src="data:image/…">` is the ONE data-URL exception
  // (Starlight ships inline SVG icons this way).
  if (scheme === "data:" && tagName === "img" && attrName === "src") {
    return /^data:image\//.test(decoded);
  }
  // Same-origin-only: any scheme (including http/https) refuses.
  if (requireSameOrigin || SAME_ORIGIN_ONLY_TAGS.has(tagName)) return false;
  return ALLOWED_URL_SCHEMES.has(scheme);
}

/** Normalize a URL string the same way `url-scheme.ts` does — HTML
 * entity decode, strip ASCII whitespace + control chars. Kept inline
 * so this module has no extra dep (and the check is exhaustive). */
function decodeAndStrip(input: string): string {
  const decoded = input.replace(/&#(?:x([0-9a-fA-F]+)|(\d+));?/g, (_all, hex, dec) => {
    const cp = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (!Number.isFinite(cp) || cp < 0 || cp > 0x10FFFF) return "";
    try { return String.fromCodePoint(cp); } catch { return ""; }
  });
  return decoded.replace(/[\t\n\r\f\v\u0000-\u001F\u007F ]/g, "");
}

/** Compute SHA-256 hex of `text`. */
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

/** Is `attrName` allowed on `<tagName>`? Global attrs pass; per-tag
 * entries pass; wildcards (data-*, aria-*) pass. Everything else
 * fails and the caller emits a diagnostic. */
function isAttrAllowed(tagName: string, attrName: string, entry: ElementEntry | undefined): boolean {
  const lower = attrName.toLowerCase();
  if (isDataAttr(lower) || isAriaAttr(lower)) return true;
  if (GLOBAL_ATTR_NAMES.has(lower)) return true;
  if (entry !== undefined && entry.attrs.some((a) => a.toLowerCase() === lower)) return true;
  // SVG child elements — reuse the sanitiser's attribute allowlist
  // so a single source of truth governs which SVG attrs survive.
  if (ALLOWED_SVG_ELEMENTS.has(tagName) && ALLOWED_SVG_ATTRIBUTES.has(lower)) return true;
  return false;
}

/** Check per-attribute value constraints (e.g. `<link rel>` must be
 * one of the allowed relation types). Returns a refusal message when
 * the value is not on the constraint list; `null` when it passes or
 * the attribute has no constraint. */
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
  // Multi-value attrs (`rel="a b"`) — each token must be allowed.
  const tokens = value.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  const bad = tokens.filter((t) => !allowed.includes(t));
  if (bad.length === 0) return null;
  return `<${tagName} ${attrName}=${JSON.stringify(value)}> — value(s) [${bad.join(", ")}] not on allowlist [${allowed.join(", ")}].`;
}

/** CSS-content check for `style` attribute values. */
function styleAttrFinding(tagName: string, value: string): string | null {
  const lowered = decodeAndStrip(value).toLowerCase();
  for (const bad of CSS_REFUSED_SUBSTRINGS) {
    if (lowered.includes(bad)) {
      return `style attribute on <${tagName}> contains refused CSS token ${JSON.stringify(bad)}.`;
    }
  }
  return null;
}

/** `<link>` rel values whose href is metadata (a canonical URL, an
 * alternate-page pointer), NOT a resource fetched by the page. These
 * are allowed to be absolute so a page's canonical URL stays
 * absolute. */
const METADATA_LINK_RELS: ReadonlySet<string> = new Set([
  "canonical",
  "alternate",
  "sitemap",
]);

/** Special-case handler for <link> — same-origin href for fetching
 * rels (stylesheet/preload/icon/…); absolute URL allowed only when
 * `rel` is one of the metadata rels above. `dns-prefetch` /
 * `prefetch` external hosts still refuse. */
function linkElementFindings(link: DomElement, findings: CheckDistFinding[], reportPath: string): void {
  const rel = (link.getAttribute?.("rel") ?? "").toLowerCase();
  const href = link.getAttribute?.("href") ?? "";
  if (href.length === 0) return;
  // Metadata rels: absolute URL passes only when the scheme is
  // http(s) (not javascript / data / vbscript, which the generic
  // check already refuses).
  if (rel.split(/\s+/).some((token) => METADATA_LINK_RELS.has(token))) {
    const decoded = decodeAndStrip(href).toLowerCase();
    if (decoded.startsWith("javascript:") || decoded.startsWith("data:") || decoded.startsWith("vbscript:")) {
      findings.push({
        file: reportPath,
        message: `refused <link rel=${JSON.stringify(rel)} href=${JSON.stringify(href)}> — refused scheme in metadata link.`,
      });
    }
    return;
  }
  // Fetching rels (stylesheet, preload, icon, prefetch, modulepreload,
  // manifest, apple-touch-icon, mask-icon): href must be same-origin.
  if (!isAllowedUrl(href, "link", "href", /* requireSameOrigin */ true)) {
    findings.push({
      file: reportPath,
      message: `refused <link rel=${JSON.stringify(rel)} href=${JSON.stringify(href)}> — external URL or refused scheme.`,
    });
  }
}

/** Scan one HTML document. */
export function scanDocument(document: DomDocument, reportPath: string): CheckDistFinding[] {
  const findings: CheckDistFinding[] = [];
  for (const element of Array.from(document.querySelectorAll("*"))) {
    const tagName = (element.tagName ?? "").toLowerCase();

    // 1) Explicitly refused element names — a browser-attack-surface
    //    anchor even if not needed by allowlist logic.
    if (REFUSED_ELEMENTS.has(tagName)) {
      findings.push({
        file: reportPath,
        message: `refused element <${tagName}> (on the refusedElements list).`,
      });
      continue;
    }

    // 2) Element must be on one of the allowlists. Custom elements
    //    live in a separate registry.
    let entry: ElementEntry | undefined = ALLOWLIST.elements[tagName];
    if (!entry && isCustomElementTag(tagName)) {
      entry = ALLOWLIST.customElements[tagName];
      if (!entry) {
        findings.push({
          file: reportPath,
          message: `refused custom element <${tagName}> — not on the customElements allowlist.`,
        });
        continue;
      }
    } else if (!entry && !ALLOWED_SVG_ELEMENTS.has(tagName)) {
      findings.push({
        file: reportPath,
        message: `refused element <${tagName}> — not on the elements allowlist.`,
      });
      continue;
    }

    // 3) Attribute walk: name allowlist, value constraints, URL
    //    scheme check for URL-bearing attrs, style-attr CSS check.
    const attributes = element.attributes;
    if (attributes) {
      for (let i = 0; i < attributes.length; i += 1) {
        const attr = attributes[i] as DomAttribute | undefined;
        if (!attr) continue;
        const attrName = attr.name;
        const attrValue = attr.value;
        const lower = attrName.toLowerCase();

        // Inline event handlers refuse regardless of allowlist (belt +
        // suspenders): on* is not in the global set and not in any
        // entry.attrs, so this is duplicative — but the message is
        // more specific and worth surfacing.
        if (/^on[a-z]/.test(lower)) {
          findings.push({
            file: reportPath,
            message: `refused attribute '${attrName}' on <${tagName}> (inline event handler).`,
          });
          continue;
        }

        if (!isAttrAllowed(tagName, attrName, entry)) {
          findings.push({
            file: reportPath,
            message: `refused attribute '${attrName}' on <${tagName}> — not on the per-element or global allowlist.`,
          });
          continue;
        }

        const constraintFinding = attrValueConstraintFinding(tagName, attrName, attrValue, entry);
        if (constraintFinding !== null) {
          findings.push({ file: reportPath, message: constraintFinding });
          continue;
        }

        if (URL_ATTRS_HTML.has(lower) && !URL_CHECK_DEFERRED_TAGS.has(tagName)) {
          if (!isAllowedUrl(attrValue, tagName, lower)) {
            findings.push({
              file: reportPath,
              message: `refused URL on <${tagName} ${attrName}=${JSON.stringify(attrValue)}> — refused scheme or off-site.`,
            });
            continue;
          }
        }

        if (lower === "style") {
          const styleFinding = styleAttrFinding(tagName, attrValue);
          if (styleFinding !== null) {
            findings.push({ file: reportPath, message: styleFinding });
          }
        }
      }
    }

    // 4) Per-tag specials.
    if (tagName === "link") linkElementFindings(element, findings, reportPath);
    if (tagName === "script") {
      const src = element.getAttribute?.("src");
      if (src !== null && src !== undefined) {
        if (!src.startsWith(ALLOWED_SCRIPT_SRC_PREFIX)) {
          findings.push({
            file: reportPath,
            message: `refused <script src=${JSON.stringify(src)}> — script sources must be under ${JSON.stringify(ALLOWED_SCRIPT_SRC_PREFIX)}.`,
          });
        }
      } else {
        const inline = element.textContent ?? "";
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
  }
  return findings;
}

/** Run the check over every `.html` file under `distDir`. */
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
    const { document } = parseHTML(html);
    for (const finding of scanDocument(document as unknown as DomDocument, relative(distDir, absolute))) {
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

/** `--print-hashes` implementation: enumerate every distinct inline
 * script hash in the dir so a maintainer can seed / update
 * `dist-check-allowlist.json`. */
export function collectInlineScriptHashes(distDir: string): Map<string, { count: number; sample: string }> {
  const seen = new Map<string, { count: number; sample: string }>();
  for (const absolute of walkHtml(distDir)) {
    const { document } = parseHTML(readFileSync(absolute, "utf8"));
    const scriptDoc = document as unknown as DomDocument;
    for (const script of Array.from(scriptDoc.querySelectorAll("script"))) {
      if (script.getAttribute?.("src")) continue;
      const inline = script.textContent ?? "";
      const hash = sha256Hex(inline);
      const existing = seen.get(hash);
      if (existing !== undefined) existing.count += 1;
      else seen.set(hash, { count: 1, sample: inline.slice(0, 100) });
    }
  }
  return seen;
}
