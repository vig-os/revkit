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
import { readFile, realpath, lstat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { DOMParser } from "linkedom";
import { isSiblingFilename } from "../content/schemas/plots.ts";

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
 * paths, no `..` traversal, no symlinks that leak outside. Overrides
 * `sanitize`, `load`, `file` and `http` on the base loader so every path
 * Vega uses to fetch a dataset flows through the same containment check.
 *
 * `sanitize` returns the relative URL as `href` (not the absolute one):
 * Vega also calls `sanitize` for the `href` encoding channel and the
 * `image` mark's URL — the schema rejects both, but returning an
 * absolute build-host path here would leak `/home/runner/…` into a page
 * anyway if a future schema hole let one through. Reads still resolve
 * against `specDir` inside `load` / `file`, so the sandbox stays intact. */
function buildRestrictedLoader(specDir: string): VegaLoaderShape {
  const baseVegaLoader = vegaLoader();

  async function resolveInsideReal(uri: string): Promise<string> {
    if (!isSiblingFilename(uri)) {
      throw new Error(
        `plot loader refused a non-sibling data url: ${JSON.stringify(uri)}`,
      );
    }
    const specDirReal = await realpath(specDir);
    const specDirRealTrimmed = specDirReal.endsWith(sep)
      ? specDirReal.slice(0, -1)
      : specDirReal;
    const candidate = resolve(specDirRealTrimmed, uri);
    // Refuse a symlinked data file outright — `realpath()` on the target
    // would follow the link and pass the prefix check even when the real
    // file lives outside the plot directory.
    const stat = await lstat(candidate).catch(() => null);
    if (stat === null) {
      throw new Error(`plot loader: data file not found: ${uri}`);
    }
    if (stat.isSymbolicLink()) {
      throw new Error(
        `plot loader refused a symlinked data file: ${uri} (symlinks would let a data file escape the plot directory).`,
      );
    }
    const targetReal = await realpath(candidate);
    if (
      targetReal !== specDirRealTrimmed &&
      !targetReal.startsWith(`${specDirRealTrimmed}${sep}`)
    ) {
      const outside = relative(specDirRealTrimmed, targetReal);
      throw new Error(
        `plot loader refused to read outside the spec dir: ${uri} ` +
          `(real target ${outside} sits above the spec directory).`,
      );
    }
    return targetReal;
  }

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
      const absolute = await resolveInsideReal(uri);
      return readFile(absolute, "utf8");
    },
    async file(filename: string) {
      const absolute = await resolveInsideReal(filename);
      return readFile(absolute, "utf8");
    },
    async http() {
      throw new Error(`plot loader refused an HTTP fetch (data.url must be a sibling file)`);
    },
  };
  return restricted;
}

/** Elements a Vega SVG never legitimately emits and that would be
 * dangerous to render even if the CSP blocked their side effects. */
const DISALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
  "script",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "base",
  "form",
  "input",
  "button",
]);

/** Attributes stripped from every element regardless of tag name.
 * `on*` handlers, plus the two `href` shapes an SVG can carry. */
function isDangerousAttribute(name: string, value: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith("on")) return true;
  if (/\s*javascript:/i.test(value)) return true;
  // Only same-page fragment hrefs survive; any absolute / relative /
  // scheme-carrying href is refused. Applies to both `href` and
  // `xlink:href` — Vega does not emit either, so this is defence in
  // depth ready for a future encoding channel escape.
  if (lower === "href" || lower === "xlink:href") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("#")) return true;
  }
  return false;
}

/** Minimal shape of a linkedom node — the class ships with types that
 * don't line up with the browser lib.dom `Element`, so we describe just
 * the surface the sanitiser walks (children, attributes, remove,
 * removeAttribute, localName). Kept here so the rest of the file uses
 * ordinary DOM ergonomics without pulling in linkedom's whole typing. */
interface SvgNode {
  readonly localName?: string;
  readonly children?: readonly SvgNode[];
  readonly attributes?: readonly { name: string; value: string }[];
  remove(): void;
  removeAttribute(name: string): void;
  readonly outerHTML: string;
}

/** Recursively strip disallowed elements and attributes from an SVG DOM
 * tree in place. */
function sanitizeSvgTree(root: SvgNode): void {
  // Copy children into an array first — mutating during iteration would
  // skip siblings after a removal.
  const children = Array.from(root.children ?? []);
  for (const child of children) {
    const tagName = child.localName?.toLowerCase() ?? "";
    if (DISALLOWED_ELEMENTS.has(tagName)) {
      child.remove();
      continue;
    }
    // Drop dangerous attributes on this element.
    const attributes = Array.from(child.attributes ?? []);
    for (const attribute of attributes) {
      if (isDangerousAttribute(attribute.name, attribute.value)) {
        child.removeAttribute(attribute.name);
      }
    }
    sanitizeSvgTree(child);
  }
}

/**
 * Sanitise an SVG fragment: parse it into a real DOM, strip disallowed
 * elements and dangerous attributes anywhere in the tree, and serialise
 * back to a string. Applied unconditionally; Vega's SVG renderer does
 * not emit any of the stripped shapes today and never should for us.
 */
export function sanitizeSvg(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement as unknown as SvgNode | null;
  if (!root || root.localName?.toLowerCase() !== "svg") {
    throw new Error(
      `sanitizeSvg: expected an <svg> root element, got <${root?.localName ?? "unknown"}>`,
    );
  }
  // Strip dangerous attrs on the SVG root itself before descending.
  const rootAttrs = Array.from(root.attributes ?? []);
  for (const attribute of rootAttrs) {
    if (isDangerousAttribute(attribute.name, attribute.value)) {
      root.removeAttribute(attribute.name);
    }
  }
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
