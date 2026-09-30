// Build-time Vega-Lite -> Vega -> SVG renderer for the `plots` collection
// (ADR-0004, C4). Called from the `<Plot>` component; extracted as a pure
// function so unit tests can exercise real Vega/Vega-Lite behaviour against
// fixture specs without standing up an Astro build.
//
// - Vega-Lite is compiled to a Vega spec, then parsed and rendered via a
//   `View` in `renderer: 'none'` mode with `toSVG()` — no headless browser
//   or DOM, no client JS shipped to the reader.
// - The file loader is restricted to the spec's directory: `data.url` is
//   resolved as a relative sibling path (schema-checked by
//   `isSiblingFilename`), then the real filesystem path is compared
//   against the real spec directory so a symlink cannot escape (the
//   naive `resolve()` check does not follow links, so `plots/x/link.csv
//   -> /etc/hostname` would slip past). Symlinked data files are refused
//   outright before their contents are read.
// - The returned SVG is sanitised through a DOM parser + denylist
//   (linkedom, pinned): `<script>`, `<foreignObject>`, `<iframe>` etc.
//   are stripped, every `on*` handler is removed, and every `href` /
//   `xlink:href` that is not a same-page `#` fragment is dropped, along
//   with any `javascript:` URL. This is defence in depth on top of the
//   page CSP (ADR-0012, `default-src 'none'`): a regex sanitiser can
//   miss nested constructs like `<scr<script>ipt>` (CodeQL rule
//   js/incomplete-multi-character-sanitization); a real parser cannot.

import type { View } from "vega";
import {
  parse as vegaParse,
  View as VegaView,
  loader as vegaLoader,
  Error as VegaError,
} from "vega";
import { compile as vegaLiteCompile } from "vega-lite";
import { DOMParser } from "linkedom";
import { isSiblingFilename } from "../content/schemas/plots.ts";
import { readConfinedSibling } from "./plot-file-io.ts";

/** Options for {@link renderPlotToSvg}. */
export interface RenderPlotOptions {
  /** Absolute path to the directory that holds the spec and its sibling
   * data files. Every `data.url` in the spec is resolved against this
   * directory and MUST land inside it (real paths compared, not just
   * lexical prefixes). */
  specDir: string;
  /** Optional accessible name. Rendered inside the SVG as `<title>` so
   * assistive tech announces it. Falls back to the spec's `title` /
   * `description`; empty when neither is present. */
  accessibleName?: string;
  /** Optional accessible description. Rendered inside the SVG as `<desc>`. */
  accessibleDescription?: string;
}

/** A Vega-Lite spec — kept as `unknown` so the caller decides how to type
 * it. The spec is validated by the plots schema (ADR-0004) before it
 * reaches us; here we treat it as opaque JSON. */
export type PlotSpec = unknown;

type VegaLoaderShape = ReturnType<typeof vegaLoader>;

/** Build a Vega loader that resolves data URLs relative to `specDir` and
 * refuses anything that would escape it — no HTTP fetches, no absolute
 * paths, no `..` traversal, no symlinks that leak outside. Every read
 * routes through {@link readConfinedSibling}, so this loader and the
 * pre-render column check share exactly one containment implementation.
 *
 * `sanitize` returns the relative URL as `href` (not the absolute one):
 * Vega also calls `sanitize` for the `href` encoding channel and the
 * `image` mark's URL — the schema rejects both, but returning an
 * absolute build-host path here would leak `/home/runner/…` into a page
 * anyway if a future schema hole let one through. Reads still route
 * through `load` / `file` where the containment check runs. */
function buildRestrictedLoader(specDir: string): VegaLoaderShape {
  const baseVegaLoader = vegaLoader();

  const restricted: VegaLoaderShape = {
    ...baseVegaLoader,
    async sanitize(uri: string) {
      if (!isSiblingFilename(uri)) {
        throw new Error(
          `plot loader refused a non-sibling data url in sanitize(): ${JSON.stringify(uri)}`,
        );
      }
      // Return the RELATIVE href so an SVG attribute (`<image xlink:href>`,
      // `<a xlink:href>` etc.) can never carry the build-host absolute
      // path — see the block comment above. The real read still routes
      // through `load` / `file` where the containment check runs.
      return { href: uri };
    },
    async load(uri: string) {
      const { text } = await readConfinedSibling(specDir, uri);
      return text;
    },
    async file(filename: string) {
      const { text } = await readConfinedSibling(specDir, filename);
      return text;
    },
    async http() {
      throw new Error(`plot loader refused an HTTP fetch (data.url must be a sibling file)`);
    },
  };
  return restricted;
}

/** Allowlist of element tag names Vega's static SVG output legitimately
 * emits. Everything else is removed at sanitise time — animation
 * elements (`<set>`, `<animate>`, `<animateTransform>`, `<animateMotion>`),
 * SMIL declarative logic, embed / script / foreign-object escape hatches
 * and unknown-to-us elements all fail closed. Names are lowercased
 * because linkedom's SVG-XML parser normalises tag names. */
export const ALLOWED_SVG_ELEMENTS: ReadonlySet<string> = new Set([
  "svg",
  "g",
  "defs",
  "clippath",
  "path",
  "rect",
  "line",
  "circle",
  "ellipse",
  "polygon",
  "polyline",
  "text",
  "tspan",
  "title",
  "desc",
  "lineargradient",
  "radialgradient",
  "stop",
  "pattern",
  "mask",
  "marker",
  "symbol",
  "use",
  "metadata",
  "switch",
]);

/** Attributes that are always safe on an allowed element regardless of
 * value. Keeps the list to what Vega's static output uses: geometry,
 * presentation, text, and the ARIA / structural bits we care about for
 * accessibility. Any attribute not in this set is stripped from the
 * element (allowlist, not denylist) — a `<set attributeName="href" …>`
 * dropped through the element allowlist would still lose the attribute
 * anyway. */
export const ALLOWED_SVG_ATTRIBUTES: ReadonlySet<string> = new Set([
  // Structural / accessibility
  "id",
  "class",
  "role",
  "aria-label",
  "aria-labelledby",
  "aria-describedby",
  "aria-roledescription",
  "aria-hidden",
  "lang",
  "xml:lang",
  "xml:space",
  "xmlns",
  "xmlns:xlink",
  "version",
  // Layout
  "width",
  "height",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "dx",
  "dy",
  "d",
  "points",
  "viewbox",
  "preserveaspectratio",
  "transform",
  "clip-path",
  "clip-rule",
  "fill-rule",
  "mask",
  "offset",
  "patterncontentunits",
  "patternunits",
  "gradienttransform",
  "gradientunits",
  "spreadmethod",
  "marker-end",
  "marker-mid",
  "marker-start",
  "markerheight",
  "markerwidth",
  "markerunits",
  "refx",
  "refy",
  "orient",
  "viewport-fill",
  // Presentation
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-opacity",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "display",
  "visibility",
  "color",
  "cursor",
  "pointer-events",
  "shape-rendering",
  "text-rendering",
  "vector-effect",
  "stop-color",
  "stop-opacity",
  // `style` is deliberately absent: CSS has a wider surface than an SVG
  // presentation attribute (image-set(), CSS-escape sequences like
  // `\72` for `r`, url(...) values our regex would only catch when it
  // reads as the literal text `url`), and Vega's static SVG output
  // uses presentation attributes throughout. If a future Vega bump
  // starts emitting `style="…"`, convert the specific properties into
  // presentation attributes rather than re-allowing CSS.
  // Text
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-variant",
  "text-anchor",
  "text-decoration",
  "dominant-baseline",
  "alignment-baseline",
  "baseline-shift",
  "letter-spacing",
  "word-spacing",
  "writing-mode",
  "direction",
  "unicode-bidi",
  "text-indent",
  "line-height",
  // Symbol / use (only same-document fragment, checked separately)
  "href",
  "xlink:href",
]);

/** Regex extracting every `url(…)` value from a CSS declaration list.
 * Matches both quoted and unquoted forms. */
const URL_VALUE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;

/** True when a `url(...)` argument is a same-document fragment
 * (`url(#gradient1)`) — the only outbound reference an inline SVG here
 * ever needs, so allow it and refuse everything else. */
function isSafeFragmentReference(raw: string): boolean {
  return /^#[A-Za-z_][\w.-]*$/.test(raw.trim());
}

/** Rewrite a `style` or presentation-attribute value so any `url(…)` that
 * is not a same-document fragment (`url(#foo)`) is dropped. Returns
 * `null` when nothing survives worth keeping. */
function sanitizeUrlsInValue(value: string): string {
  return value.replace(URL_VALUE, (whole, dq, sq, uq) => {
    const inner = (dq ?? sq ?? uq ?? "").trim();
    return isSafeFragmentReference(inner) ? `url(#${inner.slice(1)})` : "";
  });
}

/** Presentation attributes whose values can legitimately carry a
 * `url(#fragment)` reference (Vega uses these for gradient / clip
 * fills), so the value is rewritten rather than the attribute stripped.
 * `style` is intentionally NOT here — see the block comment on
 * ALLOWED_ATTRIBUTES for why raw CSS never survives.
 *
 * Exported so `revkit check-dist` can URL-scan the same set of
 * presentation attributes at the output gate (issue #27) — one source
 * of truth for which SVG attribute values can carry `url(…)`. */
export const URL_BEARING_SVG_ATTRIBUTES: ReadonlySet<string> = new Set([
  "fill",
  "stroke",
  "clip-path",
  "mask",
  "filter",
  "marker-start",
  "marker-mid",
  "marker-end",
  // `cursor: url(…)` is a legitimate CSS presentation value; without it
  // an attacker could point cursor at a tracker (`cursor="url(https://
  // evil.example/pixel.png)"`) and check-dist would miss it. Added here
  // so both the source sanitiser and check-dist rewrite / refuse it.
  "cursor",
]);

const URL_BEARING_ATTRIBUTES = URL_BEARING_SVG_ATTRIBUTES;

/** Exported for `revkit check-dist` (issue #27): given a value from an
 * SVG presentation attribute or a `style` value, decide whether the
 * (unescaped) `url(…)` argument names a same-document fragment
 * (`url(#gradient1)`). Anything else — `url(https://…)`, `url(//…)`,
 * `url(data:…)`, `url()`, a nested URL — refuses. */
export function isSameDocumentFragmentRef(raw: string): boolean {
  return isSafeFragmentReference(raw);
}

/** Exported for `revkit check-dist`: the raw `url(…)` regex both
 * sanitisers use. Kept as a source-of-truth export so the output gate
 * cannot drift from the source sanitiser on which token shapes count
 * as a `url(…)` (quoted, unquoted, whitespace-padded). */
export const CSS_URL_VALUE_REGEX = URL_VALUE;

function isSameDocumentFragment(value: string): boolean {
  return value.trim().startsWith("#");
}

/** Decide whether an attribute survives on an allowed element. Returns
 * either the (possibly rewritten) value to keep, or `null` to remove
 * the attribute entirely. */
function keepAttribute(name: string, value: string): string | null {
  const lower = name.toLowerCase();
  // `xmlns:*` declarations pass — linkedom parses SVG in the XHTML
  // namespace, and we still want the source's own namespace bindings.
  if (lower.startsWith("xmlns:")) return value;
  if (lower.startsWith("on")) return null;
  // href / xlink:href only survive as same-document fragments; every
  // other href would be an outbound reference from a supposedly static
  // figure (ADR-0004).
  if (lower === "href" || lower === "xlink:href") {
    return isSameDocumentFragment(value) ? value : null;
  }
  if (!ALLOWED_SVG_ATTRIBUTES.has(lower)) return null;
  // `javascript:` URLs in any surviving attribute value must go too.
  if (/\bjavascript:/i.test(value)) return null;
  if (URL_BEARING_ATTRIBUTES.has(lower)) {
    return sanitizeUrlsInValue(value);
  }
  return value;
}

/** Minimal shape of a linkedom node — the class ships with types that
 * don't line up with the browser lib.dom `Element`, so we describe just
 * the surface the sanitiser walks (children, attributes, remove,
 * removeAttribute, setAttribute, localName). Kept here so the rest of
 * the file uses ordinary DOM ergonomics without pulling in linkedom's
 * whole typing. */
interface SvgNode {
  readonly localName?: string;
  readonly children?: readonly SvgNode[];
  readonly attributes?: readonly { name: string; value: string }[];
  remove(): void;
  removeAttribute(name: string): void;
  setAttribute(name: string, value: string): void;
  readonly outerHTML: string;
}

/** Apply the element + attribute allowlist to one element in place. */
function sanitizeOneElement(element: SvgNode): void {
  const attributes = Array.from(element.attributes ?? []);
  for (const attribute of attributes) {
    const kept = keepAttribute(attribute.name, attribute.value);
    if (kept === null) {
      element.removeAttribute(attribute.name);
    } else if (kept !== attribute.value) {
      element.setAttribute(attribute.name, kept);
    }
  }
}

/** Recursively enforce the element allowlist on a tree in place. */
function sanitizeSvgTree(root: SvgNode): void {
  // Copy children into an array first — mutating during iteration would
  // skip siblings after a removal.
  const children = Array.from(root.children ?? []);
  for (const child of children) {
    const tagName = child.localName?.toLowerCase() ?? "";
    if (!ALLOWED_SVG_ELEMENTS.has(tagName)) {
      child.remove();
      continue;
    }
    sanitizeOneElement(child);
    sanitizeSvgTree(child);
  }
}

/**
 * Sanitise an SVG fragment: parse it into a real DOM, enforce an
 * ALLOWLIST of elements and attributes, sanitise `url(...)` values in
 * style / presentation attributes so only `url(#fragment)` survives,
 * and serialise back to a string. Applied unconditionally; Vega's SVG
 * renderer stays inside the allowlist today, so any element or
 * attribute this drops is either dead code or a new escape hatch a
 * reviewer should approve.
 */
export function sanitizeSvg(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement as unknown as SvgNode | null;
  if (!root || root.localName?.toLowerCase() !== "svg") {
    throw new Error(
      `sanitizeSvg: expected an <svg> root element, got <${root?.localName ?? "unknown"}>`,
    );
  }
  // Enforce the allowlist on the root <svg> itself before descending.
  sanitizeOneElement(root);
  sanitizeSvgTree(root);
  // `outerHTML` on a linkedom node serialises the whole subtree with the
  // element's own tag, preserving attributes and namespaces — same shape
  // XMLSerializer would produce, without pulling that class in.
  return root.outerHTML;
}

/** Read a spec's `title` and `description` (Vega-Lite grammar) into plain
 * strings, if they exist. Kept small — full spec shape is opaque to us. */
function extractSpecMetadata(spec: PlotSpec): { title?: string; description?: string } {
  if (spec === null || typeof spec !== "object") return {};
  const record = spec as Record<string, unknown>;
  const out: { title?: string; description?: string } = {};
  if (typeof record.title === "string") out.title = record.title;
  else if (record.title !== null && typeof record.title === "object") {
    const textValue = (record.title as Record<string, unknown>).text;
    if (typeof textValue === "string") out.title = textValue;
  }
  if (typeof record.description === "string") out.description = record.description;
  return out;
}

/** Escape text before inserting it inside an SVG `<title>` / `<desc>`. */
function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape an attribute value inserted inside an SVG root tag. */
function escapeXmlAttribute(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Turn a Vega SVG fragment into an accessible inline SVG:
 * - The root `<svg>` gets `role="img"` and `aria-label="<name>"` (unless
 *   an existing `role`/`aria-label` is already present, in which case
 *   the caller wins).
 * - A `<title>` element is inserted after the opening tag so a hovered
 *   plot surfaces its name as a tooltip, and a `<desc>` when a
 *   description was provided.
 *
 * When both `name` and `description` are absent, the SVG is returned
 * unchanged — the caller can then wrap it or hide it with `aria-hidden`.
 */
function injectAccessibleLabels(
  svg: string,
  name: string | undefined,
  description: string | undefined,
): string {
  const openMatch = svg.match(/^\s*<svg\b[^>]*>/i);
  if (!openMatch) return svg;
  let openTag = openMatch[0];

  if (name && !/\brole\s*=/.test(openTag)) {
    openTag = openTag.replace(/<svg\b/, '<svg role="img"');
  }
  if (name && !/\baria-label\s*=/.test(openTag)) {
    openTag = openTag.replace(
      /<svg\b/,
      `<svg aria-label="${escapeXmlAttribute(name)}"`,
    );
  }

  const inner: string[] = [];
  if (name) inner.push(`<title>${escapeXmlText(name)}</title>`);
  if (description) inner.push(`<desc>${escapeXmlText(description)}</desc>`);

  return `${openTag}${inner.join("")}${svg.slice(openMatch[0].length)}`;
}

/**
 * Render a Vega-Lite {@link PlotSpec} to a static SVG string.
 *
 * The spec must have already passed the plots schema (ADR-0004); this
 * function does not re-validate its shape. Missing data files, restricted
 * URLs, or a Vega-Lite / Vega compilation error surface as thrown errors
 * — the caller (a build-time component) should let them propagate so the
 * build fails loudly rather than shipping an empty plot.
 */
export async function renderPlotToSvg(
  spec: PlotSpec,
  options: RenderPlotOptions,
): Promise<string> {
  const { spec: vegaSpec } = vegaLiteCompile(
    spec as Parameters<typeof vegaLiteCompile>[0],
  );
  const runtime = vegaParse(vegaSpec);
  const loader = buildRestrictedLoader(options.specDir);

  // Vega's default logger swallows data-load failures as `warn` logs and
  // the View still renders — an empty scenegraph, but no thrown error.
  // That is the exact "silently ships an empty plot" regression ADR-0004
  // warns against, so a custom logger watches for the two signatures a
  // failed data fetch produces ("Loading failed …" from Vega itself, and
  // the "plot loader refused …" strings thrown by our restricted loader)
  // and we re-throw after the dataflow settles.
  const loadErrors: string[] = [];
  function isLoadFailure(message: string): boolean {
    return (
      message.includes("Loading failed") || message.includes("plot loader refused")
    );
  }
  function formatArgs(args: readonly unknown[]): string {
    return args
      .map((a) => (a instanceof Error ? a.message : String(a)))
      .join(" ");
  }
  const capturingLogger = {
    level(): number {
      return VegaError;
    },
    error(...args: unknown[]) {
      loadErrors.push(formatArgs(args));
      return capturingLogger;
    },
    warn(...args: unknown[]) {
      const formatted = formatArgs(args);
      if (isLoadFailure(formatted)) loadErrors.push(formatted);
      return capturingLogger;
    },
    info() {
      return capturingLogger;
    },
    debug() {
      return capturingLogger;
    },
  };

  const view: View = new VegaView(runtime, { renderer: "none", loader });
  // Vega exposes `logger(custom)` on the inherited Dataflow prototype
  // (not the View class itself), so replacing the default console logger
  // is a runtime method call rather than a constructor option.
  const viewWithLogger = view as View & { logger: (l: typeof capturingLogger) => void };
  viewWithLogger.logger(capturingLogger);
  try {
    // Vega 6's `View.toSVG()` no longer awaits the async dataflow before
    // rendering — a plot whose `data.url` is still loading would emit an
    // empty scenegraph (paths but no marks). Running the dataflow
    // explicitly first waits for the sibling data file to arrive through
    // the restricted loader before the SVG is produced.
    await view.runAsync();
    if (loadErrors.length > 0) {
      throw new Error(`plot render failed: ${loadErrors.join("; ")}`);
    }
    const svg = await view.toSVG();
    const meta = extractSpecMetadata(spec);
    const name = options.accessibleName ?? meta.title;
    const description = options.accessibleDescription ?? meta.description;
    return sanitizeSvg(injectAccessibleLabels(svg, name, description));
  } finally {
    // `View.finalize` releases the runtime's timers / subscriptions so the
    // build process exits cleanly after rendering many plots.
    view.finalize();
  }
}
