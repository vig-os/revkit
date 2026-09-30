// `revkit check-dist <dir>` — output-gate sanitiser, ADR-0012 defence
// in depth. Parses every built HTML file with a real DOM parser
// (linkedom — the same one site/src/lib/rehype-katex-strict.ts and
// the SVG sanitiser use, so a parser differential between the
// source-side check and the browser can not silently open the door
// the source guards close) and refuses:
//
//   - `on*` attributes on any element (inline event handlers).
//   - `javascript:`, `data:`, `vbscript:` on any URL-bearing attr.
//     `data:image/…` on `<img src>` is the ONLY data-URL allowed
//     (Starlight ships a couple of inline SVG icons this way).
//   - `<script src>` whose src is not under `/_astro/`, and inline
//     `<script>` whose SHA-256 is not in
//     `dist-check-allowlist.json` (the file lists every hash the
//     current Starlight/Astro build is known to emit and names the
//     feature each one comes from).
//   - `<iframe>`, `<object>`, `<embed>`, `<base>`,
//     `<meta http-equiv="refresh">`.
//   - External stylesheets — `<link rel="stylesheet">` whose href
//     leaves the origin (`http:`, `https:`, `//`).
//
// The output shape mirrors `revkit check`: one diagnostic per finding,
// `file:line: rule: message`, exit 1 on any finding. `line` is 0
// because linkedom does not preserve source lines through parseHTML.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { parseHTML } from "linkedom";
import type { Diagnostic } from "./diagnostics.ts";
import { REFUSED_URL_SCHEMES, URL_BEARING_ATTRIBUTES, isRefusedUrl } from "./url-scheme.ts";
import ALLOWLIST_JSON from "./dist-check-allowlist.json" with { type: "json" };

/** Shape of the shipped allowlist: hash -> descriptive label. */
interface AllowlistShape {
  readonly sha256: Readonly<Record<string, string>>;
}

const ALLOWLISTED_HASHES: ReadonlySet<string> = new Set(
  Object.keys((ALLOWLIST_JSON as unknown as AllowlistShape).sha256),
);

/** Tag names that must never appear in a built page. */
const REFUSED_TAG_NAMES: ReadonlySet<string> = new Set([
  "iframe",
  "object",
  "embed",
  "base",
]);

/** External-script src prefix: only `/_astro/` is allowed. */
const ALLOWED_SCRIPT_SRC_PREFIX = "/_astro/";

/** Walk `dir` recursively and return every `.html` file's absolute path. */
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

/** Compute the SHA-256 hex digest of `text`. Kept a named helper so
 * the two call sites (inline-script hash, `--print-hashes` output)
 * cannot diverge on encoding. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Is `href` an external stylesheet URL? Same-origin (leading `/` or
 * relative) is fine; scheme-carrying or protocol-relative is not. */
function isExternalHref(href: string): boolean {
  if (href.startsWith("//")) return true;
  return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

/** Is `dataUrl` an image-only data URL? The exception the allowlist
 * makes for `<img src>` — a `data:image/…;base64,…` is inert (no
 * script). Everything else (`data:text/html,`, `data:application/…`)
 * stays refused. Runs the same normalization `isRefusedUrl` does
 * before the scheme check. */
function isDataImageUrl(url: string): boolean {
  const decoded = url
    .replace(/&#(?:x([0-9a-fA-F]+)|(\d+));?/g, (_all, hex, dec) => {
      const cp = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10FFFF) return "";
      try { return String.fromCodePoint(cp); } catch { return ""; }
    })
    .replace(/[\t\n\r\f\v\u0000-\u001F\u007F ]/g, "")
    .toLowerCase();
  return decoded.startsWith("data:image/");
}

/** Every "URL attribute" a browser might act on. Superset of
 * URL_BEARING_ATTRIBUTES since the DOM has aliases (`xlink:href` on
 * SVG elements, `srcset` on `img`/`source`, `formaction` on `button`). */
const URL_ATTRS_IN_DOM: ReadonlySet<string> = URL_BEARING_ATTRIBUTES;

interface CheckDistFinding {
  readonly file: string;
  readonly message: string;
}

/** Minimal DOM projections — matches the linkedom runtime shape
 * without adding a lib.dom.d.ts dependency to the CLI's tsconfig
 * (bun runs in a `types: ["bun"]` environment, no built-in DOM). */
interface DomAttribute {
  readonly name: string;
  readonly value: string;
}

interface DomElement {
  readonly tagName?: string;
  readonly attributes?: { readonly length: number; readonly [index: number]: DomAttribute };
  readonly textContent?: string;
  getAttribute?(name: string): string | null;
}

interface DomDocument {
  querySelectorAll(selector: string): Iterable<DomElement>;
}

/** Scan one HTML document and return every finding. Kept pure over
 * the document so tests can feed a fixture. */
export function scanDocument(
  document: DomDocument,
  reportPath: string,
): CheckDistFinding[] {
  const findings: CheckDistFinding[] = [];

  // 1) Refused tag names + <meta http-equiv=refresh>.
  for (const tag of REFUSED_TAG_NAMES) {
    for (const _element of Array.from(document.querySelectorAll(tag))) {
      findings.push({
        file: reportPath,
        message: `refused tag <${tag}> in built HTML.`,
      });
      void _element;
    }
  }
  for (const meta of Array.from(document.querySelectorAll("meta"))) {
    const equiv = meta.getAttribute?.("http-equiv");
    if (equiv !== null && equiv !== undefined && equiv.toLowerCase() === "refresh") {
      findings.push({
        file: reportPath,
        message: `refused <meta http-equiv=\"refresh\"> in built HTML.`,
      });
    }
  }

  // 2) All-element scan for on* attrs and URL-bearing attrs.
  for (const element of Array.from(document.querySelectorAll("*"))) {
    const tagName = (element.tagName ?? "").toLowerCase();
    const attributes = element.attributes;
    if (!attributes) continue;
    for (let i = 0; i < attributes.length; i += 1) {
      const attr = attributes[i] as DomAttribute | undefined;
      const name = (attr?.name ?? "").toLowerCase();
      const value = attr?.value ?? "";
      if (/^on[a-z]/.test(name)) {
        findings.push({
          file: reportPath,
          message: `refused attribute '${name}' on <${tagName}> (inline event handler).`,
        });
        continue;
      }
      if (URL_ATTRS_IN_DOM.has(name) && isRefusedUrl(value)) {
        // Exception: `data:image/...` on `<img src>` is inert.
        if (tagName === "img" && name === "src" && isDataImageUrl(value)) continue;
        findings.push({
          file: reportPath,
          message: `refused URL scheme (${[...REFUSED_URL_SCHEMES].join(", ")}) on <${tagName} ${name}> in built HTML.`,
        });
      }
    }
  }

  // 3) Scripts: src must be `/_astro/`, inline must be hash-allowlisted.
  for (const script of Array.from(document.querySelectorAll("script"))) {
    const src = script.getAttribute?.("src");
    if (src !== null && src !== undefined) {
      if (!src.startsWith(ALLOWED_SCRIPT_SRC_PREFIX)) {
        findings.push({
          file: reportPath,
          message: `refused <script src=${JSON.stringify(src)}> — script sources must be under ${JSON.stringify(ALLOWED_SCRIPT_SRC_PREFIX)}.`,
        });
      }
      continue;
    }
    const inline = script.textContent ?? "";
    const hash = sha256Hex(inline);
    if (!ALLOWLISTED_HASHES.has(hash)) {
      const excerpt = inline.replace(/\s+/g, " ").trim().slice(0, 80);
      findings.push({
        file: reportPath,
        message: `refused inline <script> (sha256=${hash}); add to packages/cli/src/dist-check-allowlist.json if intended. Excerpt: ${JSON.stringify(excerpt)}.`,
      });
    }
  }

  // 4) External stylesheets: no <link rel="stylesheet" href="https://…">.
  for (const link of Array.from(document.querySelectorAll("link"))) {
    const rel = (link.getAttribute?.("rel") ?? "").toLowerCase();
    if (rel !== "stylesheet") continue;
    const href = link.getAttribute?.("href") ?? "";
    if (isExternalHref(href)) {
      findings.push({
        file: reportPath,
        message: `refused external stylesheet <link rel="stylesheet" href=${JSON.stringify(href)}>.`,
      });
    }
  }

  return findings;
}

/** Run the output-gate check over every `.html` file under `distDir`. */
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

/** Print every distinct inline-script hash observed under `distDir` so
 * a maintainer can seed / update `dist-check-allowlist.json` after a
 * Starlight or Astro upgrade. Returns the map for programmatic use. */
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
